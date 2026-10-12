import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testConfig } from './helpers.ts';
import { defaultConfig, validateConfig } from '../src/core/config.ts';
import { buildPlan, cellKey, describeTarget, ruleProblems } from '../src/core/submit/plan.ts';
import type { Plan, RedmineTarget, SubmitRule } from '../src/core/submit/types.ts';
import type { DayReport, DayStatus } from '../src/core/types.ts';
import { diff, fingerprint } from '../src/core/submit/diff.ts';
import { Store } from '../src/core/store.ts';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, chromeAvailable, launchError, openBrowser } from '../src/core/submit/browser.ts';
import { capture, safeUrl } from '../src/core/submit/inspect.ts';
import { interruptHandler, SubmitRunner } from '../src/core/submit/run.ts';
import { startUrl, SubmitSession } from '../src/core/submit/session.ts';

describe('submit config', () => {
  it('defaults to off, fill-only, no rules, and is valid', () => {
    const c = defaultConfig();
    assert.deepEqual(c.submit.redmine, { url: '', fillOnly: true, rules: [] });
    assert.deepEqual(c.submit.netsuite, { url: '', fillOnly: true, rules: [] });
    assert.deepEqual(validateConfig(testConfig()), []);
  });

  it('rejects bad URLs, unknown names, duplicates and incomplete targets', () => {
    const c = testConfig();
    c.submit.redmine.url = 'http://redmine.local';
    c.submit.redmine.rules = [
      { project: 'Nope', category: 'Development', target: { issueId: 1, activity: 'Fejlesztés' } },
      { project: 'Default', category: 'Bogus', target: { issueId: 2, activity: 'Fejlesztés' } },
      { project: 'Default', category: '*', target: { issueId: 0, activity: '' } },
      { project: 'Default', category: '*', target: { issueId: 3, activity: 'Fejlesztés' } },
    ];
    c.submit.netsuite.rules = [{ project: 'Default', category: 'Testing', target: { project: '', task: 'Testing' } }];
    const errors = validateConfig(c);
    assert.ok(errors.includes('submit.redmine.url must start with https://'));
    assert.ok(errors.includes('submit.redmine rule uses unknown project "Nope"'));
    assert.ok(errors.includes('submit.redmine rule uses unknown category "Bogus"'));
    assert.ok(errors.includes('submit.redmine rule Default / * needs a positive issueId and an activity'));
    assert.ok(errors.includes('submit.redmine has two rules for Default / *'));
    assert.ok(errors.includes('submit.netsuite rule Default / Testing needs a project and a task'));
  });

  it('takes the Redmine address without query or fragment; NetSuite keeps its query', () => {
    const msg = 'submit.redmine.url must not contain ?… or #…; use https://host/work_time/index';
    for (const url of ['https://r.example.com/work_time/index?ticket_del=closed', 'https://r.example.com/work_time/index#memo', 'https://r.example.com/work_time/index?']) {
      const c = testConfig();
      c.submit.redmine.url = url;
      assert.ok(validateConfig(c).includes(msg), url);
    }
    const ok = testConfig();
    ok.submit.redmine.url = 'https://r.example.com/work_time/index';
    ok.submit.netsuite.url = 'https://1234.app.netsuite.com/app/center/card.nl?sc=-29&whence=';
    assert.deepEqual(validateConfig(ok), []);
  });

  it('opens Redmine at the bare Worktime page, NetSuite at the configured address', () => {
    assert.equal(startUrl('redmine', 'https://r.example.com/redmine/work_time/index?year=2026&ticket_del=closed#x'), 'https://r.example.com/redmine/work_time/index');
    assert.equal(startUrl('redmine', 'https://r.example.com/'), 'https://r.example.com/work_time/index');
    assert.equal(startUrl('netsuite', 'https://1234.app.netsuite.com/app/center/card.nl?sc=-29'), 'https://1234.app.netsuite.com/app/center/card.nl?sc=-29');
    assert.throws(() => startUrl('redmine', 'http://r.example.com/work_time/index'), /https/);
  });

  it('reports malformed rules instead of throwing', () => {
    const c = testConfig();
    c.submit.redmine.rules = [null, { project: 7, category: 'Development', target: null }, { project: 'Default', category: 'Development' }] as never;
    c.submit.netsuite.rules = 'nope' as never;
    const errors = validateConfig(c);
    assert.ok(errors.includes('submit.redmine rule 1 needs a project and a category'));
    assert.ok(errors.includes('submit.redmine rule 2 needs a project and a category'));
    assert.ok(errors.includes('submit.redmine rule Default / Development needs a positive issueId and an activity'));
    assert.ok(errors.includes('submit.netsuite.rules must be a list'));
  });
});

