import { dirname } from 'node:path';
import { categoriesFor, computeKey, contractHome, expandDirs, isHoliday, targetFor } from './config.ts';
import type { Category, Config } from './config.ts';
import { createHash } from 'node:crypto';
import { PROMPT_VERSION, blockFallback, claudeClassifier, itemFallback, defaultCategory, fallbackSummary, sanitize } from './classify.ts';
import { cleanPrompt, clipIntervals } from './collectors/spans.ts';
import type { Classifier } from './classify.ts';
import { collectCalendar, isConnected, isSignInError } from './collectors/gcal.ts';
import { collectClaude } from './collectors/claude.ts';
import { collectOpenCode } from './collectors/opencode.ts';
import { collectGit, discoverRepos, repoRoot } from './collectors/git.ts';
import { githubCollector } from './collectors/github.ts';
import type { GithubResult } from './collectors/github.ts';
import { dayBounds, daysBetween, fmtTime, today } from './dates.ts';
import { buildEntries } from './hours.ts';
import { Scope, resolutionKey } from './scope.ts';
import type { Store } from './store.ts';
import { buildBlocks, measuredMinutes } from './timeline.ts';
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
  /** Whether Google Calendar has a sign-in (default: the keychain); days that failed for lack of one wait for it. */
  calendarConnected?: () => boolean;
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

/** On a day without a target, out-of-office time this long makes the whole day off. */
const OOO_MIN_HOURS = 4;
const H = 3_600_000;
const OTHER_GAP_MINUTES = 60;
/** Today is recomputed at most this often unless refreshed explicitly. */
const TODAY_TTL_MS = 15 * 60_000;
/** A day that failed partway (source down, classifier error) is retried after this long. */
const RETRY_AFTER_MS = 5 * 60_000;
const CALENDAR_FAILURE = 'Google Calendar: ';
/**
 * A day computed before this long after its end is computed once more after it: transcripts,
 * pushes from another machine and calendar edits often land late.
 */
const SETTLE_MS = 24 * H;
/** A carried-over block category needs this much of the old block to still be in the new one. */
const CARRY_MIN_OVERLAP = 0.5;

