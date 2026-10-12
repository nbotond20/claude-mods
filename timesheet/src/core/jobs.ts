import { randomUUID } from 'node:crypto';
import type { Engine } from './engine.ts';
import type { JobRow, JobStatus, Store } from './store.ts';

/**
 * Background computation of days, persisted in SQLite so it survives a close or crash.
 *
 * Progress is never tracked separately: a job's date counts as done when the store holds
 * that day computed with the current settings, either after the job was created or (for a
 * non-refresh job) still fresh. Every finished day is saved on its own, so after a crash
 * the job simply continues with the days that are not in the store yet ("reconciliation").
 */

export interface JobView extends JobRow {
  done: string[];
  remaining: string[];
  /** Days being computed right now (only known to the process running the job) */
  current: string[];
  /** Running in another process (e.g. the CLI while the web app is open) */
  elsewhere: boolean;
}

const ACTIVE: JobStatus[] = ['queued', 'running', 'paused', 'interrupted'];
const now = () => new Date().toISOString();

export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class JobRunner {
  private controller: AbortController | null = null;
  private runningId: string | null = null;
  private current = new Set<string>();
  private pumping = false;
  private waiters = new Map<string, (() => void)[]>();

  private engine: () => Engine;
  private store: Store;
  private log: (msg: string) => void;

  constructor(engine: () => Engine, store: Store, log: (msg: string) => void = () => {}) {
    this.engine = engine;
    this.store = store;
    this.log = log;
  }

  /**
   * Jobs left "running" by a process that is gone were interrupted (closed or crashed).
   * Returns them; `resume` continues them.
   */
  reconcile(): JobRow[] {
    const found: JobRow[] = [];
    for (const j of this.store.jobs()) {
      if (j.status === 'running' && !alive(j.pid)) {
        this.update(j, { status: 'interrupted' });
        found.push({ ...j, status: 'interrupted' });
      } else if (j.status === 'interrupted') found.push(j);
    }
    this.store.pruneJobs();
    return found;
  }

  isDone(job: JobRow, date: string): boolean {
    const engine = this.engine();
    const day = this.store.getDay(date);
    if (!day || day.computeKey !== engine.key) return false;
    return day.computedAt >= job.createdAt || (!job.refresh && !engine.isStale(day));
  }

  view(job: JobRow): JobView {
    // A finished job keeps its result even if later settings changes made its days stale.
    const done = job.status === 'done' ? job.dates : job.dates.filter((d) => this.isDone(job, d));
    const doneSet = new Set(done);
    return {
      ...job,
      done,
      remaining: job.dates.filter((d) => !doneSet.has(d)),
      current: this.runningId === job.id ? [...this.current] : [],
      elsewhere: job.status === 'running' && job.pid !== process.pid && alive(job.pid),
    };
  }

  get(id: string): JobView | null {
    const j = this.store.getJob(id);
    return j ? this.view(j) : null;
  }

  /** Unfinished jobs, plus ones that finished in the last `recentMs`. */
  list(recentMs = 5 * 60_000): JobView[] {
    const since = new Date(Date.now() - recentMs).toISOString();
    return this.store
      .jobs()
      .filter((j) => ACTIVE.includes(j.status) || j.updatedAt >= since)
      .map((j) => this.view(j));
  }

  /**
   * Makes sure the days in [from, to] get computed. Dates already covered by an unfinished
   * job stay with that job (a paused job stays paused); only the rest start a new job.
   * A refresh always starts a new job for every date.
   */
  ensure(from: string, to: string, refresh = false): JobView[] {
    const engine = this.engine();
    const needed = engine.pending(from, to, refresh);
    const active = this.store.jobs().filter((j) => ACTIVE.includes(j.status));
    const covered = new Set(refresh ? [] : active.flatMap((j) => this.view(j).remaining));
    const fresh = needed.filter((d) => !covered.has(d));
    if (fresh.length) this.create(from, to, fresh, refresh);
    const inRange = (d: string) => d >= from && d <= to;
    return this.store
      .jobs()
      .filter((j) => ACTIVE.includes(j.status) && j.dates.some(inRange))
      .map((j) => this.view(j))
      .filter((j) => j.remaining.length);
  }

  /** Resumes a matching unfinished job (same range and refresh) or creates one. */
  startOrResume(from: string, to: string, refresh = false): JobView | null {
    const match = this.store.jobs().find((j) => ACTIVE.includes(j.status) && j.from === from && j.to === to && j.refresh === refresh);
    if (match && this.view(match).remaining.length) {
      if (match.status !== 'running' || !alive(match.pid)) this.resume(match.id);
      return this.get(match.id);
    }
    const dates = this.engine().pending(from, to, refresh);
    return dates.length ? this.view(this.create(from, to, dates, refresh)) : null;
  }

  private create(from: string, to: string, dates: string[], refresh: boolean): JobRow {
    const job: JobRow = { id: randomUUID(), from, to, refresh, dates, status: 'queued', createdAt: now(), updatedAt: now() };
    this.store.saveJob(job);
    this.pump();
    return job;
  }

  pause(id: string): JobView | null {
    const j = this.store.getJob(id);
    if (!j || !ACTIVE.includes(j.status)) return j && this.view(j);
    this.update(j, { status: 'paused' });
    if (this.runningId === id) this.controller?.abort();
    return this.get(id);
  }

  resume(id: string): JobView | null {
    const j = this.store.getJob(id);
    if (!j || j.status === 'done' || j.status === 'cancelled') return j && this.view(j);
    if (j.status === 'running' && alive(j.pid)) return this.view(j);
    this.update(j, { status: 'queued', error: undefined });
    this.pump();
    return this.get(id);
  }

  cancel(id: string): JobView | null {
    const j = this.store.getJob(id);
    if (!j || !ACTIVE.includes(j.status)) return j && this.view(j);
    this.update(j, { status: 'cancelled' });
    if (this.runningId === id) this.controller?.abort();
    return this.get(id);
  }

  /** After a settings change: stop the running job and continue it with the new engine. */
  restart(): void {
    if (!this.runningId) return;
    const j = this.store.getJob(this.runningId);
    if (j) this.update(j, { status: 'queued' });
    this.controller?.abort();
  }

  /** Stops this process's work without losing it: the job continues on the next start. */
  shutdown(): void {
    if (!this.runningId) return;
    const j = this.store.getJob(this.runningId);
    if (j?.status === 'running') this.update(j, { status: 'interrupted' });
    this.controller?.abort();
  }

  /** Resolves when the job is no longer queued or running in this process. */
  wait(id: string): Promise<JobView | null> {
    const j = this.store.getJob(id);
    if (!j || !['queued', 'running'].includes(j.status)) return Promise.resolve(j && this.view(j));
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), () => resolve(this.get(id))]));
  }

  private update(j: JobRow, patch: Partial<JobRow>): void {
    const next = { ...(this.store.getJob(j.id) ?? j), ...patch, updatedAt: now() };
    if (patch.error === undefined && 'error' in patch) delete next.error;
    this.store.saveJob(next);
    if (!['queued', 'running'].includes(next.status)) this.settle(j.id);
  }

  private settle(id: string): void {
    for (const w of this.waiters.get(id) ?? []) w();
    this.waiters.delete(id);
  }

  /** Runs queued jobs one at a time, oldest first. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(async () => {
      try {
        for (;;) {
          const next = this.store.jobs().find((j) => j.status === 'queued');
          if (!next) break;
          await this.run(next);
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  private async run(job: JobRow): Promise<void> {
    const remaining = this.view(job).remaining;
    if (!remaining.length) return this.update(job, { status: 'done' });
    this.update(job, { status: 'running', pid: process.pid });
    this.runningId = job.id;
    const controller = new AbortController();
    this.controller = controller;
    this.current.clear();
    this.log(`Computing ${remaining.length} day${remaining.length > 1 ? 's' : ''} (${remaining[0]} → ${remaining[remaining.length - 1]})…`);
    try {
      await this.engine().compute(remaining, {
        signal: controller.signal,
        reclassify: job.refresh,
        onStart: (d) => this.current.add(d),
        onDone: (day) => {
          this.current.delete(day.date);
          // Another process (the web app, a second CLI) may have paused or cancelled it.
          const status = this.store.getJob(job.id)?.status;
          if (status !== 'running') controller.abort();
        },
      });
      const status = this.store.getJob(job.id)?.status;
      if (status === 'running') {
        const left = this.view(job).remaining;
        this.update(job, left.length ? { status: 'failed', error: `${left.length} day(s) could not be computed` } : { status: 'done' });
      }
    } catch (e) {
      if (this.store.getJob(job.id)?.status === 'running') this.update(job, { status: 'failed', error: (e as Error).message });
    } finally {
      this.runningId = null;
      this.controller = null;
      this.current.clear();
    }
  }
}
