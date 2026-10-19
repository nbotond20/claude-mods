import { basename } from 'node:path';
import { CLASSIFIER_CWD } from './config.ts';
import { describeChanges, describeWork } from './changes.ts';
import { MIN_FRACTION, enforce, inheritEmpty, isEmpty } from './guards.ts';
import { runClaude } from './claude-runner.ts';
import type { Category, Config } from './config.ts';
import { fmtTime } from './dates.ts';
import type { Allocation, Block, BlockItem, CommitRef, SessionWork } from './types.ts';

export interface ClassifyInput {
  date: string;
  categories: Category[];
  blocks: Block[];
  notes?: string;
}

export interface ClassifyOutput {
  allocations: Record<number, Allocation[]>;
  summary: string;
  /** One line per block id on what was done */
  blockSummaries?: Record<number, string>;
  /** One line per block item id (`3.1`) */
  itemSummaries?: Record<string, string>;
  /** Set by sanitize: blocks the answer left out (or gave no usable category), booked under their default */
  missing?: number[];
}

export type Classifier = (input: ClassifyInput, opts?: { signal?: AbortSignal }) => Promise<ClassifyOutput>;

/** Booked when no categories are configured yet. */
export const UNCATEGORIZED = 'Uncategorized';

const withRole = (categories: Category[], role: Category['role']) => categories.find((c) => c.role === role)?.name;

/**
 * Category a block gets when classification is off or fails: the meeting role for meetings, the
 * work role otherwise, then the fallback role, then the first category the classifier may pick.
 */
export function defaultCategory(kind: Block['kind'], categories: Category[]): string {
  return (
    (kind === 'meeting' ? withRole(categories, 'meeting') : undefined) ??
    withRole(categories, 'work') ??
    withRole(categories, 'fallback') ??
    (categories.find((c) => c.classify !== false) ?? categories[0])?.name ??
    UNCATEGORIZED
  );
}

/** Keeps only known categories and normalizes fractions to sum to 1; falls back to the default category. */
export function sanitize(output: ClassifyOutput, blocks: Block[], categories: Category[]): ClassifyOutput {
  const valid = new Set(categories.map((c) => c.name));
  const allocations: Record<number, Allocation[]> = {};
  const missing: number[] = [];
  for (const b of blocks) {
    if (!isEmpty(b) && !(output.allocations[b.id] ?? []).some((a) => valid.has(a.category) && a.fraction > 0)) missing.push(b.id);
    let raw = (output.allocations[b.id] ?? []).filter((a) => valid.has(a.category) && a.fraction > 0);
    // Fold slivers (< MIN_FRACTION) into the rest so a block never books tiny fragments.
    if (raw.some((a) => a.fraction >= MIN_FRACTION)) raw = raw.filter((a) => a.fraction >= MIN_FRACTION);
    const sum = raw.reduce((s, a) => s + a.fraction, 0);
    allocations[b.id] = enforce(sum > 0 ? raw.map((a) => ({ category: a.category, fraction: a.fraction / sum })) : [{ category: b.hint, fraction: 1 }], b, categories);
  }
  inheritEmpty(blocks, allocations);
  const blockSummaries: Record<number, string> = {};
  const itemSummaries: Record<string, string> = {};
  for (const b of blocks) {
    blockSummaries[b.id] = output.blockSummaries?.[b.id]?.trim() || blockFallback(b);
    for (const it of b.items ?? []) itemSummaries[it.id] = output.itemSummaries?.[it.id]?.trim() || itemFallback(it);
  }
  return { allocations, summary: output.summary?.trim() || fallbackSummary(blocks), blockSummaries, itemSummaries, ...(missing.length ? { missing } : {}) };
}

const repoName = (p?: string) => (p ? basename(p) : 'unknown folder');
const clip = (t: string) => (t.length > 90 ? `${t.slice(0, 87)}…` : t);

/**
 * A block's title without the classifier. Never a prompt (those are private notes, not titles):
 * the meeting title, else the first commit subject, else where the work happened.
 */
export function blockFallback(b: Pick<Block, 'kind' | 'texts' | 'paths'> & Partial<Pick<Block, 'commits' | 'actions' | 'sessions'>>): string {
  if (b.kind === 'meeting') return b.texts[0] ?? 'Meeting';
  if (b.commits?.length) return clip(b.commits[0].subject);
  // A GitHub action names the block only when it is all there was, not hours of sessions around it.
  if (b.actions?.length && !b.sessions?.length) return clip(b.actions[0].title);
  const repos = [...new Set(b.paths.map(repoName))];
  return repos.length ? `Work in ${repos.slice(0, 2).join(' and ')}${repos.length > 2 ? ` +${repos.length - 2}` : ''}` : 'Work';
}

