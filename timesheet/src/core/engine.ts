import { categoriesFor, computeKey, contractHome, targetFor } from './config.ts';
import type { Category, Config } from './config.ts';
import { createHash } from 'node:crypto';
import { PROMPT_VERSION, blockFallback, claudeClassifier, itemFallback, defaultCategory, fallbackSummary, sanitize } from './classify.ts';
import { cleanPrompt, clipIntervals } from './collectors/spans.ts';
import type { Classifier } from './classify.ts';
import { collectCalendar } from './collectors/gcal.ts';
import { collectClaude } from './collectors/claude.ts';
import { collectOpenCode } from './collectors/opencode.ts';
import { collectGit, discoverRepos, repoRoot } from './collectors/git.ts';
import { githubCollector } from './collectors/github.ts';
import type { GithubResult } from './collectors/github.ts';
import { dayBounds, daysBetween, today } from './dates.ts';
import { buildEntries } from './hours.ts';
import { Scope, resolutionKey } from './scope.ts';
import type { Store } from './store.ts';
import { buildBlocks } from './timeline.ts';
import type { WorkEvent } from './timeline.ts';
import type { Block, DayReport, OtherBlock, RawEvent, StoredDay } from './types.ts';

export interface Sources {
  claude: (from: number, to: number) => Promise<RawEvent[]>;
  opencode: (from: number, to: number) => Promise<RawEvent[]>;
  git: (paths: string[], from: number, to: number) => RawEvent[];
  /** Gets every path seen in AI sessions, to match GitHub repos to local clones */
  github: ((paths: string[], from: number, to: number) => Promise<GithubResult>) | null;
  calendar: ((from: number, to: number) => Promise<RawEvent[]>) | null;
}

export interface EngineOptions {
  config: Config;
  store: Store;
  /** null disables LLM classification (hints only) */
  classifier?: Classifier | null;
  sources?: Partial<Sources>;
  today?: () => string;
  /** The current time; nothing after it is counted */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface DaysOptions {
  refresh?: boolean;
  target?: number;
}

export interface ComputeOptions {
  /** Stops taking new days and kills running classifications; unfinished days are not saved. */
  signal?: AbortSignal;
  onStart?: (date: string) => void;
  onDone?: (day: StoredDay) => void;
  /** Ask the classifier again even where the day's blocks are unchanged (an explicit refresh) */
  reclassify?: boolean;
}

const OOO_MIN_HOURS = 4;
const OTHER_GAP_MINUTES = 60;
/** Today is recomputed at most this often unless refreshed explicitly. */
const TODAY_TTL_MS = 15 * 60_000;
/** A day that failed partway (source down, classifier error) is retried after this long. */
const RETRY_AFTER_MS = 5 * 60_000;

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    while (queue.length && !signal?.aborted) await fn(queue.shift()!);
  }));
}

