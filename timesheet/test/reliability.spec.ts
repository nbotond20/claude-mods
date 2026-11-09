import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { at, testConfig } from './helpers.ts';
import type { Config } from '../src/core/config.ts';
import { computeKey } from '../src/core/config.ts';
import { Engine } from '../src/core/engine.ts';
import { applySettingsChange, blockEditProblem, hoursEditProblem } from '../src/core/edits.ts';
import { Store } from '../src/core/store.ts';
import { sanitize } from '../src/core/classify.ts';
import { buildBlocks } from '../src/core/timeline.ts';
import { collectGit } from '../src/core/collectors/git.ts';
import { buildPlan } from '../src/core/submit/plan.ts';
import { createApp } from '../src/web/server.ts';
import type { Block, RawEvent } from '../src/core/types.ts';

const D = '2026-09-15';
const TODAY = '2026-09-30';

/** An engine whose sources read from mutable lists, so a test can change what a recompute sees. */
function setup(opts: { config?: Partial<Config>; store?: Store; now?: number } = {}) {
  const src = {
    claude: [{ source: 'claude', start: at(D, '09:00'), end: at(D, '13:00'), path: '/work/repo', texts: ['build it'] }] as RawEvent[],
    calendar: [] as RawEvent[],
  };
  let collects = 0;
  const store = opts.store ?? new Store(':memory:');
  const config = testConfig({ calendar: { ...testConfig().calendar, enabled: true }, ...opts.config });
  const make = (c: Config = config) =>
    new Engine({
      config: c,
      store,
      classifier: async ({ blocks }) => ({ allocations: Object.fromEntries(blocks.map((b) => [b.id, [{ category: b.kind === 'meeting' ? 'Meetings' : 'QA', fraction: 1 }]])), summary: '- done' }),
      today: () => TODAY,
      now: () => opts.now ?? at(TODAY, '12:00'),
      sources: {
        claude: async () => (collects++, src.claude),
        opencode: async () => [],
        git: () => [],
        calendar: async () => src.calendar,
      },
    });
  return { engine: make(), make, store, src, config, collects: () => collects };
}

describe('locked days', () => {
  it('are never recomputed, also with refresh or changed settings', async () => {
    const { engine, make, store, src, config, collects } = setup();
    const [first] = await engine.days(D, D);
    assert.equal(first.total, 8);
    store.setMark(D, 'locked', true, 'test');
    src.claude = [];
    await engine.days(D, D, { refresh: true });
    const [kept] = await make({ ...config, gapMinutes: config.gapMinutes + 7 }).days(D, D);
    assert.equal(collects(), 1);
    assert.equal(kept.locked, true);
    assert.equal(kept.total, 8);
    assert.deepEqual(engine.pending(D, D, true), []);
  });

  it('refuse hand edits until unlocked', () => {
    const store = new Store(':memory:');
    const config = testConfig();
    store.setMark(D, 'locked', true);
    assert.match(hoursEditProblem(config, store, D, 'Default', 'QA', 2)!, /locked/);
    store.setMark(D, 'locked', false);
    assert.equal(hoursEditProblem(config, store, D, 'Default', 'QA', 2), null);
  });
});

