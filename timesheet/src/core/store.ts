import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HOME } from './config.ts';
import type { Override } from './hours.ts';
import type { SystemId } from './submit/types.ts';
import type { RawEvent, StoredDay } from './types.ts';

/** A per-day mark: locked = never recomputed (submitted, or by hand); confirmed = a low-activity day accepted as it is. */
export type DayMark = 'locked' | 'confirmed';

/** One change made by hand, kept so it can be listed and undone. */
export interface Edit {
  id: number;
  at: string;
  date: string;
  kind: 'hours' | 'block' | 'count' | 'confirm';
  /** hours: "project\tcategory"; block: the block id; confirm: "" */
  key: string;
  /** Value before and after; null = not set */
  before: string | number | null;
  after: string | number | null;
  undone: boolean;
}

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
    // The CLI and the web server may write at the same time. The timeout comes first: switching to WAL takes a
    // lock too, and without it a second process opening the database at that moment fails with "database is locked".
    if (path !== ':memory:') this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
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
      CREATE TABLE IF NOT EXISTS block_counts (
        date TEXT NOT NULL,
        block_id INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        PRIMARY KEY (date, block_id)
      );
      CREATE TABLE IF NOT EXISTS day_marks (
        date TEXT NOT NULL,
        mark TEXT NOT NULL,
        at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (date, mark)
      );
      CREATE TABLE IF NOT EXISTS evidence (
        date TEXT PRIMARY KEY,
        events BLOB NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        date TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        before TEXT,
        after TEXT,
        undone INTEGER NOT NULL DEFAULT 0
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

  /** Blocks set by hand to count (true) or not count (false) towards the daily target. */
  blockCounts(date: string): Map<number, boolean> {
    const rows = this.db.prepare('SELECT block_id, counted FROM block_counts WHERE date = ?').all(date) as any[];
    return new Map(rows.map((r) => [Number(r.block_id), !!r.counted]));
  }

  setBlockCount(date: string, blockId: number, counted: boolean | null): void {
    if (counted === null) this.db.prepare('DELETE FROM block_counts WHERE date = ? AND block_id = ?').run(date, blockId);
    else this.db.prepare('INSERT OR REPLACE INTO block_counts VALUES (?, ?, ?)').run(date, blockId, counted ? 1 : 0);
  }

  /** Sets whether a block counts towards the target (null = follow the config rule), recorded for undo. */
  editBlockCount(date: string, blockId: number, counted: boolean | null): void {
    const prev = this.blockCounts(date).get(blockId);
    const before = prev === undefined ? null : prev ? 1 : 0;
    this.setBlockCount(date, blockId, counted);
    this.logEdit(date, 'count', String(blockId), before, counted === null ? null : counted ? 1 : 0);
  }

  /** Sets an hour override and records it for undo. */
  editHours(date: string, project: string, category: string, hours: number | null): void {
    const before = this.overrides(date).find((o) => o.project === project && o.category === category)?.hours ?? null;
    this.setOverride(date, project, category, hours);
    this.logEdit(date, 'hours', `${project}\t${category}`, before, hours);
  }

  /** Sets a block's category and records it for undo. */
  editBlock(date: string, blockId: number, category: string | null): void {
    const before = this.blockOverrides(date).get(blockId) ?? null;
    this.setBlockOverride(date, blockId, category);
    this.logEdit(date, 'block', String(blockId), before, category);
  }

  /** Confirms (or un-confirms) a low-activity day, recorded for undo. */
  editConfirm(date: string, confirmed: boolean): void {
    const before = this.hasMark(date, 'confirmed');
    this.setMark(date, 'confirmed', confirmed);
    this.logEdit(date, 'confirm', '', before ? 1 : null, confirmed ? 1 : null);
  }

  private logEdit(date: string, kind: Edit['kind'], key: string, before: string | number | null, after: string | number | null): void {
    if (before === after) return;
    this.db.prepare('INSERT INTO edits (at, date, kind, key, before, after) VALUES (?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), date, kind, key, JSON.stringify(before), JSON.stringify(after));
  }

  /** Hand edits, newest first (undone ones included, flagged). */
  edits(date?: string, limit = 50): Edit[] {
    const rows = this.db.prepare('SELECT * FROM edits WHERE (? IS NULL OR date = ?) ORDER BY id DESC LIMIT ?').all(date ?? null, date ?? null, limit) as any[];
    return rows.map((r) => ({ id: Number(r.id), at: r.at, date: r.date, kind: r.kind, key: r.key, before: JSON.parse(r.before), after: JSON.parse(r.after), undone: !!r.undone }));
  }

  /**
   * Reverts the newest edit not undone yet (optionally of one day), restoring its previous value.
   * Returns it, or null when there is nothing to undo. Locked days are skipped by the caller's check.
   */
  undo(date?: string): Edit | null {
    const e = this.edits(date, 500).find((x) => !x.undone);
    if (!e) return null;
    if (e.kind === 'hours') {
      const [project, category] = e.key.split('\t');
      this.setOverride(e.date, project, category, e.before as number | null);
    } else if (e.kind === 'block') this.setBlockOverride(e.date, Number(e.key), e.before as string | null);
    else if (e.kind === 'count') this.setBlockCount(e.date, Number(e.key), e.before === null ? null : !!e.before);
    else this.setMark(e.date, 'confirmed', e.before !== null);
    this.db.prepare('UPDATE edits SET undone = 1 WHERE id = ?').run(e.id);
    return e;
  }

  hasMark(date: string, mark: DayMark): boolean {
    return !!this.db.prepare('SELECT 1 FROM day_marks WHERE date = ? AND mark = ?').get(date, mark);
  }

  setMark(date: string, mark: DayMark, on: boolean, reason = ''): void {
    if (!on) this.db.prepare('DELETE FROM day_marks WHERE date = ? AND mark = ?').run(date, mark);
    else this.db.prepare('INSERT OR REPLACE INTO day_marks VALUES (?, ?, ?, ?)').run(date, mark, new Date().toISOString(), reason);
  }

  /** Dates carrying a mark, with when and why it was set. */
  marks(mark: DayMark): Map<string, { at: string; reason: string }> {
    const rows = this.db.prepare('SELECT date, at, reason FROM day_marks WHERE mark = ? ORDER BY date').all(mark) as any[];
    return new Map(rows.map((r) => [r.date, { at: r.at, reason: r.reason }]));
  }

  isLocked(date: string): boolean {
    return this.hasMark(date, 'locked');
  }

  /**
   * The AI-session activity a day was computed from, kept compressed so the day can still be
   * recomputed after Claude Code deletes old transcripts.
   */
  saveEvidence(date: string, events: RawEvent[]): void {
    if (!events.length) this.db.prepare('DELETE FROM evidence WHERE date = ?').run(date);
    else this.db.prepare('INSERT OR REPLACE INTO evidence VALUES (?, ?, ?)').run(date, gzipSync(JSON.stringify(events)), new Date().toISOString());
  }

  evidence(date: string): RawEvent[] {
    const row = this.db.prepare('SELECT events FROM evidence WHERE date = ?').get(date) as any;
    if (!row) return [];
    try {
      return JSON.parse(gunzipSync(row.events).toString('utf8'));
    } catch {
      return [];
    }
  }

  evidenceDates(): string[] {
    return (this.db.prepare('SELECT date FROM evidence ORDER BY date').all() as any[]).map((r) => r.date);
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