describe('submit rule problems', () => {
  it('checks shape, duplicates and targets', () => {
    assert.deepEqual(ruleProblems('redmine', {}), ['submit.redmine.rules must be a list']);
    assert.deepEqual(ruleProblems('netsuite', [
      { project: 'P', category: 'C', target: { project: 'Acme', task: 'Dev' } },
      { project: 'P', category: 'C', target: { project: 'Acme', task: 'Dev' } },
      { project: 'P', category: 'D', target: { project: 'Acme', task: ' ' } },
      'x',
    ]), ['submit.netsuite has two rules for P / C', 'submit.netsuite rule P / D needs a project and a task', 'submit.netsuite rule 4 needs a project and a category']);
    assert.deepEqual(ruleProblems('redmine', [
      { project: 'P', category: 'C', target: { issueId: 1.5, activity: 'Dev' } },
      { project: 'P', category: 'D', target: { issueId: '2', activity: 'Dev' } },
      { project: 'P', category: '*', target: { issueId: 2, activity: 'Dev' } },
      { project: 'P', category: 'E', target: { issueId: 2, activity: 'Test' } },
    ]), ['submit.redmine rule P / C needs a positive issueId and an activity', 'submit.redmine rule P / D needs a positive issueId and an activity']);
  });
});

const WEEK = '2026-09-28'; // Monday

function day(date: string, entries: [string, string, number][], status: DayStatus = 'final', warnings: string[] = []): DayReport {
  return {
    date, status, computedAt: '', blocks: [], summary: '', warnings, paths: {}, outOfOffice: false,
    target: 8, realTotal: 0, total: 0,
    entries: entries.map(([project, category, hours]) => ({ project, category, capex: false, real: hours, hours })),
  };
}

const RULES: SubmitRule<RedmineTarget>[] = [
  { project: 'NLP', category: '*', target: { issueId: 9888, activity: 'Fejlesztés' } },
  { project: 'NLP', category: 'Team Meeting', target: { issueId: 13, activity: 'Megbeszélés, egyeztetés' } },
  { project: 'NLP', category: 'Testing', target: { issueId: 9888, activity: 'Fejlesztés' } },
];

const plan = (reports: DayReport[], today = '2026-10-04', rules = RULES, exists?: (t: RedmineTarget) => boolean) =>
  buildPlan({ system: 'redmine', week: WEEK, reports, today, rules, exists });

