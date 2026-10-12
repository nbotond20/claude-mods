/// <reference lib="dom" />
import type { BrowserContext, CDPSession, Dialog, Page, Request, Route } from 'playwright-core';
import { addDays, daysBetween } from '../dates.ts';
import { Abort, type Adapter, type ApplyOptions, Failed, type LoginState, type Protection, sleep, type UnitWork } from './adapter.ts';
import { byCell, cellKey, cents } from './plan.ts';
import type { Cell, RedmineTarget, Snapshot } from './types.ts';

/** An issue row listed on the Worktime page. */
export interface RedmineIssue {
  id: number;
  /** Subject, without the "Feature #9888: " prefix */
  title: string;
  /** Redmine project of the black header row above it */
  project: string;
  /** Activity option texts of its row (they depend on the project); empty = cannot be booked */
  activities: string[];
}

export interface RedmineCatalog {
  /** Redmine root (origin plus a sub-path if Redmine is not at the root), no trailing slash */
  origin: string;
  userId: number;
  /** Name in the "Monthly Report (…)" heading */
  user: string;
  issues: RedmineIssue[];
  /** Every activity offered by any issue, in page order */
  activities: string[];
  discoveredAt: string;
}

const NAV_TIMEOUT = 30_000;
const SAVE_TIMEOUT = 60_000;
const USER_TIMEOUT = 15 * 60_000;

// ---------- addresses ----------