describe('hand edits', () => {
  it('validate hours, projects, categories and blocks', async () => {
    const { engine, store, config } = setup();
    await engine.days(D, D);
    assert.match(hoursEditProblem(config, store, D, 'Default', 'QA', 1.3)!, /multiple of the rounding step/);
    assert.match(hoursEditProblem(config, store, D, 'Default', 'QA', NaN)!, /number from 0 to 24/);
    assert.match(hoursEditProblem(config, store, D, 'Default', 'QA', -1)!, /number from 0 to 24/);
    assert.match(hoursEditProblem(config, store, D, 'Nope', 'QA', 1)!, /unknown project/);
    assert.match(hoursEditProblem(config, store, D, 'Default', 'Nope', 1)!, /unknown category/);
    assert.equal(hoursEditProblem(config, store, D, 'Default', 'Nope', null), null, 'clearing an old category is allowed');
    assert.match(hoursEditProblem(config, store, '2026-13-45', 'Default', 'QA', 1)!, /not a date/);
    assert.match(blockEditProblem(config, store, D, 99, 'QA')!, /no block 99/);
    assert.match(blockEditProblem(config, store, D, 1.5, 'QA')!, /whole number/);
    assert.match(blockEditProblem(config, store, '2026-09-16', 1, 'QA')!, /not computed/);
    assert.equal(blockEditProblem(config, store, D, 1, 'Feature Build'), null);
  });

  it('are logged and undone newest first', async () => {
    const { engine, store } = setup();
    await engine.days(D, D);
    store.editHours(D, 'Default', 'QA', 6);
    store.editHours(D, 'Default', 'QA', 5);
    store.editBlock(D, 1, 'Feature Build');
    assert.deepEqual(store.edits(D).map((e) => [e.kind, e.before, e.after]), [['block', null, 'Feature Build'], ['hours', 6, 5], ['hours', null, 6]]);
    assert.equal(store.undo(D)?.kind, 'block');
    assert.equal(store.blockOverrides(D).size, 0);
    store.undo(D);
    assert.equal(store.overrides(D)[0].hours, 6);
    store.undo(D);
    assert.deepEqual(store.overrides(D), []);
    assert.equal(store.undo(D), null);
    assert.equal(store.edits(D).every((e) => e.undone), true);
  });
});

describe('block categories across recomputes', () => {
  it('follow their block when it moves a little, and are dropped with a warning when it is gone', async () => {
    const { engine, store, src } = setup();
    await engine.days(D, D);
    store.setBlockOverride(D, 1, 'Feature Build');
    // The session now starts 30 minutes later: same block, shifted.
    src.claude = [{ source: 'claude', start: at(D, '09:30'), end: at(D, '13:00'), path: '/work/repo', texts: ['build it'] }];
    let [day] = await engine.days(D, D, { refresh: true });
    assert.deepEqual(day.entries.map((e) => e.category), ['Feature Build']);
    // The work moved to the afternoon: nothing to follow.
    src.claude = [{ source: 'claude', start: at(D, '15:00'), end: at(D, '17:00'), path: '/work/repo', texts: ['other'] }];
    [day] = await engine.days(D, D, { refresh: true });
    assert.deepEqual(day.entries.map((e) => e.category), ['QA']);
    assert.ok(day.warnings.some((w) => /Your category "Feature Build" for 09:30–13:00 was dropped/.test(w)), day.warnings.join('\n'));
    assert.equal(store.blockOverrides(D).size, 0);
  });
});

describe('out of office and holidays', () => {
  it('lowers the target by part-day absences', async () => {
    const { engine, src } = setup();
    src.calendar = [{ source: 'calendar', start: at(D, '14:00'), end: at(D, '17:00'), texts: ['Dentist'], outOfOffice: true }];
    const [day] = await engine.days(D, D);
    assert.equal(day.outOfOffice, false);
    assert.equal(day.target, 5);
    assert.equal(day.total, 5);
    assert.ok(day.warnings.some((w) => /Out of office for 3h/.test(w)));
  });

  it('treats a full-day absence as a day off', async () => {
    const { engine, src } = setup();
    src.calendar = [{ source: 'calendar', start: at(D, '00:00'), end: at('2026-09-16', '00:00'), texts: ['Vacation'], outOfOffice: true }];
    const [day] = await engine.days(D, D);
    assert.equal(day.outOfOffice, true);
    assert.equal(day.target, null);
  });

  it('books nothing on a holiday unless hours are set by hand', async () => {
    const { engine, store } = setup({ config: { holidays: [D] } });
    let [day] = await engine.days(D, D);
    assert.equal(day.holiday, true);
    assert.equal(day.target, null);
    assert.equal(day.total, 0);
    assert.equal(day.realTotal, 4);
    assert.ok(day.warnings.some((w) => /Day off: 4h of recorded work is not booked/.test(w)), day.warnings.join('\n'));
    store.editHours(D, 'Default', 'QA', 2);
    [day] = await engine.days(D, D);
    assert.equal(day.total, 2);
    assert.ok(!day.warnings.some((w) => /Day off/.test(w)));
  });
});