describe('submit plan', () => {
  it('maps exact rules before wildcards, sums cells that share a target, skips zero hours', () => {
    const r = plan([day('2026-09-28', [['NLP', 'Development', 5], ['NLP', 'Testing', 2.25], ['NLP', 'Team Meeting', 0.75], ['NLP', 'Requirements', 0]])], '2026-09-28');
    assert.ok(r.ok);
    // Sorted by date, then by the target's key (activity before issueId): "Fejlesztés" < "Megbeszélés…".
    assert.deepEqual(r.plan.cells, [
      { date: '2026-09-28', target: { issueId: 9888, activity: 'Fejlesztés' }, hours: 7.25 },
      { date: '2026-09-28', target: { issueId: 13, activity: 'Megbeszélés, egyeztetés' }, hours: 0.75 },
    ]);
    assert.deepEqual(r.plan.notes, []);
  });

  it('ignores days after today and notes today', () => {
    const r = plan([day('2026-09-28', [['NLP', 'Development', 8]]), day('2026-09-29', [['NLP', 'Development', 3]], 'today')], '2026-09-29');
    assert.ok(r.ok);
    assert.equal(r.plan.cells.length, 2);
    assert.deepEqual(r.plan.notes, ['2026-09-29 is today: its hours may still change']);
  });

  it('blocks on unmapped entries, partial or missing days and targets gone from the site', () => {
    const r = plan(
      [day('2026-09-28', [['Other', 'Development', 8]]), day('2026-09-29', [['NLP', 'Development', 8]], 'partial', ['claude: failed'])],
      '2026-09-30',
    );
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.reasons, [
      '2026-09-28: no redmine mapping for Other / Development',
      '2026-09-29: day is partial (claude: failed); fix or recompute it first',
      '2026-09-30: not computed yet',
    ]);
    const gone = plan([day('2026-09-28', [['NLP', 'Development', 8]])], '2026-09-28', RULES, (t) => t.issueId !== 9888);
    assert.deepEqual(!gone.ok && gone.reasons, ['2026-09-28: NLP / Development maps to #9888 · Fejlesztés, which is no longer on redmine']);
  });

  it('blocks on invalid hours and on more than 24 h a day', () => {
    const r = plan([
      day('2026-09-28', [['NLP', 'Development', Number.NaN], ['NLP', 'Testing', -1], ['NLP', 'Team Meeting', Number.POSITIVE_INFINITY]]),
      day('2026-09-29', [['NLP', 'Development', 20], ['NLP', 'Team Meeting', 4.5], ['NLP', 'Testing', 0]]),
    ], '2026-09-29');
    assert.deepEqual(!r.ok && r.reasons, [
      '2026-09-28: NLP / Development has invalid hours (NaN)',
      '2026-09-28: NLP / Testing has invalid hours (-1)',
      '2026-09-28: NLP / Team Meeting has invalid hours (Infinity)',
      '2026-09-29: 24.5 h booked, more than a day',
    ]);
    assert.ok(plan([day('2026-09-28', [['NLP', 'Development', 20], ['NLP', 'Team Meeting', 4]])], '2026-09-28').ok);
  });

  it('blocks on invalid rules before planning', () => {
    const r = plan([day('2026-09-28', [['NLP', 'Development', 8]])], '2026-09-28', [{ project: 'NLP', category: '*', target: { issueId: 0, activity: '' } }]);
    assert.deepEqual(!r.ok && r.reasons, ['submit.redmine rule NLP / * needs a positive issueId and an activity']);
    const bad = buildPlan({ system: 'redmine', week: WEEK, reports: [], today: '2026-09-28', rules: null as never });
    assert.deepEqual(!bad.ok && bad.reasons, ['submit.redmine.rules must be a list']);
  });

  it('blocks two activities on one Redmine issue on the same day', () => {
    const rules: SubmitRule<RedmineTarget>[] = [
      { project: 'NLP', category: '*', target: { issueId: 9888, activity: 'Fejlesztés' } },
      { project: 'NLP', category: 'Testing', target: { issueId: 9888, activity: 'Tesztelés' } },
    ];
    const r = plan([day('2026-09-28', [['NLP', 'Testing', 1], ['NLP', 'Development', 5]]), day('2026-09-29', [['NLP', 'Testing', 2]])], '2026-09-29', rules);
    assert.deepEqual(!r.ok && r.reasons, ['2026-09-28: #9888 would get two activities (Fejlesztés, Tesztelés); Worktime has one row per issue']);
    assert.ok(plan([day('2026-09-28', [['NLP', 'Development', 5]]), day('2026-09-29', [['NLP', 'Testing', 2]])], '2026-09-29', rules).ok);
    const ns = buildPlan({
      system: 'netsuite', week: WEEK, today: '2026-09-28',
      reports: [day('2026-09-28', [['NLP', 'Testing', 1], ['NLP', 'Development', 5]])],
      rules: [{ project: 'NLP', category: '*', target: { project: 'Acme', task: 'Dev' } }, { project: 'NLP', category: 'Testing', target: { project: 'Acme', task: 'Test' } }],
    });
    assert.ok(ns.ok);
  });

  it('rejects a week that does not start on Monday', () => {
    assert.throws(() => buildPlan({ system: 'redmine', week: '2026-09-29', reports: [], today: '2026-10-04', rules: RULES }), /Monday/);
  });

  it('keys cells independently of property order', () => {
    assert.equal(cellKey({ date: 'd', target: { a: 1, b: 2 } }), cellKey({ date: 'd', target: { b: 2, a: 1 } }));
    assert.equal(describeTarget('netsuite', { project: 'Acme : NLP', task: 'Testing' }), 'Acme : NLP · Testing');
  });
});