/** The Redmine root from the configured Worktime address (…/work_time/index, or the Redmine root). */
export function redmineBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Abort(`the Redmine address is not a URL: ${url}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Abort('the Redmine address must start with https://');
  const path = u.pathname.replace(/\/+$/, '');
  const m = /^(.*)\/work_time(\/index)?$/.exec(path);
  if (m) return u.origin + m[1];
  if (path === '') return u.origin;
  throw new Abort(`the Redmine address must be the Worktime page (…/work_time/index), not ${u.pathname}`);
}

const ymd = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return { year: String(y), month: String(m), day: String(d) };
};

/** The only address the adapter ever opens for a day: exactly year, month, day and user (GET params drive side effects in Worktime). */
export function dayUrl(origin: string, userId: number, date: string): string {
  const { year, month, day } = ymd(date);
  return `${origin}/work_time/index?year=${year}&month=${month}&day=${day}&user=${userId}`;
}

/** Why a URL is not the Worktime page of this day and user, or null if it is. Only `prj=false` (added by Worktime itself) may be extra. */
export function dayUrlProblem(raw: string, origin: string, userId: number, date: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `not a URL: ${raw}`;
  }
  const base = new URL(origin);
  if (u.origin !== base.origin) return `on ${u.origin}, expected ${base.origin}`;
  if (u.pathname !== `${base.pathname.replace(/\/$/, '')}/work_time/index`) return `on ${u.pathname}, expected the Worktime page`;
  const want: Record<string, string> = { ...ymd(date), user: String(userId) };
  const seen = new Set<string>();
  for (const [key, value] of u.searchParams) {
    if (seen.has(key)) return `parameter ${key} appears twice`;
    seen.add(key);
    if (key === 'prj' && value === 'false') continue;
    if (!(key in want)) return `unexpected parameter ${key}`;
    if (want[key] !== value) return `${key}=${value}, expected ${want[key]}`;
  }
  for (const key of Object.keys(want)) if (!seen.has(key)) return `parameter ${key} is missing`;
  return null;
}

// ---------- reading the page ----------

interface DomControl {
  name: string;
  tag: string;
  type: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  /** Inputs and textareas: the value as rendered by the server (the value attribute) */
  defaultValue?: string;
  /** Selects only; defaultSelected = the option carries the selected attribute (what the server rendered) */
  options?: { text: string; value: string; selected: boolean; defaultSelected: boolean }[];
}

interface DomRow {
  id: string;
  index: number;
  /** Text of the first cell */
  first: string;
  /** Text of the second cell */
  second: string;
  /** data-issue of every a.wt_iss_link in the row */
  issues: string[];
  /** Text of the first issue link */
  link: string;
  controls: DomControl[];
}

export interface WorktimeDom {
  url: string;
  monthly: string[];
  daily: string[];
  loggedAs: { text: string; href: string } | null;
  loginForm: boolean;
  errors: string[];
  tables: number;
  form: { action: string; method: string; fields: [string, string][] } | null;
  /** Update buttons that follow the day table in its form */
  updateButtons: number;
  rows: DomRow[];
  savedTotal: string | null;
  /** Every new_time_entry[…][hours] / time_entry[…][hours] in the document, also outside the table */
  hoursFields: { name: string; value: string }[];
}

/**
 * Runs inside the page (page.evaluate), so it must stay self-contained. A plain description of the
 * Worktime page; all decisions are made by the caller.
 */
export function readWorktimeDom(): WorktimeDom {
  const text = (n: Element | null | undefined) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const h2 = [...document.querySelectorAll('h2')].map((h) => text(h));
  const monthly = h2.map((t) => /^Monthly Report \((.*)\)$/.exec(t)?.[1]).filter((x): x is string => x !== undefined);
  const daily = h2.map((t) => /^Daily Report (\S+)$/.exec(t)?.[1]).filter((x): x is string => x !== undefined);
  const logged = document.querySelector('#loggedas a');
  // Worktime renders its messages (@message) as <div style="background:#faa;"> at the top of #content. The month
  // table's day scroller (#day_scroll) colours Sunday cells the same way: those are not errors. Everything else is.
  const errors = [...document.querySelectorAll('div[style*="background:#faa"], div[style*="background: #faa"], #errorExplanation, .flash.error')]
    .filter((e) => !e.closest('#day_scroll'))
    .map((e) => text(e) || 'error');
  const tables = document.querySelectorAll('#time_input_table');
  const table = tables[0] as HTMLTableElement | undefined;
  const formEl = table?.closest('form') ?? null;
  const control = (el: Element): DomControl => {
    const f = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    return {
      name: f.getAttribute('name') ?? '',
      tag: el.localName,
      type: (el.getAttribute('type') ?? '').toLowerCase(),
      value: f.value,
      disabled: f.disabled,
      readOnly: 'readOnly' in f ? !!(f as HTMLInputElement).readOnly : false,
      ...(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? { defaultValue: el.defaultValue } : {}),
      ...(el instanceof HTMLSelectElement ? { options: [...el.options].map((o) => ({ text: text(o), value: o.value, selected: o.selected, defaultSelected: o.defaultSelected })) } : {}),
    };
  };
  const rows: DomRow[] = table
    ? [...table.rows].map((tr, index) => ({
        id: tr.id,
        index,
        first: text(tr.cells[0]),
        second: text(tr.cells[1]),
        issues: [...tr.querySelectorAll('a.wt_iss_link')].map((a) => a.getAttribute('data-issue') ?? ''),
        link: text(tr.querySelector('a.wt_iss_link')),
        controls: [...tr.querySelectorAll('input[name], select[name], textarea[name]')].map(control),
      }))
    : [];
  let updateButtons = 0;
  if (table && formEl) {
    for (let n = table.nextElementSibling; n; n = n.nextElementSibling)
      if (n.matches('input[type="button"][value="Update"]') && n.closest('form') === formEl) updateButtons++;
  }
  return {
    url: location.href,
    monthly,
    daily,
    loggedAs: logged ? { text: text(logged), href: logged.getAttribute('href') ?? '' } : null,
    loginForm: !!document.querySelector('input[type="password"], form[action*="/login"]'),
    errors,
    tables: tables.length,
    form: formEl
      ? {
          action: formEl.action,
          method: (formEl.getAttribute('method') ?? 'get').toLowerCase(),
          fields: [...new FormData(formEl).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `[file ${v.name}]`] as [string, string]),
        }
      : null,
    updateButtons,
    rows,
    savedTotal: document.querySelector('#currentTotal')?.getAttribute('title') ?? null,
    hoursFields: [...document.querySelectorAll('input[name^="new_time_entry["], input[name^="time_entry["]')]
      .filter((i) => /\]\[hours\]$/.test(i.getAttribute('name') ?? ''))
      .map((i) => ({ name: i.getAttribute('name') ?? '', value: (i as HTMLInputElement).value })),
  };
}

async function readDom(page: Page): Promise<WorktimeDom> {
  return page.evaluate(readWorktimeDom);
}

const HOURS = /^\d{1,3}(\.\d{1,4})?$/;
/** How Worktime renders the hours of an entry: sprintf("%1.2f"). */
const RENDERED_HOURS = /^\d{1,3}\.\d{2}$/;
const parseHours = (s: string): number | null => (HOURS.test(s.trim()) ? cents(Number(s.trim())) : null);
const fmtCents = (c: number) => (c / 100).toFixed(2);
/** How the adapter types hours: dot decimal, at most two decimals. */
export const hoursText = (hours: number) => fmtCents(cents(hours));

const NEW_HOURS = /^new_time_entry\[(\d+)\]\[(\d+)\]\[hours\]$/;
const ENTRY = /^time_entry_pos(\d+)$/;
const NEW_ROW = /^time_entry_pos(\d+)_0$/;

interface NewRow {
  issueId: number;
  title: string;
  hours: DomControl;
  activity: DomControl | null;
}

interface DayData {
  date: string;
  cells: Cell<RedmineTarget>[];
  /** Issue rows without entries, by issue id (only issues listed exactly once) */
  newRows: Map<number, NewRow>;
  /** How many rows (any kind) show each issue */
  issueRows: Map<number, number>;
  /** Issues in page order, with their project and activities (for discovery) */
  issues: RedmineIssue[];
}

export interface PageContext {
  origin: string;
  userId: number;
  user: string;
  date: string;
}

const subject = (link: string) => link.replace(/^.*?#\d+\s*:\s*/, '').trim() || link;

/** Asserts this is the Worktime page of the expected user and day; throws Abort with the reason otherwise. */
export function assertDayPage(dom: WorktimeDom, ctx: PageContext): void {
  const where = `Redmine ${ctx.date}`;
  if (dom.loginForm || !dom.loggedAs) throw new Abort(`${where}: not logged in (log in again in the browser window)`);
  const urlProblem = dayUrlProblem(dom.url, ctx.origin, ctx.userId, ctx.date);
  if (urlProblem) throw new Abort(`${where}: unexpected page address (${urlProblem})`);
  if (dom.monthly.length !== 1 || dom.monthly[0] !== ctx.user) throw new Abort(`${where}: the page is for ${dom.monthly.length === 1 ? `"${dom.monthly[0]}"` : 'an unknown user'}, expected "${ctx.user}"`);
  if (dom.daily.length !== 1 || dom.daily[0] !== ctx.date) throw new Abort(`${where}: the page shows the day ${dom.daily.join(', ') || '(none)'}`);
  if (dom.tables !== 1) throw new Abort(`${where}: expected one Worktime day table, found ${dom.tables}`);
  if (dom.errors.length) throw new Abort(`${where}: Redmine shows an error: ${dom.errors.join(' / ').slice(0, 300)}`);
  if (!dom.form || dom.form.method !== 'post') throw new Abort(`${where}: the day table is not in a POST form`);
  const actionProblem = dayUrlProblem(dom.form.action, ctx.origin, ctx.userId, ctx.date);
  if (actionProblem) throw new Abort(`${where}: the form would post to an unexpected address (${actionProblem})`);
  // Hidden fields are posted along and are read by Worktime like the URL parameters.
  const field = (name: string) => dom.form!.fields.filter(([k]) => k === name).map(([, v]) => v);
  const want: Record<string, string> = { ...ymd(ctx.date), user: String(ctx.userId), prj: 'false' };
  for (const [name, value] of Object.entries(want)) {
    const got = field(name);
    if (got.length !== 1 || got[0] !== value) throw new Abort(`${where}: form field ${name} is ${got.length ? got.join(', ') : 'missing'}, expected ${value}`);
  }
  for (const [name] of dom.form.fields) if (/ticket_del|ticket_pos|prj_pos|member_pos|set_holiday|del_holiday/.test(name)) throw new Abort(`${where}: the form carries ${name}`);
}

/**
 * The time entries of a day as cells, plus the empty issue rows. Anything unexpected (hours on
 * issues the user cannot see, pre-filled new rows, an entry whose issue or activity cannot be
 * read, a day total that does not add up, an unknown row) throws Abort.
 */
export function parseDay(dom: WorktimeDom, date: string): DayData {
  const where = `Redmine ${date}`;
  const cells: Cell<RedmineTarget>[] = [];
  const newRows = new Map<number, NewRow>();
  const issueRows = new Map<number, number>();
  const issues = new Map<number, RedmineIssue>();
  const fresh: NewRow[] = [];
  let project: string | null = null;
  let privateCents = 0;
  let sum = 0;

  for (const f of dom.hoursFields) {
    if (!/^new_time_entry\[/.test(f.name)) continue;
    if (f.value.trim() !== '') throw new Abort(`${where}: a new entry is already filled in on the page (${f.name} = ${f.value}); reload it in the browser`);
  }

  const issueOf = (row: DomRow): number => {
    if (row.issues.length !== 1 || !/^\d+$/.test(row.issues[0])) throw new Abort(`${where}: cannot tell which issue row ${row.id || row.index} belongs to`);
    const id = Number(row.issues[0]);
    issueRows.set(id, (issueRows.get(id) ?? 0) + 1);
    return id;
  };
  const activitiesOf = (c: DomControl | undefined) => (c?.options ?? []).map((o) => o.text);
  const remember = (id: number, row: DomRow, activity: DomControl | undefined) => {
    if (project === null) throw new Abort(`${where}: issue #${id} is not under a project header`);
    if (!issues.has(id)) issues.set(id, { id, title: subject(row.link), project, activities: activitiesOf(activity) });
  };

  for (const row of dom.rows) {
    if (row.id === 'time_input_table_bottom') continue;
    const entry = ENTRY.exec(row.id);
    const empty = NEW_ROW.exec(row.id);
    if (empty) {
      const id = issueOf(row);
      if (Number(empty[1]) !== id) throw new Abort(`${where}: row ${row.id} links to issue #${id}`);
      const hours = row.controls.filter((c) => NEW_HOURS.test(c.name));
      const activity = row.controls.filter((c) => c.name === `new_time_entry[${id}][0][activity_id]`);
      remember(id, row, activity[0]);
      if (hours.length === 1 && hours[0].name === `new_time_entry[${id}][0][hours]` && activity.length <= 1) fresh.push({ issueId: id, title: subject(row.link), hours: hours[0], activity: activity[0] ?? null });
    } else if (entry) {
      const entryId = entry[1];
      const id = issueOf(row);
      const hours = row.controls.filter((c) => c.name === `time_entry[${entryId}][hours]`);
      const activity = row.controls.filter((c) => c.name === `time_entry[${entryId}][activity_id]`);
      remember(id, row, activity[0]);
      if (hours.length !== 1) throw new Abort(`${where}: cannot read the hours of entry ${entryId} on #${id}`);
      // Every field of an entry is posted back on Update and rewrites the entry, so what the page shows must
      // be exactly what Redmine stored. Hours are rendered with two decimals: an entry stored with more
      // (e.g. 1.255) shows rounded and cannot be told apart here; Update would round it.
      const shown = hours[0].value;
      if (!RENDERED_HOURS.test(shown) || shown !== hours[0].defaultValue) throw new Abort(`${where}: entry ${entryId} on #${id} shows hours "${shown}", not the saved "${hours[0].defaultValue ?? '?'}"; reload the page`);
      const h = parseHours(shown);
      if (h === null) throw new Abort(`${where}: entry ${entryId} on #${id} has unreadable hours "${shown}"`);
      sum += h;
      // options_for_select marks the stored activity; none marked = an activity no longer offered, and the
      // browser would show (and Update would save) the first option instead.
      if (activity.length !== 1 || activity[0].tag !== 'select') throw new Abort(`${where}: cannot read the activity of entry ${entryId} on #${id}`);
      const stored = (activity[0].options ?? []).filter((o) => o.defaultSelected);
      if (stored.length !== 1) throw new Abort(`${where}: entry ${entryId} has an activity Redmine no longer offers; fix it by hand`);
      const selected = (activity[0].options ?? []).filter((o) => o.selected);
      if (selected.length !== 1 || selected[0].value !== stored[0].value || !selected[0].text) throw new Abort(`${where}: the activity of entry ${entryId} on #${id} is not shown as saved; reload the page`);
      if (h === 0) continue;
      cells.push({ date, target: { issueId: id, activity: selected[0].text }, hours: h / 100 });
    } else if (row.id) {
      throw new Abort(`${where}: unknown row ${row.id} in the day table`);
    } else if (row.index === 0) {
      continue; // column titles
    } else if (row.first === 'private') {
      const h = parseHours(row.second);
      if (h === null) throw new Abort(`${where}: cannot read the hours on issues you cannot see ("${row.second}")`);
      privateCents += h;
      sum += h;
    } else {
      if (row.issues.length || row.controls.length) throw new Abort(`${where}: unexpected row ${row.index} in the day table`);
      project = row.first.replace(/^(\*|-?\d+)\s*:\s*/, '').trim();
      if (!project) throw new Abort(`${where}: a project header without a name`);
    }
  }

  // An issue shown in more than one row (two entries, or a duplicated row) has no row we may fill.
  for (const r of fresh) if (issueRows.get(r.issueId) === 1) newRows.set(r.issueId, r);

  // Hours fields outside the rows read above would be posted too: refuse them.
  const known = new Set(dom.rows.flatMap((r) => r.controls.map((c) => c.name)));
  for (const f of dom.hoursFields) if (!known.has(f.name)) throw new Abort(`${where}: hours field ${f.name} outside the day table`);

  if (privateCents !== 0) throw new Abort(`${where}: ${fmtCents(privateCents)} h on issues you cannot see; enter this week by hand`);
  const saved = /(\d+(?:\.\d+)?)\s*$/.exec(dom.savedTotal ?? '');
  if (!saved) throw new Abort(`${where}: cannot read the saved day total`);
  if (cents(Number(saved[1])) !== sum) throw new Abort(`${where}: the saved day total (${saved[1]} h) does not match the entries shown (${fmtCents(sum)} h)`);
  return { date, cells: cells.sort(byCell), newRows, issueRows, issues: [...issues.values()] };
}

