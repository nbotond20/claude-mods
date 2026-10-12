import type { CommitRef, FileChange, SessionWork } from './types.ts';

/** What part of a codebase a file belongs to, so the classifier can tell building from maintaining. */
export type FileArea = 'deps' | 'ci' | 'infra' | 'test' | 'docs' | 'config' | 'generated' | 'code';

const AREA_RULES: [FileArea, RegExp][] = [
  ['deps', /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock|renovate\.json5?|\.nvmrc|\.node-version|\.tool-versions)$/],
  ['ci', /(^|\/)(\.github\/(workflows|actions)\/|\.gitlab-ci|\.circleci\/|azure-pipelines|Jenkinsfile|\.husky\/|lefthook|\.pre-commit)/],
  ['infra', /(^|\/)(Dockerfile|docker-compose|\.dockerignore|helm\/|charts\/|k8s\/|kubernetes\/|terraform\/|infra\/|deploy(ment)?\/|pulumi|serverless\.ya?ml)|\.tf(vars)?$/i],
  ['test', /(^|\/)(__tests__|tests?|e2e|spec|cypress|playwright)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/],
  ['docs', /\.(md|mdx|rst|adoc)$|(^|\/)docs?\//i],
  ['generated', /(\.generated\.|\.gen\.|__generated__\/|(^|\/)generated\/|\.snap$|\.min\.(js|css)$)/],
  ['config', /(^|\/)(package\.json|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|vite\.config\.[cm]?[jt]s|\.env[^/]*|[^/]+\.config\.[cm]?[jt]s)$|\.(ya?ml|toml|ini)$/],
];

export function fileArea(path: string): FileArea {
  for (const [area, re] of AREA_RULES) if (re.test(path)) return area;
  return 'code';
}

/** Conventional-commit type (`feat`, `fix`, …) or a keyword the subject starts with; `other` when none. */
export function commitType(subject: string): string {
  const s = subject.trim();
  const cc = /^([a-z]+)(\([^)]*\))?!?:/i.exec(s);
  if (cc) return cc[1].toLowerCase();
  if (/^revert\b/i.test(s)) return 'revert';
  if (/^(bump|update|upgrade|pin)\b.*\b(dependenc|version|to v?\d)/i.test(s) || /^(pin|update) dependenc/i.test(s)) return 'deps';
  if (/^(hot)?fix(es|ed)?\b/i.test(s)) return 'fix';
  if (/^(add|implement|introduce|create|support)\b/i.test(s)) return 'feat';
  return 'other';
}

const MAX_FILES = 8;

/** Summary of what some commits changed, compact enough for the classifier prompt. */
export function describeChanges(commits: CommitRef[]) {
  if (!commits.length) return undefined;
  const types: Record<string, number> = {};
  const churn = new Map<string, number>();
  let added = 0;
  let removed = 0;
  for (const c of commits) {
    const t = commitType(c.subject);
    types[t] = (types[t] ?? 0) + 1;
    added += c.added ?? 0;
    removed += c.removed ?? 0;
    for (const f of c.files ?? []) churn.set(f.path, (churn.get(f.path) ?? 0) + f.added + f.removed);
  }
  // Distinct files per area
  const areas: Record<string, number> = {};
  for (const p of churn.keys()) areas[fileArea(p)] = (areas[fileArea(p)] ?? 0) + 1;
  const newFiles = new Set(commits.flatMap((c) => (c.files ?? []).filter((f) => f.isNew).map((f) => f.path))).size;
  return {
    commits: commits.length,
    types,
    lines: `+${added}/-${removed}`,
    ...(churn.size ? { fileAreas: areas, newFiles, topFiles: [...churn].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES).map(([p]) => p) } : {}),
  };
}

/** One tool call of an AI assistant, reduced to what says what kind of work it was. */
export interface ToolUse {
  kind: 'edit' | 'read' | 'shell' | 'web' | 'other';
  file?: string;
  added?: number;
  removed?: number;
  /** Program + subcommand of a shell command */
  command?: string;
}

const lineCount = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0);

/** First program and subcommand of a shell command (`pnpm test`, `kubectl logs`); arguments are dropped so no secrets leak. */
export function commandName(cmd: string): string | undefined {
  // The first command that is not just changing directory
  const first = cmd.trim().split(/\s*(?:&&|\|\||;|\|)\s*/).find((c) => !/^cd(\s|$)/.test(c)) ?? '';
  const words = first.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w) && w !== 'sudo' && w !== 'npx');
  const prog = words[0]?.split('/').pop();
  if (!prog || !/^[\w.-]+$/.test(prog)) return undefined;
  const sub = words[1] && /^[a-z][\w:-]*$/.test(words[1]) ? ` ${words[1]}` : '';
  return prog + sub;
}

