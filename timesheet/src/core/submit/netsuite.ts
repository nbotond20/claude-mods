/// <reference lib="dom" />
import type { BrowserContext, Dialog, Page, Request, Route } from 'playwright-core';
import { addDays, today, weekStart } from '../dates.ts';
import { Abort, type Adapter, type ApplyOptions, Failed, type LoginState, type Protection, sleep, type UnitWork } from './adapter.ts';
import { byCell, cellKey, cents } from './plan.ts';
import type { Cell, NetsuiteTarget, Snapshot } from './types.ts';

/**
 * NetSuite weekly timesheet (weeklytimebill.nl, the Redwood/UIF form). The grid is virtualized, so
 * everything is read and written through the page's own SuiteScript API (N/currentRecord); only the
 * task list of a project is read from the UI dropdown (the API loads it lazily). Saving sends one
 * XHR (submitDynamicClientRecord) that is checked field by field before it may pass; Submit (for
 * approval) never passes.
 */

export interface NetsuiteProject {
  /** Option text of the Customer : Project select, e.g. "P00036826 Infinitas … 2026 part 2" */
  name: string;
  /** Internal id of the project */
  value: string;
  /** Option texts of the Case/Task/Event select for this project */
  tasks: string[];
}

export interface NetsuiteCatalog {
  /** https://<account>.app.netsuite.com */
  origin: string;
  /** Internal id of the employee the timesheets belong to */
  employeeId: string;
  /** Employee text, e.g. "E00000723 Nuszpl Botond" */
  user: string;
  projects: NetsuiteProject[];
  discoveredAt: string;
}

const NAV_TIMEOUT = 45_000;
const READY_TIMEOUT = 30_000;
const SAVE_TIMEOUT = 90_000;
const USER_TIMEOUT = 15 * 60_000;
const PATH = '/app/accounting/transactions/time/weeklytimebill.nl';
const SUBLIST = 'timeitem';
const TASK = 'custcol_il_filtered_project_task';

/** Header approval status: '' never saved, '1' open (saved, not submitted), '2' pending approval, '3' approved, '4' rejected. */
const EDITABLE_APPROVAL = new Set(['', '1', '3']);
/** What a save (never a Submit) may leave: open. Adding lines to an approved timesheet reopens it. */
const SAVED_APPROVAL = new Set(['', '1']);
export const approvalText = (s: string): string => ({ '': 'new', '1': 'open', '2': 'pending approval', '3': 'approved', '4': 'rejected' })[s] ?? `in approval status ${s}`;

// ---------- addresses and dates ----------

/** The account origin from the configured timesheet address. */
export function netsuiteBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Abort(`the NetSuite address is not a URL: ${url}`);
  }
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Abort('the NetSuite address must start with https://');
  if (!local && !/\.netsuite\.com$/.test(u.hostname)) throw new Abort(`the NetSuite address must be on netsuite.com, not ${u.hostname}`);
  if (u.pathname !== PATH) throw new Abort(`the NetSuite address must be a weekly timesheet (…${PATH}), not ${u.pathname}`);
  return u.origin;
}

/** 2026-10-05 → 05/10/2026 (the account's date format; checked against the record on every page). */
export function dmy(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

/** The only address the adapter opens for a week: NetSuite redirects it to the week's timesheet in edit mode, or opens a new one. */
export function weekUrl(origin: string, employeeId: string, week: string): string {
  return `${origin}${PATH}?whence=&employee=${encodeURIComponent(employeeId)}&trandate=${encodeURIComponent(dmy(week))}`;
}

/** Why a URL is not a weekly timesheet page on this account, or null. */
export function pageUrlProblem(raw: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `not a URL: ${raw}`;
  }
  if (u.origin !== origin) return `on ${u.origin}, expected ${origin}`;
  if (u.pathname !== PATH) return `on ${u.pathname}, expected the weekly timesheet`;
  return null;
}

// ---------- reading the record ----------

export interface LineData {
  customer: string;
  customerText: string;
  task: string;
  taskText: string;
  item: string;
  /** 'T', 'F' or '' (unknown) */
  editable: string;
  /** hours0..hours6 (Mon..Sun) as the API returns them: number, '' or text */
  hours: (number | string)[];
  /** statushours0..6: approval status of each day's entry ('3' approved, '' none); missing = unknown */
  status?: string[];
}

export interface RecordData {
  url: string;
  error?: string;
  type: string;
  id: string;
  isDynamic: boolean;
  employee: string;
  employeeText: string;
  trandate: string;
  approvalstatus: string;
  lockstatus: string;
  lines: LineData[];
}

/**
 * Runs inside the page (page.evaluate), so it must stay self-contained: the timesheet record as
 * N/currentRecord sees it. Never throws; a problem comes back in `error`.
 */
