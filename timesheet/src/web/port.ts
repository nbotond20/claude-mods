import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../core/paths.ts';

export const APP_VERSION: string = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version;

/** What holds a port: nothing, a timesheet server (version null when it predates /api/version), or something else. */
export type PortHolder = { kind: 'free' } | { kind: 'timesheet'; version: string | null; pid: number | null } | { kind: 'foreign' };

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

export async function probe(port: number): Promise<PortHolder> {
  const base = `http://127.0.0.1:${port}`;
  try {
    const v = await getJson(`${base}/api/version`);
    const body = v.body as { app?: string; version?: string; pid?: number } | null;
    if (v.status === 200 && body?.app === 'timesheet') return { kind: 'timesheet', version: body.version ?? null, pid: body.pid ?? null };
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
  const pid = holder.pid ?? listeningPid(port);
  if (!pid) throw new Error(`an older server holds port ${port}; stop it (Ctrl+C in its terminal) or use --port`);
  process.kill(pid, 'SIGTERM');
  // The server gives a submission browser up to 3 s to close before exiting.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if ((await probe(port)).kind === 'free') return;
  }
  throw new Error(`the server on port ${port} (pid ${pid}) did not stop; stop it by hand or use --port`);
}