/** Cells as a comparable list (duplicates kept). */
const cellList = (cells: Cell<RedmineTarget>[]) => cells.map((c) => `${cellKey(c)}=${cents(c.hours)}`).sort();
const sameCells = (a: Cell<RedmineTarget>[], b: Cell<RedmineTarget>[]) => JSON.stringify(cellList(a)) === JSON.stringify(cellList(b));
const describeCells = (cells: Cell<RedmineTarget>[]) => (cells.length ? cells.map((c) => `#${c.target.issueId} ${c.target.activity} ${fmtCents(cents(c.hours))} h`).join(', ') : 'nothing');

// ---------- navigation, dialogs, saving ----------

/** Dismisses every dialog; one counts as a reason to stop unless it is allowed (a beforeunload while the user saves). */
function watchDialogs(page: Page) {
  let seen: string | null = null;
  let allowLeave = false;
  const handler = (d: Dialog) => {
    if (allowLeave && d.type() === 'beforeunload') {
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
    dispose: () => page.off('dialog', handler),
  };
}

async function gotoDay(page: Page, ctx: PageContext): Promise<WorktimeDom> {
  const url = dayUrl(ctx.origin, ctx.userId, ctx.date);
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  } catch (e) {
    const blocked = blockedRequest(page);
    throw new Abort(`Redmine ${ctx.date}: ${blocked ?? `could not open the day (${(e as Error).message.split('\n')[0]})`}`);
  }
  const blocked = blockedRequest(page);
  if (blocked) throw new Abort(`Redmine ${ctx.date}: ${blocked}`);
  if (response && response.status() !== 200) throw new Abort(`Redmine ${ctx.date}: the day page answered ${response.status()}`);
  const dom = await readDom(page);
  assertDayPage(dom, ctx);
  return dom;
}