describe("meetings that don't count towards the target", () => {
  const standup: RawEvent = { source: 'calendar', start: at(D, '14:00'), end: at(D, '15:00'), texts: ['Company all-hands'], project: 'Default' };

  it('books a meeting set by hand on top of the target, and undo restores it', async () => {
    const { engine, store, src } = setup();
    src.calendar = [standup];
    let [day] = await engine.days(D, D);
    assert.equal(day.total, 8);
    const meeting = day.blocks.find((b) => b.kind === 'meeting')!;
    store.editBlockCount(D, meeting.id, false);
    [day] = await engine.days(D, D);
    assert.equal(day.blocks.find((b) => b.id === meeting.id)!.uncounted, true);
    assert.deepEqual(day.entries.map((e) => [e.category, e.hours, e.uncounted]), [['QA', 8, undefined], ['Meetings', 1, 1]]);
    assert.equal(day.total, 9);
    assert.equal(day.flags, undefined);
    assert.equal(store.undo(D)?.kind, 'count');
    [day] = await engine.days(D, D);
    assert.equal(day.total, 8);
  });

  it('applies title rules from config, which a hand setting overrides', async () => {
    const { engine, store, src } = setup({ config: { calendar: { ...testConfig().calendar, enabled: true, uncounted: ['ALL-HANDS'] } } });
    src.calendar = [standup];
    let [day] = await engine.days(D, D);
    assert.equal(day.total, 9);
    const meeting = day.blocks.find((b) => b.kind === 'meeting')!;
    store.editBlockCount(D, meeting.id, true);
    [day] = await engine.days(D, D);
    assert.equal(day.total, 8);
  });

  it('merges into a counted row of the same category', async () => {
    const { engine, store, src } = setup();
    src.calendar = [standup, { ...standup, start: at(D, '16:30'), end: at(D, '17:30'), texts: ['Planning'] }];
    let [day] = await engine.days(D, D);
    const allHands = day.blocks.find((b) => b.kind === 'meeting' && b.texts[0] === 'Company all-hands')!;
    store.editBlockCount(D, allHands.id, false);
    [day] = await engine.days(D, D);
    const meetings = day.entries.find((e) => e.category === 'Meetings')!;
    assert.equal(meetings.uncounted, 1);
    assert.equal(day.total, 9);
  });
});

describe('low activity', () => {
  it('flags thin days and blocks submission until confirmed or edited', async () => {
    const { engine, store, src } = setup({ config: { lowActivityRatio: 0.5 } });
    src.claude = [{ source: 'claude', start: at(D, '09:00'), end: at(D, '10:00'), path: '/work/repo', texts: ['tiny'] }];
    let [day] = await engine.days(D, D);
    assert.equal(day.lowActivity, true);
    assert.match(day.flags![0], /Only 1h of recorded work, booked as 8h/);
    const week = '2026-09-14';
    const rules = [{ project: 'Default', category: '*', target: { issueId: 1, activity: 'Dev' } }];
    let plan = buildPlan({ system: 'redmine', week, reports: [day], today: TODAY, rules });
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.reasons.some((r) => r.startsWith(`${D}: Only 1h`)));

    store.editConfirm(D, true);
    [day] = await engine.days(D, D);
    assert.equal(day.confirmed, true);
    assert.equal(day.flags, undefined);
    plan = buildPlan({ system: 'redmine', week, reports: [day], today: TODAY, rules });
    assert.ok(!plan.ok ? !plan.reasons.some((r) => r.startsWith(D)) : true);

    store.undo(D);
    store.editHours(D, 'Default', 'QA', 1);
    [day] = await engine.days(D, D);
    assert.equal(day.lowActivity, undefined, 'hours set by hand settle it');
  });
});

