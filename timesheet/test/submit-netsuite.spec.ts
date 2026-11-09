import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Abort } from '../src/core/submit/adapter.ts';
import {
  assertWeek, classifyRequest, dmy, minutesOf, netsuite, netsuiteBase, pageUrlProblem, parseWeek, retryableNavigation, saveProblem, validateProblem, weekUrl,
  type LineData, type NetsuiteCatalog, type RecordData, type SaveExpectation,
} from '../src/core/submit/netsuite.ts';
import { buildPlan, rebalanceDay } from '../src/core/submit/plan.ts';
import type { Cell, NetsuiteTarget, SubmitRule } from '../src/core/submit/types.ts';
import type { DayReport } from '../src/core/types.ts';

const O = 'https://5854112.app.netsuite.com';
const PAGE = `${O}/app/accounting/transactions/time/weeklytimebill.nl`;
const DIR = join(import.meta.dirname, 'fixtures', 'netsuite');
// The real requests NetSuite sent for Save (captured with the network blocked; ids anonymised).
const SAVE = readFileSync(join(DIR, 'save-request.txt'), 'utf8').trim();
const VALIDATE = readFileSync(join(DIR, 'validate-request.txt'), 'utf8').trim();
const PROJECT = 'P00036826 Infinitas Technology B.V. : Secondary Segment : Secondary Learning Platform 2026 part 2';

describe('netsuite addresses', () => {
  it('accepts only weekly timesheet addresses on netsuite.com', () => {
    assert.equal(netsuiteBase(`${PAGE}?id=1054219`), O);
    assert.throws(() => netsuiteBase('http://5854112.app.netsuite.com/app/accounting/transactions/time/weeklytimebill.nl'), Abort);
    assert.throws(() => netsuiteBase(`${O}/app/center/card.nl`), Abort);
    assert.throws(() => netsuiteBase('https://evil.example.com/app/accounting/transactions/time/weeklytimebill.nl'), Abort);
    assert.equal(netsuiteBase('http://127.0.0.1:9/app/accounting/transactions/time/weeklytimebill.nl'), 'http://127.0.0.1:9');
  });

  it('opens a week by employee and date', () => {
    assert.equal(dmy('2026-10-05'), '05/10/2026');
    assert.equal(weekUrl(O, '42', '2026-10-05'), `${PAGE}?whence=&employee=42&trandate=05%2F10%2F2026`);
    assert.equal(pageUrlProblem(`${PAGE}?id=1&e=T`, O), null);
    assert.match(pageUrlProblem(`${O}/app/login.nl`, O)!, /expected the weekly timesheet/);
    assert.match(pageUrlProblem(`https://system.netsuite.com${new URL(PAGE).pathname}`, O)!, /system\.netsuite\.com/);
  });
});

describe('netsuite hours', () => {
  it('reads API values and H:MM text', () => {
    assert.equal(minutesOf(8), 480);
    assert.equal(minutesOf(4.25), 255);
    assert.equal(minutesOf(''), 0);
    assert.equal(minutesOf('4:15'), 255);
    assert.equal(minutesOf('10:30'), 630);
    assert.equal(minutesOf('1.5'), 90);
    assert.equal(minutesOf(1 / 7), null);
    assert.equal(minutesOf('abc'), null);
    assert.equal(minutesOf(-1), null);
  });
});

const line = (over: Partial<LineData> = {}): LineData => ({
  customer: '8430492', customerText: PROJECT, task: '724275', taskText: 'Development', item: '175', editable: 'T', hours: ['', '', '', '', '', '', ''], ...over,
});
const record = (over: Partial<RecordData> = {}): RecordData => ({
  url: `${PAGE}?id=1059922&e=T`, type: 'timesheet', id: '1059922', isDynamic: true, employee: '42', employeeText: 'E1 Test User', trandate: '05/10/2026', approvalstatus: '', lockstatus: 'unlocked', lines: [], ...over,
});
const CTX = { origin: O, employeeId: '42', user: 'E1 Test User', week: '2026-10-05' };

