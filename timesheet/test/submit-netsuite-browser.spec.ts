import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from './helpers.ts';
import { defaultState, MAIN, OTHER, startNetsuite, taskId, TASKS, type FxState } from './netsuite-fixture.ts';
import { Store } from '../src/core/store.ts';
import { chromeAvailable, openBrowser } from '../src/core/submit/browser.ts';
import { SubmitSession } from '../src/core/submit/session.ts';
import { SubmitRunner, type PrepareResult } from '../src/core/submit/run.ts';
import { loginTiming, netsuite, readRecordInPage, type NetsuiteCatalog } from '../src/core/submit/netsuite.ts';
import type { NetsuiteTarget, SubmitRule } from '../src/core/submit/types.ts';
import type { DayReport } from '../src/core/types.ts';

const WEEK = '2026-10-05';
const TODAY = '2026-10-12';
const DAYS = ['05', '06', '07', '08', '09', '10', '11'].map((d) => `2026-10-${d}`);

function report(date: string, entries: [string, number][]): DayReport {
  return {
    date, status: 'final', computedAt: '', blocks: [], summary: '', warnings: [], paths: {}, outOfOffice: false, target: 8, realTotal: 0, total: 0,
    entries: entries.map(([category, hours]) => ({ project: 'SEP', category, capex: false, real: hours, hours })),
  };
}
const week = (days: Record<string, [string, number][]>) => DAYS.map((d) => report(d, days[d] ?? []));

const RULES: SubmitRule<NetsuiteTarget>[] = [
  { project: 'SEP', category: 'Development', target: { project: MAIN, task: 'Development' } },
  { project: 'SEP', category: 'Small Enhancements', target: { project: MAIN, task: 'Small Enhancements' } },
  { project: 'SEP', category: 'Team Meeting', target: { project: MAIN, task: 'Team Meeting' } },
  { project: 'SEP', category: 'Training', target: { project: OTHER, task: 'Training' } },
];

/** Mon 6 Dev + 2 Meeting, Tue 7.9/0.1 (entered as 7.75/0.25), Wed 8 Dev, Thu 1.5 Training. */
const REPORTS = week({
  '2026-10-05': [['Development', 6], ['Team Meeting', 2]],
  '2026-10-06': [['Development', 7.9], ['Team Meeting', 0.1]],
  '2026-10-07': [['Development', 8]],
  '2026-10-08': [['Training', 1.5]],
});

const catalogOf = (origin: string, s: FxState): NetsuiteCatalog => ({
  origin, employeeId: s.employee.id, user: s.employee.text, discoveredAt: '',
  projects: s.projects.map((p) => ({ name: p.text, value: p.value, tasks: p.tasks.map((t) => t.text) })),
});

