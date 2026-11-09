import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Config } from '../config.ts';
import { addDays, daysBetween, weekStart } from '../dates.ts';
import type { Store, SubmitRun, SubmitRunStatus } from '../store.ts';
import type { DayReport } from '../types.ts';
import { alive } from '../jobs.ts';
import { Abort, type Adapter, Failed, type Protection, sleep } from './adapter.ts';
import { diff, fingerprint as planFingerprint } from './diff.ts';
import { INSPECT_DIR } from './inspect.ts';
import { buildPlan, cellKey, cents, describeTarget } from './plan.ts';
import { netsuite } from './netsuite.ts';
import { redmine } from './redmine.ts';
import type { SubmitSession } from './session.ts';
import type { Cell, Held, Plan, Snapshot, SubmitRule, SystemId } from './types.ts';

export type LabeledCell = Cell<object> & { label: string };

interface Base {
  system: SystemId;
  week: string;
}

export type PrepareResult = Base &
  (
    | { state: 'login'; reason: string }
    | { state: 'blocked'; reasons: string[] }
    | { state: 'aborted'; reason: string; screenshots: string[] }
    | ({ state: 'conflict'; reasons: string[] } & Compared)
    | ({ state: 'noop' } & Compared)
    | ({ state: 'ready'; write: LabeledCell[]; unchanged: number; fingerprint: string; fillOnly: boolean } & Compared)
  );

/** The plan next to what the site holds, as the user reviews it. */
export interface Compared {
  plan: LabeledCell[];
  site: LabeledCell[];
  notes: string[];
  /** Days not written because the site holds other hours there (date → why) */
  held: Held;
  /** Days the site no longer lets change (date → why) */
  frozen: Record<string, string>;
  /** Days off in the timesheet: nothing booked */
  off: string[];
}

export type CheckWeekState = 'pending' | 'reading' | 'ready' | 'noop' | 'conflict' | 'blocked' | 'failed';

/** One week of a check: what the site holds, what the timesheet books and what would be written. */
export interface CheckWeek extends Compared {
  week: string;
  state: CheckWeekState;
  write: LabeledCell[];
  /** Why the week cannot be entered (blocked, conflict, failed) */
  reasons: string[];
}

/**
 * The first step of entering a range: the site is read (read-only) week by week and compared with
 * the timesheet. Entering requires its token, and enters exactly what it showed.
 */
export interface CheckProgress {
  id: string;
  system: SystemId;
  from: string;
  to: string;
  fillOnly: boolean;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** Waiting for the user to log in in the browser window */
  login: boolean;
  message: string;
  weeks: CheckWeek[];
  /** Set when done: starting a run requires it */
  token?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** How long a check stays valid for starting a run. */
export const CHECK_VALID_MS = 30 * 60_000;

export type UnitState = 'pending' | 'working' | 'waiting' | 'saved' | 'failed' | 'aborted';

/** One week of a run: checked, then skipped (nothing to do or cannot be entered) or entered. */
export type WeekState = 'pending' | 'checking' | 'entering' | 'done' | 'skipped' | 'saved' | 'failed' | 'aborted';

export interface WeekProgress {
  week: string;
  state: WeekState;
  /** Why it was skipped, what was left as it is (approved days), or what went wrong */
  detail: string[];
  /** Cells entered (or being entered) this run */
  cells: LabeledCell[];
}

/** One week's plan for a range, as shown before entering. */
export type RangeWeekPlan = { week: string } & ({ ok: true; cells: LabeledCell[]; notes: string[] } | { ok: false; reasons: string[] });

export interface RangePlan {
  system: SystemId;
  from: string;
  to: string;
  fillOnly: boolean;
  weeks: RangeWeekPlan[];
  /** Identifies exactly these plans: starting a run requires it, so it enters what was shown */
  token: string;
}

export interface RunProgress {
  id: string;
  system: SystemId;
  /** First week of the run */
  week: string;
  /** Days the run enters (a week, or a month) */
  from: string;
  to: string;
  weeks: WeekProgress[];
  fillOnly: boolean;
  status: SubmitRunStatus;
  /** What is happening now, or the outcome */
  message: string;
  units: { unit: string; state: UnitState; cells: LabeledCell[] }[];
  error?: string;
  screenshots: string[];
  startedAt: string;
  finishedAt?: string;
}

/** Another step (prepare, discover or a run) is using the browser. */
export class Busy extends Error {
  name = 'Busy';
}

export interface RunDeps {
  store: Store;
  config(): Config;
  today(): string;
  /** The week's days that may be submitted; `outdated` explains days left out (date → reason). */
  reports(week: string): Promise<{ reports: DayReport[]; outdated?: Map<string, string> }>;
  session: SubmitSession;
  adapters?: Partial<Record<SystemId, Adapter<any, any>>>;
  /** Screenshots go to <dir>/<system>/runs (default ~/.timesheet/inspect) */
  screenshotDir?: string;
  /** How long fill-only waits for the user to press Update/Save */
  userTimeoutMs?: number;
  /** Clock (ms), for tests */
  now?(): number;
  /** How long a run waits for the user to log in (default 10 min) */
  loginWaitMs?: number;
  /** How often a waiting run looks whether the user has logged in (default 1.5 s) */
  loginPollMs?: number;
}

/** The longest range one run enters. */
export const MAX_RANGE_DAYS = 62;

export interface PrepareOptions {
  /** Days that count (default: the whole week) */
  inScope?: (date: string) => boolean;
  /** Wait for the user to log in instead of returning 'login'; gets the text to show meanwhile */
  waitLogin?: (msg: string) => void;
}

/** Mondays of the weeks with a day in [from, to]. */
export function weeksBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = weekStart(from); w <= to; w = addDays(w, 7)) out.push(w);
  return out;
}