describe('netsuite record checks', () => {
  it('accepts the expected week and refuses any other', () => {
    assertWeek(record(), CTX);
    assert.throws(() => assertWeek(record({ employee: '43' }), CTX), /expected E1 Test User/);
    assert.throws(() => assertWeek(record({ employeeText: 'E2 Other' }), CTX), /employee reads/);
    assert.throws(() => assertWeek(record({ trandate: '12/10/2026' }), CTX), /week of 12\/10\/2026/);
    assert.throws(() => assertWeek(record({ trandate: '10/05/2026' }), CTX), /expected 05\/10\/2026/);
    assert.throws(() => assertWeek(record({ type: 'expensereport' }), CTX), /not a timesheet/);
    assert.throws(() => assertWeek(record({ url: `${O}/app/login.nl` }), CTX), /unexpected page/);
  });

  it('turns lines into cells per day (Mon..Sun)', () => {
    const rec = record({ lines: [line({ hours: [8, '', 4.25, '', '', '', 1] }), line({ task: '724267', taskText: 'Testing', hours: ['', 2.5, '', '', '', '', ''] })] });
    const w = parseWeek(rec, '2026-10-05');
    assert.deepEqual(w.cells.map((c) => [c.date, c.target.task, c.hours]), [
      ['2026-10-05', 'Development', 8], ['2026-10-06', 'Testing', 2.5], ['2026-10-07', 'Development', 4.25], ['2026-10-11', 'Development', 1],
    ]);
    assert.equal(w.cells[0].target.project, PROJECT);
    assert.deepEqual(w.lines[0].minutes, [480, 0, 255, 0, 0, 0, 60]);
  });

  it('refuses what it cannot read for sure', () => {
    assert.throws(() => parseWeek(record({ lines: [line({ hours: ['x', '', '', '', '', '', ''] })] }), '2026-10-05'), /unreadable hours/);
    assert.throws(() => parseWeek(record({ lines: [line({ hours: [1 / 6, '', '', '', '', '', ''] })] }), '2026-10-05'), /not a whole quarter hour/);
    assert.throws(() => parseWeek(record({ lines: [line({ taskText: '', hours: [1, '', '', '', '', '', ''] })] }), '2026-10-05'), /no task/);
    assert.throws(() => parseWeek(record({ lines: [line({ hours: [1, '', '', '', '', '', ''] }), line({ hours: [2, '', '', '', '', '', ''] })] }), '2026-10-05'), /two lines/);
    // Same target on different days in two lines is readable.
    assert.equal(parseWeek(record({ lines: [line({ hours: [1, '', '', '', '', '', ''] }), line({ hours: ['', 2, '', '', '', '', ''] })] }), '2026-10-05').cells.length, 2);
  });
});

