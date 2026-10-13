import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Runs Claude Code headlessly for classification.
 *
 * `command` may be a binary on PATH (`claude`), a path, or a shell function/alias such
 * as a profile wrapper (`claude-work`) that exports CLAUDE_CONFIG_DIR and auth/routing
 * variables before calling `claude`. Functions only exist in an interactive shell, so
 * those run through `$SHELL -ic` and set up auth exactly as when typed; timesheet never
 * reads or stores their credentials.
 */

export interface Invocation {
  file: string;
  args: string[];
  viaShell: boolean;
}

function onPath(cmd: string): boolean {
  const candidates = cmd.includes('/') ? [cmd] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, cmd));
  return candidates.some((f) => {
    try {
      accessSync(f, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function userShell(): string {
  return process.env.SHELL || '/bin/zsh';
}

export function resolveInvocation(command: string, args: string[]): Invocation {
  const cmd = command.trim();
  if (!/\s/.test(cmd) && onPath(cmd)) return { file: cmd, args, viaShell: false };
  // `$0` is the label; "$@" forwards the real arguments without any quoting games.
  return { file: userShell(), args: ['-ic', `${cmd} "$@"`, 'timesheet-classifier', ...args], viaShell: true };
}

function commandQuery(): { shell: string; script: string; zsh: boolean } | null {
  const shell = userShell();
  if (/zsh$/.test(shell)) return { shell, script: 'print -l ${(k)functions[(I)claude*]} ${(k)aliases[(I)claude*]}', zsh: true };
  if (/bash$/.test(shell)) return { shell, script: 'compgen -A function -A alias claude', zsh: false };
  return null;
}

function commandNames(stdout: string): string[] {
  const found = new Set<string>();
  if (onPath('claude')) found.add('claude');
  for (const name of stdout.split('\n').map((s) => s.trim())) if (/^claude[\w-]*$/.test(name) && !name.endsWith('-sync')) found.add(name);
  return [...found].sort();
}

/** Claude commands the user's shell knows: `claude` plus functions/aliases named claude*. */
export function listClaudeCommands(): string[] {
  const q = commandQuery();
  const r = q ? spawnSync(q.shell, ['-ic', q.script], { encoding: 'utf8', timeout: 10_000 }) : null;
  return commandNames(r?.stdout ?? '');
}

/** Same as listClaudeCommands without blocking (an interactive shell can take a second to start). */
export function listClaudeCommandsAsync(): Promise<string[]> {
  const q = commandQuery();
  if (!q) return Promise.resolve(commandNames(''));
  return new Promise((resolve) => {
    const child = spawn(q.shell, ['-ic', q.script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      resolve(commandNames(out));
    });
  });
}

/**
 * The `--output-format json` envelope. Interactive shells may print their own lines
 * (version managers, banners) before it, so scan for the result object.
 */
export function parseEnvelope(stdout: string): { result: string; isError: boolean } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && 'result' in e) return { result: String(e.result ?? ''), isError: !!e.is_error };
    } catch {
      /* not the envelope */
    }
  }
  throw new Error(`no result in Claude output${stdout.trim() ? `: ${stdout.trim().slice(0, 200)}` : ''}`);
}

export interface RunOptions {
  command: string;
  model: string;
  cwd: string;
  timeoutSeconds: number;
  /** Aborting kills the Claude process (pause / cancel) */
  signal?: AbortSignal;
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function runClaude(prompt: string, opts: RunOptions): Promise<string> {
  const inv = resolveInvocation(opts.command, ['-p', '--output-format', 'json', '--model', opts.model]);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    mkdirSync(opts.cwd, { recursive: true });
    const child = spawn(inv.file, inv.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`"${opts.command}" timed out after ${opts.timeoutSeconds}s`));
    }, opts.timeoutSeconds * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new Error(`could not run "${opts.command}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) return reject(abortError());
      try {
        const env = parseEnvelope(out);
        if (env.isError) throw new Error(env.result || `exit ${code}`);
        resolve(env.result);
      } catch (e) {
        const hint = inv.viaShell && /command not found|not found/.test(err) ? ` ("${opts.command}" is not a command or function in ${userShell()})` : '';
        reject(new Error(`${(e as Error).message}${hint}${err.trim() ? ` [stderr: ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}]` : ''}`));
      }
    });
    child.stdin.on('error', () => {}); // the process may exit (or be killed) before reading everything
    child.stdin.end(prompt);
  });
}