/** The sign-in is done when the tab is back on the site, off its login pages. */
function landed(raw: string, siteUrl: string): boolean {
  try {
    const u = new URL(raw);
    return u.origin === new URL(siteUrl).origin && !/login|saml|sso|signin|oauth/i.test(u.pathname);
  } catch {
    return false;
  }
}

const NOT_ENABLED: Partial<Record<SystemId, string>> = {};
const SITE: Record<SystemId, string> = { redmine: 'Redmine', netsuite: 'NetSuite' };

/** After a failed run, the same week is neither prepared nor entered for this long: the site needs a look by hand first. */
export const FAILED_COOLDOWN_MS = 5 * 60_000;
export const INTERRUPTED = 'interrupted (timesheet stopped during the run) — check the site by hand';

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Ctrl+C during \`submit week\`: the first one cancels the run (nothing more is pressed); later ones
 * never quit the process, since an Update may be in flight: the run settles and reports first.
 */
export function interruptHandler(runner: { cancel(): unknown }, log: (msg: string) => void): () => void {
  let count = 0;
  return () => {
    if (count++ === 0) {
      log('\nCancelling: nothing more is pressed; the run stops at its next check and reports what was saved.');
      runner.cancel();
    } else log('\nStill stopping: an Update may be in flight, so timesheet is waiting for the run to settle and report.');
  };
}

/**
 * One system, one week: prepare (plan, login, read, diff) and execute (re-prepare, require the
 * reviewed fingerprint, then apply unit by unit). Only one step uses the browser at a time.
 */
export class SubmitRunner {
  private readonly deps: RunDeps;
  private readonly adapters: Partial<Record<SystemId, Adapter<any, any>>>;
  private readonly pages = new Map<SystemId, Page>();
  private lock: string | null = null;
  private controller: AbortController | null = null;
  private current: RunProgress | null = null;
  private finished: Promise<RunProgress> | null = null;
  private checking: CheckProgress | null = null;
  private checkDone: Promise<CheckProgress> | null = null;
  private protection: { page: Page; handle: Protection } | null = null;

  constructor(deps: RunDeps) {
    this.deps = deps;
    this.adapters = deps.adapters ?? { redmine, netsuite };
    // A run left "running" by a process that is gone was cut off midway: the site may hold part of it.
    for (const r of deps.store.submitRuns()) {
      if (r.status === 'running' && !alive(r.pid)) this.deps.store.saveSubmitRun({ ...r, status: 'failed', error: r.error ? `${INTERRUPTED}\n${r.error}` : INTERRUPTED, pid: undefined, updatedAt: new Date(this.now()).toISOString() });
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Why the week may not be prepared or entered now (a recent failure), or null. */
  private cooldown(system: SystemId, week: string): string | null {
    const failed = this.deps.store.submitRuns(system, week).find((r) => r.status === 'failed');
    if (!failed) return null;
    const at = Date.parse(failed.updatedAt);
    if (!Number.isFinite(at) || this.now() - at >= FAILED_COOLDOWN_MS) return null;
    return `the last run failed at ${hhmm(at)}; check ${SITE[system]} and retry after ${hhmm(at + FAILED_COOLDOWN_MS)}`;
  }

  /** Blocks requests that would change the site while this step uses the page (one page at a time). */
  private async protect(adapter: Adapter<any, any>, page: Page, url: string): Promise<void> {
    if (!adapter.protect || this.protection?.page === page) return;
    await this.unprotect();
    this.protection = { page, handle: await adapter.protect(page, url) };
  }

  private async unprotect(): Promise<void> {
    const p = this.protection;
    this.protection = null;
    await p?.handle.dispose().catch(() => {});
  }

  /** Throws Abort when a request that would change the site was blocked. */
  private checkProtection(): void {
    const problem = this.protection?.handle.problem();
    if (problem) throw new Abort(problem);
  }

  /** The run in progress, or the last one of this process. */
  progress(): RunProgress | null {
    return this.current ? structuredClone(this.current) : null;
  }

  get running(): boolean {
    return this.current?.status === 'running' || this.checking?.status === 'running';
  }

  /** The check in progress, or the last one of this process. */
  checkProgress(): CheckProgress | null {
    return this.checking ? structuredClone(this.checking) : null;
  }

  /** Resolves when the current check ends (immediately with null when there is none). */
  waitCheck(): Promise<CheckProgress | null> {
    return this.checkDone ?? Promise.resolve(null);
  }

  /** Resolves when the current run ends (immediately with null when there is none). */
  wait(): Promise<RunProgress | null> {
    return this.finished ?? Promise.resolve(null);
  }

  cancel(): RunProgress | null {
    if (this.checking?.status === 'running') {
      this.checking.message = 'Cancelling the check';
      this.controller?.abort();
    }
    if (this.current?.status === 'running') {
      this.current.message = 'Cancelling: nothing more is pressed';
      this.controller?.abort();
    }
    return this.progress();
  }

  adapter(system: SystemId): Adapter<any, any> | null {
    return NOT_ENABLED[system] ? null : (this.adapters[system] ?? null);
  }

  private async exclusive<T>(what: string, fn: () => Promise<T>): Promise<T> {
    if (this.lock) throw new Busy(`busy: ${this.lock} is still running`);
    this.lock = what;
    try {
      return await fn();
    } finally {
      this.lock = null;
    }
  }

  /** The tab this system works in: kept between steps, replaced when the user closed it. */
  private async page(system: SystemId): Promise<Page> {
    const session = await this.deps.session.ensure();
    const known = this.pages.get(system);
    if (known && !known.isClosed() && known.context() === session.context) return known;
    const taken = new Set([...this.pages.values()].filter((p) => !p.isClosed()));
    const page = !session.page.isClosed() && !taken.has(session.page) ? session.page : await session.context.newPage();
    this.pages.set(system, page);
    return page;
  }

  private async screenshot(page: Page | undefined, system: SystemId, label: string): Promise<string[]> {
    if (!page || page.isClosed()) return [];
    const dir = join(this.deps.screenshotDir ?? INSPECT_DIR, system, 'runs');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^a-z0-9-]+/gi, '-')}.png`);
      await page.screenshot({ path, fullPage: true, timeout: 10_000 });
      return [path];
    } catch {
      return [];
    }
  }

  /**
   * After the site holds the week's hours, its past days are locked: a later settings change or
   * recompute can no longer move hours away from what was entered. `timesheet unlock` undoes it.
   */
  private lockWeek(system: SystemId, week: string, inScope: (date: string) => boolean = () => true, held: Held = {}): void {
    for (const d of daysBetween(week, addDays(week, 6))) {
      if (inScope(d) && !held[d] && d < this.deps.today() && this.deps.store.getDay(d) && !this.deps.store.isLocked(d)) this.deps.store.setMark(d, 'locked', true, `entered in ${system}`);
    }
  }

  private record(r: Omit<SubmitRun, 'createdAt' | 'updatedAt'> & { createdAt?: string }): void {
    const now = new Date(this.now()).toISOString();
    this.deps.store.saveSubmitRun({ ...r, createdAt: r.createdAt ?? now, updatedAt: now });
  }

  /** Reads what the site offers and stores it as the system's catalog. */
  async discover(system: SystemId): Promise<{ state: 'login'; reason: string } | { state: 'ok'; catalog: unknown; discoveredAt: string }> {
    const adapter = this.adapter(system);
    if (!adapter) throw new Abort(NOT_ENABLED[system] ?? `${system} is not supported`);
    const url = this.deps.config().submit[system].url;
    if (!url) throw new Abort(`set the ${system} address in Settings → Submission first`);
    return this.exclusive('discovery', async () => {
      try {
        const page = await this.page(system);
        await this.protect(adapter, page, url);
        const login = await adapter.checkLogin(page, url);
        this.checkProtection();
        if (!login.ok) {
          await page.bringToFront().catch(() => {});
          return { state: 'login' as const, reason: login.reason };
        }
        const catalog = await adapter.discover(page, url);
        this.checkProtection();
        const at = new Date().toISOString();
        this.deps.store.saveSubmitCatalog(system, catalog, at);
        return { state: 'ok' as const, catalog, discoveredAt: at };
      } finally {
        await this.unprotect();
      }
    });
  }

  /** Plans the week, checks the login, reads the site and compares: what the user reviews. */
  async prepare(system: SystemId, week: string): Promise<PrepareResult> {
    if (this.running) throw new Busy('a submission is running');
    return this.exclusive('a preparation', async () => {
      try {
        return await this.prepareInner(system, week, true);
      } finally {
        await this.unprotect();
      }
    });
  }

  /**
   * Checks the login; with `onWait`, a session that is not logged in waits (in the same tab, without
   * reloading it) for the user to log in, then checks again.
   */
  private async login(adapter: Adapter<any, any>, page: Page, url: string, signal?: AbortSignal, onWait?: (msg: string) => void): Promise<{ ok: true; user: string } | { ok: false; reason: string }> {
    let login = await adapter.checkLogin(page, url);
    if (login.ok || !onWait) return login;
    const site = SITE[adapter.system];
    await page.bringToFront().catch(() => {});
    const end = Date.now() + (this.deps.loginWaitMs ?? 10 * 60_000);
    onWait(`Waiting for you to log in to ${site} in the browser window; it continues by itself`);
    while (Date.now() < end) {
      await sleep(this.deps.loginPollMs ?? 1500, signal);
      this.checkProtection();
      if (page.isClosed()) return { ok: false, reason: `the ${site} window was closed before logging in` };
      if (!landed(page.url(), url)) continue;
      login = await adapter.checkLogin(page, url);
      if (login.ok) return login;
    }
    return { ok: false, reason: `${login.reason} (waited ${Math.round((this.deps.loginWaitMs ?? 600_000) / 60_000)} min)` };
  }

  private async prepareInner(system: SystemId, week: string, record: boolean, signal?: AbortSignal, opts: PrepareOptions = {}): Promise<PrepareResult> {
    if (weekStart(week) !== week) throw new Abort(`${week} is not a Monday`);
    const base = { system, week };
    const adapter = this.adapter(system);
    const cfg = this.deps.config().submit[system];
    const runBase = { system, week, fillOnly: cfg.fillOnly, screenshots: [] as string[] };
    const blocked = (reasons: string[]): PrepareResult => {
      if (record) this.record({ id: randomUUID(), ...runBase, status: 'blocked', error: reasons.join('\n') });
      return { ...base, state: 'blocked', reasons };
    };
    if (!adapter) return blocked([NOT_ENABLED[system] ?? `${system} is not supported`]);
    if (!cfg.url) return blocked([`set the ${system} address in Settings → Submission first`]);
    const wait = record ? this.cooldown(system, week) : null;
    if (wait) return blocked([wait]);

    const { reports, outdated } = await this.deps.reports(week);
    const stored = this.deps.store.submitCatalog(system);
    let catalog: unknown = stored && adapter.sameSite(stored.data, cfg.url) ? stored.data : null;
    const plan = () => {
      const result = buildPlan({ system, week, reports, today: this.deps.today(), rules: cfg.rules as SubmitRule<object>[], inScope: opts.inScope, exists: catalog ? (t) => adapter.exists(catalog, t) : undefined });
      if (result.ok) return result;
      const reasons = result.reasons.map((r) => {
        const date = r.slice(0, 10);
        return r === `${date}: not computed yet` && outdated?.has(date) ? `${date}: ${outdated.get(date)}` : r;
      });
      return { ok: false as const, reasons };
    };
    let planned = plan();
    if (!planned.ok) return blocked(planned.reasons);

    let page: Page | undefined;
    try {
      page = await this.page(system);
      await this.protect(adapter, page, cfg.url);
      const login = await this.login(adapter, page, cfg.url, signal, opts.waitLogin);
      this.checkProtection();
      if (!login.ok) {
        await page.bringToFront().catch(() => {});
        return { ...base, state: 'login', reason: login.reason };
      }
      if (!catalog) {
        catalog = await adapter.discover(page, cfg.url);
        this.deps.store.saveSubmitCatalog(system, catalog);
        planned = plan();
        if (!planned.ok) return blocked(planned.reasons);
      }
      const expected = adapter.catalogUser(catalog);
      if (expected !== login.user) return blocked([`logged in as "${login.user}", but the mapping was read for "${expected}": log in as ${expected}, or Refresh from site in Settings → Submission`]);
      if (signal?.aborted) throw new Abort('cancelled');

      const snapshot: Snapshot<object> = await adapter.read(page, catalog, week, signal);
      this.checkProtection();
      const p: Plan<object> = planned.plan;
      const label = (cells: Cell<object>[]): LabeledCell[] => cells.map((c) => ({ ...c, label: adapter.label(catalog, c.target) }));
      const d = diff(p, snapshot, opts.inScope);
      const shown: Compared = { plan: label(p.cells), site: label(snapshot.cells), notes: d.kind === 'conflict' ? p.notes : [...p.notes, ...d.skipped], held: d.held ?? {}, frozen: snapshot.frozen ?? {}, off: p.off ?? [] };
      const fp = `${planFingerprint(p, snapshot)}${cfg.fillOnly ? 'f' : 's'}`;
      const status: SubmitRunStatus = d.kind === 'write' ? 'ready' : d.kind;
      if (record) this.record({ id: randomUUID(), ...runBase, status, fingerprint: fp, plan: p, before: snapshot, ...(d.kind === 'conflict' ? { error: d.reasons.join('\n') } : {}) });
      if (d.kind === 'conflict') return { ...base, state: 'conflict', reasons: d.reasons, ...shown };
      if (d.kind === 'noop') {
        if (record) this.lockWeek(system, week, opts.inScope, shown.held);
        return { ...base, state: 'noop', ...shown };
      }
      return { ...base, state: 'ready', ...shown, write: label(d.cells), unchanged: d.unchanged, fingerprint: fp, fillOnly: cfg.fillOnly };
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      const screenshots = await this.screenshot(page, system, 'prepare');
      if (record) this.record({ id: randomUUID(), ...runBase, status: 'aborted', error: e.message, screenshots });
      return { ...base, state: 'aborted', reason: e.message, screenshots };
    }
  }

  /**
   * Starts entering the reviewed week. The site and plan are read again first and must give the
   * same fingerprint; then each unit is applied in order and verified. Stops at the first problem.
   */
  execute(system: SystemId, week: string, fingerprint: string): RunProgress {
    if (this.lock || this.running) throw new Busy(`busy: ${this.lock ?? 'a submission'} is still running`);
    if (weekStart(week) !== week) throw new Abort(`${week} is not a Monday`);
    if (!/^[0-9a-f]{16}[fs]$/.test(fingerprint)) throw new Abort('invalid confirmation: prepare again');
    const adapter = this.adapter(system);
    if (!adapter) throw new Abort(NOT_ENABLED[system] ?? `${system} is not supported`);
    const wait = this.cooldown(system, week);
    if (wait) throw new Abort(wait);
    const fillOnly = this.deps.config().submit[system].fillOnly;
    const progress: RunProgress = { id: randomUUID(), system, week, from: week, to: addDays(week, 6), weeks: [], fillOnly, status: 'running', message: 'Checking the site again', units: [], screenshots: [], startedAt: new Date().toISOString() };
    this.current = progress;
    this.controller = new AbortController();
    this.lock = 'a submission';
    const signal = this.controller.signal;
    this.finished = this.run(adapter, progress, fingerprint, signal).finally(() => {
      this.lock = null;
    });
    return this.progress()!;
  }

  private async run(adapter: Adapter<any, any>, progress: RunProgress, fingerprint: string, signal: AbortSignal): Promise<RunProgress> {
    const { system, week, fillOnly } = progress;
    const created = progress.startedAt;
    let plan: unknown;
    let before: unknown;
    const written: Cell<object>[] = [];
    const after: Cell<object>[] = [];
    const save = () =>
      this.record({ id: progress.id, system, week, status: progress.status, fillOnly, fingerprint, plan, before, written, after, ...(progress.error ? { error: progress.error } : {}), screenshots: progress.screenshots, ...(progress.status === 'running' ? { pid: process.pid } : {}), createdAt: created });
    save();
    let applying = false;
    let page: Page | undefined;
    let held: Held = {};
    try {
      const prep = await this.prepareInner(system, week, false, signal);
      if (prep.state === 'aborted') {
        progress.screenshots.push(...prep.screenshots);
        throw new Abort(prep.reason);
      }
      if (prep.state === 'login') throw new Abort(`${prep.reason}; nothing written`);
      if (prep.state === 'blocked' || prep.state === 'conflict') throw new Abort(`changed since the review: ${prep.reasons.join('; ')}; nothing written`);
      if (prep.state === 'noop') throw new Abort('changed since the review: everything is already entered; nothing written');
      if (prep.fingerprint !== fingerprint) throw new Abort('the site or the timesheet changed since the review; prepare again (nothing written)');
      plan = prep.plan;
      before = prep.site;
      held = prep.held;
      const catalog = this.deps.store.submitCatalog(system)?.data;
      if (!catalog) throw new Abort('the catalog disappeared; prepare again');
      page = await this.page(system);
      const unitOf = (c: Cell<object>) => adapter.unitOf(week, c);
      progress.units = adapter.units(week, prep.write).map((unit) => ({ unit, state: 'pending' as UnitState, cells: prep.write.filter((c) => unitOf(c) === unit) }));
      save();
      await this.protect(adapter, page, this.deps.config().submit[system].url);
      for (const u of progress.units) {
        this.checkProtection();
        if (signal.aborted) throw new Abort('cancelled; nothing more was entered');
        u.state = 'working';
        applying = true;
        const strip = (cells: LabeledCell[]) => cells.map(({ label: _label, ...c }) => c);
        const result: Cell<object>[] = await adapter.apply(page, catalog, u.unit, { write: strip(u.cells), before: strip(prep.site.filter((c) => unitOf(c) === u.unit)) }, {
          save: !fillOnly,
          signal,
          userTimeoutMs: this.deps.userTimeoutMs,
          onState: (msg) => {
            progress.message = msg;
            if (/press Update|press Save/.test(msg)) u.state = 'waiting';
          },
        });
        applying = false;
        u.state = 'saved';
        written.push(...strip(u.cells));
        after.push(...result);
        save();
      }
      this.checkProtection();
      progress.status = 'saved';
      this.lockWeek(system, week, undefined, held);
      progress.message = fillOnly ? 'Saved by you and verified' : 'Saved and verified';
    } catch (e) {
      const failed = e instanceof Failed || (applying && !(e instanceof Abort));
      progress.status = failed ? 'failed' : 'aborted';
      const saved = progress.units.filter((u) => u.state === 'saved').map((u) => u.unit);
      progress.error = `${(e as Error).message}${saved.length && !failed ? ` (already saved and verified: ${saved.join(', ')})` : ''}`;
      progress.message = failed ? 'Failed: check the site by hand' : 'Stopped';
      const u = progress.units.find((x) => x.state === 'working' || x.state === 'waiting');
      if (u) u.state = failed ? 'failed' : 'aborted';
      progress.screenshots.push(...(await this.screenshot(page ?? this.pages.get(system), system, u?.unit ?? 'run')));
    }
    await this.unprotect();
    progress.finishedAt = new Date().toISOString();
    save();
    return structuredClone(progress);
  }

  /** Validates a range to enter: real dates, in order, at most MAX_RANGE_DAYS days. */
  private static range(from: string, to: string): void {
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
    if (!ok(from) || !ok(to)) throw new Abort('from and to must be dates (YYYY-MM-DD)');
    if (from > to) throw new Abort(`${from} is after ${to}`);
    if (daysBetween(from, to).length > MAX_RANGE_DAYS) throw new Abort(`at most ${MAX_RANGE_DAYS} days at once`);
  }

  /**
   * What entering [from, to] would write, week by week, from the timesheet alone (the site is not
   * read): days outside the range are left out. The token identifies exactly these plans.
   */
  async planRange(system: SystemId, from: string, to: string): Promise<RangePlan> {
    SubmitRunner.range(from, to);
    const cfg = this.deps.config().submit[system];
    const adapter = this.adapter(system);
    const stored = this.deps.store.submitCatalog(system);
    const catalog = adapter && cfg.url && stored && adapter.sameSite(stored.data, cfg.url) ? stored.data : null;
    const inScope = (d: string) => d >= from && d <= to;
    const weeks: RangeWeekPlan[] = [];
    for (const week of weeksBetween(from, to)) {
      if (!adapter) {
        weeks.push({ week, ok: false, reasons: [NOT_ENABLED[system] ?? `${system} is not supported`] });
        continue;
      }
      if (!cfg.url) {
        weeks.push({ week, ok: false, reasons: [`set the ${system} address in Settings → Submission first`] });
        continue;
      }
      const { reports, outdated } = await this.deps.reports(week);
      const result = buildPlan({ system, week, reports, today: this.deps.today(), rules: cfg.rules as SubmitRule<object>[], inScope, exists: catalog ? (t) => adapter.exists(catalog, t) : undefined });
      if (!result.ok) {
        const reasons = result.reasons.map((r) => {
          const date = r.slice(0, 10);
          return r === `${date}: not computed yet` && outdated?.has(date) ? `${date}: ${outdated.get(date)}` : r;
        });
        weeks.push({ week, ok: false, reasons });
        continue;
      }
      weeks.push({ week, ok: true, cells: result.plan.cells.map((c) => ({ ...c, label: catalog ? adapter.label(catalog, c.target) : describeTarget(system, c.target) })), notes: result.plan.notes });
    }
    const token = createHash('sha256')
      .update(JSON.stringify({ system, from, to, fillOnly: cfg.fillOnly, weeks: weeks.map((w) => (w.ok ? [w.week, cellsKey(w.cells)] : [w.week, w.reasons])) }))
      .digest('hex')
      .slice(0, 16);
    return { system, from, to, fillOnly: cfg.fillOnly, weeks, token };
  }

  /**
   * The first step of entering [from, to]: opens the site (waiting for the login when needed) and reads
   * every week that can be planned, read-only, comparing it with the timesheet. Runs in the background;
   * `checkProgress()` shows it. Nothing is written.
   */
  async check(system: SystemId, from: string, to: string): Promise<CheckProgress> {
    if (this.lock || this.running) throw new Busy(`busy: ${this.lock ?? 'a submission'} is still running`);
    SubmitRunner.range(from, to);
    const adapter = this.adapter(system);
    if (!adapter) throw new Abort(NOT_ENABLED[system] ?? `${system} is not supported`);
    this.lock = 'a check';
    try {
      const plan = await this.planRange(system, from, to);
      const empty = { plan: [], site: [], write: [], notes: [], reasons: [], held: {}, frozen: {}, off: [] };
      const progress: CheckProgress = {
        id: randomUUID(), system, from, to, fillOnly: plan.fillOnly, status: 'running', login: false, message: `Opening ${SITE[system]}`, startedAt: new Date(this.now()).toISOString(),
        weeks: plan.weeks.map((w): CheckWeek => (w.ok ? { ...empty, week: w.week, state: 'pending', plan: w.cells, notes: w.notes } : { ...empty, week: w.week, state: 'blocked', reasons: w.reasons })),
      };
      this.checking = progress;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.checkDone = this.runCheck(progress, signal).finally(() => {
        this.lock = null;
      });
      return this.checkProgress()!;
    } catch (e) {
      this.lock = null;
      throw e;
    }
  }

  private async runCheck(progress: CheckProgress, signal: AbortSignal): Promise<CheckProgress> {
    const { system, from, to } = progress;
    const inScope = (d: string) => d >= from && d <= to;
    const site = SITE[system];
    try {
      for (const w of progress.weeks) {
        if (w.state !== 'pending') continue;
        if (signal.aborted) throw new Abort('cancelled');
        w.state = 'reading';
        progress.message = `Reading the week of ${w.week} in ${site}`;
        const prep = await this.prepareInner(system, w.week, false, signal, {
          inScope,
          waitLogin: (msg) => {
            progress.login = true;
            progress.message = msg;
          },
        });
        progress.login = false;
        if (prep.state === 'login') throw new Abort(prep.reason);
        if (prep.state === 'aborted') {
          if (signal.aborted) throw new Abort('cancelled');
          Object.assign(w, { state: 'failed', reasons: [prep.reason, ...prep.screenshots.map((x) => `Screenshot: ${x}`)] });
          continue;
        }
        if (prep.state === 'blocked') {
          Object.assign(w, { state: 'blocked', reasons: prep.reasons });
          continue;
        }
        Object.assign(w, { plan: prep.plan, site: prep.site, notes: prep.notes, held: prep.held, frozen: prep.frozen, off: prep.off });
        if (prep.state === 'conflict') Object.assign(w, { state: 'conflict', reasons: prep.reasons });
        else if (prep.state === 'noop') w.state = 'noop';
        else Object.assign(w, { state: 'ready', write: prep.write });
      }
      progress.token = checkToken(progress);
      progress.status = 'done';
      const n = (st: CheckWeekState) => progress.weeks.filter((w) => w.state === st).length;
      const parts = [n('ready') && `${n('ready')} to enter`, n('noop') && `${n('noop')} already entered`, n('conflict') + n('blocked') + n('failed') && `${n('conflict') + n('blocked') + n('failed')} not entered`].filter(Boolean);
      progress.message = `Checked ${site}: ${parts.join(', ') || 'nothing to do'}`;
    } catch (e) {
      const cancelled = signal.aborted;
      progress.status = cancelled ? 'cancelled' : 'failed';
      progress.login = false;
      progress.error = cancelled ? undefined : (e as Error).message;
      progress.message = cancelled ? 'Check cancelled; nothing was entered' : `Could not check ${site}; nothing was entered`;
      for (const w of progress.weeks) if (w.state === 'reading') w.state = 'pending';
    } finally {
      await this.unprotect();
    }
    progress.finishedAt = new Date(this.now()).toISOString();
    return structuredClone(progress);
  }

  /**
   * Enters what the last check showed, week by week: `token` must be that check's, and each week to
   * enter is read again and must still match it exactly. Weeks the check found nothing to enter in
   * are not opened. Any problem while entering stops the whole run. Submit is never pressed.
   */
  async start(system: SystemId, from: string, to: string, token: string): Promise<RunProgress> {
    if (this.lock || this.running) throw new Busy(`busy: ${this.lock ?? 'a submission'} is still running`);
    if (!/^[0-9a-f]{16}$/.test(token)) throw new Abort('invalid confirmation: check the site first');
    const adapter = this.adapter(system);
    if (!adapter) throw new Abort(NOT_ENABLED[system] ?? `${system} is not supported`);
    const c = this.checking;
    if (!c || c.status !== 'done' || c.system !== system || c.from !== from || c.to !== to || c.token !== token) throw new Abort('this is not what the last check showed; check again (nothing entered)');
    if (this.now() - Date.parse(c.finishedAt ?? '') > CHECK_VALID_MS) throw new Abort(`the check is more than ${CHECK_VALID_MS / 60_000} minutes old; check again (nothing entered)`);
    if (this.deps.config().submit[system].fillOnly !== c.fillOnly) throw new Abort('fill-only changed since the check; check again (nothing entered)');
    this.lock = 'a submission';
    try {
      const progress: RunProgress = {
        id: randomUUID(), system, week: c.weeks[0]!.week, from, to, fillOnly: c.fillOnly, status: 'running', message: 'Starting',
        weeks: c.weeks.map((w) => ({ week: w.week, state: 'pending', detail: [], cells: w.write })), units: [], screenshots: [], startedAt: new Date().toISOString(),
      };
      this.current = progress;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.finished = this.runRange(adapter, progress, structuredClone(c), signal).finally(() => {
        this.lock = null;
      });
      return this.progress()!;
    } catch (e) {
      this.lock = null;
      throw e;
    }
  }

  private async runRange(adapter: Adapter<any, any>, progress: RunProgress, checked: CheckProgress, signal: AbortSignal): Promise<RunProgress> {
    const { system, fillOnly, from, to } = progress;
    const inScope = (d: string) => d >= from && d <= to;
    const site = SITE[system];
    let stop = false;
    for (const [i, wp] of progress.weeks.entries()) {
      const shown = checked.weeks[i]!;
      const week = wp.week;
      const id = randomUUID();
      const created = new Date(this.now()).toISOString();
      let page: Page | undefined;
      let applying = false;
      let recorded = false;
      let before: unknown;
      const written: Cell<object>[] = [];
      const after: Cell<object>[] = [];
      const save = (status: SubmitRunStatus, error?: string) => {
        recorded = true;
        this.record({ id, system, week, status, fillOnly, plan: shown, before, written, after, ...(error ? { error } : {}), screenshots: progress.screenshots, ...(status === 'running' ? { pid: process.pid } : {}), createdAt: created });
      };
      const skip = (state: WeekState, detail: string[]) => {
        wp.state = state;
        wp.detail = detail;
      };
      try {
        if (signal.aborted) throw new Abort('cancelled');
        wp.state = 'checking';
        progress.units = [];
        progress.message = `Week of ${week}: opening ${site}`;
        const heldLines = (held: Held) => Object.values(held).flat();
        const dated = (notes: string[]) => notes.filter((n) => /^\d{4}-\d{2}-\d{2}: /.test(n));
        if (shown.state === 'blocked' || shown.state === 'failed' || shown.state === 'pending' || shown.state === 'reading') {
          skip('skipped', shown.reasons.length ? shown.reasons : ['not checked']);
          continue;
        }
        if (shown.state === 'conflict') {
          skip('skipped', [`${site} already holds other hours; nothing entered in this week:`, ...shown.reasons]);
          continue;
        }
        if (shown.state === 'noop') {
          skip('done', [`already in ${site}`, ...dated(shown.notes), ...heldLines(shown.held)]);
          this.lockWeek(system, week, inScope, shown.held);
          continue;
        }
        const wait = this.cooldown(system, week);
        if (wait) {
          skip('skipped', [wait]);
          continue;
        }
        const prep = await this.prepareInner(system, week, false, signal, {
          inScope,
          waitLogin: (msg) => {
            progress.message = msg;
          },
        });
        if (prep.state === 'aborted') {
          progress.screenshots.push(...prep.screenshots);
          throw new Abort(`week of ${week}: ${prep.reason}`);
        }
        if (prep.state === 'login') throw new Abort(prep.reason);
        if (prep.state !== 'ready' || cellsKey(prep.plan) !== cellsKey(shown.plan) || cellsKey(prep.site) !== cellsKey(shown.site) || cellsKey(prep.write) !== cellsKey(shown.write))
          throw new Abort(`week of ${week}: the site or the timesheet changed since the check; check again (nothing entered in this week)`);
        before = prep.site;
        const catalog = this.deps.store.submitCatalog(system)?.data;
        if (!catalog) throw new Abort('the catalog disappeared');
        page = await this.page(system);
        wp.state = 'entering';
        wp.cells = prep.write;
        wp.detail = [...dated(prep.notes), ...heldLines(prep.held)];
        const unitOf = (c: Cell<object>) => adapter.unitOf(week, c);
        progress.units = adapter.units(week, prep.write).map((unit) => ({ unit, state: 'pending' as UnitState, cells: prep.write.filter((c) => unitOf(c) === unit) }));
        save('running');
        await this.protect(adapter, page, this.deps.config().submit[system].url);
        const strip = (cells: LabeledCell[]) => cells.map(({ label: _label, ...c }) => c);
        for (const u of progress.units) {
          this.checkProtection();
          if (signal.aborted) throw new Abort('cancelled');
          u.state = 'working';
          applying = true;
          const result: Cell<object>[] = await adapter.apply(page, catalog, u.unit, { write: strip(u.cells), before: strip(prep.site.filter((c) => unitOf(c) === u.unit)) }, {
            save: !fillOnly,
            signal,
            userTimeoutMs: this.deps.userTimeoutMs,
            onState: (msg) => {
              progress.message = `Week of ${week}: ${msg}`;
              if (/press Update|press Save/.test(msg)) u.state = 'waiting';
            },
          });
          applying = false;
          u.state = 'saved';
          written.push(...strip(u.cells));
          after.push(...result);
          save('running');
        }
        this.checkProtection();
        wp.state = 'saved';
        this.lockWeek(system, week, inScope, prep.held);
        save('saved');
      } catch (e) {
        const failed = e instanceof Failed || (applying && !(e instanceof Abort));
        const msg = (e as Error).message;
        wp.state = failed ? 'failed' : 'aborted';
        wp.detail = [...wp.detail, msg];
        progress.status = failed ? 'failed' : 'aborted';
        progress.error = msg;
        const u = progress.units.find((x) => x.state === 'working' || x.state === 'waiting');
        if (u) u.state = failed ? 'failed' : 'aborted';
        progress.screenshots.push(...(await this.screenshot(page ?? this.pages.get(system), system, `${week}-${u?.unit ?? 'run'}`)));
        // A week recorded as running is always closed, so no run stays "running".
        if (failed || written.length || recorded) save(failed ? 'failed' : 'aborted', msg);
        stop = true;
      }
      if (stop) break;
    }
    await this.unprotect();
    const saved = progress.weeks.filter((w) => w.state === 'saved').map((w) => w.week);
    if (progress.status === 'running') {
      progress.status = saved.length ? 'saved' : 'noop';
      const skipped = progress.weeks.filter((w) => w.state === 'skipped').length;
      progress.message = `${saved.length ? `Entered ${saved.length} week${saved.length > 1 ? 's' : ''} and verified` : 'Nothing to enter'}${skipped ? `; ${skipped} skipped (see why below)` : ''}`;
    } else {
      for (const w of progress.weeks) if (w.state === 'pending') w.state = 'aborted';
      progress.message = progress.status === 'failed' ? `Failed: check ${site} by hand` : 'Stopped';
      if (saved.length) progress.error = `${progress.error} (already entered and verified: weeks of ${saved.join(', ')})`;
    }
    progress.finishedAt = new Date().toISOString();
    return structuredClone(progress);
  }
}

/** Identifies exactly what a check showed. */
function checkToken(c: CheckProgress): string {
  const weeks = c.weeks.map((w) => [w.week, w.state, cellsKey(w.plan), cellsKey(w.site), cellsKey(w.write), Object.keys(w.held).sort(), Object.entries(w.frozen).sort(), [...w.off].sort(), w.reasons]);
  return createHash('sha256').update(JSON.stringify({ system: c.system, from: c.from, to: c.to, fillOnly: c.fillOnly, weeks })).digest('hex').slice(0, 16);
}

/** Order-independent identity of a list of cells (target, day, hours). */
function cellsKey(cells: Cell<object>[]): string {
  return JSON.stringify(cells.map((c) => `${cellKey(c)}=${cents(c.hours)}`).sort());
}

