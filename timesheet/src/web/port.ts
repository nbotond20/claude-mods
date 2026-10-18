import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../core/paths.ts';

export const APP_VERSION: string = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version;

/** What holds a port: nothing, a timesheet server (version null when it predates /api/version), or something else. */
export type PortHolder =
  | { kind: 'free' }
  | { kind: 'timesheet'; version: string | null; pid: number | null; root?: string | null }
  | { kind: 'foreign'; pid?: number | null; command?: string };

/** This server's plugin or package folder, reported by /api/version so a caller can tell a deleted install apart. */
export const APP_ROOT = packageRoot();

/**
 * Reuse or replace the timesheet server on the port. Never downgrade: a newer server (from a profile that already
 * updated) is reused, so profiles on different versions do not take turns restarting it. The same version is reused
 * unless asked to restart or its install folder is gone; an older one, or one too old to say, is replaced.
 */
export function decide(holder: Extract<PortHolder, { kind: 'timesheet' }>, ours: string, restart = false, rootExists: (p: string) => boolean = existsSync): 'reuse' | 'replace' {
  if (!holder.version) return 'replace';
  const c = compareVersions(holder.version, ours);
  if (c > 0) return 'reuse';
  if (c < 0 || restart) return 'replace';
  return holder.root && !rootExists(holder.root) ? 'replace' : 'reuse';
}

/** -1, 0 or 1 comparing dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * What holds `port`. The HTTP answer alone could come from any local process, so a timesheet answer only counts
 * when the listening process (looked up by the OS, never taken from the reply) runs timesheet.js.
 */
export async function probe(port: number): Promise<PortHolder> {
  const holder = await probeHttp(port);
  if (holder.kind === 'free') return holder;
  const pid = listeningPid(port);
  if (holder.kind === 'foreign') return { kind: 'foreign', pid, command: pid ? processCommand(pid) : undefined };
  if (pid === null) return { ...holder, pid: null };
  return isTimesheetProcess(pid) ? { ...holder, pid } : { kind: 'foreign', pid, command: processCommand(pid) };
}

export async function probeHttp(port: number): Promise<PortHolder> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const v = await getJson(`${base}/api/version`);
    const body = v.body as { app?: string; version?: string; pid?: number; root?: string } | null;
    if (v.status === 200 && body?.app === 'timesheet') return { kind: 'timesheet', version: body.version ?? null, pid: body.pid ?? null, root: body.root ?? null };
    // Servers before 0.3.3 have no /api/version; /api/meta still tells them apart.
    const m = await getJson(`${base}/api/meta`);
    const meta = m.body as { categories?: unknown; target?: unknown } | null;
    if (m.status === 200 && Array.isArray(meta?.categories) && meta?.target !== undefined) return { kind: 'timesheet', version: null, pid: null };
    return { kind: 'foreign' };
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED' ? { kind: 'free' } : { kind: 'foreign' };
  }
}

function processCommand(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isTimesheetProcess(pid: number): boolean {
  const cmd = processCommand(pid);
  return /node/.test(cmd) && /timesheet(\.js|\.mjs|[/\\]src[/\\]cli\.ts)/.test(cmd);
}

/** The error for a port held by another program: what holds it and how to pick another port. */
export function portTakenMessage(port: number, holder: Extract<PortHolder, { kind: 'foreign' }>): string {
  const who = holder.pid ? ` (pid ${holder.pid}${holder.command ? `: ${holder.command.slice(0, 80)}` : ''})` : '';
  return `port ${port} is in use by another program${who}; stop it, or pick another port with --port <n> (or TIMESHEET_PORT=<n> for /timesheet open)`;
}

function listeningPid(port: number): number | null {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = Number(out.trim().split('\n')[0]);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Stops the timesheet server on `port` the way Ctrl+C would (running jobs resume on the next start) and waits for the port. */
export async function stopServer(port: number, holder: Extract<PortHolder, { kind: 'timesheet' }>): Promise<void> {
  // Only a pid the OS reported for this port and verified as timesheet is ever signalled.
  const pid = holder.pid;
  if (!pid) throw new Error(`an older server holds port ${port}; stop it (Ctrl+C in its terminal) or use --port`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    // already gone (another start stopped it first)
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
  // The server gives a submission browser up to 3 s to close before exiting.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if ((await probe(port)).kind === 'free') return;
  }
  throw new Error(`the server on port ${port} (pid ${pid}) did not stop; stop it by hand or use --port`);
}