describe('netsuite request guard', () => {
  const save = { method: 'POST', url: `${O}/app/common/scripting/ClientScriptHandler.nl?script=&deploy=`, body: SAVE, navigation: false };
  const validate = { method: 'POST', url: `${O}/app/accounting/transactions/time/timelimits/timelimitvalidation.nl`, body: VALIDATE, navigation: false };
  const EXP: SaveExpectation = { employeeId: '424242', id: '1059922', week: '2026-10-05', approval: '', lines: [{ customer: '8430492', task: '724275', minutes: [255, 0, 0, 0, 0, 0, 0] }] };
  const edit = (fn: (p: any[]) => void) => {
    const q = new URLSearchParams(SAVE);
    const p = JSON.parse(q.get('jrparams')!);
    fn(p);
    q.set('jrparams', JSON.stringify(p));
    return q.toString();
  };

  it('classifies requests', () => {
    assert.equal(classifyRequest(save, O), 'save');
    assert.equal(classifyRequest(validate, O), 'validate');
    assert.equal(classifyRequest({ ...save, method: 'GET' }, O), 'safe');
    assert.equal(classifyRequest({ method: 'POST', url: `${O}/app/common/scripting/ClientScriptHandler.nl`, body: 'jrmethod=remoteObject.getSelectOptions', navigation: false }, O), 'safe');
    assert.equal(classifyRequest({ method: 'POST', url: `${O}/app/common/scripting/ClientScriptHandler.nl`, body: 'jrmethod=remoteObject.deleteRecord', navigation: false }, O), 'danger');
    assert.equal(classifyRequest({ method: 'POST', url: `${O}/x.nl`, body: 'jrmethod=remoteObject.submitRecord', navigation: false }, O), 'danger');
    assert.equal(classifyRequest({ method: 'POST', url: `${PAGE}?id=1`, body: 'submitter=Submit', navigation: true }, O), 'danger');
    assert.equal(classifyRequest({ method: 'POST', url: `${PAGE}?id=1`, body: '', navigation: false }, O), 'danger');
    assert.equal(classifyRequest({ method: 'POST', url: 'https://system.netsuite.com/app/x.nl', body: 'jrmethod=remoteObject.submitDynamicClientRecord', navigation: false }, O), 'save');
    assert.equal(classifyRequest({ method: 'POST', url: 'https://telemetry.example.com/collect', body: 'a=1', navigation: false }, O), 'safe');
  });

  it('lets the real save of the checked week pass', () => {
    assert.equal(saveProblem(SAVE, EXP), null);
    assert.equal(validateProblem(VALIDATE, EXP), null);
  });

  it('refuses a save that differs from the checked week', () => {
    assert.match(saveProblem(SAVE, { ...EXP, lines: [{ ...EXP.lines[0], minutes: [240, 0, 0, 0, 0, 0, 0] }] })!, /other lines/);
    assert.match(saveProblem(SAVE, { ...EXP, lines: [] })!, /other lines/);
    assert.match(saveProblem(SAVE, { ...EXP, id: '1065726' })!, /record 1059922/);
    assert.match(saveProblem(SAVE, { ...EXP, employeeId: '1' })!, /employee 424242/);
    assert.match(saveProblem(SAVE, { ...EXP, week: '2026-10-12' })!, /week of 05\/10\/2026/);
    assert.match(saveProblem(null, EXP)!, /cannot be read/);
    assert.match(saveProblem('jrmethod=x&jrparams=%5B%5D', EXP)!, /cannot be read/);
  });

  it('never lets Submit pass', () => {
    assert.match(saveProblem(edit((p) => (p[1].submitted = 'T')), EXP)!, /Submit is never allowed/);
    assert.match(saveProblem(edit((p) => (p[1]._multibtnstate_ = 'savesubmit')), EXP)!, /Submit is never allowed/);
    assert.match(saveProblem(edit((p) => (p[1].approvalstatus = '1')), EXP)!, /approval status 1/);
    const q = new URLSearchParams(VALIDATE);
    const v = JSON.parse(q.get('jrparams')!);
    v[0].ACTION = 'submit';
    q.set('jrparams', JSON.stringify(v));
    assert.match(validateProblem(q.toString(), EXP)!, /only save/);
  });

  it('refuses malformed lines', () => {
    assert.match(saveProblem(edit((p) => (p[2].timeitem.data[0][p[2].timeitem.fields.indexOf('hours0')] = '4.2.1')), EXP)!, /unreadable hours/);
    assert.match(saveProblem(edit((p) => (p[2].timeitem.size = 2)), EXP)!, /line count/);
    assert.match(saveProblem(edit((p) => p[2].timeitem.data[0].pop()), EXP)!, /malformed/);
  });
});

describe('netsuite catalog', () => {
  const cat: NetsuiteCatalog = { origin: O, employeeId: '42', user: 'E1 Test User', projects: [{ name: PROJECT, value: '8430492', tasks: ['Development', 'Testing'] }], discoveredAt: '' };
  it('checks targets against the offered projects and tasks', () => {
    assert.equal(netsuite.exists(cat, { project: PROJECT, task: 'Testing' }), true);
    assert.equal(netsuite.exists(cat, { project: PROJECT, task: 'Backups' }), false);
    assert.equal(netsuite.exists(cat, { project: 'P1', task: 'Testing' }), false);
    assert.equal(netsuite.sameSite(cat, `${PAGE}?id=1`), true);
    assert.equal(netsuite.sameSite(cat, 'https://other.app.netsuite.com/app/accounting/transactions/time/weeklytimebill.nl'), false);
    assert.deepEqual(netsuite.units('2026-10-05', []), ['2026-10-05']);
  });
});