describe('transcript archive', () => {
  it('rebuilds a day from archived sessions after the transcript is deleted', async () => {
    const store = new Store(':memory:');
    const session = { id: 's1', source: 'claude' as const, path: '/work/repo' };
    const { engine, src } = setup({ store });
    src.claude = [{ source: 'claude', start: at(D, '09:00'), end: at(D, '13:00'), path: '/work/repo', texts: ['build it'], session }];
    const [first] = await engine.days(D, D);
    assert.equal(first.realTotal, 4);
    assert.equal(store.evidence(D).length, 1);
    // Claude Code cleaned up: only a history.jsonl guess of 30 minutes is left.
    src.claude = [{ source: 'claude', start: at(D, '09:00'), end: at(D, '09:30'), path: '/work/repo', texts: ['build it'], session, fromHistory: true }];
    const [again] = await engine.days(D, D, { refresh: true });
    assert.equal(again.realTotal, 4);
  });
});

describe('settling', () => {
  it('recomputes a final day once after it settled, then keeps it', async () => {
    const store = new Store(':memory:');
    const early = setup({ store, now: at('2026-09-16', '08:00') });
    await early.engine.days(D, D);
    const day = store.getDay(D)!;
    assert.equal(early.engine.isStale(day, at('2026-09-16', '09:00')), false);
    assert.equal(early.engine.isStale({ ...day, computedAt: new Date(at('2026-09-16', '08:00')).toISOString() }, at('2026-09-17', '01:00')), true);
    assert.equal(early.engine.isStale({ ...day, computedAt: new Date(at('2026-09-17', '02:00')).toISOString() }, at('2026-09-20', '01:00')), false);
  });
});

describe('settings changes from a date', () => {
  it('keep earlier days as they were', async () => {
    const { engine, make, store, config } = setup();
    await engine.days('2026-09-14', '2026-09-16');
    const next = { ...config, gapMinutes: config.gapMinutes + 7 };
    const impact = applySettingsChange(store, computeKey(config), computeKey(next), '2026-09-16');
    assert.deepEqual(impact, { kept: 2, recompute: 1, locked: 0 });
    const later = make(next);
    assert.deepEqual(later.pending('2026-09-14', '2026-09-16'), ['2026-09-16']);
  });
});

describe('classifier gaps', () => {
  it('reports blocks the classifier left out', () => {
    const block = (id: number): Block => ({ id, start: 0, end: 3_600_000, kind: 'work', project: 'Default', sources: ['claude'], branches: [], paths: [], texts: ['x'], hint: '', allocations: [] });
    const out = sanitize({ allocations: { 1: [{ category: 'QA', fraction: 1 }] }, summary: '' }, [block(1), block(2)], testConfig().categories);
    assert.deepEqual(out.missing, [2]);
  });
});

describe('overlapping projects', () => {
  it('splits shared time by what was recorded in each instead of giving it all to one', () => {
    const config = testConfig({ scope: { work: [{ path: '/a/**', project: 'A' }, { path: '/b/**', project: 'B' }], personal: [] }, projects: ['A', 'B'] });
    const ev = (path: string, project: string, s: string, e: string, m: [string, string][]) => ({
      source: 'claude' as const, start: at(D, s), end: at(D, e), path, texts: ['x'], project, measured: m.map(([a, b]): [number, number] => [at(D, a), at(D, b)]),
    });
    const blocks = buildBlocks(
      [ev('/a/x', 'A', '09:00', '11:00', [['09:00', '11:00']]), ev('/b/y', 'B', '10:00', '12:00', [['10:30', '12:00']])],
      config,
      at(D, '00:00'),
      at('2026-09-16', '00:00'),
    );
    const hours = (p: string) => blocks.filter((b) => b.project === p).reduce((s, b) => s + (b.end - b.start), 0) / 3_600_000;
    // 3h of wall time in total, no double counting, and B keeps its share of the shared hour.
    assert.equal(hours('A') + hours('B'), 3);
    assert.ok(hours('B') > 1, `B got ${hours('B')}h`);
  });
});