/** A Claude Code (or OpenCode) tool call by name and input. */
export function toolUse(name: string, input: any): ToolUse {
  const n = name.toLowerCase();
  const file = input?.file_path ?? input?.filePath ?? input?.notebook_path ?? input?.path;
  if (n === 'edit' || n === 'str_replace' || n === 'patch')
    return { kind: 'edit', file, added: lineCount(input?.new_string ?? input?.newString), removed: lineCount(input?.old_string ?? input?.oldString) };
  if (n === 'multiedit')
    return {
      kind: 'edit',
      file,
      added: (input?.edits ?? []).reduce((s: number, e: any) => s + lineCount(e?.new_string), 0),
      removed: (input?.edits ?? []).reduce((s: number, e: any) => s + lineCount(e?.old_string), 0),
    };
  if (n === 'write') return { kind: 'edit', file, added: lineCount(input?.content), removed: 0 };
  if (n === 'notebookedit') return { kind: 'edit', file, added: lineCount(input?.new_source), removed: 0 };
  if (['read', 'grep', 'glob', 'ls', 'list', 'lsp'].includes(n)) return { kind: 'read' };
  if (n === 'bash' || n === 'shell') return { kind: 'shell', command: typeof input?.command === 'string' ? commandName(input.command) : undefined };
  if (n.startsWith('web') || n.includes('fetch') || n.includes('search')) return { kind: 'web' };
  return { kind: 'other' };
}

const MAX_EDITS = 15;
const MAX_COMMANDS = 12;

const relative = (file: string, cwd?: string) => (cwd && file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file);

/** Tool calls of one span, summed up. Undefined when the assistant used no tools. */
export function sessionWork(tools: ToolUse[], cwd?: string): SessionWork | undefined {
  if (!tools.length) return undefined;
  const edits = new Map<string, FileChange>();
  const commands = new Set<string>();
  let reads = 0, shell = 0, web = 0;
  for (const t of tools) {
    if (t.kind === 'edit' && t.file) {
      const path = relative(t.file, cwd);
      const f = edits.get(path) ?? { path, added: 0, removed: 0 };
      edits.set(path, { ...f, added: f.added + (t.added ?? 0), removed: f.removed + (t.removed ?? 0) });
    } else if (t.kind === 'read') reads++;
    else if (t.kind === 'shell') {
      shell++;
      if (t.command) commands.add(t.command);
    } else if (t.kind === 'web') web++;
  }
  return { edits: topEdits([...edits.values()]), reads, shell, web, commands: [...commands].slice(0, MAX_COMMANDS) };
}

const topEdits = (files: FileChange[]) => files.sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, MAX_EDITS);

export function mergeWork(a?: SessionWork, b?: SessionWork): SessionWork | undefined {
  if (!a || !b) return a ?? b;
  const edits = new Map(a.edits.map((f) => [f.path, f]));
  for (const f of b.edits) {
    const e = edits.get(f.path);
    edits.set(f.path, e ? { path: f.path, added: e.added + f.added, removed: e.removed + f.removed } : f);
  }
  return {
    edits: topEdits([...edits.values()]),
    reads: a.reads + b.reads,
    shell: a.shell + b.shell,
    web: a.web + b.web,
    commands: [...new Set([...a.commands, ...b.commands])].slice(0, MAX_COMMANDS),
  };
}

/** What the assistant did, for the classifier: whether code was written, where, and which commands ran. */
export function describeWork(w?: SessionWork) {
  if (!w) return undefined;
  const added = w.edits.reduce((n, f) => n + f.added, 0);
  const removed = w.edits.reduce((n, f) => n + f.removed, 0);
  const areas: Record<string, number> = {};
  for (const f of w.edits) areas[fileArea(f.path)] = (areas[fileArea(f.path)] ?? 0) + 1;
  return {
    filesEdited: w.edits.length,
    ...(w.edits.length ? { linesWritten: `+${added}/-${removed}`, fileAreas: areas, topFiles: w.edits.slice(0, MAX_FILES).map((f) => f.path) } : {}),
    toolCalls: { reads: w.reads, shell: w.shell, web: w.web },
    ...(w.commands.length ? { commands: w.commands } : {}),
  };
}