const normalize = (v: string) => v.replace(/\r\n?/g, '\n');
const samePairs = (a: [string, string][], b: [string, string][]) =>
  a.length === b.length && a.every(([k, v], i) => b[i][0] === k && normalize(b[i][1]) === normalize(v));

/** Form fields that differ between two serializations, except the expected ones (which must hold their expected values). */
export function unexpectedChanges(before: [string, string][], after: [string, string][], ours: Map<string, string>): string[] {
  if (before.length !== after.length || before.some(([k], i) => after[i][0] !== k)) return ['the set of form fields changed'];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  after.forEach(([k, v], i) => {
    if (ours.has(k)) {
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (v !== ours.get(k)) problems.push(`${k} is "${v}", expected "${ours.get(k)}"`);
    } else if (normalize(v) !== normalize(before[i][1])) problems.push(`${k} changed from "${before[i][1]}" to "${v}"`);
  });
  for (const k of ours.keys()) if (seen.get(k) !== 1) problems.push(`${k} is in the form ${seen.get(k) ?? 0} times`);
  return problems;
}

interface PostGuard {
  state: { blocked: string | null; request: Request | null };
  /** From now on, exactly one submission to `action` with exactly these fields may pass. */
  allow(action: string, fields: [string, string][]): void;
  /** Nothing passes any more. */
  lock(): void;
  dispose(): Promise<void>;
}

