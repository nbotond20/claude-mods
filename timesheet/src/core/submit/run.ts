import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { Config } from '../config.ts';
import { addDays, daysBetween, weekStart } from '../dates.ts';
import type { Store, SubmitRun, SubmitRunStatus } from '../store.ts';
import type { DayReport } from '../types.ts';
import { alive } from '../jobs.ts';
import { Abort, type Adapter, Failed, type Protection } from './adapter.ts';
import { diff, fingerprint as planFingerprint } from './diff.ts';
import { INSPECT_DIR } from './inspect.ts';
import { buildPlan } from './plan.ts';
import { redmine } from './redmine.ts';
import type { SubmitSession } from './session.ts';
import type { Cell, Plan, Snapshot, SubmitRule, SystemId } from './types.ts';

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
    | { state: 'conflict'; reasons: string[]; plan: LabeledCell[]; site: LabeledCell[]; notes: string[] }
    | { state: 'noop'; plan: LabeledCell[]; site: LabeledCell[]; notes: string[] }
    | { state: 'ready'; plan: LabeledCell[]; site: LabeledCell[]; notes: string[]; write: LabeledCell[]; unchanged: number; fingerprint: string; fillOnly: boolean }
  );

export type UnitState = 'pending' | 'working' | 'waiting' | 'saved' | 'failed' | 'aborted';

export interface RunProgress {
  id: string;
  system: SystemId;
  week: string;
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
}

const NOT_ENABLED: Partial<Record<SystemId, string>> = { netsuite: 'NetSuite automation is not enabled yet' };
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
  private protection: { page: Page; handle: Protection } | null = null;

  constructor(deps: RunDeps) {
    this.deps = deps;
    this.adapters = deps.adapters ?? { redmine };
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
    return this.current?.status === 'running';
  }

  /** Resolves when the current run ends (immediately with null when there is none). */
  wait(): Promise<RunProgress | null> {
    return this.finished ?? Promise.resolve(null);
  }

  cancel(): RunProgress | null {
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
  private lockWeek(system: SystemId, week: string): void {
    for (const d of daysBetween(week, addDays(week, 6))) {
      if (d < this.deps.today() && this.deps.store.getDay(d) && !this.deps.store.isLocked(d)) this.deps.store.setMark(d, 'locked', true, `entered in ${system}`);
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

  private async prepareInner(system: SystemId, week: string, record: boolean, signal?: AbortSignal): Promise<PrepareResult> {
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
      const result = buildPlan({ system, week, reports, today: this.deps.today(), rules: cfg.rules as SubmitRule<object>[], exists: catalog ? (t) => adapter.exists(catalog, t) : undefined });
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
      const login = await adapter.checkLogin(page, cfg.url);
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
      const shown = { plan: label(p.cells), site: label(snapshot.cells), notes: p.notes };
      const d = diff(p, snapshot);
      const fp = `${planFingerprint(p, snapshot)}${cfg.fillOnly ? 'f' : 's'}`;
      const status: SubmitRunStatus = d.kind === 'write' ? 'ready' : d.kind;
      if (record) this.record({ id: randomUUID(), ...runBase, status, fingerprint: fp, plan: p, before: snapshot, ...(d.kind === 'conflict' ? { error: d.reasons.join('\n') } : {}) });
      if (d.kind === 'conflict') return { ...base, state: 'conflict', reasons: d.reasons, ...shown };
      if (d.kind === 'noop') {
        if (record) this.lockWeek(system, week);
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
    const progress: RunProgress = { id: randomUUID(), system, week, fillOnly, status: 'running', message: 'Checking the site again', units: [], screenshots: [], startedAt: new Date().toISOString() };
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
      this.lockWeek(system, week);
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
}
