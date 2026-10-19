import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from './helpers.ts';
import { defaultState, startRedmine, type FxState } from './redmine-fixture.ts';
import { Store } from '../src/core/store.ts';
import { chromeAvailable, openBrowser } from '../src/core/submit/browser.ts';
import { SubmitSession } from '../src/core/submit/session.ts';
import { SubmitRunner, type PrepareResult } from '../src/core/submit/run.ts';
import { DISCOVER_DAYS, dayUrl, dayUrlProblem, hoursText, mergeIssues, redmine, redmineBase, type RedmineCatalog } from '../src/core/submit/redmine.ts';
import { Abort } from '../src/core/submit/adapter.ts';
import type { Page } from 'playwright-core';
import type { RedmineTarget, SubmitRule } from '../src/core/submit/types.ts';
import type { DayReport, DayStatus } from '../src/core/types.ts';

const WEEK = '2026-09-28';
const TODAY = '2026-10-01';

describe('redmine addresses', () => {
  it('builds day URLs with exactly year, month, day and user', () => {
    assert.equal(dayUrl('https://r.example.com', 42, '2026-09-05'), 'https://r.example.com/work_time/index?year=2026&month=9&day=5&user=42');
    assert.equal(redmineBase('https://r.example.com/work_time/index'), 'https://r.example.com');
    assert.equal(redmineBase('https://r.example.com/redmine/work_time/index?x=1'), 'https://r.example.com/redmine');
    assert.equal(redmineBase('https://r.example.com/'), 'https://r.example.com');
    assert.throws(() => redmineBase('http://r.example.com/work_time/index'), Abort);
    assert.throws(() => redmineBase('https://r.example.com/issues'), Abort);
    assert.equal(hoursText(7.25), '7.25');
    assert.equal(hoursText(8), '8.00');
    assert.equal(hoursText(0.1 + 0.2), '0.30');
  });

  it('accepts only the expected parameters (prj=false is the one harmless extra)', () => {
    const o = 'https://r.example.com';
    assert.equal(dayUrlProblem(`${o}/work_time/index?day=1&month=10&prj=false&user=42&year=2026`, o, 42, '2026-10-01'), null);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=1&month=10&user=42&year=2026&ticket_del=closed`, o, 42, '2026-10-01')!, /unexpected parameter ticket_del/);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=1&month=10&prj=170&user=42&year=2026`, o, 42, '2026-10-01')!, /unexpected parameter prj/);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=2&month=10&user=42&year=2026`, o, 42, '2026-10-01')!, /day=2/);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=1&month=10&user=43&year=2026`, o, 42, '2026-10-01')!, /user=43/);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=1&month=10&year=2026`, o, 42, '2026-10-01')!, /user is missing/);
    assert.match(dayUrlProblem(`${o}/work_time/index?day=1&day=1&month=10&user=42&year=2026`, o, 42, '2026-10-01')!, /twice/);
    assert.match(dayUrlProblem(`https://evil.example.com/work_time/index?day=1&month=10&user=42&year=2026`, o, 42, '2026-10-01')!, /evil/);
    assert.match(dayUrlProblem(`${o}/login?day=1&month=10&user=42&year=2026`, o, 42, '2026-10-01')!, /Worktime page/);
  });
});

function day(date: string, entries: [string, string, number][], status: DayStatus = 'final'): DayReport {
  return {
    date, status, computedAt: '', blocks: [], summary: '', warnings: [], paths: {}, outOfOffice: false,
    target: 8, realTotal: 0, total: 0,
    entries: entries.map(([project, category, hours]) => ({ project, category, capex: false, real: hours, hours })),
  };
}

const RULES: SubmitRule<RedmineTarget>[] = [
  { project: 'NLP', category: 'Feature Build', target: { issueId: 4242, activity: 'Development' } },
  { project: 'NLP', category: 'Meetings', target: { issueId: 101, activity: 'Meeting' } },
  { project: 'NLP', category: 'Learning', target: { issueId: 102, activity: 'Overhead - learning' } },
];

