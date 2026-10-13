import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * A stand-in Redmine with the Worktime plugin: serves day pages built from the fixture template
 * (derived from the real capture), records every request, and on POST behaves like the plugin's
 * hour_update: new entries only where hours are filled in, an existing entry with blank hours is
 * DELETED, status changes only with an "M" prefix.
 */

const DIR = join(import.meta.dirname, 'fixtures', 'redmine');
const TEMPLATE = readFileSync(join(DIR, 'day.html'), 'utf8');
const CAPTURE = readFileSync(join(DIR, 'capture-2026-10-01.html'), 'utf8');

export const ACTIVITIES: [number, string][] = [
  [15, 'Meeting'], [9, 'Development'], [18, 'Testing'], [12, 'Documentation'], [13, 'Operations support'], [16, 'Troubleshooting'],
  [10, 'Overhead - learning'], [11, 'Overhead - other'], [14, 'Overhead - bugfix'], [17, 'Overhead - Presales'], [34, 'Source - credit'],
];
const STATUSES: [number, string][] = [[1, 'New'], [2, 'Assigned'], [9, 'In progress'], [4, 'Feedback'], [3, 'Resolved'], [5, 'Closed']];

export interface FxIssue {
  id: number;
  tracker: string;
  subject: string;
  project: string;
  /** Activity options; default all of ACTIVITIES */
  activities?: [number, string][];
  status?: number;
}

export interface FxEntry {
  id: number;
  issueId: number;
  date: string;
  hours: number;
  activityId: number;
  comments: string;
}

export interface FxState {
  loggedIn: boolean;
  user: { id: number; name: string; login: string };
  /** Shown in "Monthly Report (…)" instead of the user's name */
  headingName?: string;
  /** Date Worktime opens without parameters */
  today: string;
  issues: FxIssue[];
  entries: FxEntry[];
  /** Hours on issues the user cannot see, per date */
  private: Record<string, number>;
  memo: Record<string, string>;
  /** Rendered as the plugin's error banner after a POST (nothing is saved) */
  errorOnPost?: string;
  /** Extra <script> in the page head */
  script?: string;
  /** Issue rendered twice */
  duplicateRow?: number;
  /** Issues left out of the day page (still in the catalog) */
  hiddenIssues?: number[];
  /** A GET of a day is redirected to its URL plus this */
  redirectExtra?: string;
  /** The real capture is served for 2026-10-01 */
  capture?: boolean;
  /** Answer POSTs with a redirect to the day instead of rendering it */
  redirectAfterPost?: boolean;
  /** Rendered as the plugin's error banner on every GET of a day */
  errorOnGet?: string;
  /** Delay the answer to a POST (after it was applied) */
  postDelayMs?: number;
  nextEntryId: number;
}

export interface Recorded {
  gets: string[];
  posts: { url: string; fields: [string, string][] }[];
  statusChanges: string[];
  deleted: number[];
}

