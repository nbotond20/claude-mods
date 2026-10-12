import type { Config } from '../config.ts';
import { sessionWork } from '../changes.ts';
import type { ToolUse } from '../changes.ts';
import type { RawEvent, SessionRef, Source } from '../types.ts';

/** One observed moment of activity inside an AI coding session. */
export interface Point {
  t: number;
  /** Activity continues without a gap until here (e.g. an assistant turn's completion) */
  end?: number;
  cwd: string;
  branch?: string;
  /** Set when this moment is a human-typed prompt */
  prompt?: string | null;
  /** `end` is a guess (history has no reply timing), not a recorded time */
  endAssumed?: boolean;
  /** Tool calls the assistant made at this moment */
  tools?: ToolUse[];
}

/**
 * Turns one session's activity moments into spans. Every message counts as activity,
 * so time spent waiting for the assistant to finish is included. A gap longer than
 * gapMinutes, or moving to a directory outside the span's tree, starts a new span.
 * Prompts get promptLeadMinutes of lead-in (time spent reading and typing).
 * Assistant activity more than idleMinutes after the last prompt ran unattended (an agent
 * left working overnight) and is dropped. The recorded part stops at quiet gaps longer
 * than idleMinutes, so it never covers time nothing was observed.
 */
export function spansFromPoints(points: Point[], source: Source, from: number, to: number, config: Config, session?: Omit<SessionRef, 'path'>): RawEvent[] {
  const gap = config.gapMinutes * 60_000;
  const idle = config.idleMinutes * 60_000;
  const lead = config.promptLeadMinutes * 60_000;
  const events: RawEvent[] = [];
  // `measured`: the recorded parts of the span, without the prompt lead-in, an assumed tail or quiet gaps.
  let span: { start: number; end: number; measured: [number, number][]; cwd: string; branch?: string; texts: string[]; tools: ToolUse[] } | null = null;
  const flush = () => {
    if (span) {
      const work = sessionWork(span.tools, span.cwd);
      events.push({ source, start: span.start, end: span.end, measured: span.measured, path: span.cwd, branch: span.branch, texts: span.texts, ...(work ? { work } : {}), ...(session ? { session: { ...session, path: span.cwd } } : {}) });
    }
    span = null;
  };
  let lastPrompt = -Infinity;
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    if (p.prompt) lastPrompt = p.t;
    const attended = lastPrompt + idle;
    if (p.t > attended) continue;
    const pEnd = Math.max(p.t, Math.min(p.end ?? p.t, p.endAssumed ? Infinity : attended));
    if (pEnd < from - gap || p.t >= to + gap) continue;
    const s = span as typeof span;
    const sameTree = s && (p.cwd === s.cwd || p.cwd.startsWith(s.cwd + '/'));
    if (!s || p.t - s.end > gap || !sameTree) {
      flush();
      span = { start: p.prompt ? p.t - lead : p.t, end: p.t, measured: [], cwd: p.cwd, branch: p.branch, texts: [], tools: [] };
    }
    const cur = span!;
    cur.end = Math.max(cur.end, pEnd);
    const recorded = p.endAssumed ? p.t : pEnd;
    const last = cur.measured[cur.measured.length - 1];
    if (last && p.t - last[1] <= idle) last[1] = Math.max(last[1], recorded);
    else cur.measured.push([p.t, recorded]);
    if (p.branch && p.branch !== 'HEAD') cur.branch = p.branch;
    if (p.prompt) cur.texts.push(p.prompt);
    if (p.tools) cur.tools.push(...p.tools);
  }
  flush();
  return events
    .filter((ev) => ev.end >= from && ev.start < to)
    .map((ev) => ({ ...ev, start: Math.max(ev.start, from), end: Math.min(ev.end, to), measured: clipIntervals(ev.measured ?? [], from, to) }));
}

/** `intervals` cut to [from, to); intervals left empty are dropped. */
export function clipIntervals(intervals: [number, number][], from: number, to: number): [number, number][] {
  return intervals.map(([s, e]): [number, number] => [Math.max(s, from), Math.min(e, to)]).filter(([s, e]) => e > s);
}

/** Harness-injected blocks that are not something the person typed. */
const INJECTED = /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-args|bash-input|bash-stdout|bash-stderr)>[\s\S]*?(<\/\1>|$)/g;
const NOT_A_PROMPT = /^(Caveat:|\[Request interrupted|This session is being continued from a previous conversation)/;

/** Normalizes a prompt for the classifier: harness noise removed, one line, bounded length. */
export function cleanPrompt(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim();
  if (NOT_A_PROMPT.test(raw)) return null;
  const t = raw
    .replace(INJECTED, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 400) : null;
}