export function itemFallback(it: Pick<BlockItem, 'path' | 'commits' | 'sessions' | 'actions'>): string {
  if (it.commits.length === 1) return clip(it.commits[0].subject);
  if (it.commits.length) return `${it.commits.length} commits in ${repoName(it.path)}`;
  if (it.actions?.length === 1 && !it.sessions.length) return clip(it.actions[0].title);
  if (it.actions?.length && !it.sessions.length) return `${it.actions.length} GitHub actions in ${repoName(it.path)}`;
  return it.sessions.length > 1 ? `${it.sessions.length} AI sessions in ${repoName(it.path)}` : `Work in ${repoName(it.path)}`;
}

export function fallbackSummary(blocks: Block[]): string {
  return blocks
    .map((b) => `- ${fmtTime(b.start)}–${fmtTime(b.end)} ${b.project}: ${b.texts.slice(0, 3).join('; ') || b.kind}`)
    .join('\n');
}

/** Texts within a character budget. */
function within(texts: string[], budget: number): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (budget <= 0) break;
    out.push(t.slice(0, budget));
    budget -= t.length;
  }
  return out;
}

function changesOf(commits: CommitRef[], work: SessionWork | undefined) {
  const committed = describeChanges(commits);
  const assistant = describeWork(work);
  return { ...(committed ? { committed } : {}), ...(assistant ? { assistant } : {}) };
}

function describeBlock(b: Block) {
  const items = b.items ?? [];
  const share = items.length ? Math.max(400, Math.floor(2500 / items.length)) : 2500;
  return {
    id: b.id,
    time: `${fmtTime(b.start)}-${fmtTime(b.end)}`,
    minutes: Math.round((b.end - b.start) / 60_000),
    kind: b.kind,
    project: b.project,
    repos: b.paths.map((p) => basename(p)),
    branches: b.branches,
    sources: b.sources,
    ...(items.length
      ? {
          items: items.map((it) => ({
            id: it.id,
            time: `${fmtTime(it.start)}-${fmtTime(it.end)}`,
            minutes: Math.round((it.end - it.start) / 60_000),
            sources: it.sources,
            repo: repoName(it.path),
            branch: it.branch,
            activity: within(it.texts, share),
            ...changesOf(it.commits, it.work),
          })),
        }
      : { activity: within(b.texts, 2500), ...changesOf(b.commits ?? [], undefined) }),
  };
}

/** Bumped when the prompt or what it is shown changes, so cached classifications are redone. */
export const PROMPT_VERSION = 6;

const cats0 = (categories: Category[]) => categories.find((c) => c.classify !== false)?.name ?? UNCATEGORIZED;

/** How to pick categories: each one's own description, plus what its role means. */
function roleGuidance(categories: Category[]): string {
  const pickable = categories.filter((c) => c.classify !== false);
  const named = (role: Category['role']) => pickable.filter((c) => c.role === role).map((c) => `"${c.name}"`);
  const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]);
  const lines = ['- Follow each category\'s description: it says what belongs there.'];
  const work = named('work');
  if (work.length) lines.push(`- ${work[0]} is the usual category for building and coding work; when unsure between it and a similar category, choose it.`);
  const incident = named('incident');
  if (incident.length)
    lines.push(
      `- ${list(incident)}: only when the prompts, commits or branches explicitly show a production problem (alerts, crashes, outages, errors reported from production, hotfixes, reverts); an ordinary bug fix, or a problem in a local or dev environment, is not an incident. When they do, the whole effort on that problem belongs there: investigating, writing and shipping the fix, and checking afterwards, in every block where that happens. Routine deployment approvals are not a production problem.`,
    );
  const deploy = named('deploy');
  if (deploy.length)
    lines.push(`- ${list(deploy)}: only the time actually spent releasing: publishing releases, running deploy/release workflows, approving deployments. A release, approval or workflow run takes minutes: it never turns a block of coding into ${list(deploy)}. Fixing CI/CD or deployment pipelines is not releasing.`);
  const noCode = named('no-code');
  if (noCode.length) lines.push(`- ${list(noCode)}: work that produced NO code (few or no edits outside docs, mostly reads/searches, talks). Never use them for a block where code files were edited or committed in any real amount.`);
  const meeting = named('meeting');
  if (meeting.length) lines.push(`- Meetings are ${meeting[0]} unless a meeting clearly matches another category by its topic.`);
  const fallback = named('fallback');
  if (fallback.length) lines.push(`- ${fallback[0]} only when nothing else fits.`);
  return `How to pick categories:\n${lines.join('\n')}\n`;
}