async function waitFor(cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('netsuite adapter and run flow (fake NetSuite)', { skip: !chromeAvailable() && 'Google Chrome not installed' }, () => {
  let session: SubmitSession;
  const shots = mkdtempSync(join(tmpdir(), 'shots-'));

  before(() => {
    loginTiming.settleMs = 1500;
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    session = new SubmitSession(() => openBrowser({ headless: true, profileDir, lockPath: join(profileDir, '..', `lock-netsuite-${process.pid}`) }));
  });
  after(async () => {
    await session.close();
  });

  async function setup(opts: { state?: Partial<FxState>; fillOnly?: boolean; reports?: DayReport[]; reportsFor?: (week: string) => DayReport[]; catalog?: boolean; userTimeoutMs?: number } = {}) {
    const fx = await startNetsuite({ ...defaultState(), ...opts.state });
    const store = new Store(':memory:');
    if (opts.catalog !== false) store.saveSubmitCatalog('netsuite', catalogOf(fx.origin, fx.state));
    const config = testConfig({
      submit: {
        redmine: { url: '', fillOnly: false, rules: [] },
        netsuite: { url: fx.url, fillOnly: opts.fillOnly ?? false, rules: RULES },
      },
    });
    const runner = new SubmitRunner({
      store, config: () => config, today: () => TODAY, session, screenshotDir: shots, userTimeoutMs: opts.userTimeoutMs ?? 60_000,
      loginPollMs: 100,
      reports: async (wk) => ({ reports: opts.reportsFor ? opts.reportsFor(wk) : (opts.reports ?? REPORTS) }),
    });
    const page = async () => (await session.ensure()).page;
    return { fx, store, runner, page, close: fx.close };
  }

  const ready = (r: PrepareResult) => {
    assert.equal(r.state, 'ready', JSON.stringify(r));
    return r as Extract<PrepareResult, { state: 'ready' }>;
  };

  const dev = (s: FxState) => taskId(s, 'Development');
  const meeting = (s: FxState) => taskId(s, 'Team Meeting');
  const training = (s: FxState) => taskId(s, 'Training', '7338455');

  /** Lines of a stored timesheet as "project task minutes…". */
  const sheetLines = (s: FxState, wk = WEEK) => (s.sheets.find((x) => x.week === wk)?.lines ?? []).map((l) => `${l.customer} ${l.task} ${l.minutes.join(',')}`).sort();

  /** The tab shows the week freshly loaded: nothing filled in that a later Save could store. */
  async function assertClean(t: Awaited<ReturnType<typeof setup>>, lines: number) {
    const page = await t.page();
    assert.ok(!page.isClosed());
    await waitFor(() => true);
    let rec = await page.evaluate(readRecordInPage);
    for (let i = 0; i < 20 && rec.error; i++) {
      await new Promise((r) => setTimeout(r, 200));
      rec = await page.evaluate(readRecordInPage);
    }
    assert.equal(rec.error, undefined);
    assert.equal(rec.lines.length, lines);
  }

  it('discovers the employee, the projects and every task of each (scrolling the virtual list), saving nothing', async () => {
    const t = await setup({ catalog: false });
    try {
      const r = await t.runner.discover('netsuite');
      assert.equal(r.state, 'ok', JSON.stringify(r));
      const c = (r as { catalog: NetsuiteCatalog }).catalog;
      assert.equal(c.origin, t.fx.origin);
      assert.equal(c.employeeId, '424242');
      assert.equal(c.user, 'E00000001 Jane Doe');
      assert.deepEqual(c.projects.map((p) => [p.name, p.value]), [[MAIN, '8430492'], [OTHER, '7338455']]);
      assert.deepEqual(c.projects[0].tasks, TASKS);
      assert.deepEqual(c.projects[1].tasks, ['General', 'Training', 'Team Meeting']);
      assert.deepEqual(t.store.submitCatalog('netsuite')?.data, c);
      assert.deepEqual(t.fx.rec.posts, []);
      assert.deepEqual(t.fx.state.sheets, []);
      assert.equal(netsuite.label(c, { project: MAIN, task: 'Development' }), `${MAIN} · Development`);
    } finally {
      await t.close();
    }
  });

  it('enters a new week: new lines, quarter hours, one checked save, never submitted', async () => {
    const t = await setup();
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      assert.equal(prep.fillOnly, false);
      assert.deepEqual(prep.write.map((c) => `${c.date} ${c.target && (c.target as NetsuiteTarget).task} ${c.hours}`), [
        '2026-10-05 Development 6', '2026-10-05 Team Meeting 2',
        '2026-10-06 Development 7.75', '2026-10-06 Team Meeting 0.25',
        '2026-10-07 Development 8',
        '2026-10-08 Training 1.5',
      ]);
      assert.deepEqual(t.fx.rec.posts, [], 'prepare never posts');
      for (const r of REPORTS) t.store.saveDay(r);
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves.length, 1);
      const save = t.fx.rec.saves[0];
      assert.equal(save.submitted, '');
      assert.equal(save.multibtn, '');
      assert.equal(save.id, '');
      assert.deepEqual(t.fx.rec.validations, [{ action: 'save', employee: '424242', start: '05/10/2026' }]);
      const s = t.fx.state;
      assert.deepEqual(sheetLines(s), [
        `7338455 ${training(s)} 0,0,0,90,0,0,0`,
        `8430492 ${dev(s)} 360,465,480,0,0,0,0`,
        `8430492 ${meeting(s)} 120,15,0,0,0,0,0`,
      ].sort());
      assert.equal(s.sheets[0].approvalstatus, '1', 'saved, open (not submitted)');
      assert.ok(t.store.marks('locked').has('2026-10-05'));
      const again = await t.runner.prepare('netsuite', WEEK);
      assert.equal(again.state, 'noop', JSON.stringify(again));
      assert.equal(t.fx.rec.saves.length, 1);
    } finally {
      await t.close();
    }
  });

  it('adds days to an existing line and a new line, keeping what is there', async () => {
    const base = defaultState();
    const t = await setup({
      reports: week({ '2026-10-05': [['Development', 4]], '2026-10-06': [['Development', 6], ['Team Meeting', 2]] }),
      state: { sheets: [{ id: '777', week: WEEK, approvalstatus: '', lines: [{ customer: '8430492', task: dev(base), minutes: [240, 0, 0, 0, 0, 0, 0] }] }] },
    });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      assert.equal(prep.unchanged, 1);
      assert.equal(prep.write.length, 2);
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves.length, 1);
      assert.equal(t.fx.rec.saves[0].id, '777');
      const s = t.fx.state;
      assert.deepEqual(sheetLines(s), [`8430492 ${dev(s)} 240,360,0,0,0,0,0`, `8430492 ${meeting(s)} 0,120,0,0,0,0,0`].sort());
    } finally {
      await t.close();
    }
  });

  it('fill only: fills in, waits for the user to press Save, then verifies', async () => {
    const t = await setup({ fillOnly: true });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting', 60_000);
      assert.match(t.runner.progress()!.message, /press Save in the browser window \(not Submit\)/);
      assert.equal(t.fx.rec.saves.length, 0);
      await (await t.page()).click('[data-automation-id="form.save"] button[aria-label="Save"]');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves.length, 1);
      assert.equal(sheetLines(t.fx.state).length, 3);
    } finally {
      await t.close();
    }
  });

  it('fill only: NetSuite rejects the first Save; the second Save goes through and is verified', async () => {
    const t = await setup({ fillOnly: true, state: { saveRejects: 1 } });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting', 60_000);
      const page = await t.page();
      await page.click('[data-automation-id="form.save"] button[aria-label="Save"]');
      await waitFor(() => /press Save again/.test(t.runner.progress()?.message ?? ''), 60_000);
      assert.equal(t.fx.rec.saves.length, 1);
      assert.deepEqual(t.fx.state.sheets, []);
      await (await t.page()).click('[data-automation-id="form.save"] button[aria-label="Save"]');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves.length, 2);
      assert.equal(sheetLines(t.fx.state).length, 3);
      assert.equal((t.fx.state.sheets as FxState['sheets'])[0]!.approvalstatus, '1');
    } finally {
      await t.close();
    }
  });

  it('fill only: a reload before Save fills the week in again', async () => {
    const t = await setup({ fillOnly: true });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting', 60_000);
      const page = await t.page();
      await page.evaluate(() => location.reload());
      await waitFor(() => /reloaded/.test(t.runner.progress()?.message ?? ''), 60_000);
      await waitFor(() => /press Save in the browser/.test(t.runner.progress()?.message ?? ''), 60_000);
      assert.equal(t.fx.rec.saves.length, 0);
      await (await t.page()).click('[data-automation-id="form.save"] button[aria-label="Save"]');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves.length, 1);
      assert.equal(sheetLines(t.fx.state).length, 3);
    } finally {
      await t.close();
    }
  });

  it('adds to a timesheet that was saved before (open)', async () => {
    const base = defaultState();
    const t = await setup({
      reports: week({ '2026-10-05': [['Development', 4]], '2026-10-06': [['Development', 6]] }),
      state: { sheets: [{ id: '790', week: WEEK, approvalstatus: '1', lines: [{ customer: '8430492', task: dev(base), minutes: [240, 0, 0, 0, 0, 0, 0] }] }] },
    });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? '');
      assert.equal(t.fx.rec.saves[0]!.approval, '1');
      assert.deepEqual(sheetLines(t.fx.state), [`8430492 ${dev(base)} 240,360,0,0,0,0,0`]);
    } finally {
      await t.close();
    }
  });

  it('a timesheet pending approval is not touched', async () => {
    const base = defaultState();
    const t = await setup({
      reports: week({ '2026-10-05': [['Development', 4]], '2026-10-06': [['Development', 6]] }),
      state: { sheets: [{ id: '791', week: WEEK, approvalstatus: '2', lines: [{ customer: '8430492', task: dev(base), minutes: [240, 0, 0, 0, 0, 0, 0], editable: 'F', status: '2' }] }] },
    });
    try {
      const prep = await t.runner.prepare('netsuite', WEEK);
      if (prep.state === 'ready') {
        t.runner.execute('netsuite', WEEK, prep.fingerprint);
        const done = await t.runner.wait();
        assert.equal(done?.status, 'aborted', JSON.stringify(done));
      }
      assert.deepEqual(t.fx.rec.saves, []);
    } finally {
      await t.close();
    }
  });

  it('fill only: Submit never reaches NetSuite; the filled week is discarded', async () => {
    const t = await setup({ fillOnly: true });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting', 60_000);
      await (await t.page()).click('[data-automation-id="form.submit"] button[aria-label="Submit"]');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /blocked .*(submit|Submit)/);
      assert.match(done!.error!, /nothing saved/);
      assert.deepEqual(t.fx.rec.saves, []);
      assert.deepEqual(t.fx.rec.validations, []);
      assert.deepEqual(t.fx.state.sheets, []);
      await assertClean(t, 0);
    } finally {
      await t.close();
    }
  });

  it('fill only: a change by hand after the check blocks the save', async () => {
    const t = await setup({ fillOnly: true });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting', 60_000);
      const page = await t.page();
      await page.evaluate(() => {
        const fx = (window as any).__fx;
        fx.lines[0].hours[4] = 3;
      });
      await page.click('[data-automation-id="form.save"] button[aria-label="Save"]');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /other lines than the checked ones/);
      assert.deepEqual(t.fx.rec.saves, []);
      assert.deepEqual(t.fx.state.sheets, []);
      await assertClean(t, 0);
    } finally {
      await t.close();
    }
  });

  it('a Save pressed while the adapter fills in is blocked', async () => {
    const t = await setup({
      state: {
        script: `(() => { const r = window.__fx.rec; const set = r.setCurrentSublistValue; r.setCurrentSublistValue = function (o) { set.call(this, o); if (/^hours/.test(o.fieldId)) document.getElementById('save').click(); }; })()`,
      },
    });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /blocked/);
      assert.deepEqual(t.fx.rec.saves, []);
      assert.deepEqual(t.fx.rec.validations, []);
      assert.deepEqual(t.fx.state.sheets, []);
    } finally {
      await t.close();
    }
  });

  it('other hours on the site hold back only that day: the rest of the week is still entered', async () => {
    const base = defaultState();
    const t = await setup({ state: { sheets: [{ id: '778', week: WEEK, approvalstatus: '', lines: [{ customer: '8430492', task: dev(base), minutes: [120, 0, 0, 0, 0, 0, 0] }] }] } });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      assert.deepEqual(Object.keys(prep.held), ['2026-10-05'], JSON.stringify(prep));
      assert.ok(prep.write.length > 0 && prep.write.every((c) => c.date !== '2026-10-05'), JSON.stringify(prep.write));
      assert.deepEqual(t.fx.rec.posts, []);
    } finally {
      await t.close();
    }
  });

  it('approved days are skipped; the rest of the week goes on a new line of the approved timesheet', async () => {
    const base = defaultState();
    const t = await setup({
      reports: week({ '2026-10-05': [['Development', 8]], '2026-10-06': [['Development', 8]], '2026-10-07': [['Training', 1.5]] }),
      state: { sheets: [{ id: '779', week: WEEK, approvalstatus: '3', lines: [{ customer: '8430492', task: dev(base), minutes: [480, 0, 0, 0, 0, 0, 0], editable: 'F', status: '3' }] }] },
    });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      assert.deepEqual(prep.write.map((c) => `${c.date} ${c.hours}`), ['2026-10-06 8', '2026-10-07 1.5']);
      assert.ok(prep.notes.includes('2026-10-05: approved in NetSuite; already as planned'), JSON.stringify(prep.notes));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', JSON.stringify(done));
      assert.equal(t.fx.rec.saves.length, 1);
      assert.equal(t.fx.rec.saves[0]!.submitted, '');
      assert.equal(t.fx.rec.saves[0]!.approval, '3');
      assert.deepEqual(sheetLines(t.fx.state), [`8430492 ${dev(base)} 480,0,0,0,0,0,0`, `8430492 ${dev(base)} 0,480,0,0,0,0,0`, `7338455 ${training(base)} 0,0,90,0,0,0,0`].sort());
      assert.equal(t.fx.state.sheets[0]!.approvalstatus, '1', 'new lines reopen the approved timesheet');
    } finally {
      await t.close();
    }
  });

  it('an approved day with other hours is left as it is and said so; nothing else to do is a no-op', async () => {
    const base = defaultState();
    const t = await setup({
      reports: week({ '2026-10-05': [['Development', 6]] }),
      state: { sheets: [{ id: '781', week: WEEK, approvalstatus: '3', lines: [{ customer: '8430492', task: dev(base), minutes: [480, 0, 0, 0, 0, 0, 0], editable: 'F', status: '3' }] }] },
    });
    try {
      const prep = await t.runner.prepare('netsuite', WEEK);
      assert.equal(prep.state, 'noop', JSON.stringify(prep));
      assert.ok((prep as { notes: string[] }).notes.includes('2026-10-05: approved in NetSuite with 8.00 h (the timesheet books 6.00 h); left as it is'));
      assert.deepEqual(t.fx.rec.posts, []);
    } finally {
      await t.close();
    }
  });

  it('enters a month in one run: waits for the login, enters only the days in range, skips weeks that cannot be entered', async () => {
    const base = defaultState();
    const t = await setup({ state: { loggedIn: false }, reportsFor: (wk) => (wk === WEEK ? REPORTS : []) });
    try {
      const plan = await t.runner.planRange('netsuite', '2026-10-07', '2026-10-31');
      assert.deepEqual(plan.weeks.map((w) => w.week), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
      const first = plan.weeks[0]!;
      assert.ok(first.ok);
      assert.deepEqual((first as { cells: { date: string; hours: number }[] }).cells.map((c) => `${c.date} ${c.hours}`), ['2026-10-07 8', '2026-10-08 1.5']);
      await assert.rejects(t.runner.start('netsuite', '2026-10-07', '2026-10-31', plan.token), /not what the last check showed/);
      // First step: the site is read (waiting for the login) and compared, nothing written.
      await t.runner.check('netsuite', '2026-10-07', '2026-10-31');
      await waitFor(() => !!t.runner.checkProgress()?.login);
      t.fx.state.loggedIn = true;
      await (await t.page()).goto(t.fx.url);
      const checked = (await t.runner.waitCheck())!;
      assert.equal(checked.status, 'done', JSON.stringify(checked));
      assert.deepEqual(checked.weeks.map((w) => w.state), ['ready', 'blocked', 'noop', 'noop']);
      assert.deepEqual(checked.weeks[0]!.write.map((c) => `${c.date} ${c.hours}`), ['2026-10-07 8', '2026-10-08 1.5']);
      assert.deepEqual(t.fx.rec.posts, []);
      await assert.rejects(t.runner.start('netsuite', '2026-10-07', '2026-10-31', '0000000000000000'), /not what the last check showed/);
      await t.runner.start('netsuite', '2026-10-07', '2026-10-31', checked.token!);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', JSON.stringify(done));
      assert.deepEqual(done!.weeks.map((w) => w.state), ['saved', 'skipped', 'done', 'done']);
      assert.deepEqual(sheetLines(t.fx.state), [`8430492 ${dev(base)} 0,0,480,0,0,0,0`, `7338455 ${training(base)} 0,0,0,90,0,0,0`].sort());
      assert.ok(t.fx.rec.saves.every((s) => s.submitted === '' && s.multibtn !== 'savesubmit'));
    } finally {
      await t.close();
    }
  });

  it('hours that are not whole quarters on the site stop the week', async () => {
    const base = defaultState();
    const t = await setup({ state: { sheets: [{ id: '780', week: WEEK, approvalstatus: '', lines: [{ customer: '8430492', task: dev(base), minutes: [0, 0, 0, 0, 70, 0, 0] }] }] } });
    try {
      const prep = await t.runner.prepare('netsuite', WEEK);
      assert.equal(prep.state, 'aborted', JSON.stringify(prep));
      assert.match((prep as { reason: string }).reason, /70 min on 2026-10-09, not a whole quarter hour/);
      assert.deepEqual(t.fx.rec.posts, []);
    } finally {
      await t.close();
    }
  });

  it('an error answer to Save: the week is read back, nothing was saved', async () => {
    const t = await setup({ state: { saveStatus: 500 } });
    try {
      const prep = ready(await t.runner.prepare('netsuite', WEEK));
      t.runner.execute('netsuite', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /did not save the week \(NetSuite answered 500\); nothing saved/);
      assert.equal(t.fx.rec.saves.length, 1);
      assert.deepEqual(t.fx.state.sheets, []);
    } finally {
      await t.close();
    }
  });

  it('asks to log in when the session is gone, and refuses another employee', async () => {
    const t = await setup({ state: { loggedIn: false } });
    try {
      const prep = await t.runner.prepare('netsuite', WEEK);
      assert.equal(prep.state, 'login', JSON.stringify(prep));
      t.fx.state.loggedIn = true;
      t.fx.state.employee = { id: '999', text: 'E00000009 Someone Else' };
      const other = await t.runner.prepare('netsuite', WEEK);
      assert.equal(other.state, 'blocked');
      assert.match((other as { reasons: string[] }).reasons[0], /logged in as "E00000009 Someone Else", but the mapping was read for "E00000001 Jane Doe"/);
      assert.deepEqual(t.fx.rec.posts, []);
    } finally {
      await t.close();
    }
  });
});
