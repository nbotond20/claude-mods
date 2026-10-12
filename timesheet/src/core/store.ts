import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOME } from './config.ts';
import type { Override } from './hours.ts';
import type { SystemId } from './submit/types.ts';
import type { StoredDay } from './types.ts';

export type JobStatus = 'queued' | 'running' | 'paused' | 'interrupted' | 'done' | 'failed' | 'cancelled';

/** A background computation of a set of days; persisted so it survives a close or crash. */
export interface JobRow {
  id: string;
  from: string;
  to: string;
  refresh: boolean;
  dates: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Process that runs it while status is running */
  pid?: number;
}

/**
 * ready = prepared and reviewable; saved/filled/noop end well; blocked/conflict wrote nothing;
 * aborted stopped before writing anything more (days saved before it are verified and listed);
 * failed = check the site by hand.
 */
export type SubmitRunStatus = 'ready' | 'running' | 'saved' | 'filled' | 'noop' | 'blocked' | 'conflict' | 'aborted' | 'failed';

/** One submission attempt for one system and week, kept as an audit trail. */
export interface SubmitRun {
  id: string;
  system: SystemId;
  week: string;
  status: SubmitRunStatus;
  fillOnly: boolean;
  fingerprint?: string;
  plan?: unknown;
  /** Snapshot read before writing */
  before?: unknown;
  /** Cells written */
  written?: unknown;
  /** Snapshot read back after saving */
  after?: unknown;
  error?: string;
  screenshots: string[];
  /** Process that runs it while status is running */
  pid?: number;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = join(HOME, 'db.sqlite')) {
    if (path !== ':memory:') mkdirSync(HOME, { recursive: true });
    this.db = new DatabaseSync(path);
    // The CLI and the web server may write at the same time.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS days (
        date TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        out_of_office INTEGER NOT NULL DEFAULT 0,
        blocks TEXT NOT NULL,
        warnings TEXT NOT NULL,
        paths TEXT NOT NULL,
        compute_key TEXT NOT NULL DEFAULT '',
        retry INTEGER NOT NULL DEFAULT 1,
        activity TEXT,
        other TEXT,
        classify_key TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        refresh INTEGER NOT NULL,
        dates TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        pid INTEGER
      );
      CREATE TABLE IF NOT EXISTS overrides (
        date TEXT NOT NULL,
        project TEXT NOT NULL,
        category TEXT NOT NULL,
        hours REAL NOT NULL,
        PRIMARY KEY (date, project, category)
      );
      CREATE TABLE IF NOT EXISTS block_overrides (
        date TEXT NOT NULL,
        block_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (date, block_id)
      );
      CREATE TABLE IF NOT EXISTS submit_catalog (
        system TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        discovered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submit_runs (
        id TEXT PRIMARY KEY,
        system TEXT NOT NULL,
        week TEXT NOT NULL,
        status TEXT NOT NULL,
        fill_only INTEGER NOT NULL,
        fingerprint TEXT,
        detail TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // Databases created before compute_key existed get the column; their days count as stale.
    const cols = (this.db.prepare('PRAGMA table_info(days)').all() as any[]).map((c) => c.name);
    if (!cols.includes('compute_key')) this.db.exec("ALTER TABLE days ADD COLUMN compute_key TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('retry')) this.db.exec('ALTER TABLE days ADD COLUMN retry INTEGER NOT NULL DEFAULT 1');
    if (!cols.includes('activity')) this.db.exec('ALTER TABLE days ADD COLUMN activity TEXT');
    if (!cols.includes('other')) this.db.exec('ALTER TABLE days ADD COLUMN other TEXT');
    if (!cols.includes('classify_key')) this.db.exec('ALTER TABLE days ADD COLUMN classify_key TEXT');
  }

  getDay(date: string): StoredDay | null {
    const row = this.db.prepare('SELECT * FROM days WHERE date = ?').get(date) as any;
    if (!row) return null;
    return {
      date: row.date,
      status: row.status,
      computedAt: row.computed_at,
      summary: row.summary,
      outOfOffice: !!row.out_of_office,
      blocks: JSON.parse(row.blocks),
      warnings: JSON.parse(row.warnings),
      paths: JSON.parse(row.paths),
      computeKey: row.compute_key,
      retry: !!row.retry,
      ...(row.activity ? { activity: JSON.parse(row.activity) } : {}),
      ...(row.other ? { other: JSON.parse(row.other) } : {}),
      ...(row.classify_key ? { classifyKey: row.classify_key } : {}),
    };
  }

  saveDay(d: StoredDay): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO days (date, status, computed_at, summary, out_of_office, blocks, warnings, paths, compute_key, retry, activity, other, classify_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.date, d.status, d.computedAt, d.summary, d.outOfOffice ? 1 : 0, JSON.stringify(d.blocks), JSON.stringify(d.warnings), JSON.stringify(d.paths), d.computeKey ?? '', d.retry === false ? 0 : 1, d.activity ? JSON.stringify(d.activity) : null, d.other ? JSON.stringify(d.other) : null, d.classifyKey ?? null);
  }

  deleteDay(date: string): void {
    this.db.prepare('DELETE FROM days WHERE date = ?').run(date);
  }

  cachedDates(): string[] {
    return (this.db.prepare('SELECT date FROM days ORDER BY date').all() as any[]).map((r) => r.date);
  }

  overrides(date: string): Override[] {
    return this.db.prepare('SELECT project, category, hours FROM overrides WHERE date = ?').all(date) as any[];
  }

  setOverride(date: string, project: string, category: string, hours: number | null): void {
    if (hours === null) this.db.prepare('DELETE FROM overrides WHERE date = ? AND project = ? AND category = ?').run(date, project, category);
    else this.db.prepare('INSERT OR REPLACE INTO overrides VALUES (?, ?, ?, ?)').run(date, project, category, hours);
  }

  blockOverrides(date: string): Map<number, string> {
    const rows = this.db.prepare('SELECT block_id, category FROM block_overrides WHERE date = ?').all(date) as any[];
    return new Map(rows.map((r) => [Number(r.block_id), String(r.category)]));
  }

  setBlockOverride(date: string, blockId: number, category: string | null): void {
    if (category === null) this.db.prepare('DELETE FROM block_overrides WHERE date = ? AND block_id = ?').run(date, blockId);
    else this.db.prepare('INSERT OR REPLACE INTO block_overrides VALUES (?, ?, ?)').run(date, blockId, category);
  }

  saveJob(j: JobRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(j.id, j.from, j.to, j.refresh ? 1 : 0, JSON.stringify(j.dates), j.status, j.createdAt, j.updatedAt, j.error ?? null, j.pid ?? null);
  }

  getJob(id: string): JobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? toJob(row) : null;
  }

  /** Jobs, oldest first. */
  jobs(): JobRow[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at').all() as any[]).map(toJob);
  }

  /** Keeps every unfinished job and the most recent finished ones. */
  pruneJobs(keep = 20): void {
    this.db
      .prepare(
        `DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled')
         AND id NOT IN (SELECT id FROM jobs WHERE status IN ('done', 'failed', 'cancelled') ORDER BY updated_at DESC LIMIT ?)`,
      )
      .run(keep);
  }

  submitCatalog<T = unknown>(system: SystemId): { data: T; discoveredAt: string } | null {
    const row = this.db.prepare('SELECT data, discovered_at FROM submit_catalog WHERE system = ?').get(system) as any;
    return row ? { data: JSON.parse(row.data), discoveredAt: row.discovered_at } : null;
  }

  saveSubmitCatalog(system: SystemId, data: unknown, discoveredAt = new Date().toISOString()): void {
    this.db.prepare('INSERT OR REPLACE INTO submit_catalog VALUES (?, ?, ?)').run(system, JSON.stringify(data), discoveredAt);
  }

  saveSubmitRun(r: SubmitRun): void {
    const detail = JSON.stringify({ plan: r.plan, before: r.before, written: r.written, after: r.after, screenshots: r.screenshots, pid: r.pid });
    this.db
      .prepare('INSERT OR REPLACE INTO submit_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.system, r.week, r.status, r.fillOnly ? 1 : 0, r.fingerprint ?? null, detail, r.error ?? null, r.createdAt, r.updatedAt);
  }

  /** Newest first. */
  submitRuns(system?: SystemId, week?: string): SubmitRun[] {
    const rows = this.db
      .prepare('SELECT * FROM submit_runs WHERE (? IS NULL OR system = ?) AND (? IS NULL OR week = ?) ORDER BY created_at DESC, updated_at DESC')
      .all(system ?? null, system ?? null, week ?? null, week ?? null) as any[];
    return rows.map((row) => {
      const d = JSON.parse(row.detail);
      return {
        id: row.id, system: row.system, week: row.week, status: row.status, fillOnly: !!row.fill_only,
        ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
        ...(d.plan !== undefined ? { plan: d.plan } : {}),
        ...(d.before !== undefined ? { before: d.before } : {}),
        ...(d.written !== undefined ? { written: d.written } : {}),
        ...(d.after !== undefined ? { after: d.after } : {}),
        ...(row.error ? { error: row.error } : {}),
        screenshots: d.screenshots ?? [],
        ...(typeof d.pid === 'number' ? { pid: d.pid } : {}),
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}

function toJob(row: any): JobRow {
  return {
    id: row.id,
    from: row.from_date,
    to: row.to_date,
    refresh: !!row.refresh,
    dates: JSON.parse(row.dates),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    pid: row.pid ?? undefined,
  };
}
