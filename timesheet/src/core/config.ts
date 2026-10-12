import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ruleProblems } from './submit/plan.ts';
import type { NetsuiteTarget, RedmineTarget, SubmitSystemConfig } from './submit/types.ts';

export const HOME = process.env.TIMESHEET_HOME ?? join(homedir(), '.timesheet');
export const CONFIG_PATH = join(HOME, 'config.json');
/** Working directory for `claude -p` classification calls; always excluded from collection. */
export const CLASSIFIER_CWD = join(HOME, 'classifier');

export interface Category {
  name: string;
  subtask: string;
  description: string;
  capex: boolean;
  /** When false the classifier never picks it; still usable in manual overrides. */
  classify?: boolean;
  validFrom?: string;
  validTo?: string;
  /** Colour in the calendar view: accent | info | good | warn | danger | conflict | working | waiting */
  tone?: string;
}

export interface ScopeRule {
  path: string;
  project?: string;
}

export interface Config {
  authorEmails: string[];
  /** Claude Code `projects` dirs; globs allowed; the default matches every ~/.claude-something profile */
  claudeDirs: string[];
  /** Read each profile's history.jsonl for sessions whose transcripts Claude Code already deleted */
  claudeHistory: boolean;
  /** Minutes credited after a prompt known only from history (no reply timing there) */
  historyTailMinutes: number;
  /** OpenCode data dirs (containing opencode.db and/or storage/); empty disables OpenCode */
  opencodeDirs: string[];
  projects: string[];
  defaultProject: string;
  scope: { work: ScopeRule[]; personal: string[] };
  /** Target hours for normalized output. weekdayTargets overrides per weekday (0=Sun..6=Sat); null = keep real hours. */
  target: number;
  weekdayTargets: Record<string, number | null>;
  gapMinutes: number;
  /** Assistant work more than this long after your last prompt ran unattended and is not counted; recorded time also stops at quiet gaps longer than this */
  idleMinutes: number;
  commitLeadMinutes: number;
  promptLeadMinutes: number;
  minBlockMinutes: number;
  rounding: number;
  decimalSeparator: '.' | ',';
  dateFormat: string;
  calendar: {
    enabled: boolean;
    calendarIds: string[];
    project?: string;
    includeTentative: boolean;
    /** Invitations you never answered */
    includeUnanswered: boolean;
    /** Meetings you declined (e.g. you joined anyway) */
    includeDeclined: boolean;
    skipWithoutAttendees: boolean;
    /** Longer meetings (blockers, conferences, all-afternoon holds) are ignored; 0 = no limit. */
    maxMeetingHours: number;
  };
  github: {
    enabled: boolean;
    /**
     * Repos to watch besides the ones you have cloned or touched on GitHub in the period, e.g. the
     * platform repo whose deployments you approve: "owner/name", or "owner/*" for every repo of an
     * owner pushed to in the month before.
     */
    repos: string[];
    /** Time credited before each action (an approval, a release, an issue…), like commitLeadMinutes */
    leadMinutes: number;
  };
  /** notes: extra guidance appended to the classification prompt, e.g. how your team splits Development vs Small Enhancements */
  classifier: { enabled: boolean; command: string; model: string; timeoutSeconds: number; concurrency: number; notes?: string };
  categories: Category[];
  /** Entering booked hours into Redmine (Worktime) and NetSuite (weekly timesheet) through the browser */
  submit: { redmine: SubmitSystemConfig<RedmineTarget>; netsuite: SubmitSystemConfig<NetsuiteTarget> };
}

