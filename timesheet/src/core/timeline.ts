import { mergeWork } from './changes.ts';
import type { Config } from './config.ts';
import type { Block, BlockItem, CommitRef, GithubAction, RawEvent, SessionRef, Source } from './types.ts';

/** A raw event already resolved to a work project. */
export type WorkEvent = RawEvent & { project: string };

type Draft = Omit<Block, 'id' | 'hint' | 'allocations' | 'summary' | 'items'> & { sessions: SessionRef[]; commits: CommitRef[]; actions: GithubAction[]; events: WorkEvent[] };

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const uniqBy = <T>(xs: T[], key: (x: T) => string): T[] => [...new Map(xs.map((x) => [key(x), x])).values()];
const actionKey = (a: GithubAction) => `${a.kind}:${a.url}`;

const commitsOf = (e: RawEvent): CommitRef[] => (e.commit && e.path ? [{ hash: e.commit, repo: e.path, subject: e.texts[0] ?? '', ...e.change }] : []);

/** Recorded minutes of `events` inside [start, end): overlaps counted once, nothing rounded. */
export function measuredMinutes(events: RawEvent[], start: number, end: number): number {
  const parts = events
    .flatMap((e) => e.measured ?? [[e.start, e.end] as [number, number]])
    .map(([s, e]): [number, number] => [Math.max(s, start), Math.min(e, end)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let ms = 0;
  let at = -Infinity;
  for (const [s, e] of parts) {
    if (e <= at) continue;
    ms += e - Math.max(s, at);
    at = e;
  }
  return ms / 60_000;
}

function merge(a: Draft, b: Draft): Draft {
  return {
    ...a,
    end: Math.max(a.end, b.end),
    sources: uniq([...a.sources, ...b.sources]) as Source[],
    branches: uniq([...a.branches, ...b.branches]),
    paths: uniq([...a.paths, ...b.paths]),
    texts: uniq([...a.texts, ...b.texts]),
    sessions: uniqBy([...a.sessions, ...b.sessions], (s) => `${s.source}:${s.id}`),
    commits: uniqBy([...a.commits, ...b.commits], (c) => c.hash),
    actions: uniqBy([...a.actions, ...b.actions], actionKey),
    events: [...a.events, ...b.events],
  };
}

function draft(e: WorkEvent, kind: Block['kind']): Draft {
  return {
    start: e.start,
    end: e.end,
    kind,
    project: e.project,
    sources: [e.source],
    branches: e.branch ? [e.branch] : [],
    paths: e.path ? [e.path] : [],
    texts: e.texts.filter(Boolean),
    sessions: e.session ? [e.session] : [],
    commits: commitsOf(e),
    actions: e.action ? [e.action] : [],
    events: [e],
  };
}

/**
 * The separate pieces of work in [start, end): one per folder, holding its sessions, commits and GitHub actions,
 * clipped to the block. Work in different repos at the same time stays separate so the calendar
 * can show it side by side; parallel sessions in one repo form one piece. Booked time still
 * comes from the block.
 */
function itemsOf(events: WorkEvent[], start: number, end: number, blockId: number, minMs: number): BlockItem[] {
  type Piece = Omit<BlockItem, 'id'> & { events: WorkEvent[] };
  const groups = new Map<string, WorkEvent[]>();
  for (const e of events) {
    if (e.end <= start || e.start >= end) continue;
    const key = e.path ?? e.source;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const all: Piece[] = [...groups.values()]
    .map((es) => ({
      events: es,
      start: Math.max(start, Math.min(...es.map((e) => e.start))),
      end: Math.min(end, Math.max(...es.map((e) => e.end))),
      sources: uniq(es.map((e) => e.source)),
      path: es[0].path,
      branch: es.map((e) => e.branch).find((b) => b && b !== 'HEAD'),
      sessions: uniqBy(es.flatMap((e) => (e.session ? [e.session] : [])), (s) => `${s.source}:${s.id}`),
      commits: es.flatMap(commitsOf),
      actions: uniqBy(es.flatMap((e) => (e.action ? [e.action] : [])), actionKey),
      work: es.reduce<BlockItem['work']>((w, e) => mergeWork(w, e.work), undefined),
      texts: uniq(es.flatMap((e) => e.texts).filter(Boolean)),
    }))
    .sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start);
  // Pieces shorter than a minimum block are folded into the piece they overlap most (or the
  // nearest one), so a quick look into another repo does not become its own sliver.
  const kept: Piece[] = [];
  const short: Piece[] = [];
  for (const it of all.reverse()) (it.end - it.start >= minMs || !kept.length ? kept : short).push(it);
  for (const it of short) {
    const overlap = (k: Piece) => Math.min(k.end, it.end) - Math.max(k.start, it.start);
    const host = kept.reduce((best, k) => (overlap(k) > overlap(best) ? k : best));
    host.sessions = uniqBy([...host.sessions, ...it.sessions], (s) => `${s.source}:${s.id}`);
    host.commits = [...host.commits, ...it.commits];
    host.actions = uniqBy([...(host.actions ?? []), ...(it.actions ?? [])], actionKey);
    host.work = mergeWork(host.work, it.work);
    host.texts = uniq([...host.texts, ...it.texts]);
    host.sources = uniq([...host.sources, ...it.sources]);
    host.events = [...host.events, ...it.events];
    if (it.path && it.path !== host.path) host.alsoPaths = uniq([...(host.alsoPaths ?? []), it.path]);
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map(({ events: es, ...it }, i) => ({ ...it, id: `${blockId}.${i + 1}`, measured: measuredMinutes(es, it.start, it.end) }));
}

/** Merge drafts whose gap is at most `gap` ms. Input need not be sorted. */
function mergeRuns(drafts: Draft[], gap: number): Draft[] {
  const sorted = [...drafts].sort((a, b) => a.start - b.start);
  const out: Draft[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && d.start - last.end <= gap) out[out.length - 1] = merge(last, d);
    else out.push(d);
  }
  return out;
}

/** Parts of [start, end) not covered by any of `taken`. */
export function subtract(start: number, end: number, taken: [number, number][]): [number, number][] {
  let parts: [number, number][] = [[start, end]];
  for (const [ts, te] of taken) {
    parts = parts.flatMap(([s, e]): [number, number][] => {
      if (te <= s || ts >= e) return [[s, e]];
      const r: [number, number][] = [];
      if (ts > s) r.push([s, ts]);
      if (te < e) r.push([te, e]);
      return r;
    });
  }
  return parts;
}

/**
 * Builds the day's time blocks. Work activity is merged per project when gaps are at most
 * gapMinutes; short blocks are padded to minBlockMinutes; meetings take precedence over
 * overlapping work, and overlapping work from different projects is counted once.
 */
export function buildBlocks(events: WorkEvent[], config: Config, dayStart: number, dayEnd: number): Omit<Block, 'hint' | 'allocations' | 'summary'>[] {
  const gap = config.gapMinutes * 60_000;
  const minBlock = config.minBlockMinutes * 60_000;

  const meetings = mergeRuns(
    events.filter((e) => e.source === 'calendar' && !e.outOfOffice).map((e) => draft(e, 'meeting')),
    0,
  ).map((m) => ({ ...m, start: Math.max(m.start, dayStart), end: Math.min(m.end, dayEnd) }));

  const byProject = new Map<string, Draft[]>();
  for (const e of events.filter((e) => e.source !== 'calendar')) {
    const list = byProject.get(e.project) ?? [];
    list.push(draft(e, 'work'));
    byProject.set(e.project, list);
  }
  const work = [...byProject.values()]
    .flatMap((ds) => mergeRuns(ds, gap))
    .map((d) => {
      if (d.end - d.start >= minBlock) return d;
      const end = Math.min(dayEnd, d.start + minBlock);
      return { ...d, end, start: Math.max(dayStart, end - minBlock) };
    })
    .sort((a, b) => a.start - b.start);

  const taken: [number, number][] = meetings.map((m) => [m.start, m.end]);
  const pieces: Draft[] = [];
  for (const w of work) {
    for (const [s, e] of subtract(w.start, w.end, taken)) {
      if (e - s >= 60_000) pieces.push({ ...w, start: s, end: e });
    }
    taken.push([w.start, w.end]);
  }

  return [...meetings, ...pieces]
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start)
    .map(({ events: raw, ...b }, i) => ({ ...b, id: i + 1, measured: measuredMinutes(raw, b.start, b.end), ...(b.kind === 'work' ? { items: itemsOf(raw, b.start, b.end, i + 1, minBlock) } : {}) }));
}
