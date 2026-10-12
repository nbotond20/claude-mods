import { fileArea } from './changes.ts';
import type { Category } from './config.ts';
import type { Allocation, Block, BlockItem, FileChange } from './types.ts';

/**
 * Hard limits on what the classifier may answer, checked against the evidence. The model judges
 * meaning; these keep it from booking hours that the activity cannot back:
 * - a release or approval takes minutes, so Deployment cannot claim hours of coding,
 * - analysis-type categories cannot claim time in which code was written,
 * - Incident Management needs a sign of a production problem,
 * - a block with nothing in it follows its neighbours instead of landing in General.
 */

/** Time credited per deployment event (release, approval, deploy workflow run or command). */
export const DEPLOY_EVENT_MINUTES = 15;
/** Code lines (added + removed) from which a piece of work counts as writing code. */
export const CODE_LINES = 20;
/** Fractions under this are folded into the rest of the block. */
export const MIN_FRACTION = 0.25;

/** Categories for work that produces no code. */
const NO_CODE = new Set(['Admin/Analysis', 'Requirements', 'Monitoring', 'Training', 'Management', 'General', 'Service Requests', 'Security (S&M)', 'Backups']);

const INCIDENT_EVIDENCE =
  /\b(prod(uction)?|incident|outage|downtime|alert(s|ing)?|pod(s)?|restart(s|ed)?|crash(es|ed|ing)?|oom|out of memory|hot-?fix|revert(ed)?|roll-?back|sentry|pager(duty)?|50[0-4]|customer|client report|users? (can't|cannot|are unable)|urgent|on-?call)\b/i;

const DEPLOY_WORKFLOW = /\b(deploy|release|publish|promot|rollout|ship)/i;
const DEPLOY_COMMAND =
  /^(vercel|netlify|flyctl|fly|helm (upgrade|install|rollback)|kubectl (apply|rollout|set)|gh release|npm publish|pnpm publish|terraform apply|pulumi up|argocd)/;

const CODE_AREAS = new Set(['code', 'test', 'config', 'ci', 'infra']);
const codeLines = (files: FileChange[] | undefined) => (files ?? []).filter((f) => CODE_AREAS.has(fileArea(f.path))).reduce((n, f) => n + f.added + f.removed, 0);

/** Code lines written in a piece of work, by the assistant or in commits. */
export function itemCodeLines(it: Pick<BlockItem, 'commits' | 'work'>): number {
  return codeLines(it.work?.edits) + it.commits.reduce((n, c) => n + codeLines(c.files), 0);
}

function deployEvents(b: Block): number {
  const actions = (b.actions ?? []).filter(
    (a) => a.kind === 'release' || a.kind === 'approval' || a.kind === 'tag' || (a.kind === 'workflow' && DEPLOY_WORKFLOW.test(a.title)),
  ).length;
  const commands = (b.items ?? []).reduce((n, it) => n + (it.work?.commands ?? []).filter((c) => DEPLOY_COMMAND.test(c)).length, 0);
  return actions + commands;
}

/** Share of the block's time spent in pieces of work that wrote no code (0–1). */
function noCodeShare(b: Block): number {
  const items = b.items ?? [];
  if (!items.length) return (b.commits ?? []).some((c) => codeLines(c.files) >= CODE_LINES) ? 0 : 1;
  const total = items.reduce((n, it) => n + (it.end - it.start), 0);
  if (!total) return 1;
  return items.filter((it) => itemCodeLines(it) < CODE_LINES).reduce((n, it) => n + (it.end - it.start), 0) / total;
}

/** A block with no evidence of any work: no commits, edits or GitHub actions, and no real prompt. */
export function isEmpty(b: Block): boolean {
  if (b.kind !== 'work' || b.commits?.length || b.actions?.length) return false;
  if ((b.items ?? []).some((it) => it.work?.edits.length || it.commits.length)) return false;
  return b.texts.every((t) => !t.trim() || /^\/\w[\w:-]*$/.test(t.trim()));
}

/** Where time taken from a category goes when nothing else in the block can take it. */
function replacement(category: string, writesCode: boolean, valid: Set<string>, fallback: string): string {
  const want = category === 'Incident Management' ? 'Small Enhancements' : writesCode ? 'Development' : 'Admin/Analysis';
  return valid.has(want) ? want : fallback;
}

/** Caps each category at what the block's evidence allows, moving the excess to the block's other categories. */
export function enforce(allocations: Allocation[], b: Block, categories: Category[]): Allocation[] {
  if (b.kind !== 'work') return allocations;
  const valid = new Set(categories.map((c) => c.name));
  const minutes = Math.max(1, (b.end - b.start) / 60_000);
  const noCode = noCodeShare(b);
  const writesCode = noCode < 1;
  // Prompts, commit subjects and branches; GitHub action titles ("Approved deployment … to production") say nothing about a problem.
  const actionTitles = new Set((b.actions ?? []).map((a) => a.title));
  const evidence = [...b.texts.filter((t) => !actionTitles.has(t)), ...b.branches].join('\n');

  const cap = (category: string): number => {
    let limit = 1;
    if (category === 'Deployment') limit = Math.min(1, (deployEvents(b) * DEPLOY_EVENT_MINUTES) / minutes + noCode);
    if (NO_CODE.has(category)) limit = Math.min(limit, noCode);
    if (category === 'Incident Management' && !INCIDENT_EVIDENCE.test(evidence)) limit = 0;
    return limit;
  };

  let out = allocations.map((a) => ({ ...a }));
  const capped = new Set<string>();
  // Excess moved into another category can push that one over its own cap: repeat until stable.
  for (let round = 0; round < 4; round++) {
    let excess = 0;
    for (const a of out) {
      const limit = cap(a.category);
      if (a.fraction > limit + 1e-9) {
        excess += a.fraction - limit;
        a.fraction = limit;
        capped.add(a.category);
      }
    }
    if (excess > 1e-9) {
      const open = out.filter((a) => !capped.has(a.category) && a.fraction > 0);
      const room = open.reduce((n, a) => n + a.fraction, 0);
      if (room > 0) for (const a of open) a.fraction += (excess * a.fraction) / room;
      else {
        const to = replacement([...capped][0], writesCode, valid, b.hint);
        const hit = out.find((a) => a.category === to);
        if (hit) hit.fraction += excess;
        else out.push({ category: to, fraction: excess });
      }
    }
    if (excess <= 1e-9) break;
  }
  out = out.filter((a) => a.fraction > 1e-9);
  if (out.some((a) => a.fraction >= MIN_FRACTION)) out = out.filter((a) => a.fraction >= MIN_FRACTION);
  const sum = out.reduce((n, a) => n + a.fraction, 0);
  return out.map((a) => ({ category: a.category, fraction: a.fraction / sum }));
}

/** Blocks without evidence take the category of the nearest block of the same project that has some. */
export function inheritEmpty(blocks: Block[], allocations: Record<number, Allocation[]>): void {
  const solid = blocks.filter((b) => b.kind === 'work' && !isEmpty(b));
  for (const b of blocks) {
    if (!isEmpty(b)) continue;
    const near = solid.filter((s) => s.project === b.project).sort((x, y) => Math.abs(x.start - b.start) - Math.abs(y.start - b.start))[0];
    if (!near) continue;
    const main = [...allocations[near.id]].sort((x, y) => y.fraction - x.fraction)[0];
    if (main) allocations[b.id] = [{ category: main.category, fraction: 1 }];
  }
}
