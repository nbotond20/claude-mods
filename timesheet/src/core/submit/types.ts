export type SystemId = 'redmine' | 'netsuite';
export const SYSTEMS: SystemId[] = ['redmine', 'netsuite'];

/** A row in Redmine Worktime: the issue (by ID, never by position) and the activity to select. */
export interface RedmineTarget {
  issueId: number;
  activity: string;
}

/** A row in the NetSuite weekly timesheet: option texts of the project and task selects. */
export interface NetsuiteTarget {
  project: string;
  task: string;
}

export interface TargetOf {
  redmine: RedmineTarget;
  netsuite: NetsuiteTarget;
}

/** Maps booked (project, category) to a row on the site. category "*" = any category of that project; an exact rule wins. */
export interface SubmitRule<T> {
  project: string;
  category: string;
  target: T;
}

export interface SubmitSystemConfig<T> {
  /** Start page, e.g. https://redmine.example.com/work_time/index or the NetSuite account URL */
  url: string;
  /** Fill and verify the inputs but leave Update/Save to the user */
  fillOnly: boolean;
  rules: SubmitRule<T>[];
}

/** Hours for one row on one day. */
export interface Cell<T> {
  date: string;
  target: T;
  hours: number;
}

export interface Plan<T> {
  system: SystemId;
  /** Monday of the week */
  week: string;
  /** Non-zero cells only, sorted by date then target */
  cells: Cell<T>[];
  /** Shown in review, do not block (e.g. "2026-10-01 is today") */
  notes: string[];
}

export type PlanResult<T> = { ok: true; plan: Plan<T> } | { ok: false; reasons: string[] };

/** Every non-zero value the site holds in the week, on any row (also rows we do not manage). */
export interface Snapshot<T> {
  week: string;
  cells: Cell<T>[];
}

export type Diff<T> =
  | { kind: 'noop' }
  | { kind: 'write'; cells: Cell<T>[]; unchanged: number }
  | { kind: 'conflict'; reasons: string[] };