export function buildPrompt(input: ClassifyInput): string {
  const cats = input.categories
    .filter((c) => c.classify !== false)
    .map((c) => `- ${c.name}: ${c.subtask} — ${c.description}`)
    .join('\n');
  return `You are filling in a work timesheet for ${input.date}. Assign every time block to task categories and write a short summary of the day.

Task categories:
${cats}

Evidence per block (and per item: work in one repo; items may overlap in time):
- "activity": the developer's prompts to an AI coding assistant, commit subjects, GitHub actions (issues and PRs, reviews, comments, releases, manual workflow runs, deployment approvals) and meeting titles.
- "committed": what the commits changed: conventional-commit types (feat, fix, chore, refactor, deps, ci, test, docs, revert, ...), lines, distinct files per area (code, test, deps = lockfiles/renovate, ci = pipelines/hooks, infra = Docker/k8s/helm/terraform, docs, config, generated), how many files were new, and the most-changed files.
- "assistant": what the AI assistant actually did in the session: files it edited with lines written and their areas, how many reads/searches, shell and web calls, and which shell commands ran (program + subcommand only).
Judge the MEANING of the work from all of this together, not from the wording of one prompt. Book time where the effort went: minutes follow the sessions and code, not one-off events inside them. What was changed outweighs what was asked: a prompt that says "analyze" or "look into" followed by hundreds of lines of new code is building, not analysis.

${roleGuidance(input.categories)}
Rules:
- Split a block into allocations {category, fraction} when its items (or clear phases of it) are different kinds of work: weight fractions by the items' minutes. Keep a single category when the whole block is one kind of work. Fractions per block sum to 1; ignore slivers under a quarter of the block.
- Classify by the dominant purpose of each piece of work, not by every topic that was touched.
- Be consistent: the same feature, fix or topic gets the same category in every block of the day (work on one feature that spans several blocks is one kind of work). Decide per feature first, then allocate.
- Use only the exact category names above.
${input.notes ? `- ${input.notes}\n` : ''}- For each block write "summary": one short line (at most ~10 words, no trailing period) saying what was actually done, e.g. "Fixed token refresh race in auth middleware". For meetings, restate the meeting's topic.
- Give each item its own "summary" line the same way.
- Summaries are titles in a calendar: write them in your own words. Never copy or quote a prompt.
- summary: 3–8 concise bullet lines ("- ...") describing what was actually done that day, grouped by project. For the developer's own records.

Blocks:
${JSON.stringify(input.blocks.map(describeBlock), null, 1)}

Respond with ONLY a JSON object, no prose, in this shape:
{"blocks":[{"id":1,"summary":"...","allocations":[{"category":${JSON.stringify(cats0(input.categories))},"fraction":1}],"items":[{"id":"1.1","summary":"..."}]}],"summary":"- ..."}`;
}

export function parseResponse(text: string): ClassifyOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Classifier returned no JSON');
  const json = JSON.parse(text.slice(start, end + 1));
  const allocations: Record<number, Allocation[]> = {};
  const blockSummaries: Record<number, string> = {};
  const itemSummaries: Record<string, string> = {};
  for (const b of json.blocks ?? []) {
    for (const it of b.items ?? []) if (typeof it?.summary === 'string' && it.summary.trim()) itemSummaries[String(it.id)] = it.summary.trim();
    allocations[Number(b.id)] = (b.allocations ?? []).map((a: any) => ({ category: String(a.category), fraction: Number(a.fraction) }));
    if (typeof b.summary === 'string' && b.summary.trim()) blockSummaries[Number(b.id)] = b.summary.trim();
  }
  return { allocations, summary: String(json.summary ?? ''), blockSummaries, itemSummaries };
}

/** Classifier backed by `claude -p` (or a profile wrapper), run from a dedicated directory that collection ignores. */
export function claudeClassifier(config: Config): Classifier {
  return async (input, opts = {}) => {
    const text = await runClaude(buildPrompt(input), {
      command: config.classifier.command,
      model: config.classifier.model,
      cwd: CLASSIFIER_CWD,
      timeoutSeconds: config.classifier.timeoutSeconds,
      signal: opts.signal,
    }).catch((e: Error) => {
      if (e.name === 'AbortError') throw e;
      throw new Error(`Classifier failed: ${e.message}`);
    });
    return parseResponse(text);
  };
}