const isAI = (e: RawEvent) => e.source === 'claude' || e.source === 'opencode';
const sessionKey = (e: RawEvent) => (e.session ? `${e.session.source}:${e.session.id}` : null);

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
    categories: categories.map((c) => [c.name, c.classify !== false, ...(c.role ? [c.role] : [])]),
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
  private calendarConnected: () => boolean;

  constructor(opts: EngineOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.scope = new Scope(opts.config);
    this.key = computeKey(opts.config);
    this.classifier = opts.classifier !== undefined ? opts.classifier : opts.config.classifier.enabled ? claudeClassifier(opts.config) : null;
    this.today = opts.today ?? today;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    let checked = { at: 0, value: false };
    // A keychain lookup per stale check would slow every report; a few seconds old is fine.
    this.calendarConnected = opts.calendarConnected ?? (() => (Date.now() - checked.at < 5_000 ? checked.value : (checked = { at: Date.now(), value: isConnected() }).value));
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
   * TODAY_TTL), it failed partway and RETRY_AFTER has passed, or it was computed before it
   * settled (SETTLE_MS after its end). A day that is partial only because of unclassified paths
   * waits for a scope change instead of re-running Claude. A locked day is never stale.
   */
  isStale(day: StoredDay, now = Date.now()): boolean {
    if (this.store.isLocked(day.date)) return false;
    if (day.computeKey !== this.key) return true;
    if (Object.entries(day.paths).some(([p, key]) => resolutionKey(this.scope.resolve(p)) !== key)) return true;
    const age = now - Date.parse(day.computedAt);
    if (day.status === 'today') return day.date < this.today() || age > TODAY_TTL_MS;
    if (day.status === 'partial') {
      if (day.retry !== false) return age > RETRY_AFTER_MS;
      // Calendar sign-in failures wait for a reconnect instead of retrying every few minutes.
      return day.warnings.some((w) => w.startsWith(CALENDAR_FAILURE) && isSignInError(w)) && this.calendarConnected();
    }
    const settled = dayBounds(day.date)[1] + SETTLE_MS;
    return Date.parse(day.computedAt) < settled && now >= settled;
  }

  /** Dates in [from, to] up to today that are missing or stale (all of them with refresh). */
  pending(from: string, to: string, refresh = false): string[] {
    return daysBetween(from, to).filter((d) => {
      if (d > this.today()) return false;
      const s = this.store.getDay(d);
      if (s && this.store.isLocked(d)) return false;
      if (refresh) return true;
      return !s || this.isStale(s);
    });
  }

  /** Reports for every day in [from, to] up to today, computing only what is missing or stale. */
  async days(from: string, to: string, opts: DaysOptions = {}): Promise<DayReport[]> {
    const dates = daysBetween(from, to).filter((d) => d <= this.today());
    const stored = new Map<string, StoredDay>();
    const missing: string[] = [];
    for (const d of dates) {
      const s = opts.refresh && !this.store.isLocked(d) ? null : this.store.getDay(d);
      if (s && !this.isStale(s)) stored.set(d, s);
      else missing.push(d);
    }
    if (missing.length) for (const s of await this.compute(missing, { reclassify: opts.refresh })) stored.set(s.date, s);
    return dates.map((d) => this.report(stored.get(d)!, opts.target));
  }

  report(day: StoredDay, targetOverride?: number): DayReport {
    const blockOverrides = this.store.blockOverrides(day.date);
    const blockCounts = this.store.blockCounts(day.date);
    const holiday = isHoliday(this.config, day.date);
    const offDay = holiday && targetOverride === undefined;
    const rules = (this.config.calendar.uncounted ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    // Texts stored before prompt cleaning improved are cleaned on the way out.
    const blocks: Block[] = day.blocks.map((b) => {
      const texts = b.texts.map((t) => (b.kind === 'work' ? cleanPrompt(t) : t)).filter((t): t is string => !!t);
      const out: Block = blockOverrides.has(b.id) ? { ...b, texts, allocations: [{ category: blockOverrides.get(b.id)!, fraction: 1 }] } : { ...b, texts };
      const byRule = b.kind === 'meeting' && rules.some((r) => (texts[0] ?? '').toLowerCase().includes(r));
      if (!offDay && (blockCounts.get(b.id) === false || (byRule && blockCounts.get(b.id) !== true))) out.uncounted = true;
      return out;
    });
    if (day.summary && day.summary === fallbackSummary(day.blocks)) day = { ...day, summary: fallbackSummary(blocks) };
    let target = day.outOfOffice ? null : targetFor(this.config, day.date, targetOverride);
    // Part of the day out of office: only the rest is expected.
    if (target !== null && targetOverride === undefined && day.oooHours) target = Math.max(0, Math.round((target - day.oooHours) * 100) / 100);
    const overrides = this.store.overrides(day.date);
    // A day off books nothing unless hours were set by hand.
    const entries = buildEntries(blocks, this.config.categories, offDay ? 0 : target, this.config.rounding, overrides);
    const measured = blocks.every((b) => b.measured !== undefined);
    const realTotal = entries.reduce((s, e) => s + e.real, 0);
    const total = Math.round(entries.reduce((s, e) => s + e.hours, 0) * 100) / 100;
    const locked = this.store.isLocked(day.date);
    const ratio = this.config.lowActivityRatio ?? 0;
    const lowActivity = day.status !== 'today' && target !== null && target > 0 && ratio > 0 && !overrides.length && realTotal < ratio * target;
    const confirmed = lowActivity && this.store.hasMark(day.date, 'confirmed');
    const flags: string[] = [];
    if (lowActivity && !confirmed)
      flags.push(
        realTotal > 0
          ? `Only ${Math.round(realTotal * 10) / 10}h of recorded work, booked as ${total}h: confirm it (\`timesheet confirm ${day.date}\`) or set the hours (\`timesheet edit\`)`
          : `No work recorded on a workday: add it to holidays if you were off, confirm it (\`timesheet confirm ${day.date}\`), or set the hours (\`timesheet edit\`)`,
      );
    const extra = entries.reduce((s, e) => s + (e.uncounted ?? 0), 0);
    if (target !== null && overrides.length && Math.abs(total - extra - target) > 1e-6) flags.push(`Booked ${total}h against a ${target}h target after your edits`);
    const warnings = offDay && realTotal > 0 && !overrides.length ? [...day.warnings, `Day off: ${Math.round(realTotal * 10) / 10}h of recorded work is not booked; set hours with \`timesheet edit\` if you worked`] : day.warnings;
    return {
      ...day,
      warnings,
      blocks,
      target,
      entries,
      realTotal,
      total,
      ...(measured ? { measuredTotal: blocks.reduce((s, b) => s + b.measured!, 0) } : {}),
      ...(locked ? { locked } : {}),
      ...(holiday ? { holiday } : {}),
      ...(lowActivity ? { lowActivity } : {}),
      ...(confirmed ? { confirmed } : {}),
      ...(flags.length ? { flags } : {}),
    };
  }

  /** Claude Code profiles currently configured; archived sessions from removed ones are not brought back. */
  private profiles(): Set<string> {
    return new Set(expandDirs(this.config.claudeDirs).map((d) => dirname(d)));
  }

  /**
   * AI sessions archived for `dates` whose transcripts are gone from the live sources: they come
   * back from the archive (with their real timing) in place of the history-only guess.
   */
  private restoreArchived(dates: string[], live: RawEvent[]): { restored: RawEvent[]; replaced: Set<RawEvent> } {
    const liveSessions = new Set(live.filter((e) => !e.fromHistory).map(sessionKey).filter((k): k is string => !!k));
    const profiles = this.profiles();
    const restored = new Map<string, RawEvent>();
    const replaced = new Set<RawEvent>();
    for (const date of dates) {
      const [start, end] = dayBounds(date);
      const back = new Set<string>();
      for (const e of this.store.evidence(date)) {
        const key = sessionKey(e);
        if (!key || liveSessions.has(key)) continue;
        if (e.source === 'claude' && e.session?.profile && !profiles.has(e.session.profile)) continue;
        if (e.source === 'opencode' && !this.config.opencodeDirs.length) continue;
        back.add(key);
        restored.set(`${key}|${e.start}|${e.end}`, e);
      }
      for (const e of live) if (e.fromHistory && back.has(sessionKey(e)!) && e.end >= start && e.start < end) replaced.add(e);
    }
    return { restored: [...restored.values()], replaced };
  }

  /** Collects all sources once for the span of `dates`, then builds, classifies and stores each day. */
  async compute(dates: string[], opts: ComputeOptions = {}): Promise<StoredDay[]> {
    const results: StoredDay[] = [];
    // Locked days keep what they have; a job asking for them is told they are done.
    for (const d of dates) {
      const kept = this.store.isLocked(d) ? this.store.getDay(d) : null;
      if (!kept) continue;
      opts.onStart?.(d);
      results.push(kept);
      opts.onDone?.(kept);
    }
    const sorted = dates.filter((d) => !results.some((r) => r.date === d)).sort();
    if (!sorted.length) return results;
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
    const liveAI = [...claudeEvents, ...opencodeEvents];
    const { restored, replaced } = this.restoreArchived(sorted, liveAI);
    if (restored.length) this.log(`Restored ${new Set(restored.map(sessionKey)).size} archived session(s) whose transcripts are gone`);
    const claude = [...liveAI.filter((e) => !replaced.has(e)), ...restored];
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
        failures.push(`${CALENDAR_FAILURE}${e.message}`);
        return [] as RawEvent[];
      });
    }

    await pool(
      sorted,
      this.config.classifier.concurrency,
      async (date) => {
        opts.onStart?.(date);
        try {
          const day = await this.computeDay(date, [...claude, ...git, ...github], calendar, failures, notes, opts.signal, opts.reclassify);
          this.store.saveDay(day);
          this.archive(date, claude);
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

  /** Keeps the day's AI-session activity (with real timing, not history guesses) for later recomputes. */
  private archive(date: string, events: RawEvent[]): void {
    const [start, end] = dayBounds(date);
    this.store.saveEvidence(date, events.filter((e) => isAI(e) && !e.fromHistory && e.end >= start && e.start < end));
  }

  /**
   * Block settings made by hand (categories, counting) follow their block when a recompute changes the
   * blocks: each goes to the new block that holds most of the old one. Returns warnings for the ones that could not follow.
   */
  private carryBlockOverrides(date: string, before: Block[], after: Block[]): string[] {
    const same = JSON.stringify(before.map((b) => [b.id, b.start, b.end])) === JSON.stringify(after.map((b) => [b.id, b.start, b.end]));
    if (same) return [];
    return [
      ...this.carry(before, after, this.store.blockOverrides(date), (id, v) => this.store.setBlockOverride(date, id, v), (c) => `"${c}"`, 'category'),
      ...this.carry(before, after, this.store.blockCounts(date), (id, v) => this.store.setBlockCount(date, id, v), (c) => (c ? '"count"' : '"don\'t count"'), 'setting'),
    ];
  }

  private carry<T extends string | boolean>(before: Block[], after: Block[], set: Map<number, T>, save: (id: number, v: T | null) => void, show: (v: T) => string, what: string): string[] {
    if (!set.size) return [];
    const warnings: string[] = [];
    const next = new Map<number, T>();
    const lost = (old: Block | undefined, v: T, why: string) =>
      warnings.push(`Your ${what} ${show(v)}${old ? ` for ${fmtTime(old.start)}–${fmtTime(old.end)}` : ''} was dropped: ${why}; check the day`);
    for (const [id, v] of set) {
      const old = before.find((b) => b.id === id);
      if (!old) {
        lost(old, v, 'its block no longer exists');
        continue;
      }
      const overlap = (b: Block) => Math.max(0, Math.min(b.end, old.end) - Math.max(b.start, old.start));
      const best = after.filter((b) => b.kind === old.kind).sort((x, y) => overlap(y) - overlap(x))[0];
      if (!best || overlap(best) < CARRY_MIN_OVERLAP * Math.min(old.end - old.start, best.end - best.start)) {
        lost(old, v, 'the activity there changed');
        continue;
      }
      if (next.has(best.id) && next.get(best.id) !== v) {
        lost(old, v, `it merged into a block you set to ${show(next.get(best.id)!)}`);
        continue;
      }
      next.set(best.id, v);
    }
    for (const id of set.keys()) if (!next.has(id)) save(id, null);
    for (const [id, v] of next) save(id, v);
    return warnings;
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
    let oooHours = 0;
    const away: [number, number][] = [];
    // Out of office is judged on the whole day; meetings count only up to now.
    for (const e of calendar.filter((e) => e.end >= start && e.start < dayEnd)) {
      if (e.outOfOffice) away.push([Math.max(e.start, start), Math.min(e.end, dayEnd)]);
      else if (e.skipped) {
        if (e.start >= start) warnings.push(e.skipped);
      } else if (overlaps(e)) {
        work.push({ ...e, start: Math.max(e.start, start), end: Math.min(e.end, end), project: e.project ?? this.config.defaultProject });
      }
    }
    if (away.length) {
      const covered = measuredMinutes(away.map(([s, e]) => ({ source: 'calendar', start: s, end: e, texts: [] })), start, dayEnd) / 60;
      const target = targetFor(this.config, date);
      // Away for (at least) the day's target: a day off. Less: the target shrinks by the time away.
      if (target === null ? covered >= OOO_MIN_HOURS : covered >= target - 1e-9) outOfOffice = true;
      else if (target !== null && covered > 0) oooHours = Math.round(covered * 100) / 100;
    }
    if (outOfOffice) warnings.push('Out of office; hours are not normalized to the target');
    else if (oooHours) warnings.push(`Out of office for ${oooHours}h; the target is lowered by that`);

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
    // Nothing to choose from until categories are set up: blocks stay under their default.
    const classifier = categories.some((c) => c.classify !== false) ? this.classifier : null;
    const classifyKey = blocks.length && classifier ? classificationKey(blocks, categories, this.config) : undefined;
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
    } else if (blocks.length && classifier) {
      try {
        this.log(`Classifying ${date} (${blocks.length} blocks)…`);
        const out = sanitize(await classifier({ date, categories, blocks, notes: this.config.classifier.notes }, { signal }), blocks, categories);
        for (const b of blocks) {
          b.allocations = out.allocations[b.id];
          b.summary = out.blockSummaries?.[b.id] ?? b.summary;
          for (const it of b.items ?? []) it.summary = out.itemSummaries?.[it.id] ?? it.summary;
        }
        summary = out.summary;
        if (out.missing?.length) {
          const when = out.missing.map((id) => blocks.find((b) => b.id === id)!).map((b) => `${fmtTime(b.start)}–${fmtTime(b.end)}`);
          warnings.push(`The classifier left out ${when.length} block(s) (${when.join(', ')}); they are booked as their default category: check them or recompute with --refresh`);
        }
      } catch (e) {
        if (isAbort(e) || signal?.aborted) throw e;
        classifyFailed = true;
        warnings.push(`Classification: ${(e as Error).message}; booked under the default categories`);
      }
    }
    if (!summary && blocks.length) summary = fallbackSummary(blocks);

    // Skipping the LLM for one run (--no-llm) must not freeze default categories into the cache.
    const unclassified = blocks.length > 0 && !this.classifier && this.config.classifier.enabled;
    const status = date >= this.today() ? 'today' : failures.length || unknown.size || classifyFailed || unclassified ? 'partial' : 'final';
    if (previous) warnings.push(...this.carryBlockOverrides(date, previous.blocks, blocks));
    const retry = failures.some((f) => !(f.startsWith(CALENDAR_FAILURE) && isSignInError(f))) || classifyFailed || unclassified;
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
      ...(oooHours ? { oooHours } : {}),
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