describe('submit diff', () => {
  const dev = { issueId: 9888, activity: 'Fejlesztés' };
  const meet = { issueId: 13, activity: 'Megbeszélés, egyeztetés' };
  const p: Plan<RedmineTarget> = {
    system: 'redmine', week: WEEK, notes: [],
    cells: [{ date: '2026-09-28', target: dev, hours: 7.3 }, { date: '2026-09-29', target: meet, hours: 1 }],
  };

  it('writes into an empty week', () => {
    assert.deepEqual(diff(p, { week: WEEK, cells: [] }), { kind: 'write', cells: p.cells, unchanged: 0 });
  });

  it('is a no-op when everything is already there (rounding-safe), and writes only what is missing', () => {
    assert.deepEqual(diff(p, { week: WEEK, cells: [{ date: '2026-09-28', target: { activity: 'Fejlesztés', issueId: 9888 }, hours: 7.1 + 0.2 }, p.cells[1]] }), { kind: 'noop' });
    assert.deepEqual(diff(p, { week: WEEK, cells: [p.cells[1]] }), { kind: 'write', cells: [p.cells[0]], unchanged: 1 });
  });

  it('refuses when a planned cell holds another value or the site has hours we do not book', () => {
    const r = diff(p, {
      week: WEEK,
      cells: [{ date: '2026-09-28', target: dev, hours: 2 }, { date: '2026-09-30', target: meet, hours: 0.5 }],
    });
    assert.deepEqual(r, {
      kind: 'conflict',
      reasons: [
        '2026-09-28 #9888 · Fejlesztés: 2.00 h already entered, plan says 7.30 h',
        '2026-09-30 #13 · Megbeszélés, egyeztetés: 0.50 h entered that the timesheet does not book',
      ],
    });
  });

  it('refuses a snapshot of another week or with duplicate cells', () => {
    assert.equal(diff(p, { week: '2026-10-05', cells: [] }).kind, 'conflict');
    assert.equal(diff(p, { week: WEEK, cells: [p.cells[1], p.cells[1]] }).kind, 'conflict');
  });

  it('refuses a plan with the same cell twice or invalid hours', () => {
    const twice = { ...p, cells: [p.cells[0], { ...p.cells[0], target: { activity: 'Fejlesztés', issueId: 9888 } }] };
    assert.deepEqual(diff(twice, { week: WEEK, cells: [] }), { kind: 'conflict', reasons: ['2026-09-28 #9888 · Fejlesztés is planned twice'] });
    for (const hours of [Number.NaN, -1, 0])
      assert.deepEqual(diff({ ...p, cells: [{ ...p.cells[0], hours }] }, { week: WEEK, cells: [] }), { kind: 'conflict', reasons: [`2026-09-28 #9888 · Fejlesztés: invalid planned hours (${hours})`] });
  });

  it('fingerprints plan + snapshot independently of order', () => {
    const a = fingerprint(p, { week: WEEK, cells: [p.cells[1]] });
    assert.equal(a, fingerprint({ ...p, cells: [...p.cells].reverse() }, { week: WEEK, cells: [p.cells[1]] }));
    assert.notEqual(a, fingerprint(p, { week: WEEK, cells: [] }));
  });
});