export async function readRecordInPage(): Promise<RecordData> {
  const empty: RecordData = { url: location.href, type: '', id: '', isDynamic: false, employee: '', employeeText: '', trandate: '', approvalstatus: '', lockstatus: '', lines: [] };
  const w = window as unknown as { require?: (deps: string[], ok: (m: any) => void, fail?: (e: unknown) => void) => void };
  if (typeof w.require !== 'function') return { ...empty, error: 'no SuiteScript on the page' };
  try {
    const mod = await new Promise<any>((resolve, reject) => {
      setTimeout(() => reject(new Error('timeout loading N/currentRecord')), 5000);
      w.require!(['N/currentRecord'], resolve, reject);
    });
    const r = mod.get();
    const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    const val = (f: string) => str(r.getValue({ fieldId: f }));
    const txt = (f: string) => str(r.getText({ fieldId: f }));
    const S = 'timeitem';
    const n = r.getLineCount({ sublistId: S });
    const lines: LineData[] = [];
    for (let line = 0; line < n; line++) {
      const v = (f: string) => r.getSublistValue({ sublistId: S, fieldId: f, line });
      const t = (f: string) => str(r.getSublistText({ sublistId: S, fieldId: f, line }));
      const ed = v('editable');
      lines.push({
        customer: str(v('customer')),
        customerText: t('customer'),
        task: str(v('custcol_il_filtered_project_task')),
        taskText: t('custcol_il_filtered_project_task'),
        item: str(v('item')),
        editable: ed === true || ed === 'T' ? 'T' : ed === false || ed === 'F' ? 'F' : '',
        hours: [0, 1, 2, 3, 4, 5, 6].map((d) => {
          const h = v(`hours${d}`);
          return typeof h === 'number' ? h : str(h);
        }),
        status: [0, 1, 2, 3, 4, 5, 6].map((d) => str(v(`statushours${d}`))),
      });
    }
    return { url: location.href, type: str(r.type), id: str(r.id), isDynamic: !!r.isDynamic, employee: val('employee'), employeeText: txt('employee'), trandate: txt('trandate'), approvalstatus: val('approvalstatus'), lockstatus: val('lockstatus'), lines };
  } catch (e) {
    return { ...empty, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** How long a sign-in may take on its own (SSO redirects) before the user is asked to log in. */
/** How long checkLogin lets the single sign-on redirects finish (tests shorten it). */
export const loginTiming = { settleMs: 20_000 };
const NOT_LOGGED_IN = 'not logged in: log in to NetSuite in the browser window';

const onTimesheet = (raw: string, origin: string) => {
  try {
    const u = new URL(raw);
    return u.origin === origin && u.pathname === PATH;
  } catch {
    return false;
  }
};

/** Waits until the tab shows the account's timesheet page (true), or the time is up (false). */
async function settleOnTimesheet(page: Page, origin: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (page.isClosed()) return false;
    if (onTimesheet(page.url(), origin)) {
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      if (onTimesheet(page.url(), origin)) return true;
    }
    if (Date.now() > end) return false;
    await sleep(250);
  }
}

/** Waits until the form's record can be read (UIF loads it after the document). */
async function readRecord(page: Page, where: string): Promise<RecordData> {
  const deadline = Date.now() + READY_TIMEOUT;
  let last = '';
  for (;;) {
    blockedCheck(page, where);
    try {
      const rec = await page.evaluate(readRecordInPage);
      if (!rec.error && rec.type) return rec;
      last = rec.error ?? 'no record';
    } catch (e) {
      last = (e as Error).message.split('\n')[0];
    }
    if (Date.now() > deadline) throw new Abort(`${where}: the timesheet did not load (${last})`);
    await sleep(500);
  }
}

/** Minutes of an hours value as the API returns it (8, 4.25, '', '4:15'); null if unreadable. */
export function minutesOf(raw: number | string): number | null {
  if (raw === '' || raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    const m = Math.round(raw * 60);
    return Math.abs(raw * 60 - m) < 1e-6 ? m : null;
  }
  const hm = /^(\d{1,3}):([0-5]\d)$/.exec(raw.trim());
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  if (/^\d{1,3}(\.\d+)?$/.test(raw.trim())) return minutesOf(Number(raw.trim()));
  return null;
}

export interface WeekContext {
  origin: string;
  employeeId: string;
  user: string;
  week: string;
}

/** Asserts the record is the expected employee's timesheet of the week; throws Abort otherwise. */
export function assertWeek(rec: RecordData, ctx: WeekContext): void {
  const where = `NetSuite week ${ctx.week}`;
  const urlProblem = pageUrlProblem(rec.url, ctx.origin);
  if (urlProblem) throw new Abort(`${where}: unexpected page (${urlProblem})`);
  if (rec.type !== 'timesheet') throw new Abort(`${where}: the page holds a ${rec.type || 'unknown'} record, not a timesheet`);
  if (rec.employee !== ctx.employeeId) throw new Abort(`${where}: the timesheet is for ${rec.employeeText || rec.employee || 'nobody'}, expected ${ctx.user}`);
  if (rec.employeeText !== ctx.user) throw new Abort(`${where}: the employee reads "${rec.employeeText}", expected "${ctx.user}"`);
  if (rec.trandate !== dmy(ctx.week)) throw new Abort(`${where}: the timesheet is for the week of ${rec.trandate || '?'}, expected ${dmy(ctx.week)}`);
}

export interface WeekData {
  cells: Cell<NetsuiteTarget>[];
  lines: { line: number; data: LineData; minutes: number[] }[];
  /** Days NetSuite no longer lets change (approved, or on a line that cannot be edited): date → why */
  frozen: Record<string, string>;
}

/** Why a day's entry on a line can no longer change, or null. */
function frozenReason(data: LineData, d: number, minutes: number): string | null {
  const status = data.status?.[d] ?? '';
  if (status === '3') return 'approved';
  if (minutes > 0 && data.editable === 'F') return status ? `submitted (status ${status})` : 'not editable';
  return null;
}

/** The non-zero cells of the week. Anything unreadable (hours, a line without project or task with hours) throws Abort. */
export function parseWeek(rec: RecordData, week: string): WeekData {
  const where = `NetSuite week ${week}`;
  const cells: Cell<NetsuiteTarget>[] = [];
  const lines: WeekData['lines'] = [];
  const frozen: Record<string, string> = {};
  const seen = new Map<string, number>();
  rec.lines.forEach((data, line) => {
    if (data.hours.length !== 7) throw new Abort(`${where}: line ${line + 1} does not have 7 days`);
    const minutes = data.hours.map((raw, d) => {
      const m = minutesOf(raw);
      if (m === null) throw new Abort(`${where}: line ${line + 1} has unreadable hours on ${addDays(week, d)} ("${raw}")`);
      if (m % 15 !== 0) throw new Abort(`${where}: line ${line + 1} has ${m} min on ${addDays(week, d)}, not a whole quarter hour; fix it by hand`);
      return m;
    });
    lines.push({ line, data, minutes });
    minutes.forEach((m, d) => {
      const why = frozenReason(data, d, m);
      if (why) frozen[addDays(week, d)] ??= why;
      if (m === 0) return;
      if (!data.customerText || !data.taskText) throw new Abort(`${where}: line ${line + 1} has hours but no ${data.customerText ? 'task' : 'project'}`);
      const cell = { date: addDays(week, d), target: { project: data.customerText, task: data.taskText }, hours: m / 60 };
      const key = cellKey(cell);
      if (seen.has(key)) throw new Abort(`${where}: ${data.customerText} · ${data.taskText} has hours on ${cell.date} in two lines; fix it by hand`);
      seen.set(key, line);
      cells.push(cell);
    });
  });
  return { cells: cells.sort(byCell), lines, frozen };
}

const cellList = (cells: Cell<NetsuiteTarget>[]) => cells.map((c) => `${cellKey(c)}=${cents(c.hours)}`).sort();
export const sameCells = (a: Cell<NetsuiteTarget>[], b: Cell<NetsuiteTarget>[]) => JSON.stringify(cellList(a)) === JSON.stringify(cellList(b));
const fmtH = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const describeCells = (cells: Cell<NetsuiteTarget>[]) => (cells.length ? cells.map((c) => `${c.date} ${c.target.task} ${fmtH(c.hours)}`).join(', ') : 'nothing');

// ---------- requests that change NetSuite ----------

export interface RequestInfo {
  method: string;
  url: string;
  body: string | null;
  navigation: boolean;
}

export type RequestKind = 'safe' | 'validate' | 'save' | 'danger';

const jrmethodOf = (r: RequestInfo): string => {
  try {
    const q = new URL(r.url).searchParams.get('jrmethod');
    if (q) return q;
  } catch {
    // not a URL: no method
  }
  if (!r.body) return '';
  try {
    return new URLSearchParams(r.body).get('jrmethod') ?? '';
  } catch {
    return '';
  }
};

const isNetsuite = (url: string, origin: string) => {
  try {
    const u = new URL(url);
    return u.origin === origin || /(^|\.)netsuite\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

/** NetSuite's sign-in addresses (the SSO answer and the login router pages). */
export function isLoginPath(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === '/saml2/acs' || path.startsWith('/app/login/') || path.startsWith('/pages/customerlogin');
  } catch {
    return false;
  }
}

/**
 * What a request would do to NetSuite: 'save' (the timesheet save call), 'validate' (its read-only
 * time-limit check), 'danger' (anything else that may write: submit, delete, a form post, a post to
 * the timesheet pages) or 'safe' (reads and field sourcing).
 */
export function classifyRequest(r: RequestInfo, origin: string): RequestKind {
  if (['GET', 'HEAD', 'OPTIONS'].includes(r.method.toUpperCase())) return 'safe';
  if (!isNetsuite(r.url, origin)) return 'safe';
  // Signing in (single sign-on answer, login pages) creates a session and changes no record.
  if (r.navigation && isLoginPath(r.url)) return 'safe';
  const method = jrmethodOf(r);
  if (method === 'remoteObject.submitDynamicClientRecord') return 'save';
  if (method === 'remoteObject.validateWeeklyTimesheetRecordMacro') return 'validate';
  if (/submit|delete|remove|void|approve|reject|save|copy|import|reverse|unlock/i.test(method)) return 'danger';
  if (r.navigation) return 'danger';
  let path = '';
  try {
    path = new URL(r.url).pathname;
  } catch {
    return 'danger';
  }
  if (/weeklytimebill|timebill|timesheet/i.test(path)) return 'danger';
  return 'safe';
}

/** A line as the save call carries it: project id, task id, minutes Mon..Sun. */
export interface SaveLine {
  customer: string;
  task: string;
  minutes: number[];
}

export interface SaveExpectation {
  employeeId: string;
  /** Record id; '' for a week saved for the first time */
  id: string;
  week: string;
  /** The record's approval status when it was opened: a save must carry it ('' new, '1' open, '3' approved) */
  approval: string;
  lines: SaveLine[];
}

const lineKey = (l: SaveLine) => `${l.customer}|${l.task}|${l.minutes.join(',')}`;
const lineKeys = (lines: SaveLine[]) => lines.map(lineKey).sort();

const jrparams = (body: string): unknown[] | null => {
  try {
    const v = JSON.parse(new URLSearchParams(body).get('jrparams') ?? '');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Why the time-limit check is not the one of saving this week (null = fine). */
export function validateProblem(body: string | null, exp: SaveExpectation): string | null {
  const p = body ? jrparams(body) : null;
  const a = p?.[0] as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return 'a time-limit check that cannot be read';
  if (a.ACTION !== 'save') return `a time-limit check for "${String(a.ACTION)}" (only save is allowed)`;
  if (a.EMPLOYEE_ID !== exp.employeeId) return `a time-limit check for employee ${String(a.EMPLOYEE_ID)}`;
  if (a.TIMESHEET_STARTDATE !== dmy(exp.week)) return `a time-limit check for the week of ${String(a.TIMESHEET_STARTDATE)}`;
  return null;
}

/**
 * Why a save call is not exactly the verified week (null = it is): the right record, employee and
 * week, still open (not submitted for approval), and the lines exactly as checked after filling in.
 */
export function saveProblem(body: string | null, exp: SaveExpectation): string | null {
  const p = body ? jrparams(body) : null;
  if (!p || p.length < 3) return 'a save that cannot be read';
  if (p[0] !== 'timesheet') return `a save of a ${String(p[0])} record`;
  const rec = p[1] as Record<string, unknown>;
  if (!rec || typeof rec !== 'object') return 'a save without the record';
  const s = (k: string) => (rec[k] === undefined || rec[k] === null ? '' : String(rec[k]));
  if (s('employee') !== exp.employeeId) return `a save for employee ${s('employee')}`;
  if (s('id') !== exp.id) return `a save of record ${s('id') || '(new)'}, expected ${exp.id || '(new)'}`;
  if (s('trandate') !== dmy(exp.week) || s('startdate') !== dmy(exp.week)) return `a save for the week of ${s('trandate')}`;
  if (s('approvalstatus') !== exp.approval) return `a save with approval status ${s('approvalstatus') || '(open)'}, expected ${exp.approval || '(open)'}`;
  for (const k of Object.keys(rec)) {
    if (k === 'submittedhours') continue;
    if (/submit|_multibtnstate_|approv/i.test(k) && k !== 'approvalstatus' && s(k) !== '') return `a save with ${k}=${s(k)} (Submit is never allowed)`;
  }
  const opts = p[3] as Record<string, unknown> | undefined;
  if (opts && typeof opts === 'object') {
    const ctx = opts.recordrequestcontext as Record<string, unknown> | undefined;
    if (exp.id && ctx && String(ctx.id ?? '') !== exp.id) return `a save with request context ${String(ctx.id)}`;
  }
  const sub = (p[2] as Record<string, unknown> | undefined)?.timeitem as { fields?: unknown; data?: unknown; size?: unknown } | undefined;
  if (!sub || !Array.isArray(sub.fields) || !Array.isArray(sub.data)) return 'a save without the time lines';
  const fields = sub.fields as string[];
  const at = (f: string) => fields.indexOf(f);
  const idx = { customer: at('customer'), task: at(TASK), hours: [0, 1, 2, 3, 4, 5, 6].map((d) => at(`hours${d}`)) };
  if (idx.customer < 0 || idx.task < 0 || idx.hours.some((i) => i < 0)) return 'a save whose time lines lack project, task or hours';
  if (sub.size !== undefined && Number(sub.size) !== sub.data.length) return 'a save whose line count does not add up';
  const lines: SaveLine[] = [];
  for (const row of sub.data as unknown[]) {
    if (!Array.isArray(row) || row.length !== fields.length) return 'a save with a malformed time line';
    const minutes = idx.hours.map((i) => minutesOf(String(row[i] ?? '')));
    if (minutes.some((m) => m === null)) return `a save with unreadable hours (${idx.hours.map((i) => row[i]).join(' ')})`;
    lines.push({ customer: String(row[idx.customer] ?? ''), task: String(row[idx.task] ?? ''), minutes: minutes as number[] });
  }
  const got = lineKeys(lines);
  const want = lineKeys(exp.lines);
  if (JSON.stringify(got) !== JSON.stringify(want)) return `a save with other lines than the checked ones (${got.join('; ') || 'none'} instead of ${want.join('; ') || 'none'})`;
  return null;
}

/** Protection state per browser context: why a request was blocked. */
const PROTECTED = new WeakMap<BrowserContext, { problem: string | null }>();
const blockedRequest = (page: Page): string | null => PROTECTED.get(page.context())?.problem ?? null;
function blockedCheck(page: Page, where: string) {
  const b = blockedRequest(page);
  if (b) throw new Abort(`${where}: ${b}; nothing saved`);
}

const infoOf = (req: Request): RequestInfo => ({ method: req.method(), url: req.url(), body: req.postData(), navigation: req.isNavigationRequest() });

/**
 * Blocks, in every tab, every request that could change NetSuite (saving, submitting, deleting, form
 * posts), also the user's own clicks. During a run the adapter lets exactly one checked save through
 * its own page route, which takes precedence over this one.
 */
export async function protectNetsuite(page: Page, url: string): Promise<Protection> {
  const origin = netsuiteBase(url);
  const context = page.context();
  const state = { problem: null as string | null };
  const handler = async (route: Route) => {
    const kind = classifyRequest(infoOf(route.request()), origin);
    if (kind === 'safe') return route.fallback();
    state.problem ??= `blocked a request that would change NetSuite (${kind === 'danger' ? 'not a save' : kind})`;
    return route.abort('blockedbyclient');
  };
  PROTECTED.set(context, state);
  try {
    await context.route('**/*', handler);
  } catch (e) {
    PROTECTED.delete(context);
    throw new Abort(`cannot protect the browser against requests that change NetSuite (${(e as Error).message.split('\n')[0]}); nothing done`);
  }
  return {
    problem: () => state.problem,
    dispose: async () => {
      await context.unroute('**/*', handler).catch(() => {});
      if (PROTECTED.get(context) === state) PROTECTED.delete(context);
    },
  };
}

interface SaveGuard {
  state: { blocked: string | null; request: Request | null; validated: boolean; dropped: number };
  /** From now on, exactly one save of exactly these lines may pass (and its time-limit checks). */
  allow(exp: SaveExpectation): void;
  lock(): void;
  /** After a save that NetSuite verifiably did not keep: the same save may pass once more. */
  reallow(): void;
  dispose(): Promise<void>;
}

/** Page route for the run: blocks every write until `allow`, then lets exactly the expected save through once. */
async function guardSave(page: Page, origin: string): Promise<SaveGuard> {
  const state: SaveGuard['state'] = { blocked: null, request: null, validated: false, dropped: 0 };
  let expected: SaveExpectation | null = null;
  let last: SaveExpectation | null = null;
  const handler = async (route: Route) => {
    const req = route.request();
    const info = infoOf(req);
    const kind = classifyRequest(info, origin);
    if (kind === 'safe') return route.fallback();
    let problem: string | null = null;
    if (kind === 'danger') problem = `a request that is not a save (${new URL(info.url).pathname})`;
    else if (state.request) {
      // Save pressed again while the first one is on its way: only that first one goes out.
      state.dropped++;
      return route.abort('blockedbyclient');
    }
    else if (!expected) problem = 'a save before the filled-in week was checked';
    else if (kind === 'validate') problem = validateProblem(info.body, expected);
    else problem = saveProblem(info.body, expected);
    if (problem) {
      state.blocked ??= problem;
      return route.abort('blockedbyclient');
    }
    if (kind === 'validate') {
      state.validated = true;
      return route.continue();
    }
    state.request = req;
    expected = null;
    return route.continue();
  };
  await page.route('**/*', handler);
  return {
    state,
    allow(exp) {
      if (!state.request && !state.blocked) expected = last = exp;
    },
    reallow() {
      if (state.blocked || !last) return;
      state.request = null;
      state.validated = false;
      expected = last;
    },
    lock() {
      expected = null;
    },
    dispose: () => page.unroute('**/*', handler).catch(() => {}),
  };
}

// ---------- page helpers ----------

function watchDialogs(page: Page) {
  let seen: string | null = null;
  let allowLeave = false;
  let accept = false;
  const handler = (d: Dialog) => {
    if (allowLeave && d.type() === 'beforeunload') {
      d.accept().catch(() => {});
      return;
    }
    // The user is saving: NetSuite's questions (e.g. about the hours) get a yes, as a click would.
    // Every request still passes the save checks.
    if (accept && (d.type() === 'confirm' || d.type() === 'alert')) {
      d.accept().catch(() => {});
      return;
    }
    // A reload while the user saves: let it happen; the run notices and fills the week in again.
    if (accept && d.type() === 'beforeunload') {
      d.accept().catch(() => {});
      return;
    }
    seen ??= `${d.type()}: ${d.message().slice(0, 200)}`;
    d.dismiss().catch(() => {});
  };
  page.on('dialog', handler);
  return {
    check(where: string) {
      if (seen) throw new Abort(`${where}: unexpected dialog (${seen})`);
    },
    allowLeave(v: boolean) {
      allowLeave = v;
    },
    acceptPrompts(v: boolean) {
      accept = v;
    },
    dispose: () => page.off('dialog', handler),
  };
}

async function markDocument(page: Page): Promise<string> {
  const token = `ts${Math.random().toString(36).slice(2)}`;
  await page.evaluate((t) => {
    (window as unknown as Record<string, unknown>).__timesheetDoc = t;
  }, token);
  return token;
}

async function documentState(page: Page, token: string): Promise<'old' | 'loading' | 'new' | 'closed'> {
  if (page.isClosed()) return 'closed';
  try {
    const r = await page.evaluate(() => ({ t: (window as unknown as Record<string, unknown>).__timesheetDoc, ready: document.readyState }));
    if (r.t === token) return 'old';
    return r.ready === 'complete' ? 'new' : 'loading';
  } catch {
    return page.isClosed() ? 'closed' : 'loading';
  }
}

/** Navigation errors caused by the page navigating by itself meanwhile: worth another try. */
export const retryableNavigation = (msg: string) => /interrupted by another navigation|Timeout \d+ms exceeded|net::ERR_ABORTED|frame was detached|Execution context was destroyed/i.test(msg);

async function goto(page: Page, url: string, where: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      if (res && res.status() >= 400) throw new Abort(`${where}: NetSuite answered ${res.status()}`);
      break;
    } catch (e) {
      if (e instanceof Abort) throw e;
      blockedCheck(page, where);
      const msg = (e as Error).message.split('\n')[0];
      if (attempt < 3 && !page.isClosed() && retryableNavigation(msg)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        await sleep(1000);
        continue;
      }
      throw new Abort(`${where}: could not open the timesheet (${msg})`);
    }
  }
  blockedCheck(page, where);
}

/** Opens the week (edit mode, or a new timesheet) and checks it is the right one. */
async function gotoWeek(page: Page, ctx: WeekContext): Promise<RecordData> {
  const where = `NetSuite week ${ctx.week}`;
  for (let attempt = 1; ; attempt++) {
    await goto(page, weekUrl(ctx.origin, ctx.employeeId, ctx.week), where);
    try {
      const rec = await readRecord(page, where);
      assertWeek(rec, ctx);
      return rec;
    } catch (e) {
      // NetSuite may still be moving on from an earlier page (after a save): open the week once more.
      if (attempt >= 2 || page.isClosed() || blockedRequest(page)) throw e;
      await sleep(1500);
    }
  }
}

/** Leaves a filled-in week without saving (accepting the leave prompt) and checks it is gone; closes the tab otherwise. */
async function resetPage(page: Page, ctx: WeekContext, token: string, before: Cell<NetsuiteTarget>[], dialogs: ReturnType<typeof watchDialogs>): Promise<string> {
  if (page.isClosed()) return '';
  dialogs.allowLeave(true);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(weekUrl(ctx.origin, ctx.employeeId, ctx.week), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        break;
      } catch (e) {
        if (attempt >= 3 || page.isClosed()) throw e;
        await sleep(500);
      }
    }
    if ((await documentState(page, token)) === 'old') throw new Error('not reloaded');
    // The record loads a while after the document (UIF).
    const deadline = Date.now() + READY_TIMEOUT;
    let rec = await page.evaluate(readRecordInPage);
    while ((rec.error || !rec.type) && Date.now() < deadline) {
      await sleep(500);
      rec = await page.evaluate(readRecordInPage);
    }
    if ((await documentState(page, token)) !== 'new') throw new Error('not reloaded');
    if (!rec.error && sameCells(parseWeek(rec, ctx.week).cells, before)) return '; the page was reloaded without the filled-in values';
  } catch {
    // closed below
  } finally {
    dialogs.allowLeave(false);
  }
  try {
    await page.close({ runBeforeUnload: false });
    return '; the browser tab was closed to discard the filled-in values';
  } catch {
    return '; the browser window may still show the filled-in values: do not press Save there, reload the page';
  }
}

const reasonOf = (e: unknown, where: string) =>
  ((e as Error)?.message ?? String(e))
    .split('\n')[0]
    .replace(`${where}: `, '')
    .replace(/[;,]? ?nothing saved\.?/g, '')
    .trim();

// ---------- writing through the API (inside the page) ----------

export interface FillOp {
  /** Existing line index, or -1 for a new line */
  line: number;
  customer: string;
  task: string;
  /** day index → hours */
  hours: [number, number][];
}

/** Runs inside the page: one line, through N/currentRecord, committed. Returns a problem or ''. */
export async function fillLineInPage(op: FillOp): Promise<string> {
  const w = window as unknown as { require: (deps: string[], ok: (m: any) => void, fail?: (e: unknown) => void) => void };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const S = 'timeitem';
  const T = 'custcol_il_filtered_project_task';
  try {
    const mod = await new Promise<any>((resolve, reject) => w.require(['N/currentRecord'], resolve, reject));
    const r = mod.get();
    const cur = (f: string) => {
      const v = r.getCurrentSublistValue({ sublistId: S, fieldId: f });
      return v === null || v === undefined ? '' : String(v);
    };
    const until = async (ok: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) return false;
        await wait(200);
      }
      return true;
    };
    if (op.line < 0) {
      r.selectNewLine({ sublistId: S });
      if (cur('customer') !== '' || cur(T) !== '') return 'the new line is not empty';
      r.setCurrentSublistValue({ sublistId: S, fieldId: 'customer', value: op.customer });
      if (!(await until(() => cur('customer') === op.customer, 10_000))) return `the project did not stick (${cur('customer')})`;
      await wait(1500);
      r.setCurrentSublistText({ sublistId: S, fieldId: T, text: op.task });
      if (!(await until(() => cur(T) !== '' && cur('item') !== '', 10_000))) return `the task "${op.task}" could not be chosen`;
      const text = r.getCurrentSublistText({ sublistId: S, fieldId: T });
      if (text !== op.task) return `the task reads "${text}", expected "${op.task}"`;
      await wait(500);
    } else {
      r.selectLine({ sublistId: S, line: op.line });
      if (cur('customer') !== op.customer) return `line ${op.line + 1} holds project ${cur('customer')}`;
    }
    for (const [d, h] of op.hours) {
      const f = `hours${d}`;
      const before = r.getCurrentSublistValue({ sublistId: S, fieldId: f });
      if (before !== '' && before !== null && before !== undefined && before !== 0) return `${f} already holds ${before}`;
      r.setCurrentSublistValue({ sublistId: S, fieldId: f, value: h });
      await wait(300);
      const after = r.getCurrentSublistValue({ sublistId: S, fieldId: f });
      if (Number(after) !== h) return `${f} reads ${after} after entering ${h}`;
    }
    if (cur('customer') !== op.customer) return `the project changed to ${cur('customer')} while filling in`;
    r.commitLine({ sublistId: S });
    await wait(800);
    return '';
  } catch (e) {
    try {
      const mod = await new Promise<any>((resolve, reject) => w.require(['N/currentRecord'], resolve, reject));
      mod.get().cancelLine({ sublistId: S });
    } catch {
      // the reset reloads the page anyway
    }
    return String((e as Error)?.message ?? e).slice(0, 200);
  }
}