/**
 * Blocks every navigation POST of the tab until `allow` names the one expected submission (so an
 * Update pressed while the form is being filled in is stopped), then lets exactly one POST of that
 * body through. The body is compared field by field with what was verified, so a page script
 * changing a field on submit cannot slip a change through. `state.request` is set once a
 * submission went out: from then on Redmine may have saved something.
 */
async function guardPost(page: Page): Promise<PostGuard> {
  const state: PostGuard['state'] = { blocked: null, request: null };
  let expected: { action: string; fields: [string, string][] } | null = null;
  const handler = async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET' || !req.isNavigationRequest() || req.frame() !== page.mainFrame()) return route.fallback();
    let problem: string | null = null;
    if (state.request) problem = 'a second submission';
    else if (!expected) problem = 'a submission before the form was checked';
    else if (req.url() !== expected.action) problem = `a submission to ${req.url()}`;
    else {
      const raw = req.postData();
      const type = req.headers()['content-type'] ?? '';
      if (raw === null || !type.startsWith('application/x-www-form-urlencoded')) problem = 'a submission that cannot be checked';
      else {
        const body = [...new URLSearchParams(raw).entries()];
        const want = expected.fields;
        if (!samePairs(want, body)) {
          const diff = body.filter(([k, v], i) => want[i]?.[0] !== k || normalize(want[i][1]) !== normalize(v)).map(([k]) => k);
          problem = `a submission with other values than the checked form (${diff.slice(0, 5).join(', ') || 'fields missing'})`;
        }
      }
    }
    if (problem) {
      state.blocked ??= problem;
      return route.abort('blockedbyclient');
    }
    state.request = req;
    expected = null;
    return route.continue();
  };
  await page.route('**/*', handler);
  return {
    state,
    allow(action, fields) {
      if (!state.request && !state.blocked) expected = { action, fields };
    },
    lock() {
      expected = null;
    },
    dispose: () => page.unroute('**/*', handler).catch(() => {}),
  };
}

// ---------- requests that change Redmine ----------

/** GET parameters on which Worktime changes data whatever the request method (see WorkTimeController#index). */
export const MUTATING_PARAMS = ['ticket_del', 'ticket_pos', 'prj_pos', 'member_pos', 'set_holiday', 'del_holiday', 'memo'];

/** The first mutating parameter in the query of a request to the Redmine origin, or null. */
export function mutatingParam(raw: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== new URL(origin).origin) return null;
  for (const key of u.searchParams.keys()) if (MUTATING_PARAMS.includes(key)) return key;
  return null;
}

/** Protection state per browser context: why a request was blocked. */
const PROTECTED = new WeakMap<BrowserContext, { problem: string | null }>();
const blockedRequest = (page: Page): string | null => PROTECTED.get(page.context())?.problem ?? null;

/**
 * Fails every request to the Redmine origin that carries a mutating parameter, in every tab of the
 * browser, also redirect hops (page.route does not see those, so this uses the DevTools Fetch
 * domain directly) and the user's own clicks.
 */