describe('submit store', () => {
  it('keeps the latest catalog per system and runs newest first', () => {
    const s = new Store(':memory:');
    assert.equal(s.submitCatalog('redmine'), null);
    s.saveSubmitCatalog('redmine', { user: 'Nuszpl Botond', issues: [] });
    s.saveSubmitCatalog('redmine', { user: 'Nuszpl Botond', issues: [{ id: 13 }] });
    assert.deepEqual(s.submitCatalog('redmine')?.data, { user: 'Nuszpl Botond', issues: [{ id: 13 }] });

    const base = { system: 'redmine' as const, week: WEEK, fillOnly: true, screenshots: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' };
    s.saveSubmitRun({ ...base, id: 'a', status: 'conflict', error: 'x' });
    s.saveSubmitRun({ ...base, id: 'b', status: 'filled', plan: { cells: [] }, createdAt: '2026-10-01T11:00:00Z' });
    s.saveSubmitRun({ ...base, id: 'a', status: 'aborted', error: 'y' });
    const runs = s.submitRuns('redmine', WEEK);
    assert.deepEqual(runs.map((r) => [r.id, r.status]), [['b', 'filled'], ['a', 'aborted']]);
    assert.deepEqual(runs[0].plan, { cells: [] });
    assert.equal(runs[1].error, 'y');
    assert.deepEqual(s.submitRuns('netsuite'), []);
  });
});

describe('submit runs left running', () => {
  const noBrowser = () => new SubmitSession(async () => {
    throw new Error('test must not open a browser');
  });

  it('marks runs of a process that is gone as failed when a runner starts', () => {
    const s = new Store(':memory:');
    const base = { system: 'redmine' as const, week: WEEK, fillOnly: true, screenshots: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' };
    s.saveSubmitRun({ ...base, id: 'old', status: 'running' });
    s.saveSubmitRun({ ...base, id: 'dead', status: 'running', pid: 99_999_999 });
    s.saveSubmitRun({ ...base, id: 'live', status: 'running', pid: process.pid });
    s.saveSubmitRun({ ...base, id: 'done', status: 'saved' });
    new SubmitRunner({ store: s, config: () => testConfig(), today: () => '2026-10-01', reports: async () => ({ reports: [] }), session: noBrowser() });
    const runs = new Map(s.submitRuns().map((r) => [r.id, r]));
    for (const id of ['old', 'dead']) {
      assert.equal(runs.get(id)!.status, 'failed', id);
      assert.equal(runs.get(id)!.error, 'interrupted (timesheet stopped during the run) — check the site by hand');
    }
    assert.equal(runs.get('live')!.status, 'running', 'a run of a live process is left alone');
    assert.equal(runs.get('done')!.status, 'saved');
  });
});

describe('submit week interrupts', () => {
  it('the first Ctrl+C cancels the run; later ones only explain that it waits for the run to settle', () => {
    let cancels = 0;
    const lines: string[] = [];
    const exit = process.exit;
    process.exit = (() => {
      throw new Error('must not exit');
    }) as never;
    try {
      const onInterrupt = interruptHandler({ cancel: () => void cancels++ }, (m) => lines.push(m));
      onInterrupt();
      onInterrupt();
      onInterrupt();
    } finally {
      process.exit = exit;
    }
    assert.equal(cancels, 1);
    assert.match(lines[0], /Cancelling/);
    assert.match(lines[1], /waiting for the run to settle/);
    assert.equal(lines.length, 3);
  });
});

describe('submit browser lock', () => {
  it('allows one holder, replaces a stale lock and releases only its own', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lock-')), 'browser.lock');
    const release = acquireLock(path);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    assert.throws(() => acquireLock(path), /already in use by process/);
    release();
    assert.equal(existsSync(path), false);

    writeFileSync(path, '999999999');
    const again = acquireLock(path);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    writeFileSync(path, '123'); // someone else's now
    again();
    assert.equal(readFileSync(path, 'utf8'), '123');
  });

  it('treats an unreadable lock as held unless it is old, and leaves no temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    const path = join(dir, 'browser.lock');
    writeFileSync(path, '');
    assert.throws(() => acquireLock(path), /in use/);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(path, old, old);
    const release = acquireLock(path);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    assert.deepEqual(readdirSync(dir), ['browser.lock']);
    release();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('explains a profile held by another Chrome', () => {
    assert.equal(launchError(new Error('Failed to create a ProcessSingleton for your profile directory')).message, 'the submission browser profile is open in another Chrome window; close it and retry');
    assert.match(launchError(new Error("Executable doesn't exist at /x")).message, /Google Chrome is required/);
    assert.equal(launchError(new Error('boom')).message, 'boom');
  });
});

describe('submit inspect url', () => {
  it('drops the fragment and redacts secret-looking query values', () => {
    const u = safeUrl('https://r.example/work_time/index?key=K1&day=2&api_ticket=K2&code=K3#access_token=K4');
    assert.doesNotMatch(u, /K1|K2|K3|K4|#/);
    assert.match(u, /day=2/);
    assert.equal(safeUrl('https://me:K5@r.example/'), 'https://r.example/');
    assert.equal(safeUrl('not a url'), '');
  });
});

describe('submit cli', () => {
  const run = (config: object, ...argv: string[]) => {
    const home = mkdtempSync(join(tmpdir(), 'timesheet-cli-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    return spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', 'bin/timesheet.js', ...argv], {
      env: { ...process.env, TIMESHEET_HOME: home }, input: '', encoding: 'utf8', timeout: 20_000,
    });
  };

  it('refuses to work with an invalid config', () => {
    const r = run({ submit: { redmine: { rules: [null] } } }, 'submit', 'plan', 'last');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /submit\.redmine rule 1 needs a project and a category/);
  });

  it('refuses to enter a week without a terminal or as JSON', () => {
    const r = run({ submit: { redmine: { url: 'https://redmine.invalid/work_time/index' } } }, 'submit', 'week', 'last', '--system', 'redmine');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /interactive: run it in a terminal/);
    const j = run({}, 'submit', 'week', 'last', '--json');
    assert.equal(j.status, 1);
    assert.match(j.stderr, /cannot be scripted/);
    const bad = run({}, 'submit', 'week', 'last', '--system', 'jira');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /expected redmine or netsuite/);
  });

  it('refuses login without a terminal instead of waiting for input', () => {
    const r = run({ submit: { redmine: { url: 'https://redmine.invalid' } } }, 'submit', 'login', 'redmine');
    assert.equal(r.signal, null);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /terminal/);
  });
});