// ---------- discovery helpers ----------

/** Runs inside the page: starts a scratch line and lists the project options. */
async function projectOptionsInPage(): Promise<{ value: string; text: string }[] | string> {
  const w = window as unknown as { require: (deps: string[], ok: (m: any) => void, fail?: (e: unknown) => void) => void };
  try {
    const mod = await new Promise<any>((resolve, reject) => w.require(['N/currentRecord'], resolve, reject));
    const r = mod.get();
    r.selectNewLine({ sublistId: 'timeitem' });
    const field = r.getCurrentSublistField({ sublistId: 'timeitem', fieldId: 'customer' });
    return (field.getSelectOptions() as { value: unknown; text: unknown }[]).map((o) => ({ value: String(o.value ?? ''), text: String(o.text ?? '').trim() })).filter((o) => o.value && o.text);
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

async function readTasks(page: Page, value: string): Promise<string[]> {
  const set = await page.evaluate(async (v) => {
    const w = window as unknown as { require: (deps: string[], ok: (m: any) => void, fail?: (e: unknown) => void) => void };
    const mod = await new Promise<any>((resolve, reject) => w.require(['N/currentRecord'], resolve, reject));
    const r = mod.get();
    r.setCurrentSublistValue({ sublistId: 'timeitem', fieldId: 'customer', value: v });
    await new Promise((x) => setTimeout(x, 2500));
    return String(r.getCurrentSublistValue({ sublistId: 'timeitem', fieldId: 'customer' }) ?? '');
  }, value);
  if (set !== value) return [];
  const cell = page.locator(`[data-automation-id="${SUBLIST}"] [data-row-type="data"] [data-automation-id="${TASK}"]`).last();
  await cell.click({ timeout: 10_000 });
  await sleep(1000);
  const button = page.locator(`[data-automation-id="${TASK}"] [data-automation-id="dropdownButton"]`);
  if ((await button.count()) !== 1) return [];
  await button.click({ timeout: 10_000 });
  await sleep(2000);
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const { texts, more } = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('[role=option]')].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const box = document.querySelector('[role=listbox]') as HTMLElement | null;
      let more = false;
      if (box && box.scrollTop + box.clientHeight < box.scrollHeight - 2) {
        box.scrollTop += box.clientHeight;
        more = true;
      }
      return { texts, more };
    });
    const size = seen.size;
    texts.forEach((t) => seen.add(t));
    if (!more && seen.size === size) break;
    if (!more) break;
    await sleep(400);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
  return [...seen];
}