describe('web api for edits', () => {
  it('validates edits and refuses locked days', async () => {
    const { engine, store } = setup();
    await engine.days(D, D);
    const server = createServer(createApp({ engine, save: () => {} }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'x-timesheet': '1' }, body: JSON.stringify(body) });
    try {
      assert.equal((await post('/api/override', { date: D, project: 'Default', category: 'QA', hours: 'abc' })).status, 400);
      assert.equal((await post('/api/block', { date: D, blockId: 42, category: 'QA' })).status, 400);
      assert.equal((await post('/api/override', { date: D, project: 'Default', category: 'QA', hours: 6 })).status, 200);
      assert.equal((await post('/api/lock', { date: D })).status, 200);
      const locked = await post('/api/override', { date: D, project: 'Default', category: 'QA', hours: 5 });
      assert.equal(locked.status, 409);
      assert.equal((await post('/api/undo', { date: D })).status, 409);
      await post('/api/unlock', { date: D });
      assert.equal((await post('/api/undo', { date: D })).status, 200);
      assert.deepEqual(store.overrides(D), []);
      const history = await (await fetch(`${base}/api/history?date=${D}`)).json();
      assert.equal(history.edits.length, 1);
    } finally {
      server.close();
    }
  });
});

describe('git', () => {
  it('counts a cherry-picked or rebased commit once', () => {
    const repo = mkdtempSync(join(tmpdir(), 'timesheet-git-'));
    const env = { ...process.env, GIT_AUTHOR_DATE: '2026-09-15T10:00:00', GIT_COMMITTER_DATE: '2026-09-15T10:00:00', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=me@x.test', '-c', 'user.name=Me', ...a], { env, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a'), '1');
    git('add', 'a');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'b'), '1');
    git('add', 'b');
    git('commit', '-q', '-m', 'feature');
    git('checkout', '-q', 'main');
    git('cherry-pick', 'side');
    const events = collectGit(testConfig({ authorEmails: ['me@x.test'] }), [repo], at(D, '00:00'), at('2026-09-16', '00:00'));
    assert.deepEqual(events.map((e) => e.texts[0]).sort(), ['base', 'feature']);
  });
});

describe('calendar sign-in failures', () => {
  const make = (store: Store, calendar: () => Promise<RawEvent[]>, connected: { value: boolean }) =>
    new Engine({
      config: testConfig({ calendar: { ...testConfig().calendar, enabled: true } }),
      store,
      classifier: async ({ blocks }) => ({ allocations: Object.fromEntries(blocks.map((b) => [b.id, [{ category: 'QA', fraction: 1 }]])), summary: '- done' }),
      today: () => TODAY,
      now: () => at(TODAY, '12:00'),
      calendarConnected: () => connected.value,
      sources: {
        claude: async () => [{ source: 'claude', start: at(D, '09:00'), end: at(D, '13:00'), path: '/work/repo', texts: ['build it'] }] as RawEvent[],
        opencode: async () => [],
        git: () => [],
        github: null,
        calendar,
      },
    });

  it('waits for a reconnect instead of retrying every few minutes', async () => {
    const store = new Store(':memory:');
    const connected = { value: false };
    const expired = make(store, async () => { throw new Error('Google access expired or was revoked; reconnect'); }, connected);
    await expired.days(D, D);
    const day = store.getDay(D)!;
    assert.equal(day.status, 'partial');
    assert.equal(day.retry, false);
    const later = Date.parse(day.computedAt) + 60 * 60_000;
    assert.equal(expired.isStale(day, later), false, 'not recomputed while signed out');
    connected.value = true;
    assert.equal(expired.isStale(day, later), true, 'recomputed once signed in again');
  });

  it('still retries other calendar failures', async () => {
    const store = new Store(':memory:');
    const flaky = make(store, async () => { throw new Error('Google Calendar API 503: backend error'); }, { value: true });
    await flaky.days(D, D);
    const day = store.getDay(D)!;
    assert.equal(day.retry, true);
    assert.equal(flaky.isStale(day, Date.parse(day.computedAt) + 60 * 60_000), true);
  });
});
