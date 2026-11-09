import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in NetSuite weekly timesheet (weeklytimebill.nl). The page offers the parts of the real
 * Redwood form the adapter relies on: N/currentRecord through window.require (loaded late, like UIF),
 * a grid whose task cell opens a virtualized dropdown, and Save / Submit buttons that send the
 * time-limit check and the submitDynamicClientRecord call in the captured format. The server applies
 * a save like NetSuite: the lines in the call replace the timesheet's lines; Submit puts it in approval.
 */

export const PATH = '/app/accounting/transactions/time/weeklytimebill.nl';
const VALIDATE_PATH = '/app/accounting/transactions/time/timelimitvalidation.nl';
const SAVE_PATH = '/app/common/scripting/ClientScriptHandler.nl';

export interface FxTask {
  value: string;
  text: string;
  item: string;
}

export interface FxProject {
  value: string;
  text: string;
  tasks: FxTask[];
}

export interface FxLine {
  customer: string;
  task: string;
  /** Minutes Mon..Sun */
  minutes: number[];
  editable?: 'T' | 'F';
  /** statushours: '3' once the line's hours are approved */
  status?: string;
}

export interface FxSheet {
  id: string;
  week: string;
  /** '' never saved, '1' open (saved), '2' pending approval, '3' approved */
  approvalstatus: string;
  lines: FxLine[];
}

export interface FxState {
  loggedIn: boolean;
  employee: { id: string; text: string };
  /** Week the timesheet address opens without parameters */
  today: string;
  projects: FxProject[];
  sheets: FxSheet[];
  nextId: number;
  /** Status the save call answers with (default 200) */
  saveStatus?: number;
  /** How many save calls NetSuite rejects with an error message (answer 200, nothing stored, the page stays) */
  saveRejects?: number;
  /** Extra script run in every page after the record is ready */
  script?: string;
}

export interface FxSave {
  id: string;
  submitted: string;
  multibtn: string;
  approval: string;
  week: string;
  lines: { customer: string; task: string; hours: string[] }[];
}

export interface Recorded {
  gets: string[];
  posts: string[];
  validations: { action: string; employee: string; start: string }[];
  saves: FxSave[];
}

export const TASKS = [
  'Admin/Analysis', 'Backups', 'Change Management', 'Deployment', 'Development', 'General', 'Incident Management', 'Infrastructure (Build)',
  'Infrastructure (S&M)', 'Integration', 'Maintenance', 'Management', 'Medium Enhancements', 'Monitoring', 'Requirements', 'Security (Build)',
  'Security (S&M)', 'Service Requests', 'Small Enhancements', 'Team Meeting', 'Testing', 'Training', 'WBSO - Development',
];

export const MAIN = 'P00000001 Acme B.V. : Platform : Learning Platform 2026';
export const OTHER = 'P00000002 Acme B.V. : Generic : Non-Product related 2026';

export function defaultState(): FxState {
  return {
    loggedIn: true,
    employee: { id: '424242', text: 'E00000001 Jane Doe' },
    today: '2026-10-05',
    projects: [
      { value: '8430492', text: MAIN, tasks: TASKS.map((text, i) => ({ value: String(724260 + i), text, item: '175' })) },
      { value: '7338455', text: OTHER, tasks: ['General', 'Training', 'Team Meeting'].map((text, i) => ({ value: String(610000 + i), text, item: '176' })) },
    ],
    sheets: [],
    nextId: 1059922,
  };
}

/** Task id of a task text on the main project. */
export const taskId = (state: FxState, text: string, project = '8430492') => state.projects.find((p) => p.value === project)!.tasks.find((t) => t.text === text)!.value;