export async function protectRedmine(page: Page, url: string): Promise<Protection> {
  const origin = new URL(redmineBase(url)).origin;
  const context = page.context();
  const state = { problem: null as string | null };
  const sessions: CDPSession[] = [];
  let disposed = false;
  const attach = async (p: Page) => {
    const cdp = await context.newCDPSession(p);
    sessions.push(cdp);
    cdp.on('Fetch.requestPaused', (ev) => {
      const param = mutatingParam(ev.request.url, origin);
      if (param) {
        state.problem ??= `blocked a request that would change Redmine: ${param}`;
        cdp.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else cdp.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/*`, requestStage: 'Request' }] });
  };
  const onPage = (p: Page) => {
    if (!disposed) attach(p).catch(() => {});
  };
  const dispose = async () => {
    disposed = true;
    context.off('page', onPage);
    for (const cdp of sessions) {
      await cdp.send('Fetch.disable').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    if (PROTECTED.get(context) === state) PROTECTED.delete(context);
  };
  PROTECTED.set(context, state);
  context.on('page', onPage);
  try {
    await attach(page);
  } catch (e) {
    await dispose();
    throw new Abort(`cannot protect the browser tab against requests that change Redmine (${(e as Error).message.split('\n')[0]}); nothing done`);
  }
  for (const p of context.pages()) if (p !== page && !p.isClosed()) await attach(p).catch(() => {});
  return { problem: () => state.problem, dispose };
}

/** Marks the current document, so a newly loaded one can be told apart even at the same URL. */
async function markDocument(page: Page): Promise<string> {
  const token = `ts${Math.random().toString(36).slice(2)}`;
  await page.evaluate((t) => {
    (window as unknown as Record<string, unknown>).__timesheetDoc = t;
  }, token);
  return token;
}

/** 'old' while the marked document is shown, 'loading' during navigation, 'new' once another document has loaded. */
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

/**
 * After a stop with the form filled in: loads the day again (accepting a beforeunload prompt) so no
 * filled-in value is left for a later Update, and checks that. Runs while the POST guard still blocks
 * every submission. If the tab cannot be shown clean, it is closed. Returns a note for the message.
 */
async function resetPage(page: Page, ctx: PageContext, token: string, dialogs: ReturnType<typeof watchDialogs>): Promise<string> {
  if (page.isClosed()) return '';
  dialogs.allowLeave(true);
  try {
    // A blocked submission leaves an error page navigation pending, which would interrupt ours: retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(dayUrl(ctx.origin, ctx.userId, ctx.date), { waitUntil: 'load', timeout: NAV_TIMEOUT });
        break;
      } catch (e) {
        if (attempt >= 3 || page.isClosed()) throw e;
        await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
        await sleep(300);
      }
    }
    const fresh = (await documentState(page, token)) === 'new';
    const dom = await readDom(page);
    const filled = dom.hoursFields.filter((f) => /^new_time_entry\[/.test(f.name) && f.value.trim() !== '');
    if (fresh && !dayUrlProblem(dom.url, ctx.origin, ctx.userId, ctx.date) && !filled.length) return '; the page was reloaded without the filled-in values';
  } catch {
    // closed below
  } finally {
    dialogs.allowLeave(false);
  }
  try {
    await page.close({ runBeforeUnload: false });
    return '; the browser tab was closed to discard the filled-in values';
  } catch {
    return '; the browser window may still show the filled-in values: do not press Update there, reload the page';
  }
}

/** The message of an error without the "Redmine <date>: " prefix and the "nothing saved" claim. */
const reasonOf = (e: unknown, where: string) =>
  ((e as Error)?.message ?? String(e))
    .split('\n')[0]
    .replace(`${where}: `, '')
    .replace(/[;,]? ?nothing saved\.?/g, '')
    .trim();

const ADAPTER_LABEL = (catalog: RedmineCatalog | null, t: RedmineTarget) => {
  const issue = catalog?.issues.find((i) => i.id === t.issueId);
  return `#${t.issueId}${issue ? ` ${issue.title}` : ''} · ${t.activity}`;
};

export const redmine: Adapter<RedmineTarget, RedmineCatalog> & {
  base: typeof redmineBase;
} = {
  system: 'redmine',
  base: redmineBase,
  protect: protectRedmine,

  async checkLogin(page, url) {
    const start = `${redmineBase(url)}/work_time/index`;
    try {
      await page.goto(start, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    } catch (e) {
      return { ok: false, reason: `could not open ${start} (${(e as Error).message.split('\n')[0]})` };
    }
    const dom = await readDom(page);
    const here = new URL(dom.url);
    if (dom.loginForm || !dom.loggedAs) return { ok: false, reason: 'not logged in: log in to Redmine in the browser window, then try again' };
    if (here.origin !== new URL(start).origin) return { ok: false, reason: `the browser ended up on ${here.origin}: log in to Redmine in the browser window, then try again` };
    if (dom.monthly.length !== 1) return { ok: false, reason: 'logged in, but the Worktime page did not open (is the Worktime plugin enabled for you?)' };
    return { ok: true, user: dom.monthly[0] } satisfies LoginState;
  },

  async discover(page, url) {
    const login = await redmine.checkLogin(page, url);
    if (!login.ok) throw new Abort(login.reason);
    const origin = redmineBase(url);
    const dom = await readDom(page);
    const here = new URL(dom.url);
    const userId = Number(here.searchParams.get('user'));
    if (!Number.isInteger(userId) || userId <= 0) throw new Abort('Redmine did not add the user to the Worktime address');
    const ownId = /\/users\/(\d+)$/.exec(dom.loggedAs?.href ?? '')?.[1];
    if (ownId !== String(userId)) throw new Abort(`the Worktime page is for user ${userId}, but you are logged in as user ${ownId ?? '?'}`);
    const date = dom.daily[0] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Abort('cannot read the date of the Worktime day');
    const ctx = { origin, userId, user: login.user, date };
    assertDayPage(dom, ctx);
    const day = parseDay(dom, date);
    const activities = [...new Set(day.issues.flatMap((i) => i.activities))];
    return { origin, userId, user: login.user, issues: day.issues, activities, discoveredAt: new Date().toISOString() };
  },

  sameSite(catalog, url) {
    try {
      return redmineBase(url) === catalog.origin;
    } catch {
      return false;
    }
  },

  catalogUser: (catalog) => catalog.user,

  exists(catalog, target) {
    return catalog.issues.some((i) => i.id === target.issueId && i.activities.includes(target.activity));
  },

  label: ADAPTER_LABEL,

  async read(page, catalog, week, signal) {
    const dialogs = watchDialogs(page);
    try {
      const cells: Cell<RedmineTarget>[] = [];
      for (const date of daysBetween(week, addDays(week, 6))) {
        if (signal?.aborted) throw new Abort('cancelled');
        const ctx = { origin: catalog.origin, userId: catalog.userId, user: catalog.user, date };
        const dom = await gotoDay(page, ctx);
        cells.push(...parseDay(dom, date).cells);
        dialogs.check(`Redmine ${date}`);
      }
      return { week, cells } satisfies Snapshot<RedmineTarget>;
    } finally {
      dialogs.dispose();
    }
  },

  units(_week, cells) {
    return [...new Set(cells.map((c) => c.date))].sort();
  },

  unitOf: (_week, cell) => cell.date,

  async apply(page, catalog, date, work: UnitWork<RedmineTarget>, opts: ApplyOptions) {
    const where = `Redmine ${date}`;
    const ctx = { origin: catalog.origin, userId: catalog.userId, user: catalog.user, date };
    if (work.write.some((c) => c.date !== date) || work.before.some((c) => c.date !== date)) throw new Abort(`${where}: cells of another day were passed`);
    if (!work.write.length) throw new Abort(`${where}: nothing to write`);
    const dialogs = watchDialogs(page);
    const cancelled = () => {
      const blocked = blockedRequest(page);
      if (blocked) throw new Abort(`${where}: ${blocked}; nothing saved`);
      if (opts.signal.aborted) throw new Abort(`${where}: cancelled, nothing saved`);
    };
    try {
      cancelled();
      opts.onState(`Checking ${date}`);
      const dom = await gotoDay(page, ctx);
      const day = parseDay(dom, date);
      if (!sameCells(day.cells, work.before)) throw new Abort(`${where}: changed since the review (now ${describeCells(day.cells)}; reviewed ${describeCells(work.before)}); prepare again`);

      // Locate every target before touching anything.
      const ours = new Map<string, string>();
      const steps: { hours: string; value: string; activity: string; select: string; index: number }[] = [];
      for (const c of work.write) {
        const id = c.target.issueId;
        if (!Number.isInteger(id) || id <= 0) throw new Abort(`${where}: invalid issue ${id}`);
        const rows = day.issueRows.get(id) ?? 0;
        if (rows === 0) throw new Abort(`${where}: issue #${id} is not listed on the Worktime page`);
        const row = day.newRows.get(id);
        if (rows > 1 || !row) throw new Abort(`${where}: issue #${id} has ${rows > 1 ? `${rows} rows` : 'no empty row'} on the Worktime page; enter this day by hand`);
        const hoursName = `new_time_entry[${id}][0][hours]`;
        const activityName = `new_time_entry[${id}][0][activity_id]`;
        if (dom.hoursFields.filter((f) => f.name === hoursName).length !== 1) throw new Abort(`${where}: the hours field of #${id} is not unique`);
        if (row.hours.value !== '' || row.hours.disabled || row.hours.readOnly || row.hours.type !== 'text') throw new Abort(`${where}: the hours field of #${id} is not an empty, editable text field`);
        if (!row.activity || row.activity.disabled || row.activity.tag !== 'select') throw new Abort(`${where}: #${id} has no activity to choose`);
        const options = row.activity.options ?? [];
        const matches = options.map((o, index) => ({ ...o, index })).filter((o) => o.text === c.target.activity);
        if (matches.length !== 1) throw new Abort(`${where}: #${id} offers the activity "${c.target.activity}" ${matches.length} times`);
        if (options.filter((o) => o.value === matches[0].value).length !== 1) throw new Abort(`${where}: the activity "${c.target.activity}" of #${id} shares its value with another option`);
        if (ours.has(hoursName)) throw new Abort(`${where}: #${id} is planned twice`);
        const value = hoursText(c.hours);
        if (cents(c.hours) <= 0) throw new Abort(`${where}: invalid hours for #${id}`);
        ours.set(hoursName, value);
        ours.set(activityName, matches[0].value);
        steps.push({ hours: hoursName, value, activity: c.target.activity, select: activityName, index: matches[0].index });
      }
      const before = dom.form!.fields;
      for (const name of ours.keys()) if (before.filter(([k]) => k === name).length !== 1) throw new Abort(`${where}: ${name} is not in the day form exactly once`);
      dialogs.check(where);
      cancelled();

      // From the first keystroke on, every submission is intercepted: none passes until the filled-in
      // form is verified, and then only that exact form, once. Any stop from here on reloads the day
      // (while submissions are still blocked), so no filled-in value is left for a later Update.
      const guard = await guardPost(page);
      let token: string;
      try {
        token = await markDocument(page);
      } catch (e) {
        await guard.dispose();
        throw new Abort(`${where}: cannot mark the page (${reasonOf(e, where)}); nothing saved`);
      }
      try {
        opts.onState(`Filling ${date}`);
        for (const s of steps) {
          if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
          const select = page.locator(`select[name="${s.select}"]`);
          const input = page.locator(`input[name="${s.hours}"]`);
          if ((await select.count()) !== 1 || (await input.count()) !== 1) throw new Abort(`${where}: the row of ${s.hours} changed while filling`);
          await select.selectOption({ index: s.index }, { timeout: 5000 });
          await input.fill(s.value, { timeout: 5000 });
        }
        // A submission started by a page script or by the user while filling shows up within moments.
        await sleep(250);
        if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
        if ((await documentState(page, token)) !== 'old') throw new Abort(`${where}: the page was reloaded or left while filling in; nothing saved`);

        // Only our fields may have changed, and they must hold exactly what we typed.
        const filled = await readDom(page);
        assertDayPage(filled, ctx);
        const problems = unexpectedChanges(before, filled.form!.fields, ours);
        if (problems.length) throw new Abort(`${where}: the form does not look as expected after filling in (${problems.slice(0, 3).join('; ')}); nothing saved`);
        for (const s of steps) {
          const sel = filled.rows.flatMap((r) => r.controls).filter((c) => c.name === s.select);
          const chosen = sel.length === 1 ? (sel[0].options ?? []).filter((o) => o.selected) : [];
          if (chosen.length !== 1 || chosen[0].text !== s.activity) throw new Abort(`${where}: ${s.select} reads "${chosen[0]?.text ?? '?'}" after filling, expected "${s.activity}"`);
          const back = await page.locator(`input[name="${s.hours}"]`).inputValue();
          if (back !== s.value) throw new Abort(`${where}: ${s.hours} reads "${back}" after filling, expected "${s.value}"`);
        }
        dialogs.check(where);
        cancelled();
        if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
        guard.allow(filled.form!.action, filled.form!.fields);

        if (opts.save) {
          const button = page.locator('#time_input_table ~ input[type="button"][value="Update"]');
          if (filled.updateButtons !== 1 || (await button.count()) !== 1) throw new Abort(`${where}: expected one Update button under the day table, found ${filled.updateButtons}`);
          if (!(await button.isEnabled()) || !(await button.isVisible())) throw new Abort(`${where}: the Update button cannot be pressed`);
          cancelled();
          opts.onState(`Saving ${date}`);
          await button.click({ noWaitAfter: true, timeout: 5000 }).catch((e: Error) => {
            if (!guard.state.request && !guard.state.blocked) throw new Failed(`${where}: pressing Update failed (${e.message.split('\n')[0]}); check Redmine by hand`);
          });
          const deadline = Date.now() + SAVE_TIMEOUT;
          for (;;) {
            if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
            const blocked = blockedRequest(page);
            if (blocked) throw new Abort(`${where}: ${blocked}`);
            const s = await documentState(page, token);
            if (s === 'closed') throw new Failed(`${where}: the browser window closed while saving; check Redmine by hand`);
            if (s === 'new') break;
            if (Date.now() > deadline) throw new Failed(`${where}: no answer from Redmine after pressing Update; check Redmine by hand`);
            await sleep(150);
          }
          if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
          if (!guard.state.request) throw new Failed(`${where}: the page changed after pressing Update, but no submission was seen; check Redmine by hand`);
        } else {
          opts.onState(`Filled ${date}: press Update in the browser window`);
          await page.bringToFront().catch(() => {});
          dialogs.allowLeave(true);
          const deadline = Date.now() + (opts.userTimeoutMs ?? USER_TIMEOUT);
          for (;;) {
            if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
            const blocked = blockedRequest(page);
            if (blocked) throw new Abort(`${where}: ${blocked}; nothing saved`);
            const submitted = !!guard.state.request;
            const s = await documentState(page, token);
            if (s === 'closed') throw (submitted ? new Failed(`${where}: the browser window closed while saving; check Redmine by hand`) : new Abort(`${where}: the browser window was closed before saving; nothing saved`));
            if (s === 'new') break;
            if (!submitted) {
              if (opts.signal.aborted) throw new Abort(`${where}: cancelled; the filled values were not saved`);
              if (Date.now() > deadline) throw new Abort(`${where}: not saved within ${Math.round((opts.userTimeoutMs ?? USER_TIMEOUT) / 60_000)} min; nothing saved, prepare again`);
            } else if (Date.now() > deadline + SAVE_TIMEOUT) throw new Failed(`${where}: no answer from Redmine after Update; check Redmine by hand`);
            await sleep(150);
          }
          if (guard.state.blocked) throw new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
          if (!guard.state.request) throw new Abort(`${where}: you left the page without saving ${date}; nothing saved`);
          dialogs.allowLeave(false);
        }
      } catch (e) {
        // Nothing more may pass, whatever happens next.
        guard.lock();
        let err: Error;
        if (guard.state.request) {
          // A submission went out: Redmine may have saved it, whatever went wrong afterwards.
          err = e instanceof Failed ? e : new Failed(`${where}: Redmine received an Update — check ${date} by hand (${reasonOf(e, where)})`);
        } else if (guard.state.blocked && !(e instanceof Failed)) {
          err = new Abort(`${where}: blocked ${guard.state.blocked}; nothing saved`);
        } else err = e as Error;
        if (!(err instanceof Abort) && !(err instanceof Failed)) err = new Failed(`${where}: ${reasonOf(err, where)} while filling in; check Redmine by hand`);
        err.message += await resetPage(page, ctx, token, dialogs);
        throw err;
      } finally {
        await guard.dispose();
      }
      const submission = guard.state.request!;

      // Saved: from here on, anything unexpected means the site must be checked by hand.
      try {
        const response = await submission.response().catch(() => null);
        if (response && response.status() >= 400) throw new Failed(`${where}: Redmine answered ${response.status()} to Update; check Redmine by hand`);
        const after = await readDom(page);
        if (after.errors.length) throw new Failed(`${where}: Redmine reported an error after Update: ${after.errors.join(' / ').slice(0, 300)}; check Redmine by hand`);
        if (dayUrlProblem(after.url, ctx.origin, ctx.userId, date)) throw new Failed(`${where}: Redmine went to ${after.url} after Update; check Redmine by hand`);
        opts.onState(`Verifying ${date}`);
        const reloaded = await gotoDay(page, ctx);
        const check = parseDay(reloaded, date);
        const expected = [...work.before, ...work.write];
        if (!sameCells(check.cells, expected)) throw new Failed(`${where}: after saving Redmine holds ${describeCells(check.cells)}, expected ${describeCells(expected)}; check Redmine by hand`);
        dialogs.check(where);
        return check.cells;
      } catch (e) {
        if (e instanceof Failed) throw e;
        throw new Failed(`${(e as Error).message.replace(/; nothing saved$/, '')} (after saving; check Redmine by hand)`);
      }
    } finally {
      dialogs.dispose();
    }
  },
};

export const redmineLabel = ADAPTER_LABEL;
