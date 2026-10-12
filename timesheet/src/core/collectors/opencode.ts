import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { RawEvent } from '../types.ts';
import { cleanPrompt, spansFromPoints } from './spans.ts';
import type { Point } from './spans.ts';

/**
 * OpenCode sessions. Three storage generations exist and all are read:
 * - 2.x: opencode.db tables session_v2 + session_message (role in `type`, payload JSON in `data`)
 * - 1.14–1.x: opencode.db tables session + message + part
 * - older: JSON files under storage/{session,message,part}
 */

/** OpenCode stores epoch ms; tolerate seconds just in case. */
const ms = (t: unknown): number | null => {
  const n = typeof t === 'string' ? Number(t) : typeof t === 'number' ? t : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

const parse = (raw: unknown): any => {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** Text of a message payload in any of the shapes OpenCode has used. */
export function payloadText(data: any): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (typeof data.text === 'string') return data.text;
  for (const key of ['content', 'parts']) {
    const v = data[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      const text = v.filter((p: any) => p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string' && !p.synthetic).map((p: any) => p.text).join('\n');
      if (text) return text;
    }
  }
  return null;
}

function tables(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as any[]).map((r) => String(r.name)));
}

function readV2(db: DatabaseSync, from: number, to: number): Map<string, Point[]> {
  const rows = db
    .prepare(
      `SELECT m.session_id AS sid, m.type AS role, m.time_created AS created, m.time_updated AS updated, m.data AS data, s.directory AS dir
       FROM session_message m JOIN session_v2 s ON s.id = m.session_id
       WHERE m.time_updated >= ? AND m.time_created < ?`,
    )
    .all(from, to) as any[];
  const sessions = new Map<string, Point[]>();
  for (const r of rows) {
    const data = parse(r.data);
    const role = String(r.role ?? data.role ?? '');
    if (role !== 'user' && role !== 'assistant') continue;
    const cwd = data.path?.cwd ?? r.dir;
    const created = ms(data.time?.created ?? r.created);
    if (!cwd || !created) continue;
    const list = sessions.get(r.sid) ?? [];
    const done = role === 'assistant' ? ms(data.time?.completed ?? r.updated) : null;
    list.push({ t: created, end: done ?? undefined, cwd, prompt: role === 'user' ? cleanPrompt(payloadText(data)) : null });
    sessions.set(r.sid, list);
  }
  return sessions;
}

function readV1(db: DatabaseSync, from: number, to: number): Map<string, Point[]> {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.session_id AS sid, m.time_created AS created, m.data AS data, s.directory AS dir
       FROM message m JOIN session s ON s.id = m.session_id
       WHERE m.time_created >= ? AND m.time_created < ?`,
    )
    .all(from - 86_400_000, to) as any[];
  const partsOf = db.prepare('SELECT data FROM part WHERE message_id = ?');
  const sessions = new Map<string, Point[]>();
  for (const r of rows) {
    const data = parse(r.data);
    if (data.role !== 'user' && data.role !== 'assistant') continue;
    const cwd = data.path?.cwd ?? r.dir;
    const created = ms(data.time?.created ?? r.created);
    if (!cwd || !created) continue;
    let prompt: string | null = null;
    if (data.role === 'user') {
      prompt = cleanPrompt(payloadText({ parts: (partsOf.all(r.id) as any[]).map((p) => parse(p.data)) }));
    }
    const list = sessions.get(r.sid) ?? [];
    list.push({ t: created, end: ms(data.time?.completed) ?? undefined, cwd, prompt });
    sessions.set(r.sid, list);
  }
  return sessions;
}

function readDb(file: string, from: number, to: number): Map<string, Point[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const t = tables(db);
    if (t.has('session_message') && t.has('session_v2')) return readV2(db, from, to);
    if (t.has('message') && t.has('session')) return readV1(db, from, to);
    throw new Error(`unrecognized OpenCode database layout in ${file}`);
  } finally {
    db.close();
  }
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

/** Pre-SQLite JSON layout. Sessions untouched since before `from` are skipped by mtime. */
function readLegacy(storage: string, from: number, to: number): Map<string, Point[]> {
  const sessions = new Map<string, Point[]>();
  for (const project of list(join(storage, 'session'))) {
    for (const f of list(join(storage, 'session', project))) {
      const file = join(storage, 'session', project, f);
      if (!f.endsWith('.json') || statSync(file).mtimeMs < from) continue;
      const session = readJson(file);
      if (!session?.id) continue;
      const points: Point[] = [];
      for (const mf of list(join(storage, 'message', session.id))) {
        const m = readJson(join(storage, 'message', session.id, mf));
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        const created = ms(m.time?.created);
        const cwd = m.path?.cwd ?? session.directory;
        if (!created || !cwd || created >= to || created < from - 86_400_000) continue;
        let prompt: string | null = null;
        if (m.role === 'user') {
          const parts = list(join(storage, 'part', m.id)).map((pf) => readJson(join(storage, 'part', m.id, pf)));
          prompt = cleanPrompt(payloadText({ parts }));
        }
        points.push({ t: created, end: ms(m.time?.completed) ?? undefined, cwd, prompt });
      }
      if (points.length) sessions.set(session.id, points);
    }
  }
  return sessions;
}

export function openCodeAvailable(config: Config): boolean {
  return config.opencodeDirs.some((d) => existsSync(join(d, 'opencode.db')) || existsSync(join(d, 'storage', 'session')));
}

export async function collectOpenCode(config: Config, from: number, to: number): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for (const dir of config.opencodeDirs) {
    const sessions = new Map<string, Point[]>();
    const db = join(dir, 'opencode.db');
    if (existsSync(db)) for (const [k, v] of readDb(db, from, to)) sessions.set(k, v);
    // Legacy sessions that were never migrated into the database are still read.
    for (const [k, v] of readLegacy(join(dir, 'storage'), from, to)) if (!sessions.has(k)) sessions.set(k, v);
    for (const [id, points] of sessions) out.push(...spansFromPoints(points, 'opencode', from, to, config, { id, source: 'opencode' }));
  }
  return out;
}