const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};
const iso = (dmyText: string) => {
  const [d, m, y] = dmyText.split('/');
  return `${y}-${m}-${d}`;
};
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const minutes = (hm: string) => {
  if (!hm) return 0;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

const CLIENT = String.raw`
(() => {
  const S = JSON.parse(document.getElementById('state').textContent);
  const T = 'custcol_il_filtered_project_task';
  const proj = (v) => S.projects.find((p) => p.value === v);
  const taskOf = (l) => proj(l.customer)?.tasks.find((t) => t.value === l.task);
  const dyn = S.mode !== 'view';
  let dirty = false;
  const lines = S.lines.map((l) => ({ customer: l.customer, task: l.task, item: taskOf(l)?.item ?? '', editable: l.editable ?? 'T', status: l.status ?? '', hours: l.minutes.map((m) => (m ? m / 60 : '')) }));
  let cur = null;
  let curIndex = -1;
  let openCell = -1;
  let listOpen = false;
  const blank = () => ({ customer: '', task: '', item: '', editable: 'T', hours: ['', '', '', '', '', '', ''] });
  const val = (l, f) => {
    if (f === 'customer') return l.customer;
    if (f === T) return l.task;
    if (f === 'item') return l.item;
    if (f === 'editable') return l.editable;
    const st = /^statushours(\d)$/.exec(f);
    if (st) return l.hours[+st[1]] === '' ? '' : (l.status ?? '');
    const m = /^hours(\d)$/.exec(f);
    if (m) return l.hours[+m[1]];
    return null;
  };
  const text = (l, f) => {
    if (f === 'customer') return proj(l.customer)?.text ?? '';
    if (f === T) return taskOf(l)?.text ?? '';
    const v = val(l, f);
    return v === null || v === undefined ? '' : String(v);
  };
  const need = (sid) => {
    if (sid !== 'timeitem') throw new Error('unknown sublist ' + sid);
  };
  const edit = () => {
    if (!dyn) throw new Error('the record is not in edit mode');
    dirty = true;
  };
  const current = () => {
    if (!cur) throw new Error('no current line');
    return cur;
  };
  const rec = {
    type: 'timesheet',
    id: S.mode === 'view' ? Number(S.id) : S.id || null,
    isDynamic: dyn,
    getValue: ({ fieldId }) => ({ employee: S.employee.id, approvalstatus: S.approvalstatus, lockstatus: 'unlocked' })[fieldId] ?? null,
    getText: ({ fieldId }) => ({ employee: S.employee.text, trandate: S.trandate, lockstatus: 'Unlocked' })[fieldId] ?? '',
    getLineCount: ({ sublistId }) => (need(sublistId), lines.length),
    getSublistValue: ({ sublistId, fieldId, line }) => (need(sublistId), val(lines[line], fieldId)),
    getSublistText: ({ sublistId, fieldId, line }) => (need(sublistId), text(lines[line], fieldId)),
    selectNewLine({ sublistId }) {
      need(sublistId);
      edit();
      cur = blank();
      curIndex = -1;
      render();
    },
    selectLine({ sublistId, line }) {
      need(sublistId);
      edit();
      if (!lines[line]) throw new Error('no line ' + line);
      cur = structuredClone(lines[line]);
      curIndex = line;
      render();
    },
    getCurrentSublistValue: ({ sublistId, fieldId }) => (need(sublistId), cur ? val(cur, fieldId) : null),
    getCurrentSublistText: ({ sublistId, fieldId }) => (need(sublistId), cur ? text(cur, fieldId) : ''),
    setCurrentSublistValue({ sublistId, fieldId, value }) {
      need(sublistId);
      edit();
      const l = current();
      if (fieldId === 'customer') {
        // Sourcing: the project sticks after a moment and clears the task.
        setTimeout(() => {
          l.customer = proj(String(value)) ? String(value) : '';
          l.task = '';
          l.item = '';
          render();
        }, 300);
        return;
      }
      const m = /^hours(\d)$/.exec(fieldId);
      if (m) {
        if (l.editable === 'F') throw new Error('the line cannot be edited');
        l.hours[+m[1]] = value === '' || value === null ? '' : Number(value);
        render();
        return;
      }
      throw new Error('the fake cannot set ' + fieldId);
    },
    setCurrentSublistText({ sublistId, fieldId, text: t }) {
      need(sublistId);
      edit();
      if (fieldId !== T) throw new Error('the fake cannot set the text of ' + fieldId);
      const l = current();
      setTimeout(() => {
        const task = proj(l.customer)?.tasks.find((x) => x.text === t);
        if (task) {
          l.task = task.value;
          l.item = task.item;
        }
        render();
      }, 200);
    },
    getCurrentSublistField({ sublistId, fieldId }) {
      need(sublistId);
      if (fieldId !== 'customer') throw new Error('the fake has no field ' + fieldId);
      return { getSelectOptions: () => [{ value: '', text: ' ' }, ...S.projects.map((p) => ({ value: p.value, text: p.text }))] };
    },
    commitLine({ sublistId }) {
      need(sublistId);
      const l = current();
      if (!l.customer || !l.task || !l.item) throw new Error('Please enter value(s) for: Customer, Task');
      if (curIndex < 0) lines.push(l);
      else lines[curIndex] = l;
      cur = null;
      curIndex = -1;
      render();
    },
    cancelLine({ sublistId }) {
      need(sublistId);
      cur = null;
      curIndex = -1;
      render();
    },
  };
  window.__fx = { rec, lines };

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  const grid = document.getElementById('grid');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function rows() {
    const all = lines.map((l, i) => (i === curIndex && cur ? cur : l));
    if (cur && curIndex < 0) all.push(cur);
    return all;
  }
  function render() {
    grid.innerHTML = rows()
      .map((l, i) => '<div data-row-type="data" data-row="' + i + '"><span data-automation-id="customer">' + esc(text(l, 'customer')) + '</span> <span data-automation-id="' + T + '" data-row="' + i + '" style="display:inline-block;min-width:120px;border:1px solid #999">' + esc(text(l, T)) + (openCell === i ? '<button type="button" data-automation-id="dropdownButton">v</button>' : '') + '</span> ' + l.hours.map((h) => '<span>' + esc(h) + '</span>').join(' ') + '</div>')
      .join('');
    renderList();
  }
  const ROW = 24;
  function renderList() {
    let box = document.querySelector('[role=listbox]');
    if (!listOpen || !cur) {
      box?.remove();
      return;
    }
    const tasks = proj(cur.customer)?.tasks ?? [];
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('role', 'listbox');
      box.style.cssText = 'height:' + ROW * 5 + 'px;overflow:auto;position:relative;border:1px solid #333;width:300px';
      box.innerHTML = '<div class="spacer" style="position:relative"></div>';
      box.addEventListener('scroll', renderList);
      document.body.appendChild(box);
    }
    const spacer = box.querySelector('.spacer');
    spacer.style.height = tasks.length * ROW + 'px';
    // Virtualized: only the visible options exist.
    const first = Math.floor(box.scrollTop / ROW);
    spacer.innerHTML = tasks
      .slice(first, first + 6)
      .map((t, i) => '<div role="option" style="position:absolute;top:' + (first + i) * ROW + 'px;height:' + ROW + 'px">' + esc(t.text) + '</div>')
      .join('');
  }
  grid.addEventListener('click', (e) => {
    if (e.target.closest('[data-automation-id="dropdownButton"]')) {
      listOpen = true;
      renderList();
      return;
    }
    const cell = e.target.closest('[data-automation-id="' + T + '"]');
    if (cell && dyn) {
      openCell = Number(cell.dataset.row);
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      listOpen = false;
      openCell = -1;
      render();
    }
  });

  const hm = (h) => (h === '' || h === 0 ? '' : Math.floor(h) + ':' + String(Math.round((h % 1) * 60)).padStart(2, '0'));
  const FIELDS = ['id', 'customer', 'hours0', 'hours1', 'hours2', 'hours3', 'hours4', 'hours5', 'hours6', 'editable', T, 'item'];
  async function post(path, method, params) {
    const body = new URLSearchParams({ jrid: '1', jrmethod: method, jrparams: JSON.stringify(params) });
    return fetch(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }
  async function save(submit) {
    const message = document.getElementById('message');
    if (cur) {
      try {
        rec.commitLine({ sublistId: 'timeitem' });
      } catch (e) {
        message.textContent = e.message;
        return;
      }
    }
    const entries = {};
    lines.forEach((l, i) => (entries[i] = Object.fromEntries(l.hours.map((h, d) => [d, hm(h)]))));
    try {
      await post(${JSON.stringify(VALIDATE_PATH)}, 'remoteObject.validateWeeklyTimesheetRecordMacro', [{ EMPLOYEE_ID: S.employee.id, ACTION: submit ? 'submit' : 'save', TIMESHEET_STARTDATE: S.trandate, TIMESHEET_ENDDATE: S.enddate, TIMEENTRIES: entries }]);
    } catch {
      // Worst case for the guard: carry on with the save even when the check failed.
    }
    const record = {
      employee: S.employee.id, id: S.id || '', trandate: S.trandate, startdate: S.trandate, enddate: S.enddate, type: 'timesheet', lockstatus: 'unlocked',
      approvalstatus: S.approvalstatus, submittedhours: '0', submitted: submit ? 'T' : '', _multibtnstate_: submit ? 'savesubmit' : '',
    };
    const data = lines.map((l) => FIELDS.map((f) => (f === 'id' ? '' : /^hours\d$/.test(f) ? hm(val(l, f)) : String(val(l, f) ?? ''))));
    const opts = S.id ? { recordrequestcontext: { e: 'T', id: S.id }, isFormSave: true } : { isFormSave: true };
    let res;
    try {
      res = await post(${JSON.stringify(SAVE_PATH)}, 'remoteObject.submitDynamicClientRecord', ['timesheet', record, { timeitem: { fields: FIELDS, size: data.length, data } }, opts]);
    } catch (e) {
      message.textContent = 'Save failed: ' + e.message;
      return;
    }
    if (!res.ok) {
      message.textContent = 'Save failed: ' + res.status;
      return;
    }
    const answer = await res.json();
    if (answer.error) {
      message.textContent = answer.error;
      return;
    }
    const { id } = answer;
    dirty = false;
    location.href = ${JSON.stringify(PATH)} + '?id=' + id + '&whence=';
  }
  document.getElementById('save')?.addEventListener('click', () => save(false));
  document.getElementById('submit')?.addEventListener('click', () => save(true));
  render();
  // UIF makes the record available a while after the document.
  setTimeout(() => {
    window.require = (deps, ok, fail) =>
      setTimeout(() => (deps.length === 1 && deps[0] === 'N/currentRecord' ? ok({ get: () => rec }) : fail?.(new Error('unknown module'))), 10);
    if (S.script) (0, eval)(S.script);
  }, 300);
})();
`;

function page(state: FxState, mode: 'new' | 'edit' | 'view', week: string, sheet: FxSheet | null): string {
  const data = {
    mode, id: sheet?.id ?? '', week, trandate: dmy(week), enddate: dmy(addDays(week, 6)), employee: state.employee,
    approvalstatus: sheet?.approvalstatus ?? '', lines: sheet?.lines ?? [], projects: state.projects, script: state.script,
  };
  const buttons = mode === 'view' ? '' : '<div data-automation-id="form.save"><button type="button" id="save" aria-label="Save">Save</button></div><div data-automation-id="form.submit"><button type="button" id="submit" aria-label="Submit">Submit</button></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Weekly Timesheet</title></head><body>
${buttons}<div id="message"></div>
<div data-automation-id="timeitem"><div id="grid"></div></div>
<script type="application/json" id="state">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${CLIENT}</script></body></html>`;
}

const read = (req: IncomingMessage) => new Promise<string>((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});

export async function startNetsuite(state: FxState = defaultState()) {
  const rec: Recorded = { gets: [], posts: [], validations: [], saves: [] };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const redirect = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    if (req.method === 'GET') {
      if (url.pathname === '/favicon.ico') return res.end();
      rec.gets.push(url.pathname + url.search);
      if (url.pathname === '/login') return html('<!doctype html><title>Login</title><p>Log in</p>');
      if (url.pathname !== PATH) {
        res.statusCode = 404;
        return res.end('not found');
      }
      if (!state.loggedIn) return redirect('/login');
      const id = url.searchParams.get('id');
      if (id) {
        const sheet = state.sheets.find((s) => s.id === id);
        if (!sheet) {
          res.statusCode = 404;
          return res.end('no such record');
        }
        // Like NetSuite: an approved timesheet still opens for editing (new lines can be added).
        const editing = url.searchParams.get('e') === 'T' && ['', '1', '3'].includes(sheet.approvalstatus);
        return html(page(state, editing ? 'edit' : 'view', sheet.week, sheet));
      }
      const trandate = url.searchParams.get('trandate');
      const week = trandate ? iso(trandate) : state.today;
      if (trandate && url.searchParams.get('employee') !== state.employee.id) {
        res.statusCode = 403;
        return res.end('other employee');
      }
      const sheet = state.sheets.find((s) => s.week === week);
      if (sheet) return redirect(`${PATH}?id=${sheet.id}${['', '1', '3'].includes(sheet.approvalstatus) ? '&e=T' : ''}`);
      return html(page(state, 'new', week, null));
    }
    const body = await read(req);
    rec.posts.push(url.pathname);
    const params = new URLSearchParams(body);
    const jr = JSON.parse(params.get('jrparams') ?? 'null');
    if (url.pathname === VALIDATE_PATH) {
      rec.validations.push({ action: jr[0].ACTION, employee: jr[0].EMPLOYEE_ID, start: jr[0].TIMESHEET_STARTDATE });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"result":"ok"}');
    }
    if (url.pathname === SAVE_PATH && params.get('jrmethod') === 'remoteObject.submitDynamicClientRecord') {
      const [, record, sub] = jr;
      const fields: string[] = sub.timeitem.fields;
      const at = (f: string) => fields.indexOf(f);
      const lines = (sub.timeitem.data as string[][]).map((row) => ({
        customer: row[at('customer')],
        task: row[at('custcol_il_filtered_project_task')],
        hours: [0, 1, 2, 3, 4, 5, 6].map((d) => row[at(`hours${d}`)]),
      }));
      const week = iso(record.trandate);
      rec.saves.push({ id: record.id, submitted: record.submitted, multibtn: record._multibtnstate_, approval: record.approvalstatus, week, lines });
      if (state.saveStatus && state.saveStatus >= 400) {
        res.statusCode = state.saveStatus;
        return res.end('{"error":"failed"}');
      }
      if (state.saveRejects) {
        state.saveRejects--;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"error":"An unexpected error occurred, please try again"}');
      }
      let sheet = state.sheets.find((s) => (record.id ? s.id === record.id : s.week === week));
      if (!sheet) {
        sheet = { id: String(state.nextId++), week, approvalstatus: '', lines: [] };
        state.sheets.push(sheet);
      }
      const old = sheet.lines;
      sheet.lines = lines.map((l, i) => ({ customer: l.customer, task: l.task, minutes: l.hours.map(minutes), ...(old[i]?.customer === l.customer && old[i]?.task === l.task && old[i]?.editable ? { editable: old[i]!.editable, status: old[i]!.status } : {}) }));
      // Like NetSuite: a save leaves the timesheet open ('1'), also an approved one that got new lines.
      sheet.approvalstatus = record.submitted === 'T' ? '2' : '1';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: sheet.id }));
    }
    res.statusCode = 400;
    res.end('unknown call');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}${PATH}`,
    state,
    rec,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
