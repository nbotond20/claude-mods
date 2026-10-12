import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from '../config.ts';
import type { Config } from '../config.ts';
import type { CommitChange, FileChange, RawEvent } from '../types.ts';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const toplevelCache = new Map<string, string | null>();

const remoteCache = new Map<string, string | null>();

/** Web URL of a repo's origin (GitHub, GitLab, Bitbucket and similar), or null. */
export function repoWebUrl(repo: string): string | null {
  if (!remoteCache.has(repo)) {
    const raw = git(['-C', repo, 'remote', 'get-url', 'origin'])?.trim() ?? '';
    const m = /^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+?)(?:\.git)?$/.exec(raw) ?? /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
    remoteCache.set(repo, m ? `https://${m[1]}/${m[2]}` : null);
  }
  return remoteCache.get(repo)!;
}

export function repoRoot(path: string): string | null {
  if (!toplevelCache.has(path)) {
    toplevelCache.set(path, existsSync(path) ? (git(['-C', path, 'rev-parse', '--show-toplevel'])?.trim() || null) : null);
  }
  return toplevelCache.get(path)!;
}

/** Git repos under a directory, down to `depth` levels. */
export function scanRepos(dir: string, depth = 3): string[] {
  if (!existsSync(dir)) return [];
  if (existsSync(join(dir, '.git'))) return [dir];
  if (depth === 0) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') out.push(...scanRepos(join(dir, d.name), depth - 1));
  }
  return out;
}

/** Repos to read: roots of the given paths plus repos under the literal prefix of each work scope rule. */
export function discoverRepos(config: Config, paths: string[]): string[] {
  const repos = new Set<string>();
  for (const p of paths) {
    const r = repoRoot(p);
    if (r) repos.add(r);
  }
  for (const rule of config.scope.work) {
    const prefix = expandHome(rule.path).replace(/\/?\*.*$/, '');
    for (const r of scanRepos(prefix)) repos.add(r);
  }
  return [...repos];
}

function authorsFor(config: Config, repo: string): string[] {
  if (config.authorEmails.length) return config.authorEmails;
  const email = git(['-C', repo, 'config', '--get', 'user.email'])?.trim();
  return email ? [email] : [];
}

export const MAX_COMMIT_FILES = 15;

/** `--numstat --summary` lines of one commit: line counts, the most-changed files and which were created. */
export function parseStat(lines: string[]): CommitChange {
  const files: FileChange[] = [];
  const created = new Set<string>();
  for (const line of lines) {
    const num = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    // Renames show as `dir/{old => new}/file` or `old => new`; keep the new name.
    if (num) files.push({ path: num[3].replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/'), added: Number(num[1]) || 0, removed: Number(num[2]) || 0 });
    const mode = /^ create mode \d+ (.+)$/.exec(line);
    if (mode) created.add(mode[1]);
  }
  return {
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    files: files
      .map((f) => (created.has(f.path) ? { ...f, isNew: true } : f))
      .sort((a, b) => b.added + b.removed - (a.added + a.removed))
      .slice(0, MAX_COMMIT_FILES),
  };
}

export function collectGit(config: Config, repos: string[], from: number, to: number): RawEvent[] {
  const lead = config.commitLeadMinutes * 60_000;
  const seen = new Set<string>();
  const out: RawEvent[] = [];
  for (const repo of repos) {
    const authors = authorsFor(config, repo);
    if (!authors.length) continue;
    const log = git([
      '-C', repo, 'log', '--all', '--no-merges', '--source',
      `--since=${new Date(from - 2 * 86_400_000).toISOString()}`,
      `--until=${new Date(to + 86_400_000).toISOString()}`,
      ...authors.map((a) => `--author=${a}`),
      '--format=%x1e%H%x1f%at%x1f%S%x1f%s', '--numstat', '--summary',
    ]);
    if (!log) continue;
    for (const record of log.split('\x1e')) {
      const [header, ...rest] = record.split('\n');
      const [hash, at, source, subject] = header.split('\x1f');
      if (!hash || seen.has(hash)) continue;
      const t = Number(at) * 1000;
      if (t < from || t >= to) continue;
      seen.add(hash);
      const branch = (source ?? '').replace(/^refs\/(heads|remotes\/[^/]+|tags)\//, '');
      out.push({ source: 'git', start: Math.max(from, t - lead), end: t, measured: [], path: repo, branch, texts: [subject ?? ''], commit: hash, change: parseStat(rest) });
    }
  }
  return out;
}