describe('submission precision (0.25 h)', () => {
  const t = (task: string): NetsuiteTarget => ({ project: PROJECT, task });
  const cells = (hs: [string, number][]): Cell<NetsuiteTarget>[] => hs.map(([task, hours]) => ({ date: '2026-10-05', target: t(task), hours }));

  it('rebalances a day to quarter hours keeping its total', () => {
    const day = cells([['Development', 5.3], ['Team Meeting', 1.6], ['Testing', 1.1]]);
    assert.deepEqual(rebalanceDay(day, 0.25), { before: 800, after: 800 });
    // largest remainders get the spare quarter; a tie goes to the bigger entry
    assert.deepEqual(day.map((c) => c.hours), [5.25, 1.75, 1]);
    for (const c of day) assert.equal(Math.round(c.hours * 100) % 25, 0);
  });

  it('keeps every entry and rounds a non-quarter total up', () => {
    const day = cells([['Development', 7.2], ['Team Meeting', 0.1]]);
    assert.deepEqual(rebalanceDay(day, 0.25), { before: 730, after: 750 });
    assert.ok(day.every((c) => c.hours >= 0.25));
  });

  const report = (date: string, entries: [string, number][]): DayReport => ({
    date, status: 'final', computedAt: '', blocks: [], summary: '', warnings: [], paths: {}, outOfOffice: false, target: 8, realTotal: 0, total: 0,
    entries: entries.map(([category, hours]) => ({ project: 'SEP', category, capex: false, real: hours, hours })),
  });
  const week = (days: Record<string, [string, number][]>) =>
    ['05', '06', '07', '08', '09', '10', '11'].map((d) => report(`2026-10-${d}`, days[`2026-10-${d}`] ?? []));
  const RULES: SubmitRule<NetsuiteTarget>[] = [{ project: 'SEP', category: '*', target: { project: PROJECT, task: 'Development' } }, { project: 'SEP', category: 'Team Meeting', target: t('Team Meeting') }];

  it('plans quarter hours from 0.1 h bookings, merging categories that share a task first', () => {
    const r = buildPlan({ system: 'netsuite', week: '2026-10-05', today: '2026-10-12', rules: RULES, reports: week({
      '2026-10-05': [['Development', 4.3], ['Small Enhancements', 2.2], ['Team Meeting', 1.5]],
      '2026-10-06': [['Development', 7.9], ['Team Meeting', 0.1]],
    }) });
    assert.ok(r.ok);
    assert.deepEqual(r.plan.cells.map((c) => [c.date, c.target.task, c.hours]), [
      ['2026-10-05', 'Development', 6.5], ['2026-10-05', 'Team Meeting', 1.5],
      ['2026-10-06', 'Development', 7.75], ['2026-10-06', 'Team Meeting', 0.25],
    ]);
    assert.deepEqual(r.plan.notes, []);
  });

  it('notes a day whose total changes', () => {
    const r = buildPlan({ system: 'netsuite', week: '2026-10-05', today: '2026-10-12', rules: RULES, reports: week({ '2026-10-10': [['Development', 1.3]] }) });
    assert.ok(r.ok);
    assert.deepEqual(r.plan.cells.map((c) => c.hours), [1.5]);
    assert.match(r.plan.notes[0], /2026-10-10: 1.3 h booked, entered as 1.5 h/);
  });
});

describe('netsuite navigation after a save', () => {
  it('retries when NetSuite redirects to the saved record while the week is being opened (the real Oct 26 failure)', () => {
    const real = 'page.goto: Navigation to "https://5854112.app.netsuite.com/app/accounting/transactions/time/weeklytimebill.nl?whence=&employee=1362787&trandate=26%2F10%2F2026" is interrupted by another navigation to "https://5854112.app.netsuite.com/app/accounting/transactions/time/weeklytimebill.nl?id=1077339&whence=&cmid=1793575788019_5962"';
    assert.equal(retryableNavigation(real), true);
    assert.equal(retryableNavigation('page.goto: net::ERR_NAME_NOT_RESOLVED'), false);
  });
});
