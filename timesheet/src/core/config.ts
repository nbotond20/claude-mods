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
  /** What the category stands for in classification and its evidence checks; see CATEGORY_ROLES. */
  role?: CategoryRole;
}

/**
 * Roles tie a company's own category names to the built-in behaviour:
 * - work / meeting: the default for work blocks / meetings (without classification, or when it fails),
 * - fallback: work that fits nowhere else,
 * - no-code: analysis, meetings, planning; never claims time in which code was written,
 * - deploy: releasing; capped at the time its release events take,
 * - incident: production problems; needs a sign of one in the prompts, commits or branches.
 */
export const CATEGORY_ROLES = ['work', 'meeting', 'fallback', 'no-code', 'deploy', 'incident'] as const;
export type CategoryRole = (typeof CATEGORY_ROLES)[number];
/** Roles at most one category may have. */
export const SINGLE_ROLES: CategoryRole[] = ['work', 'meeting', 'fallback'];

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
  /** Public holidays and other days off (YYYY-MM-DD): no target, so any work there is booked as real rounded hours */
  holidays: string[];
  /** A workday with recorded work below this share of its target is flagged and needs confirming before submission; 0 = off */
  lowActivityRatio: number;
  /** IANA time zone the days are cut in (e.g. Europe/Budapest); empty = the system's */
  timezone: string;
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
  /** notes: extra guidance appended to the classification prompt, e.g. how your team tells two similar categories apart */
  classifier: { enabled: boolean; command: string; model: string; timeoutSeconds: number; concurrency: number; notes?: string };
  categories: Category[];
  /** Entering booked hours into Redmine (Worktime) and NetSuite (weekly timesheet) through the browser */
  submit: { redmine: SubmitSystemConfig<RedmineTarget>; netsuite: SubmitSystemConfig<NetsuiteTarget> };
}

/** Empty: task categories are company specific; add them in Settings or paste your list there. */
export const DEFAULT_CATEGORIES: Category[] = [];

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
    holidays: [],
    lowActivityRatio: 0.5,
    timezone: '',
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

const ROLE_TONES: Partial<Record<CategoryRole, string>> = { work: 'accent', meeting: 'info', incident: 'danger', deploy: 'conflict', 'no-code': 'warn' };

/** The category's configured tone, or a sensible default for the calendar view. */
export function categoryTone(c: Category): string {
  return c.tone || (c.role && ROLE_TONES[c.role]) || (c.capex ? 'good' : 'waiting');
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
    categories: c.categories.map((x) => [x.name, x.classify !== false, x.validFrom, x.validTo, ...(x.role ? [x.role] : [])]),
    classifier: c.classifier.enabled ? [c.classifier.model, c.classifier.notes ?? ''] : null,
    // Only present when on, so days computed before GitHub existed keep their key.
    ...(c.github.enabled ? { github: [c.github.repos, c.github.leadMinutes] } : {}),
    // Day bounds move with the time zone; only present when set, so existing keys hold.
    ...(c.timezone ? { timezone: c.timezone } : {}),
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
  if (!Array.isArray(c.holidays) || c.holidays.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) errors.push('holidays must be a list of dates (YYYY-MM-DD)');
  if (!isNum(c.lowActivityRatio) || c.lowActivityRatio > 1) errors.push('lowActivityRatio must be between 0 and 1');
  if (typeof c.timezone !== 'string' || (c.timezone && !validTimezone(c.timezone))) errors.push(`timezone "${c.timezone}" is not a known time zone (e.g. Europe/Budapest), or leave it empty`);
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
    if (cat.role !== undefined && !CATEGORY_ROLES.includes(cat.role)) errors.push(`category "${cat.name}" has unknown role "${cat.role}" (${CATEGORY_ROLES.join(', ')})`);
  }
  for (const role of SINGLE_ROLES) {
    const holders = (c.categories ?? []).filter((x) => x.role === role).map((x) => `"${x.name}"`);
    if (holders.length > 1) errors.push(`only one category can have the ${role} role (${holders.join(', ')})`);
  }

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

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Cuts days in the configured time zone (process-wide: every date helper uses local time). */
export function applyTimezone(config: Config): void {
  if (config.timezone && validTimezone(config.timezone)) process.env.TZ = config.timezone;
}

export function isHoliday(config: Config, date: string): boolean {
  return (config.holidays ?? []).includes(date);
}

export function targetFor(config: Config, date: string, override?: number): number | null {
  if (override !== undefined) return override;
  if (isHoliday(config, date)) return null;
  const wd = String(new Date(`${date}T12:00:00`).getDay());
  return wd in config.weekdayTargets ? config.weekdayTargets[wd] : config.target;
}