export function defaultState(): FxState {
  return {
    loggedIn: true,
    user: { id: 42, name: 'Jane Doe', login: 'jane.doe' },
    today: '2026-10-01',
    issues: [
      { id: 101, tracker: 'Support', subject: 'Internal meetings', project: 'Teamwork', status: 9 },
      { id: 102, tracker: 'Support', subject: 'Learning, training', project: 'People development' },
      { id: 4242, tracker: 'Feature', subject: 'Checkout redesign', project: 'Acme Platform' },
      { id: 103, tracker: 'Feature', subject: 'Company day, tech talks', project: 'Company events' },
    ],
    entries: [],
    private: {},
    memo: {},
    nextEntryId: 5000,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const parts = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return { year: y, month: m, day: d };
};
const dateOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function options(list: [number, string][], selected: number) {
  return list.map(([v, t]) => `<option value="${v}"${v === selected ? ' selected="selected"' : ''}>${esc(t)}</option>`).join('\n');
}

function issueCell(issue: FxIssue, link: string, pos: string, n: number) {
  return `<td class="wt_iss_default">
  <div style="position:relative;width:300px;">
    <a href="#" onclick="ticket_pos('/work_time/index?${link}', ${issue.id}, ${n}, 9); return false;">${n}</a>
    <a class="wt_iss_link" data-issue="${issue.id}" href="/issues/${issue.id}">${esc(`${issue.tracker} #${issue.id}: ${issue.subject}`)}</a>
    <a name="done_ratio${issue.id}" class="wt_done_ratio" data-issue="${issue.id}" href="#" onclick="input_done_ratio('/work_time/ajax_done_ratio_input?${link}', ${issue.id}); return false;">[0%]</a>
    &nbsp;&nbsp;&nbsp;
    <a style="position:absolute;bottom:1px;right:10px;" href="#" onclick="dup_ticket('/work_time/ajax_add_tickets_insert?${link}', '${pos}', ${issue.id}); return false;">+</a>
    <a style="position:absolute;bottom:1px;right:3px;" href="/work_time/index?${link}&amp;ticket_del=${issue.id}">x</a>
  </div>
  </td>`;
}

function rows(state: FxState, date: string, link: string): { html: string; total: number } {
  const projects: string[] = [];
  for (const i of state.issues) if (!projects.includes(i.project)) projects.push(i.project);
  let html = '';
  let total = 0;
  let n = 0;
  for (const project of projects) {
    const issues = state.issues.filter((i) => i.project === project && !state.hiddenIssues?.includes(i.id));
    if (!issues.length) continue;
    const ptotal = state.entries.filter((e) => e.date === date && issues.some((i) => i.id === e.issueId)).reduce((s, e) => s + e.hours, 0);
    html += `<tr style="background:#000;color:#fff;">
  <td>
        <a href="#" style="color:#8ff;" onclick="prj_pos('/work_time/index?${link}', 1, -1, 3); return false;">*:</a>
        ${esc(project)}
  </td>
  <td>${ptotal.toFixed(2)}</td>
  <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
</tr>\n`;
    for (const issue of issues) {
      n++;
      const acts = issue.activities ?? ACTIVITIES;
      const status = `<select name="%NAME%[status_id]" onchange="statusUpdateOnDailyTable('%NAME%[status_id]')" required="required">${options(STATUSES, issue.status ?? 1)}</select>`;
      const entries = state.entries.filter((e) => e.date === date && e.issueId === issue.id);
      if (!entries.length) {
        const name = `new_time_entry[${issue.id}][0]`;
        const row = `<tr id="time_entry_pos${issue.id}_0">
  ${issueCell(issue, link, `time_entry_pos${issue.id}_0`, n)}
  <td><input type="text" name="${name}[hours]" id="new_time_entry_${issue.id}_0_hours" value="" size="5" oninput="sumDayTimes()"></td>
  <td>${acts.length ? `<select name="${name}[activity_id]" id="new_time_entry_${issue.id}_0_activity_id">${options(acts, acts[0][0])}</select>` : ''}</td>
  <td>${status.replaceAll('%NAME%', name)}</td>
  <td><input type="text" name="${name}[comments]" id="new_time_entry_${issue.id}_0_comments" value="" size="80"></td>
</tr>\n`;
        html += row;
        if (state.duplicateRow === issue.id) html += row;
        continue;
      }
      for (const e of entries) {
        total += e.hours;
        const name = `time_entry[${e.id}]`;
        html += `<tr id="time_entry_pos${e.id}">
  ${issueCell(issue, link, `time_entry_pos${e.id}`, n)}
  <td><input type="text" name="${name}[hours]" id="time_entry_${e.id}_hours" value="${e.hours.toFixed(2)}" size="5" oninput="sumDayTimes()"></td>
  <td><select name="${name}[activity_id]" id="time_entry_${e.id}_activity_id" required="required">${options(acts, e.activityId)}</select></td>
  <td>${status.replaceAll('%NAME%', name)}</td>
  <td><input type="text" name="${name}[comments]" id="time_entry_${e.id}_comments" value="${esc(e.comments)}" size="80"></td>
</tr>\n`;
      }
    }
  }
  const priv = state.private[date] ?? 0;
  if (priv) {
    total += priv;
    html += `<tr style="background:#000;color:#fff;">
  <td>private</td>
  <td>${priv.toFixed(2)}</td>
  <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
</tr>\n`;
  }
  return { html, total };
}

/** The day scroller of _user_month_table.html.erb: per day a date cell, a weekday cell and a cell per issue/project; Sundays are "#faa". */
function monthTable(state: FxState, date: string, link: (d: { year: number; month: number; day: number }) => string) {
  const { year, month, day } = parts(date);
  const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const COLOR = ['#faa', '#eee', '#eee', '#eee', '#eee', '#eee', '#aaf'];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const inMonth = (d: string) => d.startsWith(`${year}-${String(month).padStart(2, '0')}-`);
  const projects: string[] = [];
  for (const i of state.issues) if (!projects.includes(i.project)) projects.push(i.project);
  const packs = projects
    .map((project) => ({ project, issues: state.issues.filter((i) => i.project === project && state.entries.some((e) => e.issueId === i.id && inMonth(e.date))) }))
    .filter((p) => p.issues.length);
  const rowsCount = packs.reduce((n, p) => n + p.issues.length, 0);
  const boxH = 20 * 3 + 31 * rowsCount + 20 * packs.length + 20;
  let left = '';
  let ofst = 55;
  for (const p of packs) {
    const top = ofst;
    ofst += 20;
    for (const i of p.issues) {
      const total = state.entries.filter((e) => e.issueId === i.id && inMonth(e.date)).reduce((s, e) => s + e.hours, 0);
      left += `    <div style="position:absolute;top:${ofst}px;left:1px;">
      <div style="background: #fff;font-size:0.8em;">
        <div style="position:relative;top:1px;left:1px;width:298px;height:30px;">
          <a class="wt_iss_link" data-issue="${i.id}" href="/issues/${i.id}">${esc(`${i.tracker} #${i.id}: ${i.subject}`)}</a>
          <div style="position:absolute;top:15px;right:15px;">${total.toFixed(2)}</div>
        </div>
      </div>
    </div>\n`;
      ofst += 31;
    }
    left += `  <div style="position:absolute;top:${top}px;left:2px;"><div style="background:#000;color:#fff;font-size:1.0em;"><div style="position:relative;top:1px;left:1px;width:297px;height:19px;">${esc(p.project)}</div></div></div>\n`;
  }
  let days = '';
  for (let d = 1; d <= last; d++) {
    const ds = dateOf(year, month, d);
    const wday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    const color = COLOR[wday];
    const l = 35 * (d - 1);
    days += `    <div style="position:absolute;top:1px;left:${l}px;" ${d === day ? 'id=day_scroll_today' : ''} >
      <div style="background:${d === day ? '#cfc' : color};">
        <div style="text-align:center;position:relative;top:1px;left:1px;width:34px;height:19px;">
          <a href="/work_time/index?${link({ year, month, day: d })}">${d}</a>
        </div>
      </div>
    </div>
    <div style="position:absolute;top:21px;left:${l}px;">
      <div style="background:${color};">
        <div style="text-align:center;position:relative;top:1px;left:1px;width:34px;height:19px;">
          ${WDAY[wday]}
        </div>
      </div>
    </div>\n`;
    let top = 55;
    for (const p of packs) {
      const ptop = top;
      top += 20;
      for (const i of p.issues) {
        const h = state.entries.filter((e) => e.issueId === i.id && e.date === ds).reduce((s, e) => s + e.hours, 0);
        days += `    <div style="position:absolute;top:${top}px;left:${l}px;">
      <div style="background:${color};font-size:0.8em;">
        <div style="text-align:center;position:relative;top:5px;left:1px;width:34px;height:30px;">${h ? h.toFixed(2) : ''}</div>
      </div>
    </div>\n`;
        top += 31;
      }
      days += `  <div style="position:absolute;top:${ptop}px;left:${l}px;"><div style="background:#000;color:#fff;font-size:0.8em;"><div style="text-align:center;position:relative;top:5px;left:1px;width:34px;height:19px;"></div></div></div>\n`;
    }
  }
  return { left, days, boxH, first: `${year}/${String(month).padStart(2, '0')}/01`, last: `${year}/${String(month).padStart(2, '0')}/${last}` };
}

function dayPage(state: FxState, date: string, message = ''): string {
  const { year, month, day } = parts(date);
  if (state.capture && date === '2026-10-01') {
    // The real page, with the hidden field values the sanitizer removed put back.
    return CAPTURE.replace('name="year" id="year"', `name="year" id="year" value="${year}"`)
      .replace('name="month" id="month"', `name="month" id="month" value="${month}"`)
      .replace('name="day" id="day"', `name="day" id="day" value="${day}"`)
      .replace('name="user" id="user"', `name="user" id="user" value="${state.user.id}"`)
      .replace('name="prj" id="prj"', 'name="prj" id="prj" value="false"');
  }
  const link = `day=${day}&amp;month=${month}&amp;prj=false&amp;user=${state.user.id}&amp;year=${year}`;
  const at = (d: { year: number; month: number; day: number }) => `day=${d.day}&amp;month=${d.month}&amp;prj=false&amp;user=${state.user.id}&amp;year=${d.year}`;
  const next = at(month === 12 ? { year: year + 1, month: 1, day } : { year, month: month + 1, day });
  const prev = at(month === 1 ? { year: year - 1, month: 12, day } : { year, month: month - 1, day });
  const { html, total } = rows(state, date, link);
  const mt = monthTable(state, date, at);
  const values: Record<string, string> = {
    SCRIPT: state.script ? `<script>${state.script}</script>` : '',
    LOGGED_ID: String(state.user.id),
    LOGIN: esc(state.user.login),
    USER_NAME: esc(state.headingName ?? state.user.name),
    USER_ID: String(state.user.id),
    YEAR: String(year),
    MONTH: String(month),
    DAY: String(day),
    DATE: date,
    LINK: link,
    LINK_NEXT: next,
    LINK_PREV: prev,
    BOX_H: String(mt.boxH),
    FIRST_DATE: mt.first,
    LAST_DATE: mt.last,
    MONTH_LEFT: mt.left,
    MONTH_DAYS: mt.days,
    MESSAGE: message || (state.errorOnGet ? `<div style="background:#faa;">${esc(state.errorOnGet)}</div><br>` : ''),
    ROWS: html,
    TOTAL: total.toFixed(2),
    MEMO: esc(state.memo[date] ?? ''),
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}

const LOGIN_PAGE = `<!doctype html><html><head><title>Redmine</title></head><body>
<div id="top-menu"><div id="account"><ul><li><a class="login" href="/login">Sign in</a></li></ul></div></div>
<div id="content"><div id="login-form"><form action="/login" method="post">
<input type="text" name="username" id="username"><input type="password" name="password" id="password">
<input type="submit" name="login" value="Login"></form></div></div></body></html>`;

/** Applies a posted day form the way Worktime's hour_update does. */
function applyPost(state: FxState, rec: Recorded, date: string, fields: [string, string][]) {
  const get = (name: string) => fields.find(([k]) => k === name)?.[1];
  for (const [k, v] of fields) {
    const fresh = /^new_time_entry\[(\d+)\]\[(\d+)\]\[hours\]$/.exec(k);
    if (fresh && v.trim() !== '') {
      const activity = get(`new_time_entry[${fresh[1]}][${fresh[2]}][activity_id]`);
      if (!activity) throw new Error(`no activity for issue ${fresh[1]}`);
      state.entries.push({ id: state.nextEntryId++, issueId: Number(fresh[1]), date, hours: Number(v), activityId: Number(activity), comments: get(`new_time_entry[${fresh[1]}][${fresh[2]}][comments]`) ?? '' });
    }
    const existing = /^time_entry\[(\d+)\]\[hours\]$/.exec(k);
    if (existing) {
      const id = Number(existing[1]);
      const e = state.entries.find((x) => x.id === id);
      if (!e) continue;
      if (v.trim() === '') {
        state.entries = state.entries.filter((x) => x.id !== id);
        rec.deleted.push(id);
      } else {
        e.hours = Number(v);
        e.activityId = Number(get(`time_entry[${id}][activity_id]`) ?? e.activityId);
        e.comments = get(`time_entry[${id}][comments]`) ?? e.comments;
      }
    }
    if (/\[status_id\]$/.test(k) && v.startsWith('M')) rec.statusChanges.push(`${k}=${v}`);
  }
  const memo = get('memo');
  if (memo !== undefined) state.memo[date] = memo.replace(/\r\n/g, '\n');
}

export async function startRedmine(state: FxState = defaultState()) {
  const rec: Recorded = { gets: [], posts: [], statusChanges: [], deleted: [] };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (url.pathname === '/favicon.ico') return send(404, '');
    if (url.pathname === '/login') return send(200, LOGIN_PAGE);
    if (url.pathname !== '/work_time/index') return send(404, 'not found');
    if (!state.loggedIn) return send(302, '', { location: `/login?back_url=${encodeURIComponent(url.pathname)}` });
    const p = url.searchParams;
    if (req.method === 'GET') {
      rec.gets.push(url.pathname + url.search);
      if (!p.has('user')) {
        const { year, month, day } = parts(state.today);
        const y = p.get('year') ?? year;
        const m = p.get('month') ?? month;
        const d = p.get('day') ?? day;
        return send(302, '', { location: `/work_time/index?day=${d}&month=${m}&prj=false&user=${state.user.id}&year=${y}` });
      }
      if (state.redirectExtra && !url.search.includes(state.redirectExtra)) return send(302, '', { location: `${url.pathname}${url.search}&${state.redirectExtra}` });
      return send(200, dayPage(state, dateOf(Number(p.get('year')), Number(p.get('month')), Number(p.get('day')))));
    }
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const fields = [...new URLSearchParams(raw).entries()];
      rec.posts.push({ url: url.pathname + url.search, fields });
      const date = dateOf(Number(p.get('year')), Number(p.get('month')), Number(p.get('day')));
      if (state.errorOnPost) return send(200, dayPage(state, date, `<div style="background:#faa;">${esc(state.errorOnPost)}</div><br>`));
      applyPost(state, rec, date, fields);
      if (state.postDelayMs) await new Promise((r) => setTimeout(r, state.postDelayMs));
      if (state.redirectAfterPost) return send(302, '', { location: url.pathname + url.search });
      return send(200, dayPage(state, date));
    }
    send(405, '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, state, rec, close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }) };
}
