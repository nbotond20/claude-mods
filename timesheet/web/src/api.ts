import type { Category, Config } from '../../src/core/config.ts';
import type { Block, BlockItem, CommitRef, DayReport, Entry, OtherBlock, SessionRef } from '../../src/core/types.ts';
import type { SystemId } from '../../src/core/submit/types.ts';

export type { Block, BlockItem, Category, CommitRef, Config, DayReport, Entry, OtherBlock, SessionRef };

export interface Meta {
  today: string;
  target: number;
  rounding: number;
  /** How the export writes dates, e.g. MM/DD/YYYY */
  dateFormat: string;
  projects: string[];
  defaultProject: string;
  /** `hue` is a distinct calendar colour; null when the category has an explicit tone */
  categories: (Category & { tone: string; hue: number | null })[];
}

export type ReportDay = DayReport & { pending?: boolean };

export interface Report {
  from: string;
  to: string;
  days: ReportDay[];
  /** Dates still being computed (or waiting in a paused job) */
  pending: string[];
  jobs: Job[];
  /** Block folder → repo, with its web URL when the origin remote has one */
  repos: Record<string, RepoInfo>;
  paste: { grid: string; gridNoHeader: string; lines: string; daily: string };
}

export interface RepoInfo {
  root: string;
  name: string;
  url: string | null;
}

export type JobStatus = 'queued' | 'running' | 'paused' | 'interrupted' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  from: string;
  to: string;
  refresh: boolean;
  dates: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  done: string[];
  remaining: string[];
  current: string[];
  elsewhere: boolean;
}

export const jobActive = (j: Job) => j.status === 'queued' || j.status === 'running' || j.status === 'interrupted';

export interface GithubStatus {
  backend: string;
  /** Where the tokens in use come from; null = none */
  source: 'stored' | 'env' | 'gh' | null;
  tokens: { label: string; login: string | null }[];
  enabled: boolean;
}

export interface AuthStatus {
  hasClient: boolean;
  connected: boolean;
  backend: string;
  calendarEnabled: boolean;
}

export type { SystemId };

export interface SubmitCapture {
  /** Sanitized DOM copy (file name) */
  file: string;
  /** Screenshot next to it, null if it was not written */
  png: string | null;
  at: string;
}

export interface SubmitSystemStatus {
  /** Saved start URL; '' when not set */
  url: string;
  fillOnly: boolean;
  /** Number of mapping rules */
  rules: number;
  /** Where this system's captures are saved */
  folder: string;
  /** Newest first */
  captures: SubmitCapture[];
}

export interface SubmitStatus {
  chrome: boolean;
  /** Browser profile folder (~-relative) */
  profile: string;
  /** Captures folder (~-relative) */
  folder: string;
  browser: { open: boolean };
  systems: Record<SystemId, SubmitSystemStatus>;
}

export interface SubmitCell {
  date: string;
  target: object;
  /** e.g. "#4242 · Development" or "Acme:Project · Development" */
  label: string;
  hours: number;
}

export type SubmitSystemPlan =
  | { system: SystemId; fillOnly: boolean; ok: true; plan: { week: string; cells: SubmitCell[]; notes: string[] } }
  | { system: SystemId; fillOnly: boolean; ok: false; reasons: string[] };

export interface SubmitPlan {
  /** Monday */
  week: string;
  systems: SubmitSystemPlan[];
}

export const SYSTEM_LABEL: Record<SystemId, string> = { redmine: 'Redmine', netsuite: 'NetSuite' };

export type { LabeledCell, PrepareResult, RunProgress, UnitState } from '../../src/core/submit/run.ts';
export type { RedmineCatalog, RedmineIssue } from '../../src/core/submit/redmine.ts';
export type { NetsuiteTarget, RedmineTarget, SubmitRule } from '../../src/core/submit/types.ts';

/** NetSuite's catalog, once its adapter exists: project option texts with their task options. */
export interface NetsuiteCatalog {
  projects: { name: string; tasks: string[] }[];
  discoveredAt: string;
}

export interface SubmitCatalogResponse<C = unknown> {
  system: SystemId;
  catalog: C | null;
  discoveredAt: string | null;
}

export type DiscoverResponse<C = unknown> = { state: 'login'; reason: string } | { state: 'ok'; catalog: C; discoveredAt: string };

/** A (project, category) pair booked recently. */
export interface BookedPair {
  project: string;
  category: string;
  hours: number;
  days: number;
  last: string;
}

export interface SubmitRunSummary {
  id: string;
  system: SystemId;
  week: string;
  status: string;
  fillOnly: boolean;
  error: string | null;
  /** Cells written */
  written: number;
  screenshots: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SubmitRunState {
  progress: import('../../src/core/submit/run.ts').RunProgress | null;
  runs: SubmitRunSummary[];
}

export class ApiError extends Error {
  errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.errors = errors;
  }
}

/** All writes carry X-Timesheet: the server rejects writes without it (cross-site protection). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-timesheet': '1' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? (data.errors ? 'Invalid settings' : res.statusText), data.errors);
  return data as T;
}

/** Personal or unassigned activity, shown but never booked. */
export const isOther = (b: Block | OtherBlock): b is OtherBlock => b.kind === 'personal' || b.kind === 'unassigned';

export const OTHER_LABEL = { personal: 'Personal', unassigned: 'Unassigned' } as const;

/** Two decimals, never rounded down. */
export const fmt = (n: number) => String(Math.ceil((n || 0) * 100 - 1e-6) / 100);

/**
 * Recorded minutes as measured: timestamps are millisecond-exact, shown to the hundredth of a
 * minute with nothing rounded up. "—" for days computed before minutes were recorded.
 */
export const fmtMin = (n: number | undefined) => (n === undefined ? '—' : `${String(Math.floor(n * 100 + 1e-6) / 100)} min`);