export const DEFAULT_CATEGORIES: Category[] = [
  { name: 'Incident Management', subtask: 'Production incident handling', description: 'Fixing, troubleshooting, restoring service', capex: false },
  { name: 'Change Management', subtask: 'Operational changes', description: 'Patches, low-risk changes', capex: false },
  { name: 'Small Enhancements', subtask: 'Small enhancements', description: 'Minor improvements <8h', capex: false },
  { name: 'Medium Enhancements', subtask: 'Medium enhancements', description: 'Feature creation, redesign; < 10 days of work', capex: true },
  { name: 'Service Requests', subtask: 'User access & Configurations', description: 'Standard requests, access, config changes', capex: false },
  { name: 'Monitoring', subtask: 'System monitoring', description: 'Alert handling, log review', capex: false },
  { name: 'Backups', subtask: 'Backup testing', description: 'Restore tests, backup validation', capex: false },
  { name: 'Infrastructure (Build)', subtask: 'Environment build', description: 'Servers, cloud setups', capex: true },
  { name: 'Infrastructure (S&M)', subtask: 'Maintenance', description: 'Patching, tuning', capex: false },
  { name: 'Security (Build)', subtask: 'Hardening (asset-related)', description: 'IAM, encryption setup', capex: true },
  { name: 'Security (S&M)', subtask: 'Monitoring', description: 'Security alert handling', capex: false },
  { name: 'General', subtask: 'Generic work', description: 'Tasks that do not fit in the other descriptions', capex: false },
  { name: 'Training', subtask: 'Training', description: 'Learning & certifications', capex: false },
  { name: 'Admin/Analysis', subtask: '(Pre) work for project/request', description: 'Process, analysis, documentation, reporting', capex: false },
  { name: 'Requirements', subtask: 'Functional design', description: 'Workshops, analysis, documentation', capex: true },
  { name: 'Development', subtask: 'Build/configuration', description: 'Coding, scripting, config', capex: true },
  { name: 'Integration', subtask: 'API development', description: 'Interfaces, API work', capex: true },
  { name: 'Testing', subtask: 'System & integration testing', description: 'Test cases, execution', capex: true },
  { name: 'Deployment', subtask: 'Releases', description: 'Deployments, hypercare setup', capex: true },
  { name: 'Management', subtask: 'PM tasks', description: 'Status reporting, coordination', capex: false },
  {
    name: 'Team Meeting',
    subtask: 'General Team meeting',
    description: 'Team meeting with project workers about status, reporting. A meeting about development or testing is Development or Testing instead.',
    capex: false,
  },
  { name: 'Maintenance', subtask: 'Maintenance (legacy)', description: 'Legacy task, available until end of 2026', capex: false, classify: false, validTo: '2026-12-31' },
];