/** A week with hours on four days (Thursday is today). */
const WEEK_REPORTS = [
  day('2026-09-28', [['NLP', 'Feature Build', 6], ['NLP', 'Meetings', 2]]),
  day('2026-09-29', [['NLP', 'Feature Build', 8]]),
  day('2026-09-30', [['NLP', 'Feature Build', 7.25], ['NLP', 'Learning', 0.75]]),
  day('2026-10-01', [['NLP', 'Feature Build', 4]], 'today'),
];

/** Only two days with hours; the others are empty. */
const SMALL_REPORTS = [
  day('2026-09-28', []),
  day('2026-09-29', [['NLP', 'Feature Build', 8]]),
  day('2026-09-30', [['NLP', 'Meetings', 1.5]]),
  day('2026-10-01', [], 'today'),
];

const ACT = { 'Development': 9, 'Meeting': 15, 'Overhead - learning': 10 } as const;

describe('redmine adapter and run flow', { skip: !chromeAvailable() && 'Google Chrome not installed' }, () => {
  let session: SubmitSession;
  const shots = mkdtempSync(join(tmpdir(), 'shots-'));

  before(() => {
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    session = new SubmitSession(() => openBrowser({ headless: true, profileDir, lockPath: join(profileDir, '..', `lock-redmine-${process.pid}`) }));
  });
  after(async () => {
    await session.close();
  });

  async function setup(opts: { state?: Partial<FxState>; fillOnly?: boolean; reports?: DayReport[]; rules?: SubmitRule<RedmineTarget>[]; userTimeoutMs?: number; now?: () => number } = {}) {
    const fx = await startRedmine({ ...defaultState(), ...opts.state });
    const store = new Store(':memory:');
    const config = testConfig({
      submit: {
        redmine: { url: `${fx.origin}/work_time/index`, fillOnly: opts.fillOnly ?? false, rules: opts.rules ?? RULES },
        netsuite: { url: '', fillOnly: true, rules: [] },
      },
    });
    const runner = new SubmitRunner({
      store, config: () => config, today: () => TODAY, session, screenshotDir: shots, userTimeoutMs: opts.userTimeoutMs ?? 30_000, now: opts.now,
      reports: async () => ({ reports: opts.reports ?? WEEK_REPORTS }),
    });
    const page = async () => (await session.ensure()).page;
    return { fx, store, runner, page, close: fx.close };
  }

  const ready = (r: PrepareResult) => {
    assert.equal(r.state, 'ready', JSON.stringify(r));
    return r as Extract<PrepareResult, { state: 'ready' }>;
  };

  /** After a stop, the tab shows the day freshly loaded: no filled-in values a later Update could save. */
  async function assertClean(page: Page, origin: string, date: string) {
    assert.equal(dayUrlProblem(page.url(), origin, 42, date), null, `the tab shows ${page.url()}`);
    const filled = await page.$$eval('input[name^="new_time_entry["]', (els) => els.filter((e) => /\[hours\]$/.test(e.getAttribute('name') ?? '') && (e as HTMLInputElement).value !== '').map((e) => e.getAttribute('name')));
    assert.deepEqual(filled, []);
  }

  /** Every page the adapter opened carried only year/month/day/user (and the plugin's own prj=false). */
  function assertSafeGets(gets: string[]) {
    for (const g of gets) {
      const keys = [...new URLSearchParams(g.split('?')[1] ?? '').keys()].sort();
      assert.ok(keys.length === 0 || ['day,month,user,year', 'day,month,prj,user,year'].includes(keys.join(',')), `unsafe GET ${g}`);
    }
  }

  it('discovers the user, issues with their projects and the activities from the real capture', async () => {
    const t = await setup({ state: { capture: true } });
    try {
      const r = await t.runner.discover('redmine');
      assert.equal(r.state, 'ok');
      const c = (r as { catalog: RedmineCatalog }).catalog;
      assert.equal(c.origin, t.fx.origin);
      assert.equal(c.userId, 42);
      assert.equal(c.user, 'Jane Doe');
      assert.deepEqual(c.issues.map((i) => i.id), [101, 102, 4242, 103, 104, 105]);
      const nlp = c.issues.find((i) => i.id === 4242)!;
      assert.equal(nlp.title, 'Checkout redesign');
      assert.equal(nlp.project, 'Acme Platform');
      assert.equal(c.issues.find((i) => i.id === 101)!.project, 'Teamwork');
      assert.equal(c.issues.find((i) => i.id === 104)!.title, 'General presales (old, do not book)');
      assert.ok(c.issues.every((i) => i.activities.length === 11));
      assert.deepEqual(c.activities, ['Meeting', 'Development', 'Testing', 'Documentation', 'Operations support', 'Troubleshooting', 'Overhead - learning', 'Overhead - other', 'Overhead - bugfix', 'Overhead - Presales', 'Source - credit']);
      assert.ok(redmine.exists(c, { issueId: 4242, activity: 'Development' }));
      assert.ok(!redmine.exists(c, { issueId: 4242, activity: 'Developent' }));
      assert.ok(!redmine.exists(c, { issueId: 42, activity: 'Development' }));
      assert.equal(redmine.label(c, { issueId: 4242, activity: 'Development' }), '#4242 Checkout redesign · Development');
      assert.deepEqual(t.store.submitCatalog('redmine')?.data, c);
      // Reading the real day: nothing entered, total 0.
      const snap = await redmine.read(await t.page(), c, WEEK);
      assert.deepEqual(snap, { week: WEEK, cells: [] });
      assert.equal(t.fx.rec.posts.length, 0);
      assertSafeGets(t.fx.rec.gets);
    } finally {
      await t.close();
    }
  });

  it('discovers issues of the two weeks before and does not judge the entries of those days', async () => {
    const t = await setup({ state: { private: { '2026-10-01': 1.5, '2026-09-25': 2 }, hiddenIssues: [] } });
    try {
      const r = await t.runner.discover('redmine');
      assert.equal(r.state, 'ok');
      const c = (r as { catalog: RedmineCatalog }).catalog;
      assert.deepEqual(c.issues.map((i) => i.id), [101, 102, 4242, 103]);
      const days = new Set(t.fx.rec.gets.map((g) => new URLSearchParams(g.split('?')[1] ?? '').get('day')).filter(Boolean));
      assert.equal(days.size, DISCOVER_DAYS + 1);
      assert.equal(t.fx.rec.posts.length, 0);
      assertSafeGets(t.fx.rec.gets);
    } finally {
      await t.close();
    }
  });

  it('merges issue lists by id, uniting activities', () => {
    const a = { id: 1, title: 'A', project: 'P', activities: ['x'] };
    assert.deepEqual(mergeIssues([[a], [{ ...a, title: 'A2', activities: ['y', 'x'] }, { id: 2, title: 'B', project: 'Q', activities: [] }]]), [
      { id: 1, title: 'A', project: 'P', activities: ['x', 'y'] },
      { id: 2, title: 'B', project: 'Q', activities: [] },
    ]);
  });

  it('reads existing entries of the whole week, including future days', async () => {
    const t = await setup({
      state: {
        entries: [
          { id: 1, issueId: 101, date: '2026-09-28', hours: 2, activityId: 15, comments: 'standup' },
          { id: 2, issueId: 4242, date: '2026-10-03', hours: 1.5, activityId: 9, comments: '' },
          { id: 3, issueId: 102, date: '2026-09-29', hours: 0, activityId: 10, comments: '' },
        ],
      },
    });
    try {
      const d = await t.runner.discover('redmine');
      const c = (d as { catalog: RedmineCatalog }).catalog;
      const snap = await redmine.read(await t.page(), c, WEEK);
      assert.deepEqual(snap.cells, [
        { date: '2026-09-28', target: { issueId: 101, activity: 'Meeting' }, hours: 2 },
        { date: '2026-10-03', target: { issueId: 4242, activity: 'Development' }, hours: 1.5 },
      ]);
      // A wrong user in the heading stops the read.
      t.fx.state.headingName = 'Someone Else';
      await assert.rejects(redmine.read(await t.page(), c, WEEK), /expected "Jane Doe"/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('saves exactly the planned cells, day by day, touching nothing else', async () => {
    const t = await setup({
      state: { entries: [{ id: 1, issueId: 101, date: '2026-09-28', hours: 2, activityId: 15, comments: 'standup' }], memo: { '2026-09-29': 'line one\nline two' } },
    });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      assert.equal(prep.fillOnly, false);
      assert.equal(prep.unchanged, 1);
      assert.deepEqual(prep.write.map((c) => `${c.date} ${c.label} ${c.hours}`), [
        '2026-09-28 #4242 Checkout redesign · Development 6',
        '2026-09-29 #4242 Checkout redesign · Development 8',
        '2026-09-30 #4242 Checkout redesign · Development 7.25',
        '2026-09-30 #102 Learning, training · Overhead - learning 0.75',
        '2026-10-01 #4242 Checkout redesign · Development 4',
      ]);
      assert.equal(t.fx.rec.posts.length, 0, 'prepare never posts');

      // Days that were computed lock once the week is saved; today stays open.
      for (const r of WEEK_REPORTS) t.store.saveDay(r);
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? "");
      assert.deepEqual(done?.units.map((u) => [u.unit, u.state]), [['2026-09-28', 'saved'], ['2026-09-29', 'saved'], ['2026-09-30', 'saved'], ['2026-10-01', 'saved']]);
      assert.deepEqual([...t.store.marks('locked').keys()], ['2026-09-28', '2026-09-29', '2026-09-30']);
      assert.equal(t.store.marks('locked').get('2026-09-28')?.reason, 'entered in redmine');

      assert.equal(t.fx.rec.posts.length, 4);
      for (const post of t.fx.rec.posts) {
        for (const [k, v] of post.fields) {
          if (/^time_entry\[\d+\]\[hours\]$/.test(k)) assert.notEqual(v.trim(), '', `${k} posted blank (would delete the entry)`);
          if (/\[comments\]$/.test(k) && k.startsWith('new_')) assert.equal(v, '', `${k} posted a comment`);
          if (/\[status_id\]$/.test(k)) assert.match(v, /^\d+$/, `${k} posted a status change`);
        }
        const filled = post.fields.filter(([k, v]) => /^new_time_entry\[\d+\]\[0\]\[hours\]$/.test(k) && v !== '').map(([k, v]) => `${k}=${v}`);
        assert.ok(filled.length >= 1);
        assert.ok(post.url.includes('prj=false'));
      }
      assert.deepEqual(t.fx.rec.posts[0].fields.filter(([k]) => k.startsWith('time_entry[1]')), [['time_entry[1][hours]', '2.00'], ['time_entry[1][activity_id]', '15'], ['time_entry[1][status_id]', '9'], ['time_entry[1][comments]', 'standup']]);
      assert.deepEqual(t.fx.rec.posts.map((p) => p.fields.filter(([k, v]) => k.endsWith('[hours]') && k.startsWith('new_') && v).map(([k, v]) => `${k}=${v}`)), [
        ['new_time_entry[4242][0][hours]=6.00'],
        ['new_time_entry[4242][0][hours]=8.00'],
        ['new_time_entry[102][0][hours]=0.75', 'new_time_entry[4242][0][hours]=7.25'],
        ['new_time_entry[4242][0][hours]=4.00'],
      ]);
      assert.deepEqual(t.fx.rec.statusChanges, []);
      assert.deepEqual(t.fx.rec.deleted, []);
      assert.equal(t.fx.state.memo['2026-09-29'], 'line one\nline two', 'the memo is posted back unchanged');
      assert.deepEqual(
        t.fx.state.entries.map((e) => `${e.date} #${e.issueId} ${e.activityId} ${e.hours} ${e.comments}`).sort(),
        [
          '2026-09-28 #101 15 2 standup',
          `2026-09-28 #4242 ${ACT['Development']} 6 `,
          `2026-09-29 #4242 ${ACT['Development']} 8 `,
          `2026-09-30 #102 ${ACT['Overhead - learning']} 0.75 `,
          `2026-09-30 #4242 ${ACT['Development']} 7.25 `,
          `2026-10-01 #4242 ${ACT['Development']} 4 `,
        ],
      );
      assertSafeGets(t.fx.rec.gets);

      const runs = t.store.submitRuns('redmine', WEEK);
      assert.equal(runs[0].status, 'saved');
      assert.equal((runs[0].written as unknown[]).length, 5);
      assert.ok(runs.some((r) => r.status === 'ready'));

      // A rerun finds everything in place.
      const again = await t.runner.prepare('redmine', WEEK);
      assert.equal(again.state, 'noop');
      assert.equal(t.fx.rec.posts.length, 4);
    } finally {
      await t.close();
    }
  });

  it('fill only: fills in, waits for the user to press Update, then verifies', async () => {
    const t = await setup({ fillOnly: true, reports: SMALL_REPORTS, state: { redirectAfterPost: true } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      assert.equal(prep.fillOnly, true);
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const page = await t.page();
      for (const date of ['2026-09-29', '2026-09-30']) {
        await waitFor(() => t.runner.progress()?.units.find((u) => u.unit === date)?.state === 'waiting');
        assert.match(t.runner.progress()!.message, new RegExp(`Filled ${date}: press Update`));
        assert.equal(t.fx.rec.posts.length, date === '2026-09-29' ? 0 : 1, 'nothing posted until the user presses Update');
        // The user presses Update.
        await page.click('#time_input_table ~ input[type="button"][value="Update"]');
      }
      const done = await t.runner.wait();
      assert.equal(done?.status, 'saved', done?.error ?? "");
      assert.equal(t.fx.rec.posts.length, 2);
      assert.deepEqual(t.fx.state.entries.map((e) => `${e.date} #${e.issueId} ${e.hours}`).sort(), ['2026-09-29 #4242 8', '2026-09-30 #101 1.5']);
    } finally {
      await t.close();
    }
  });

  it('fill only: leaving the page without saving aborts; cancelling never presses anything', async () => {
    const t = await setup({ fillOnly: true, reports: SMALL_REPORTS });
    try {
      let prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting');
      const page = await t.page();
      await page.goto(`${t.fx.origin}/work_time/index?year=2026&month=9&day=1&user=42`);
      let done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /left the page without saving 2026-09-29/);
      assert.ok(done!.screenshots.length === 1 && existsSync(done!.screenshots[0]));
      await assertClean(page, t.fx.origin, '2026-09-29');

      prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting');
      t.runner.cancel();
      done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /cancelled/);
      assert.equal(t.fx.rec.posts.length, 0);
      assert.deepEqual(t.fx.state.entries, []);
      // The filled form is gone: the tab was reloaded, so a later Update saves nothing new.
      await assertClean(page, t.fx.origin, '2026-09-29');
      await page.click('#time_input_table ~ input[type="button"][value="Update"]');
      await waitFor(() => t.fx.rec.posts.length === 1);
      assert.deepEqual(t.fx.rec.posts[0].fields.filter(([k, v]) => /^new_time_entry\[\d+\]\[0\]\[hours\]$/.test(k) && v !== ''), []);
      await page.waitForLoadState('load');
      assert.deepEqual(t.fx.state.entries, []);
    } finally {
      await t.close();
    }
  });

  it('conflicting hours abort the week with zero posts', async () => {
    const t = await setup({ state: { entries: [{ id: 7, issueId: 4242, date: '2026-09-29', hours: 3, activityId: 9, comments: '' }] } });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'conflict');
      assert.deepEqual((prep as { reasons: string[] }).reasons, ['2026-09-29 #4242 · Development: 3.00 h already entered, plan says 8.00 h']);
      t.runner.execute('redmine', WEEK, '0123456789abcdefs');
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('two entries on the same issue and activity are a conflict', async () => {
    const t = await setup({
      state: {
        entries: [
          { id: 7, issueId: 4242, date: '2026-09-29', hours: 4, activityId: 9, comments: '' },
          { id: 8, issueId: 4242, date: '2026-09-29', hours: 4, activityId: 9, comments: '' },
        ],
      },
    });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'conflict');
      assert.match((prep as { reasons: string[] }).reasons[0], /appears twice/);
    } finally {
      await t.close();
    }
  });

  it('a change on the site after the review aborts with zero posts', async () => {
    const t = await setup();
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.fx.state.entries.push({ id: 9, issueId: 103, date: '2026-09-30', hours: 1, activityId: 15, comments: '' });
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /changed since the review/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('a stale confirmation (same site, other fingerprint) aborts with zero posts', async () => {
    const t = await setup();
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, `${prep.fingerprint.slice(0, 16)}${prep.fingerprint.endsWith('s') ? 'f' : 's'}`);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /changed since the review; prepare again/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('a page script changing another field while filling aborts with zero posts', async () => {
    const script = `document.addEventListener('input', function (e) {
      var row = e.target.closest('tr'); var s = row && row.querySelector('select[name$="[status_id]"]');
      if (s) s.selectedIndex = (s.selectedIndex + 1) % s.options.length;
    });`;
    const t = await setup({ state: { script } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /does not look as expected after filling in \(new_time_entry\[101\]\[0\]\[status_id\] changed from "9" to "3"/);
      assert.equal(t.fx.rec.posts.length, 0);
      await assertClean(await t.page(), t.fx.origin, '2026-09-28');
    } finally {
      await t.close();
    }
  });

  it('an unexpected dialog is dismissed and aborts with zero posts', async () => {
    const t = await setup({ state: { script: `document.addEventListener('input', function () { confirm('Leave?'); });` } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted');
      assert.match(done!.error!, /unexpected dialog \(confirm: Leave\?\)/);
      assert.equal(t.fx.rec.posts.length, 0);
      await assertClean(await t.page(), t.fx.origin, '2026-09-28');
    } finally {
      await t.close();
    }
  });

  it('a page script changing a field on Update is blocked before it reaches Redmine', async () => {
    const script = `document.addEventListener('click', function (e) {
      if (e.target.value !== 'Update') return;
      var c = document.querySelector('input[name="new_time_entry[101][0][comments]"]'); c.value = 'sneaky';
    }, true);`;
    const t = await setup({ state: { script } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? "");
      assert.match(done!.error!, /blocked a submission with other values than the checked form \(new_time_entry\[101\]\[0\]\[comments\]\)/);
      assert.equal(t.fx.rec.posts.length, 0);
      await assertClean(await t.page(), t.fx.origin, '2026-09-28');
    } finally {
      await t.close();
    }
  });

  it('an error banner after Update means failed: check by hand, nothing retried', async () => {
    let clock = Date.now();
    const t = await setup({ state: { errorOnPost: 'Error: Issue4242: No Activities!' }, now: () => clock });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'failed');
      assert.match(done!.error!, /2026-09-28: Redmine reported an error after Update: Error: Issue4242: No Activities!; check Redmine by hand/);
      assert.equal(t.fx.rec.posts.length, 1, 'stops at the first failure');
      assert.deepEqual(done?.units.map((u) => u.state), ['failed', 'pending', 'pending', 'pending']);
      assert.equal(t.store.submitRuns('redmine', WEEK)[0].status, 'failed');
      assert.equal(t.store.submitRuns('redmine', WEEK)[0].screenshots.length, 1);

      // For 5 minutes after a failure, the week is neither prepared nor entered again.
      const gets = t.fx.rec.gets.length;
      const again = await t.runner.prepare('redmine', WEEK);
      assert.equal(again.state, 'blocked');
      assert.match((again as { reasons: string[] }).reasons[0], /^the last run failed at \d\d:\d\d; check Redmine and retry after \d\d:\d\d$/);
      assert.throws(() => t.runner.execute('redmine', WEEK, prep.fingerprint), /the last run failed at \d\d:\d\d; check Redmine and retry after/);
      assert.equal(t.fx.rec.gets.length, gets, 'the site is not opened');
      assert.equal(t.fx.rec.posts.length, 1);
      clock += 5 * 60_000 + 1000;
      t.fx.state.errorOnPost = undefined;
      assert.equal((await t.runner.prepare('redmine', WEEK)).state, 'ready');
    } finally {
      await t.close();
    }
  });

  it('a duplicated issue row, a missing row or a missing activity aborts with zero posts', async () => {
    for (const [change, reason] of [
      [(s: FxState) => (s.duplicateRow = 4242), /#4242 has 2 rows/],
      [(s: FxState) => (s.hiddenIssues = [4242]), /#4242 is not listed/],
      [(s: FxState) => (s.issues.find((i) => i.id === 4242)!.activities = [[15, 'Meeting'], [18, 'Testing']]), /offers the activity "Development" 0 times/],
    ] as const) {
      const t = await setup();
      try {
        const first = ready(await t.runner.prepare('redmine', WEEK)); // discovers with the complete page
        change(t.fx.state);
        const prep = ready(await t.runner.prepare('redmine', WEEK));
        assert.equal(prep.fingerprint, first.fingerprint);
        t.runner.execute('redmine', WEEK, prep.fingerprint);
        const done = await t.runner.wait();
        assert.equal(done?.status, 'aborted');
        assert.match(done!.error!, reason);
        assert.equal(t.fx.rec.posts.length, 0);
      } finally {
        await t.close();
      }
    }
  });

  it('an unexpected address after navigation aborts before reading on', async () => {
    const t = await setup();
    try {
      ready(await t.runner.prepare('redmine', WEEK));
      t.fx.state.redirectExtra = 'ticket_pos=4242_1';
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'aborted');
      assert.match((prep as { reason: string }).reason, /blocked a request that would change Redmine: ticket_pos/);
      assert.equal(t.fx.rec.posts.length, 0);
      assert.ok(!t.fx.rec.gets.some((g) => g.includes('ticket_pos')), 'the redirect never reached Redmine');
    } finally {
      await t.close();
    }
  });

  it('the month table colours Sundays like an error banner: only a real banner aborts', async () => {
    const t = await setup({ state: { entries: [{ id: 1, issueId: 101, date: '2026-09-27', hours: 1, activityId: 15, comments: '' }] } });
    try {
      ready(await t.runner.prepare('redmine', WEEK));
      const page = await t.page();
      assert.ok((await page.$$('#day_scroll div[style*="background:#faa"]')).length >= 4, 'the fixture renders Sunday cells');
      t.fx.state.errorOnGet = 'Error: something broke';
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'aborted');
      assert.match((prep as { reason: string }).reason, /Redmine shows an error: Error: something broke$/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('an entry whose activity Redmine no longer offers, or hours not as saved, abort the week', async () => {
    const t = await setup({ state: { entries: [{ id: 41, issueId: 101, date: '2026-09-29', hours: 1, activityId: 99, comments: '' }] } });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'aborted', JSON.stringify(prep));
      assert.match((prep as { reason: string }).reason, /2026-09-29: entry 41 has an activity Redmine no longer offers; fix it by hand/);
      t.fx.state.entries[0].activityId = 15;
      assert.equal((await t.runner.prepare('redmine', WEEK)).state, 'conflict', 'readable again (an entry the plan does not have)');
      t.fx.state.script = `document.addEventListener('DOMContentLoaded', function () { var i = document.querySelector('input[name="time_entry[41][hours]"]'); if (i) i.value = '1.5'; });`;
      const changed = await t.runner.prepare('redmine', WEEK);
      assert.equal(changed.state, 'aborted');
      assert.match((changed as { reason: string }).reason, /entry 41 on #101 shows hours "1.5", not the saved "1.00"/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('an Update pressed while the adapter fills in is blocked: nothing reaches Redmine', async () => {
    const script = `document.addEventListener('input', function (e) {
      if (/^new_time_entry\\[\\d+\\]\\[0\\]\\[hours\\]$/.test(e.target.name || '')) e.target.form.submit();
    });`;
    const t = await setup({ state: { script } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /2026-09-28: blocked a submission before the form was checked; nothing saved/);
      assert.equal(t.fx.rec.posts.length, 0);
      assert.deepEqual(t.fx.state.entries, []);
      await assertClean(await t.page(), t.fx.origin, '2026-09-28');
    } finally {
      await t.close();
    }
  });

  it('fill only: a submission blocked after Redmine received the Update is reported as failed, never as nothing saved', async () => {
    const t = await setup({ fillOnly: true, reports: SMALL_REPORTS, state: { postDelayMs: 1500 } });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting');
      const page = await t.page();
      await page.click('#time_input_table ~ input[type="button"][value="Update"]', { noWaitAfter: true });
      await waitFor(() => t.fx.rec.posts.length === 1);
      // While Redmine is still answering, the user presses Update again.
      await page.click('#time_input_table ~ input[type="button"][value="Update"]', { noWaitAfter: true, timeout: 3000 }).catch(() => {});
      const done = await t.runner.wait();
      assert.equal(done?.status, 'failed', done?.error ?? '');
      assert.match(done!.error!, /2026-09-29: Redmine received an Update — check 2026-09-29 by hand/);
      assert.doesNotMatch(done!.error!, /nothing saved/);
      assert.equal(t.fx.rec.posts.length, 1);
      assert.equal(t.store.submitRuns('redmine', WEEK)[0].status, 'failed');
    } finally {
      await t.close();
    }
  });

  it('fill only: a link that would change Redmine is blocked while waiting, and the run stops', async () => {
    const t = await setup({ fillOnly: true, reports: SMALL_REPORTS });
    try {
      const prep = ready(await t.runner.prepare('redmine', WEEK));
      t.runner.execute('redmine', WEEK, prep.fingerprint);
      await waitFor(() => t.runner.progress()?.units[0]?.state === 'waiting');
      const page = await t.page();
      // The user clicks the "x" of an issue row (ticket_del).
      await page.evaluate(() => (document.querySelector('a[href*="ticket_del="]') as HTMLAnchorElement).click());
      const done = await t.runner.wait();
      assert.equal(done?.status, 'aborted', done?.error ?? '');
      assert.match(done!.error!, /blocked a request that would change Redmine: ticket_del/);
      assert.ok(!t.fx.rec.gets.some((g) => g.includes('ticket_del')), 'the request never reached Redmine');
      assert.equal(t.fx.rec.posts.length, 0);
      await assertClean(page, t.fx.origin, '2026-09-29');
    } finally {
      await t.close();
    }
  });

  it('hours on issues the user cannot see abort the week', async () => {
    const t = await setup({ state: { private: { '2026-09-30': 1.5 } } });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'aborted');
      assert.match((prep as { reason: string }).reason, /2026-09-30: 1.50 h on issues you cannot see/);
    } finally {
      await t.close();
    }
  });

  it('asks to log in when the session is gone, and refuses another user', async () => {
    const t = await setup({ state: { loggedIn: false } });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'login');
      t.fx.state.loggedIn = true;
      ready(await t.runner.prepare('redmine', WEEK));
      t.fx.state.headingName = 'Someone Else';
      const other = await t.runner.prepare('redmine', WEEK);
      assert.equal(other.state, 'blocked');
      assert.match((other as { reasons: string[] }).reasons[0], /logged in as "Someone Else", but the mapping was read for "Jane Doe"/);
      assert.equal(t.fx.rec.posts.length, 0);
    } finally {
      await t.close();
    }
  });

  it('blocks without opening the site when the plan is incomplete; NetSuite is not enabled', async () => {
    const t = await setup({ reports: [day('2026-09-28', [['NLP', 'Unknown', 3]])] });
    try {
      const prep = await t.runner.prepare('redmine', WEEK);
      assert.equal(prep.state, 'blocked');
      assert.ok((prep as { reasons: string[] }).reasons.includes('2026-09-28: no redmine mapping for NLP / Unknown'));
      assert.equal(t.fx.rec.gets.length, 0);
      const ns = await t.runner.prepare('netsuite', WEEK);
      assert.deepEqual(ns, { system: 'netsuite', week: WEEK, state: 'blocked', reasons: ['NetSuite automation is not enabled yet'] });
    } finally {
      await t.close();
    }
  });
});

async function waitFor(cond: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