/** Everything the classifier's answer depends on: the blocks it is shown, the categories and its settings. */
function classificationKey(blocks: Block[], categories: Category[], config: Config): string {
  const input = {
    prompt: PROMPT_VERSION,
    blocks: blocks.map((b) => [b.id, b.kind, b.project, b.start, b.end, b.texts, b.paths, (b.items ?? []).map((it) => [it.id, it.path, it.texts, it.commits.map((c) => [c.added, c.removed]), it.work])]),
    categories: categories.map((c) => [c.name, c.classify !== false]),
    classifier: [config.classifier.model, config.classifier.notes ?? ''],
  };
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

export class Engine {
  readonly config: Config;
  readonly store: Store;
  private scope: Scope;
  readonly key: string;
  private classifier: Classifier | null;
  private sources: Sources;
  private today: () => string;
  private now: () => number;
  private log: (msg: string) => void;

  constructor(opts: EngineOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.scope = new Scope(opts.config);
    this.key = computeKey(opts.config);
    this.classifier = opts.classifier !== undefined ? opts.classifier : opts.config.classifier.enabled ? claudeClassifier(opts.config) : null;
    this.today = opts.today ?? today;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.sources = {
      claude: (from, to) => collectClaude(this.config, from, to),
      opencode: (from, to) => collectOpenCode(this.config, from, to),
      git: (paths, from, to) => collectGit(this.config, discoverRepos(this.config, paths), from, to),
      github: this.config.github.enabled ? githubCollector(this.config) : null,
      calendar: this.config.calendar.enabled ? (from, to) => collectCalendar(this.config, from, to) : null,
      ...opts.sources,
    };
  }

  /**
   * A cached day must be recomputed when the settings that shaped it changed, a path it saw
   * now resolves differently, it was computed as "today" (and is now past, or older than
   * TODAY_TTL), or it failed partway and RETRY_AFTER has passed. A day that is partial only
   * because of unclassified paths waits for a scope change instead of re-running Claude.
   */
  isStale(day: StoredDay, now = Date.now()): boolean {
    if (day.computeKey !== this.key) return true;
    if (Object.entries(day.paths).some(([p, key]) => resolutionKey(this.scope.resolve(p)) !== key)) return true;
    const age = now - Date.parse(day.computedAt);
    if (day.status === 'today') return day.date < this.today() || age > TODAY_TTL_MS;
    if (day.status === 'partial') return day.retry !== false && age > RETRY_AFTER_MS;
    return false;
  }

  /** Dates in [from, to] up to today that are missing or stale (all of them with refresh). */
  pending(from: string, to: string, refresh = false): string[] {
    return daysBetween(from, to).filter((d) => {
      if (d > this.today()) return false;
      if (refresh) return true;
      const s = this.store.getDay(d);
      return !s || this.isStale(s);
    });
  }

  /** Reports for every day in [from, to] up to today, computing only what is missing or stale. */
  async days(from: string, to: string, opts: DaysOptions = {}): Promise<DayReport[]> {
    const dates = daysBetween(from, to).filter((d) => d <= this.today());
    const stored = new Map<string, StoredDay>();
    const missing: string[] = [];
    for (const d of dates) {
      const s = opts.refresh ? null : this.store.getDay(d);
      if (s && !this.isStale(s)) stored.set(d, s);
      else missing.push(d);
    }
    if (missing.length) for (const s of await this.compute(missing, { reclassify: opts.refresh })) stored.set(s.date, s);
    return dates.map((d) => this.report(stored.get(d)!, opts.target));
  }

  report(day: StoredDay, targetOverride?: number): DayReport {
    const blockOverrides = this.store.blockOverrides(day.date);
    // Texts stored before prompt cleaning improved are cleaned on the way out.
    const blocks: Block[] = day.blocks.map((b) => {
      const texts = b.texts.map((t) => (b.kind === 'work' ? cleanPrompt(t) : t)).filter((t): t is string => !!t);
      return blockOverrides.has(b.id) ? { ...b, texts, allocations: [{ category: blockOverrides.get(b.id)!, fraction: 1 }] } : { ...b, texts };
    });
    if (day.summary && day.summary === fallbackSummary(day.blocks)) day = { ...day, summary: fallbackSummary(blocks) };
    const target = day.outOfOffice ? null : targetFor(this.config, day.date, targetOverride);
    const entries = buildEntries(blocks, this.config.categories, target, this.config.rounding, this.store.overrides(day.date));
    const measured = blocks.every((b) => b.measured !== undefined);
    return {
      ...day,
      blocks,
      target,
      entries,
      realTotal: entries.reduce((s, e) => s + e.real, 0),
      total: entries.reduce((s, e) => s + e.hours, 0),
      ...(measured ? { measuredTotal: blocks.reduce((s, b) => s + b.measured!, 0) } : {}),
    };
  }

  /** Collects all sources once for the span of `dates`, then builds, classifies and stores each day. */
  async compute(dates: string[], opts: ComputeOptions = {}): Promise<StoredDay[]> {
    const sorted = [...dates].sort();
    const from = dayBounds(sorted[0])[0];
    const to = dayBounds(sorted[sorted.length - 1])[1];
    const failures: string[] = [];
    this.log(`Collecting activity ${sorted[0]} → ${sorted[sorted.length - 1]}…`);

    const claudeEvents = await this.sources.claude(from, to).catch((e) => {
      failures.push(`Claude sessions: ${e.message}`);
      return [] as RawEvent[];
    });
    const opencodeEvents = await this.sources.opencode(from, to).catch((e) => {
      failures.push(`OpenCode sessions: ${e.message}`);
      return [] as RawEvent[];
    });
    const claude = [...claudeEvents, ...opencodeEvents];
    const workPaths = [...new Set(claude.filter((e) => this.scope.resolve(e.path).kind === 'work').map((e) => e.path!))];
    let git: RawEvent[] = [];
    try {
      git = this.sources.git(workPaths, from, to);
    } catch (e) {
      failures.push(`git: ${(e as Error).message}`);
    }
    let github: RawEvent[] = [];
    /** Warnings that do not make a day worth retrying (a repo no token can read stays unreadable). */
    const notes: string[] = [];
    if (this.sources.github) {
      try {
        const r = await this.sources.github([...new Set(claude.flatMap((e) => (e.path ? [e.path] : [])))], from, to);
        github = r.events;
        for (const [repo, path] of Object.entries(r.denied)) {
          if (this.scope.resolve(path).kind === 'work') notes.push(`GitHub: no token can read ${repo}; add one for its owner with \`timesheet github add\``);
        }
      } catch (e) {
        failures.push(`GitHub: ${(e as Error).message}`);
      }
    }
    let calendar: RawEvent[] = [];
    if (this.sources.calendar) {
      calendar = await this.sources.calendar(from, to).catch((e) => {
        failures.push(`Google Calendar: ${e.message}`);
        return [] as RawEvent[];
      });
    }

    const results: StoredDay[] = [];
    await pool(
      sorted,
      this.config.classifier.concurrency,
      async (date) => {
        opts.onStart?.(date);
        try {
          const day = await this.computeDay(date, [...claude, ...git, ...github], calendar, failures, notes, opts.signal, opts.reclassify);
          this.store.saveDay(day);
          results.push(day);
          opts.onDone?.(day);
        } catch (e) {
          if (!isAbort(e)) throw e;
        }
      },
      opts.signal,
    );
    return results;
  }

  private async computeDay(date: string, activity: RawEvent[], calendar: RawEvent[], failures: string[], notes: string[], signal?: AbortSignal, reclassify = false): Promise<StoredDay> {
    const [start, dayEnd] = dayBounds(date);
    // Today ends now: a meeting later today or a session still open is not time worked yet.
    const end = Math.max(start, Math.min(dayEnd, this.now()));
    const overlaps = (e: RawEvent) => e.end >= start && e.start < end;
    const warnings = [...failures, ...notes];
    const paths: Record<string, string> = {};
    const unknown = new Map<string, number>();
    const work: WorkEvent[] = [];
    /** Outside work scope; `project` holds the kind so personal and unassigned time stay apart. */
    const outside: WorkEvent[] = [];

    for (const e of activity.filter(overlaps)) {
      const r = this.scope.resolve(e.path);
      if (e.path) paths[e.path] = resolutionKey(r);
      const clipped = { ...e, start: Math.max(e.start, start), end: Math.min(e.end, end), ...(e.measured ? { measured: clipIntervals(e.measured, start, end) } : {}) };
      if (r.kind === 'work') work.push({ ...clipped, project: r.project });
      else if (r.kind === 'personal' && !r.system) outside.push({ ...clipped, project: 'personal' });
      else if (r.kind === 'unknown' && e.path) {
        outside.push({ ...clipped, project: 'unassigned' });
        unknown.set(e.path, (unknown.get(e.path) ?? 0) + Math.max(clipped.end - clipped.start, 15 * 60_000));
      }
    }
    for (const [p, ms] of unknown) {
      const hours = Math.ceil(ms / 360_000) / 10;
      const gh = /^github\.com\/([^/]+)\//.exec(p);
      warnings.push(
        gh
          ? `${hours}h in GitHub repo ${p.slice(11)} (not cloned here); add a scope rule, e.g. \`timesheet scope add work "github.com/${gh[1]}/**"\``
          : `${hours}h in unclassified path ${contractHome(p)}; run \`timesheet scope\``,
      );
    }

    let outOfOffice = false;
    // Out of office is judged on the whole day; meetings count only up to now.
    for (const e of calendar.filter((e) => e.end >= start && e.start < dayEnd)) {
      if (e.outOfOffice) {
        const covered = Math.min(e.end, dayEnd) - Math.max(e.start, start);
        if (covered >= OOO_MIN_HOURS * 3_600_000) outOfOffice = true;
      } else if (overlaps(e)) {
        work.push({ ...e, start: Math.max(e.start, start), end: Math.min(e.end, end), project: e.project ?? this.config.defaultProject });
      }
    }
    if (outOfOffice) warnings.push('Out of office; hours are not normalized to the target');

    const categories = categoriesFor(this.config, date);
    const blocks: Block[] = buildBlocks(work, this.config, start, end).map((b) => {
      const hint = defaultCategory(b.kind, categories);
      return { ...b, hint, allocations: [{ category: hint, fraction: 1 }], summary: blockFallback(b), items: b.items?.map((it) => ({ ...it, summary: itemFallback(it) })) };
    });

    // Not classified or booked; only shown, so the day's picture is complete. Merged across
    // gaps of up to an hour so side activity stays a few chips instead of many slivers.
    const other: OtherBlock[] = buildBlocks(outside, { ...this.config, gapMinutes: Math.max(this.config.gapMinutes, OTHER_GAP_MINUTES) }, start, end).map(({ kind: _, project, ...b }) => ({
      ...b,
      kind: project as OtherBlock['kind'],
      summary: blockFallback({ ...b, kind: 'work' }),
      items: b.items?.map((it) => ({ ...it, summary: itemFallback(it) })),
    }));

    let summary = '';
    let classifyFailed = false;
    const previous = this.store.getDay(date);
    const classifyKey = blocks.length && this.classifier ? classificationKey(blocks, categories, this.config) : undefined;
    const reuse = classifyKey && previous && !reclassify && (previous.classifyKey === classifyKey || this.classifiedBeforeMeasuring(previous, blocks)) ? previous : null;
    if (reuse) {
      // Same blocks, categories and classifier settings as last time: its answer still holds.
      const before = new Map(reuse.blocks.map((b) => [b.id, b]));
      for (const b of blocks) {
        const old = before.get(b.id)!;
        b.allocations = old.allocations;
        b.summary = old.summary;
        const items = new Map((old.items ?? []).map((it) => [it.id, it.summary]));
        for (const it of b.items ?? []) it.summary = items.get(it.id) ?? it.summary;
      }
      summary = reuse.summary;
    } else if (blocks.length && this.classifier) {
      try {
        this.log(`Classifying ${date} (${blocks.length} blocks)…`);
        const out = sanitize(await this.classifier({ date, categories, blocks, notes: this.config.classifier.notes }, { signal }), blocks, categories);
        for (const b of blocks) {
          b.allocations = out.allocations[b.id];
          b.summary = out.blockSummaries?.[b.id] ?? b.summary;
          for (const it of b.items ?? []) it.summary = out.itemSummaries?.[it.id] ?? it.summary;
        }
        summary = out.summary;
      } catch (e) {
        if (isAbort(e) || signal?.aborted) throw e;
        classifyFailed = true;
        warnings.push(`Classification: ${(e as Error).message}; booked as Development / Team Meeting`);
      }
    }
    if (!summary && blocks.length) summary = fallbackSummary(blocks);

    // Skipping the LLM for one run (--no-llm) must not freeze default categories into the cache.
    const unclassified = blocks.length > 0 && !this.classifier && this.config.classifier.enabled;
    const status = date >= this.today() ? 'today' : failures.length || unknown.size || classifyFailed || unclassified ? 'partial' : 'final';
    if (previous && JSON.stringify(previous.blocks.map((b) => [b.start, b.end])) !== JSON.stringify(blocks.map((b) => [b.start, b.end]))) {
      for (const id of this.store.blockOverrides(date).keys()) this.store.setBlockOverride(date, id, null);
    }
    const retry = failures.length > 0 || classifyFailed || unclassified;
    const counts = {
      prompts: work.filter((e) => e.source === 'claude' || e.source === 'opencode').reduce((n, e) => n + e.texts.length, 0),
      commits: work.filter((e) => e.source === 'git').length,
      github: work.filter((e) => e.source === 'github').length,
      meetings: work.filter((e) => e.source === 'calendar').length,
      repos: new Set(work.flatMap((e) => (e.path ? [repoRoot(e.path) ?? e.path] : []))).size,
    };
    return {
      date,
      status,
      computedAt: new Date().toISOString(),
      blocks,
      summary,
      warnings,
      paths,
      outOfOffice,
      computeKey: this.key,
      retry,
      activity: counts,
      other,
      ...(classifyKey && !classifyFailed ? { classifyKey } : {}),
    };
  }

  /**
   * Days computed with the same settings just before schema 5 (which only added recorded minutes)
   * carry no classification fingerprint; their answer holds if the blocks came out the same.
   */
  private classifiedBeforeMeasuring(previous: StoredDay, blocks: Block[]): boolean {
    if (previous.classifyKey || previous.computeKey !== computeKey(this.config, 4)) return false;
    if (previous.warnings.some((w) => w.startsWith('Classification:'))) return false;
    const categories = categoriesFor(this.config, previous.date);
    return classificationKey(previous.blocks, categories, this.config) === classificationKey(blocks, categories, this.config);
  }

  private seenCache: { key: string; at: number; paths: Map<string, number> } | null = null;

  /** Repos (or plain dirs outside git) seen in AI sessions over the last `days` days, with span counts. Cached for ten minutes. */
  async seenPaths(days = 60): Promise<Map<string, number>> {
    const key = `${this.today()}:${days}`;
    if (this.seenCache?.key === key && Date.now() - this.seenCache.at < 600_000) return this.seenCache.paths;
    const to = dayBounds(this.today())[1];
    const from = to - days * 86_400_000;
    const events = [
      ...(await this.sources.claude(from, to).catch(() => [] as RawEvent[])),
      ...(await this.sources.opencode(from, to).catch(() => [] as RawEvent[])),
    ];
    const paths = new Map<string, number>();
    for (const e of events) {
      if (!e.path) continue;
      const root = repoRoot(e.path) ?? e.path;
      paths.set(root, (paths.get(root) ?? 0) + 1);
    }
    this.seenCache = { key, at: Date.now(), paths };
    return paths;
  }

  /** Seen repos that no scope rule covers, optionally judged against a draft config's rules. */
  async unclassifiedPaths(days = 60, config: Config = this.config): Promise<{ path: string; sessions: number }[]> {
    const scope = config === this.config ? this.scope : new Scope(config);
    return [...(await this.seenPaths(days))]
      .filter(([p]) => scope.resolve(p).kind === 'unknown')
      .map(([path, sessions]) => ({ path, sessions }))
      .sort((a, b) => b.sessions - a.sessions);
  }
}