const ADAPTER_LABEL = (_catalog: NetsuiteCatalog | null, t: NetsuiteTarget) => `${t.project} · ${t.task}`;

export const netsuite: Adapter<NetsuiteTarget, NetsuiteCatalog> & { base: typeof netsuiteBase } = {
  system: 'netsuite',
  base: netsuiteBase,
  protect: protectNetsuite,

  async checkLogin(page, url) {
    let origin: string;
    try {
      origin = netsuiteBase(url);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e) {
      return { ok: false, reason: `could not open ${url} (${(e as Error).message.split('\n')[0]})` };
    }
    // An expired session goes through single sign-on, which often signs in by itself within seconds:
    // wait for the redirects to land on the timesheet before deciding.
    if (!(await settleOnTimesheet(page, origin, loginTiming.settleMs))) return { ok: false, reason: NOT_LOGGED_IN };
    let rec: RecordData;
    try {
      rec = await readRecord(page, 'NetSuite');
    } catch (e) {
      return { ok: false, reason: `${(e as Error).message.replace(/^NetSuite: /, '')}; check the NetSuite window` };
    }
    if (rec.type !== 'timesheet' || !rec.employee || !rec.employeeText) return { ok: false, reason: 'logged in, but the page is not a weekly timesheet with an employee' };
    return { ok: true, user: rec.employeeText } satisfies LoginState;
  },

  async discover(page, url) {
    const login = await netsuite.checkLogin(page, url);
    if (!login.ok) throw new Abort(login.reason);
    const origin = netsuiteBase(url);
    const first = await readRecord(page, 'NetSuite');
    const employeeId = first.employee;
    const guard = await guardSave(page, origin); // never allowed: blocks every write while the scratch line exists
    const dialogs = watchDialogs(page);
    try {
      // The project and task options need an editable timesheet: the current week, or one of the next ones.
      let opened: RecordData | null = null;
      for (let i = 0; i < 5 && !opened; i++) {
        const week = addDays(weekStart(today()), 7 * i);
        const rec = await gotoWeek(page, { origin, employeeId, user: login.user, week });
        if (rec.isDynamic && SAVED_APPROVAL.has(rec.approvalstatus)) opened = rec;
      }
      if (!opened) throw new Abort('NetSuite: no editable timesheet in the next weeks to read the projects from');
      const options = await page.evaluate(projectOptionsInPage);
      if (typeof options === 'string') throw new Abort(`NetSuite: cannot read the projects (${options})`);
      const projects: NetsuiteProject[] = [];
      for (const o of options) {
        if (guard.state.blocked) throw new Abort(`NetSuite: blocked ${guard.state.blocked}`);
        projects.push({ name: o.text, value: o.value, tasks: await readTasks(page, o.value) });
      }
      dialogs.check('NetSuite');
      if (guard.state.blocked) throw new Abort(`NetSuite: blocked ${guard.state.blocked}`);
      return { origin, employeeId, user: login.user, projects, discoveredAt: new Date().toISOString() };
    } finally {
      // Leave the scratch line unsaved.
      dialogs.allowLeave(true);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      dialogs.dispose();
      await guard.dispose();
    }
  },

  sameSite(catalog, url) {
    try {
      return netsuiteBase(url) === catalog.origin;
    } catch {
      return false;
    }
  },

  catalogUser: (catalog) => catalog.user,

  exists(catalog, target) {
    return catalog.projects.some((p) => p.name === target.project && p.tasks.includes(target.task));
  },

  label: ADAPTER_LABEL,

  async read(page, catalog, week, signal) {
    const dialogs = watchDialogs(page);
    try {
      if (signal?.aborted) throw new Abort('cancelled');
      const ctx = { origin: catalog.origin, employeeId: catalog.employeeId, user: catalog.user, week };
      const rec = await gotoWeek(page, ctx);
      const { cells, frozen } = parseWeek(rec, week);
      dialogs.check(`NetSuite week ${week}`);
      return { week, cells, ...(Object.keys(frozen).length ? { frozen } : {}) } satisfies Snapshot<NetsuiteTarget>;
    } finally {
      dialogs.dispose();
    }
  },

  units: (week) => [week],
  unitOf: (week) => week,

  async apply(page, catalog, week, work: UnitWork<NetsuiteTarget>, opts: ApplyOptions) {
    const where = `NetSuite week ${week}`;
    const ctx = { origin: catalog.origin, employeeId: catalog.employeeId, user: catalog.user, week };
    const inWeek = (c: Cell<NetsuiteTarget>) => c.date >= week && c.date <= addDays(week, 6);
    if (![...work.write, ...work.before].every(inWeek)) throw new Abort(`${where}: cells of another week were passed`);
    if (!work.write.length) throw new Abort(`${where}: nothing to write`);
    for (const c of work.write) {
      if (cents(c.hours) <= 0 || cents(c.hours) % 25 !== 0) throw new Abort(`${where}: ${c.date} ${c.target.task} has ${c.hours} h, not a whole quarter hour (NetSuite would round it)`);
    }
    const dialogs = watchDialogs(page);
    const cancelled = () => {
      blockedCheck(page, where);
      if (opts.signal.aborted) throw new Abort(`${where}: cancelled, nothing saved`);
    };
    const expected = [...work.before, ...work.write];

    /** Checks a freshly opened week still is as reviewed, and locates every target before anything is touched. */
    const prepareFill = (rec: RecordData) => {
      if (!EDITABLE_APPROVAL.has(rec.approvalstatus)) throw new Abort(`${where}: the timesheet is ${approvalText(rec.approvalstatus)}; enter it by hand`);
      if (!rec.isDynamic) throw new Abort(`${where}: the timesheet did not open for editing`);
      if (rec.lockstatus && rec.lockstatus !== 'unlocked') throw new Abort(`${where}: the timesheet is ${rec.lockstatus}`);
      const day = parseWeek(rec, week);
      if (!sameCells(day.cells, work.before)) throw new Abort(`${where}: changed since the review (now ${describeCells(day.cells)}; reviewed ${describeCells(work.before)}); prepare again`);
      for (const c of work.write) if (day.frozen[c.date]) throw new Abort(`${where}: ${c.date} is ${day.frozen[c.date]} in NetSuite; nothing can be added on it`);
      const groups = new Map<string, { target: NetsuiteTarget; hours: [number, number][] }>();
      for (const c of work.write) {
        const key = JSON.stringify([c.target.project, c.target.task]);
        const g = groups.get(key) ?? { target: c.target, hours: [] };
        const d = Math.round((Date.parse(`${c.date}T00:00:00Z`) - Date.parse(`${week}T00:00:00Z`)) / 86_400_000);
        if (g.hours.some(([x]) => x === d)) throw new Abort(`${where}: ${c.date} ${c.target.task} is planned twice`);
        g.hours.push([d, cents(c.hours) / 100]);
        groups.set(key, g);
      }
      const ops: FillOp[] = [];
      for (const { target, hours } of groups.values()) {
        const project = catalog.projects.filter((p) => p.name === target.project);
        if (project.length !== 1) throw new Abort(`${where}: the project "${target.project}" is ${project.length ? 'listed twice' : 'not offered'}; discover again`);
        if (!project[0].tasks.includes(target.task)) throw new Abort(`${where}: the task "${target.task}" is not offered for ${target.project}; discover again`);
        // Lines NetSuite locked (approved or submitted) are never touched: the hours go on another line.
        const lines = day.lines.filter((l) => l.data.customerText === target.project && l.data.taskText === target.task && l.data.editable !== 'F' && !l.data.status?.includes('3'));
        if (lines.length > 1) throw new Abort(`${where}: ${target.project} · ${target.task} has ${lines.length} lines; enter this week by hand`);
        if (lines.length === 1) {
          const l = lines[0];
          if (l.data.customer !== project[0].value) throw new Abort(`${where}: the line of ${target.task} has project id ${l.data.customer}, expected ${project[0].value}`);
          for (const [d] of hours) if (l.minutes[d] !== 0) throw new Abort(`${where}: ${addDays(week, d)} ${target.task} already holds hours`);
          ops.push({ line: l.line, customer: project[0].value, task: target.task, hours });
        } else ops.push({ line: -1, customer: project[0].value, task: target.task, hours });
      }
      return { day, ops };
    };

    /** Opens the week afresh in the run's tab once NetSuite's own navigation (after Save, a reload) settled. */
    const reopen = async () => {
      dialogs.allowLeave(true);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
        await sleep(1000);
        return await gotoWeek(page, ctx);
      } finally {
        dialogs.allowLeave(false);
      }
    };
    /** Reads the week in a separate tab, leaving the run's tab (and what it holds) alone. */
    const readElsewhere = async () => {
      const bg = await page.context().newPage();
      const bgDialogs = watchDialogs(bg);
      try {
        return await gotoWeek(bg, ctx);
      } finally {
        bgDialogs.dispose();
        await bg.close({ runBeforeUnload: false }).catch(() => {});
        await page.bringToFront().catch(() => {});
      }
    };

    try {
      cancelled();
      opts.onState(`Checking the week of ${week}`);
      let base = await gotoWeek(page, ctx);
      let { day, ops } = prepareFill(base);
      const frozenBefore = day.frozen;
      dialogs.check(where);
      cancelled();

      // From the first change on, every write is intercepted: none passes until the filled-in week is
      // verified, and then only that exact save. Any stop before a save reloads the week.
      const guard = await guardSave(page, ctx.origin);
      let token = '';
      /** A save went out and what it did is not known yet: any problem now means checking by hand. */
      let pending = false;
      let refill = true;
      let saves = 0;
      let reloads = 0;
      let exp: SaveExpectation | null = null;

      const waitSaved = async (deadline: number, user: boolean): Promise<'sent' | 'reloaded'> => {
        for (;;) {
          if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
          blockedCheck(page, where);
          if (guard.state.request) return 'sent';
          const s = await documentState(page, token);
          if (s === 'closed') throw new Abort(`${where}: the browser window was closed before saving; nothing saved`);
          if (s !== 'old') return guard.state.request ? 'sent' : 'reloaded';
          if (user && opts.signal.aborted) throw new Abort(`${where}: cancelled; the filled values were not saved`);
          if (Date.now() > deadline) throw new Abort(user ? `${where}: not saved within ${Math.round((opts.userTimeoutMs ?? USER_TIMEOUT) / 60_000)} min; nothing saved, prepare again` : `${where}: pressing Save sent nothing (NetSuite may show a message); nothing saved`);
          await sleep(150);
        }
      };

      /** After a save went out: what NetSuite holds now, read from scratch. */
      const verifySave = async (): Promise<{ saved: true; cells: Cell<NetsuiteTarget>[] } | { saved: false; why: string; rec: RecordData | null }> => {
        const submission = guard.state.request!;
        opts.onState(`Waiting for NetSuite to save the week of ${week}`);
        const response = await Promise.race([submission.response().catch(() => null), sleep(SAVE_TIMEOUT).then(() => 'timeout' as const)]);
        if (response === 'timeout') throw new Failed(`${where}: no answer from NetSuite after Save; check the week by hand`);
        const answer = !response ? 'the save request failed in the browser' : response.status() >= 400 ? `NetSuite answered ${response.status()}` : '';
        // A save that went through shows the saved timesheet (a new page); give NetSuite time for that.
        const until = Date.now() + (answer ? 3000 : 15_000);
        while (Date.now() < until && (await documentState(page, token)) === 'old') await sleep(250);
        if (guard.state.blocked) throw new Failed(`${where}: after the save, NetSuite tried ${guard.state.blocked} (blocked); check the week by hand`);
        opts.onState(`Checking what NetSuite saved for the week of ${week}`);
        const left = (await documentState(page, token)) !== 'old';
        const fresh = left ? await reopen() : await readElsewhere();
        const check = parseWeek(fresh, week);
        if (sameCells(check.cells, expected)) {
          if (!SAVED_APPROVAL.has(fresh.approvalstatus) && fresh.approvalstatus !== base.approvalstatus) throw new Failed(`${where}: after saving the timesheet is ${approvalText(fresh.approvalstatus)}, expected open (not submitted); check it by hand`);
          const nowFrozen = work.write.filter((c) => check.frozen[c.date] && !frozenBefore[c.date]);
          if (nowFrozen.length) throw new Failed(`${where}: after saving ${nowFrozen.map((c) => `${c.date} is ${check.frozen[c.date]}`).join(', ')}, expected open (not submitted); check it by hand`);
          // The tab still shows the filled-in form when NetSuite stayed on it: show the saved week instead.
          if (!left) await reopen().catch(() => {});
          return { saved: true, cells: check.cells };
        }
        if (sameCells(check.cells, work.before) && fresh.id === base.id && fresh.approvalstatus === base.approvalstatus) return { saved: false, why: answer || 'NetSuite kept the old hours', rec: left ? fresh : null };
        throw new Failed(`${where}: after saving NetSuite holds ${describeCells(check.cells)}, expected ${describeCells(expected)}; check the week by hand`);
      };

      try {
        for (;;) {
          if (refill) {
            try {
              token = await markDocument(page);
            } catch (e) {
              throw new Abort(`${where}: cannot mark the page (${reasonOf(e, where)}); nothing saved`);
            }
            opts.onState(`Filling the week of ${week}`);
            for (const op of ops) {
              if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
              cancelled();
              const problem = await page.evaluate(fillLineInPage, op);
              if (problem) throw new Abort(`${where}: ${op.task}: ${problem}; nothing saved`);
            }
            await sleep(500);
            if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
            if ((await documentState(page, token)) !== 'old') throw new Abort(`${where}: the page was reloaded or left while filling in; nothing saved`);

            // The record must hold exactly what was there plus what we entered.
            const filled = await readRecord(page, where);
            assertWeek(filled, ctx);
            const check = parseWeek(filled, week);
            if (!sameCells(check.cells, expected)) throw new Abort(`${where}: after filling in the week holds ${describeCells(check.cells)}, expected ${describeCells(expected)}; nothing saved`);
            const newLines = ops.filter((o) => o.line < 0).length;
            if (filled.lines.length !== base.lines.length + newLines) throw new Abort(`${where}: ${filled.lines.length} lines after filling in, expected ${base.lines.length + newLines}; nothing saved`);
            for (const l of check.lines) {
              if (l.minutes.some((m) => m > 0) && (!l.data.customer || !l.data.task || !l.data.item)) throw new Abort(`${where}: line ${l.line + 1} lacks project, task or service item after filling in; nothing saved`);
            }
            dialogs.check(where);
            cancelled();
            if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
            exp = { employeeId: ctx.employeeId, id: base.id, week, approval: base.approvalstatus, lines: check.lines.map((l) => ({ customer: l.data.customer, task: l.data.task, minutes: l.minutes })) };
            refill = false;
          }
          guard.allow(exp!);

          let outcome: 'sent' | 'reloaded';
          if (opts.save) {
            const button = page.locator('[data-automation-id="form.save"] button[aria-label="Save"]').filter({ visible: true }).first();
            if ((await button.count()) !== 1) throw new Abort(`${where}: no Save button found`);
            if (!(await button.isEnabled())) throw new Abort(`${where}: the Save button cannot be pressed`);
            cancelled();
            opts.onState(`Saving the week of ${week}`);
            await button.click({ noWaitAfter: true, timeout: 5000 }).catch((e: Error) => {
              if (!guard.state.request && !guard.state.blocked) throw new Abort(`${where}: pressing Save failed (${e.message.split('\n')[0]}); nothing saved`);
            });
            outcome = await waitSaved(Date.now() + 30_000, false);
          } else {
            opts.onState(saves ? `NetSuite did not save the week of ${week}: press Save again in the browser window (not Submit)` : `Filled the week of ${week}: press Save in the browser window (not Submit)`);
            await page.bringToFront().catch(() => {});
            dialogs.acceptPrompts(true);
            try {
              outcome = await waitSaved(Date.now() + (opts.userTimeoutMs ?? USER_TIMEOUT), true);
            } finally {
              dialogs.acceptPrompts(false);
            }
          }

          if (outcome === 'reloaded') {
            // NetSuite (or the user) reloaded the page before saving: the filled-in values are gone. Fill in again.
            if (++reloads > 3) throw new Abort(`${where}: the page was reloaded ${reloads} times before saving; nothing saved`);
            opts.onState(`The page was reloaded: filling the week of ${week} in again`);
            guard.lock();
            base = await reopen();
            ({ day, ops } = prepareFill(base));
            refill = true;
            continue;
          }

          pending = true;
          saves++;
          guard.lock();
          const v = await verifySave();
          if (v.saved) return v.cells;
          // Verified: NetSuite holds what it held before. Saving again is safe.
          pending = false;
          if (opts.save || saves >= 5) throw new Abort(`${where}: NetSuite did not save the week (${v.why}); nothing saved`);
          if (v.rec) {
            base = v.rec;
            ({ day, ops } = prepareFill(base));
            refill = true;
          }
          guard.reallow();
        }
      } catch (e) {
        guard.lock();
        let err: Error;
        if (pending) err = e instanceof Failed ? e : new Failed(`${where}: NetSuite received a save — check the week by hand (${reasonOf(e, where)})`);
        else if (guard.state.blocked && !(e instanceof Failed)) err = new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
        else err = e as Error;
        if (!(err instanceof Abort) && !(err instanceof Failed)) err = new Failed(`${where}: ${reasonOf(err, where)} while filling in; check NetSuite by hand`);
        if (!pending) err.message += await resetPage(page, ctx, token, work.before, dialogs);
        throw err;
      } finally {
        await guard.dispose();
      }
    } finally {
      dialogs.dispose();
    }
  },
};

export const netsuiteLabel = ADAPTER_LABEL;