export function defaultConfig(): Config {
  return {
    authorEmails: [],
    claudeDirs: [
      ...new Set([
        '~/.claude*/projects',
        ...(process.env.CLAUDE_CONFIG_DIR ? [join(contractHome(expandHome(process.env.CLAUDE_CONFIG_DIR)), 'projects')] : []),
      ]),
    ],
    claudeHistory: true,
    historyTailMinutes: 10,
    opencodeDirs: [join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode')],
    projects: ['Default'],
    defaultProject: 'Default',
    scope: { work: [], personal: [] },
    target: 8,
    weekdayTargets: { '0': null, '6': null },
    gapMinutes: 30,
    idleMinutes: 10,
    commitLeadMinutes: 15,
    promptLeadMinutes: 2,
    minBlockMinutes: 15,
    rounding: 0.25,
    decimalSeparator: '.',
    dateFormat: 'YYYY-MM-DD',
    calendar: { enabled: false, calendarIds: ['primary'], includeTentative: true, includeUnanswered: true, includeDeclined: false, skipWithoutAttendees: true, maxMeetingHours: 4 },
    github: { enabled: false, repos: [], leadMinutes: 10 },
    classifier: { enabled: true, command: 'claude', model: 'sonnet', timeoutSeconds: 240, concurrency: 3 },
    categories: DEFAULT_CATEGORIES,
    submit: { redmine: { url: '', fillOnly: true, rules: [] }, netsuite: { url: '', fillOnly: true, rules: [] } },
  };
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function loadConfig(): Config {
  const base = defaultConfig();
  if (!existsSync(CONFIG_PATH)) return base;
  const user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config> & { hintRules?: unknown };
  delete user.hintRules; // removed setting
  return {
    ...base,
    ...user,
    scope: { ...base.scope, ...user.scope },
    calendar: { ...base.calendar, ...user.calendar },
    github: { ...base.github, ...user.github },
    classifier: { ...base.classifier, ...user.classifier },
    submit: {
      redmine: { ...base.submit.redmine, ...user.submit?.redmine },
      netsuite: { ...base.submit.netsuite, ...user.submit?.netsuite },
    },
  };
}

export const TONES = ['accent', 'info', 'good', 'warn', 'danger', 'conflict', 'working', 'waiting'];

const DEFAULT_TONES: Record<string, string> = {
  Development: 'accent',
  'Medium Enhancements': 'accent',
  'Small Enhancements': 'accent',
  Integration: 'accent',
  Testing: 'working',
  Deployment: 'conflict',
  'Team Meeting': 'info',
  Management: 'info',
  'Incident Management': 'danger',
  'Security (S&M)': 'danger',
  'Security (Build)': 'danger',
  Requirements: 'warn',
  'Admin/Analysis': 'warn',
  Training: 'good',
};

/** The category's configured tone, or a sensible default for the calendar view. */
export function categoryTone(c: Category): string {
  return c.tone || DEFAULT_TONES[c.name] || (c.capex ? 'good' : 'waiting');
}

/**
 * Fingerprint of every setting that changes how a day is computed (sources, timing,
 * identity, calendars, categories). Cached days with another key are recomputed.
 */
export const SCHEMA = 7;

export function computeKey(c: Config, schema = SCHEMA): string {
  const relevant = {
    // Bumped when computed days gain new fields (3: block and item summaries, sessions, commits; 4: personal/unassigned activity; 5: measured minutes; 6: commit changes and assistant tool use; 7: unattended agent time and the future left out).
    schema,
    claude: expandDirs(c.claudeDirs),
    history: c.claudeHistory,
    tail: c.historyTailMinutes,
    opencode: c.opencodeDirs,
    emails: c.authorEmails,
    timing: [c.gapMinutes, c.commitLeadMinutes, c.promptLeadMinutes, c.minBlockMinutes, c.idleMinutes],
    // Reply settings only when changed from the old behaviour (unanswered counted, declined not), so cached days keep their key.
    calendar: c.calendar.enabled ? [c.calendar.calendarIds, c.calendar.includeTentative, c.calendar.skipWithoutAttendees, c.calendar.project, c.calendar.maxMeetingHours, ...(c.calendar.includeUnanswered && !c.calendar.includeDeclined ? [] : [c.calendar.includeUnanswered, c.calendar.includeDeclined])] : null,
    categories: c.categories.map((x) => [x.name, x.classify !== false, x.validFrom, x.validTo]),
    classifier: c.classifier.enabled ? [c.classifier.model, c.classifier.notes ?? ''] : null,
    // Only present when on, so days computed before GitHub existed keep their key.
    ...(c.github.enabled ? { github: [c.github.repos, c.github.leadMinutes] } : {}),
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/** Human-readable problems with a config, empty when it is valid. */
export function validateConfig(c: Config): string[] {
  const errors: string[] = [];
  const isNum = (v: unknown, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min;
  const isDate = (v: unknown) => v === undefined || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

  if (!Array.isArray(c.authorEmails) || c.authorEmails.some((e) => typeof e !== 'string')) errors.push('authorEmails must be a list of strings');
  if (!Array.isArray(c.claudeDirs) || c.claudeDirs.some((d) => typeof d !== 'string' || !d.trim())) errors.push('claudeDirs must be a list of directories');
  if (!Array.isArray(c.opencodeDirs) || c.opencodeDirs.some((d) => typeof d !== 'string' || !d.trim())) errors.push('opencodeDirs must be a list of directories');
  if (!Array.isArray(c.projects) || !c.projects.length || c.projects.some((p) => !p?.trim())) errors.push('projects needs at least one non-empty name');
  else if (new Set(c.projects).size !== c.projects.length) errors.push('project names must be unique');
  if (!c.projects?.includes(c.defaultProject)) errors.push(`defaultProject "${c.defaultProject}" is not in projects`);

  for (const r of c.scope?.work ?? []) {
    if (!r.path?.trim()) errors.push('a work scope rule has an empty path');
    if (r.project && !c.projects?.includes(r.project)) errors.push(`work scope ${r.path} uses unknown project "${r.project}"`);
  }
  if ((c.scope?.personal ?? []).some((p) => !p?.trim())) errors.push('a personal scope rule has an empty path');

  if (!isNum(c.target)) errors.push('target must be a number ≥ 0');
  for (const [k, v] of Object.entries(c.weekdayTargets ?? {})) {
    if (!/^[0-6]$/.test(k)) errors.push(`weekdayTargets key "${k}" must be 0 (Sun) … 6 (Sat)`);
    if (v !== null && !isNum(v)) errors.push(`weekdayTargets.${k} must be a number ≥ 0 or null`);
  }
  for (const k of ['gapMinutes', 'idleMinutes', 'commitLeadMinutes', 'promptLeadMinutes', 'minBlockMinutes', 'historyTailMinutes'] as const) if (!isNum(c[k])) errors.push(`${k} must be a number ≥ 0`);
  if (!isNum(c.calendar?.maxMeetingHours)) errors.push('calendar.maxMeetingHours must be a number ≥ 0');
  if (!isNum(c.rounding) || c.rounding <= 0 || c.rounding > 8) errors.push('rounding must be between 0 and 8 hours');
  if (c.decimalSeparator !== '.' && c.decimalSeparator !== ',') errors.push('decimalSeparator must be "." or ","');
  if (!['YYYY', 'MM', 'DD'].every((t) => c.dateFormat?.includes(t))) errors.push('dateFormat must contain YYYY, MM and DD');

  if (!Array.isArray(c.calendar?.calendarIds)) errors.push('calendar.calendarIds must be a list');
  for (const k of ['includeTentative', 'includeUnanswered', 'includeDeclined', 'skipWithoutAttendees'] as const)
    if (c.calendar && typeof c.calendar[k] !== 'boolean') errors.push(`calendar.${k} must be true or false`);
  if (c.calendar?.project && !c.projects?.includes(c.calendar.project)) errors.push(`calendar.project "${c.calendar.project}" is not in projects`);

  if (!Array.isArray(c.github?.repos) || c.github.repos.some((r) => typeof r !== 'string' || !/^[\w.-]+\/(\*|[\w.-]+)$/.test(r)))
    errors.push('github.repos entries must look like owner/name or owner/*');
  if (!isNum(c.github?.leadMinutes)) errors.push('github.leadMinutes must be a number ≥ 0');

  if (!c.classifier?.command?.trim()) errors.push('classifier.command is required');
  if (!c.classifier?.model?.trim()) errors.push('classifier.model is required');
  if (!isNum(c.classifier?.timeoutSeconds, 10)) errors.push('classifier.timeoutSeconds must be ≥ 10');
  if (!isNum(c.classifier?.concurrency, 1)) errors.push('classifier.concurrency must be ≥ 1');

  const names = new Set<string>();
  for (const cat of c.categories ?? []) {
    if (!cat.name?.trim()) errors.push('a category has an empty name');
    else if (names.has(cat.name)) errors.push(`category "${cat.name}" is listed twice`);
    names.add(cat.name);
    if (!isDate(cat.validFrom) || !isDate(cat.validTo)) errors.push(`category "${cat.name}" has an invalid validFrom/validTo (use YYYY-MM-DD)`);
    if (cat.tone && !TONES.includes(cat.tone)) errors.push(`category "${cat.name}" has unknown tone "${cat.tone}"`);
  }
  if (!names.size) errors.push('at least one category is required');
  if (c.categories?.length && !c.categories.some((x) => x.name === 'General')) errors.push('keep a "General" category: it is the fallback for unclassifiable work');

  for (const system of ['redmine', 'netsuite'] as const) {
    const s = c.submit?.[system];
    if (!s) {
      errors.push(`submit.${system} is missing`);
      continue;
    }
    if (s.url && !/^https:\/\/[^/\s]+/.test(s.url)) errors.push(`submit.${system}.url must start with https://`);
    // Worktime acts on GET parameters (ticket_del, set_holiday, memo, …): the address must not carry any. NetSuite's query is meaningful.
    if (system === 'redmine' && typeof s.url === 'string' && /[?#]/.test(s.url)) errors.push('submit.redmine.url must not contain ?… or #…; use https://host/work_time/index');
    if (typeof s.fillOnly !== 'boolean') errors.push(`submit.${system}.fillOnly must be true or false`);
    errors.push(...ruleProblems(system, s.rules));
    if (!Array.isArray(s.rules)) continue;
    for (const r of s.rules as unknown[]) {
      if (typeof r !== 'object' || r === null) continue;
      const { project, category } = r as { project?: unknown; category?: unknown };
      if (typeof project === 'string' && !c.projects?.includes(project)) errors.push(`submit.${system} rule uses unknown project "${project}"`);
      if (typeof category === 'string' && category !== '*' && !c.categories?.some((x) => x.name === category)) errors.push(`submit.${system} rule uses unknown category "${category}"`);
    }
  }

  return errors;
}

export function saveConfig(config: Config): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Expands directory globs (`*` within a path segment, e.g. ~/.claude*\/projects) to the
 * existing directories they match. Plain paths are returned as-is when they exist.
 */
export function expandDirs(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const parts = expandHome(pattern).split('/');
    let bases = [parts[0] === '' ? '/' : parts[0]];
    for (const part of parts.slice(1)) {
      if (!part) continue;
      if (!part.includes('*')) {
        bases = bases.map((b) => join(b, part));
        continue;
      }
      const re = new RegExp(`^${part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      bases = bases.flatMap((b) => {
        try {
          return readdirSync(b, { withFileTypes: true }).filter((d) => d.isDirectory() && re.test(d.name)).map((d) => join(b, d.name));
        } catch {
          return [];
        }
      });
    }
    for (const b of bases) if (existsSync(b)) out.add(b);
  }
  return [...out].sort();
}

export function contractHome(p: string): string {
  const h = homedir();
  return p === h || p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
}

export function categoriesFor(config: Config, date: string): Category[] {
  return config.categories.filter(
    (c) => (!c.validFrom || c.validFrom <= date) && (!c.validTo || c.validTo >= date),
  );
}

export function targetFor(config: Config, date: string, override?: number): number | null {
  if (override !== undefined) return override;
  const wd = String(new Date(`${date}T12:00:00`).getDay());
  return wd in config.weekdayTargets ? config.weekdayTargets[wd] : config.target;
}
