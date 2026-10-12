import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { expandDirs } from '../config.ts';
import type { Config } from '../config.ts';
import { toolUse } from '../changes.ts';
import type { ToolUse } from '../changes.ts';
import type { RawEvent } from '../types.ts';
import { cleanPrompt, spansFromPoints } from './spans.ts';
import type { Point } from './spans.ts';

/** Every Claude Code `projects` dir the config points at (globs expanded). */
export function projectDirs(config: Config): string[] {
  return expandDirs(config.claudeDirs);
}

/** Transcript files per projects dir, plus the ids of every session that still has a transcript. */
function transcripts(dir: string): { file: string; id: string; mtime: number }[] {
  const out: { file: string; id: string; mtime: number }[] = [];
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const pdir = join(dir, project.name);
    for (const f of readdirSync(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(pdir, f);
      out.push({ file, id: basename(f, '.jsonl'), mtime: statSync(file).mtimeMs });
    }
  }
  return out;
}

/** Transcripts that may contain activity in [from, to). */
export function sessionFiles(config: Config, from: number): string[] {
  return projectDirs(config).flatMap((d) => transcripts(d).filter((t) => t.mtime >= from).map((t) => t.file));
}

/** Text of a human-typed prompt, or null for tool results, meta entries and system noise. */
export function promptText(e: any): string | null {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return null;
  const c = e.message?.content;
  let text: string | null = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && !c.some((p: any) => p?.type === 'tool_result'))
    text = c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
  if (!text) return null;
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) return cmd[1].trim();
  if (text.trimStart().startsWith('<local-command')) return null;
  return cleanPrompt(text);
}

/** Tool calls in an assistant entry (subagent work included: it was done for this session). */
export function toolUses(e: any): ToolUse[] | undefined {
  const c = e.type === 'assistant' ? e.message?.content : null;
  if (!Array.isArray(c)) return undefined;
  const tools = c.filter((p: any) => p?.type === 'tool_use' && typeof p.name === 'string').map((p: any) => toolUse(p.name, p.input));
  return tools.length ? tools : undefined;
}

/** Turns one transcript into activity spans (see spansFromPoints). */
export async function parseSession(file: string, from: number, to: number, config: Config, profile?: string): Promise<RawEvent[]> {
  const points: Point[] = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.timestamp || !e.cwd) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    points.push({ t, cwd: e.cwd, branch: e.gitBranch, prompt: promptText(e), tools: toolUses(e) });
  }
  return spansFromPoints(points, 'claude', from, to, config, { id: basename(file, '.jsonl'), source: 'claude', profile });
}

/**
 * Prompts from a profile's history.jsonl, for sessions whose transcripts are gone
 * (Claude Code deletes old transcripts; history keeps every prompt). History has no
 * reply timing, so each prompt counts as [t - promptLead, t + historyTail].
 */
export async function parseHistory(file: string, skipSessions: Set<string>, from: number, to: number, config: Config, profile?: string): Promise<RawEvent[]> {
  const tail = config.historyTailMinutes * 60_000;
  const bySession = new Map<string, Point[]>();
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t + tail < from || t >= to || !e.project) continue;
    const session = String(e.sessionId ?? `${e.project}`);
    if (skipSessions.has(session)) continue;
    const list = bySession.get(session) ?? [];
    list.push({ t, end: t + tail, endAssumed: true, cwd: e.project, prompt: cleanPrompt(e.display) ?? '(prompt)' });
    bySession.set(session, list);
  }
  return [...bySession].flatMap(([id, points]) => spansFromPoints(points, 'claude', from, to, config, { id, source: 'claude', profile }).map((e) => ({ ...e, fromHistory: true })));
}

export async function collectClaude(config: Config, from: number, to: number): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for (const dir of projectDirs(config)) {
    const all = transcripts(dir);
    for (const t of all) if (t.mtime >= from) out.push(...(await parseSession(t.file, from, to, config, dirname(dir))));
    const history = join(dirname(dir), 'history.jsonl');
    if (config.claudeHistory && existsSync(history)) {
      out.push(...(await parseHistory(history, new Set(all.map((t) => t.id)), from, to, config, dirname(dir))));
    }
  }
  return out;
}