describe('submit browser', { skip: !chromeAvailable() && 'Google Chrome not installed' }, () => {
  it('opens a headless Chrome with a private profile and releases the lock on close', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    const lockPath = join(profileDir, '..', `lock-${process.pid}`);
    const session = await openBrowser({ headless: true, profileDir, lockPath });
    await session.page.setContent('<h1>ok</h1>');
    assert.equal(await session.page.textContent('h1'), 'ok');
    await session.close();
    assert.equal(existsSync(lockPath), false);
  });

  it('captures structure and visible values without scripts, tokens or e-mails', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    const session = await openBrowser({ headless: true, profileDir, lockPath: join(profileDir, '..', `lock2-${process.pid}`) });
    try {
      await session.page.setContent(`
        <script>window.secret = 1</script><style>h1{}</style>
        <form action="/work_time/update" method="post">
          <input type="hidden" name="authenticity_token" value="SECRET-CSRF">
          <h2>Monthly Report (Test User) <span>someone@example.com</span></h2>
          <a href="/issues/9888">Feature #9888</a>
          <a href="/x.atom?key=SECRETKEY&amp;format=1">feed</a>
          <div data-csrf-token="SECRETDATA" data-row="5"></div>
          <a href="/cb#access_token=SECRETHASH">cb</a>
          <a href="/issues#top">top</a>
          <input type="text" name="new_time_entry[9888][hours]" id="h9888" data-x="1" style="color:red">
          <div style="background:#faa; --who: someone@example.com">Error</div>
          <select name="act"><option value="1">Fejlesztés</option><option value="2">Megbeszélés</option></select>
          <!-- a comment -->
        </form>`);
      await session.page.fill('#h9888', '7.5');
      await session.page.selectOption('select', '2');
      const dir = mkdtempSync(join(tmpdir(), 'inspect-'));
      const files = await capture(session.page, 'redmine', 'Worktime Day!', dir);
      const html = readFileSync(files.html, 'utf8');
      assert.match(files.html, /redmine\/.+-worktime-day\.html$/);
      assert.ok(existsSync(files.png));
      assert.doesNotMatch(html, /window\.secret|SECRET-CSRF|SECRETKEY|SECRETDATA|SECRETHASH|someone@example\.com|<style|a comment/);
      // Inline styles are kept (Worktime marks Sundays and error banners with them), e-mails still redacted.
      assert.match(html, /style="color:red"/);
      assert.match(html, /<div style="background:#faa;[^"]*&lt;email&gt;|<div style="background:#faa;[^"]*<email>/);
      assert.match(html, /data-row="5"/);
      assert.match(html, /href="\/x\.atom\?key=…&amp;format=1"/);
      assert.match(html, /href="\/cb#…"/);
      assert.match(html, /href="\/issues#top"/);
      assert.match(html, /name="authenticity_token"/);
      assert.match(html, /href="\/issues\/9888"/);
      assert.match(html, /id="h9888"[^>]*value="7\.5"|value="7\.5"[^>]*id="h9888"/);
      assert.match(html, /data-x="1"/);
      assert.match(html, /<option value="2" selected="">Megbeszélés<\/option>/);
      assert.match(html, /&lt;email&gt;|<email>/);
    } finally {
      await session.close();
    }
  });
});
