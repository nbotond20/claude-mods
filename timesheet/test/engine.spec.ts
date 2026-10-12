import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { at, testConfig } from './helpers.ts';
import { Engine } from '../src/core/engine.ts';
import { Store } from '../src/core/store.ts';
import { createApp } from '../src/web/server.ts';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RawEvent } from '../src/core/types.ts';
import type { Classifier } from '../src/core/classify.ts';
import { JobRunner } from '../src/core/jobs.ts';

const D = '2026-09-15';

function setup(opts: { classifier?: Classifier | null; claude?: RawEvent[]; calendar?: RawEvent[] } = {}) {
  let claudeCalls = 0;
  let classifyCalls = 0;
  const classifier: Classifier | null =
    opts.classifier === null
      ? null
      : opts.classifier ??
        (async ({ blocks }) => {
          classifyCalls++;
          return { allocations: Object.fromEntries(blocks.map((b) => [b.id, [{ category: b.kind === 'meeting' ? 'Team Meeting' : 'Testing', fraction: 1 }]])), summary: '- tested' };
        });
  const store = new Store(':memory:');
  const engine = new Engine({
    config: testConfig({ calendar: { ...testConfig().calendar, enabled: true } }),
    store,
    classifier,
    today: () => '2026-09-30',
    sources: {
      claude: async () => {
        claudeCalls++;
        return opts.claude ?? [
          { source: 'claude', start: at(D, '09:00'), end: at(D, '12:00'), path: '/work/repo', texts: ['write tests'] },
          { source: 'claude', start: at(D, '13:00'), end: at(D, '14:00'), path: '/home/side', texts: ['personal'] },
        ];
      },
      opencode: async () => [],
      git: () => [],
      calendar: async () => opts.calendar ?? [{ source: 'calendar', start: at(D, '14:00'), end: at(D, '15:00'), texts: ['Standup'], project: 'Default' }],
    },
  });
  return { engine, store, counts: () => ({ claudeCalls, classifyCalls }) };
}

describe('engine', () => {
  it('computes a day: personal work excluded, meeting included, normalized to target', async () => {
    const { engine } = setup();
    const [day] = await engine.days(D, D);
    assert.equal(day.status, 'final');
    assert.equal(day.realTotal, 4);
    assert.deepEqual(day.entries.map((e) => [e.category, e.hours]), [['Testing', 6], ['Team Meeting', 2]]);
    assert.equal(day.summary, '- tested');
  });

  it('counts today only up to now and real hours only from recorded minutes', async () => {
    const engine = new Engine({
      config: testConfig({ calendar: { ...testConfig().calendar, enabled: true } }),
      store: new Store(':memory:'),
      classifier: null,
      today: () => D,
      now: () => at(D, '14:30'),
      sources: {
        // 09:00–10:00 session recorded only 09:00–09:20; the rest is a quiet gap bridged into the block.
        claude: async () => [{ source: 'claude', start: at(D, '09:00'), end: at(D, '10:00'), measured: [[at(D, '09:00'), at(D, '09:20')]], path: '/work/repo', texts: ['go'] }],
        opencode: async () => [],
        git: () => [],
        calendar: async () => [
          { source: 'calendar', start: at(D, '14:00'), end: at(D, '16:00'), texts: ['Planning'], project: 'Default' },
          { source: 'calendar', start: at(D, '15:00'), end: at(D, '16:00'), texts: ['Later'], project: 'Default' },
        ],
      },
    });
    const [day] = await engine.days(D, D);
    assert.equal(day.status, 'today');
    assert.deepEqual(day.blocks.map((b) => [b.kind, b.start, b.end]), [['work', at(D, '09:00'), at(D, '10:00')], ['meeting', at(D, '14:00'), at(D, '14:30')]]);
    assert.equal(Number(day.realTotal.toFixed(4)), Number((20 / 60 + 0.5).toFixed(4)));
  });

  it('keeps personal and unassigned activity apart from work, never booked', async () => {
    const { engine } = setup({
      claude: [
        { source: 'claude', start: at(D, '09:00'), end: at(D, '12:00'), path: '/work/repo', texts: ['write tests'] },
        { source: 'claude', start: at(D, '13:00'), end: at(D, '14:00'), path: '/home/side', texts: ['personal'] },
        { source: 'claude', start: at(D, '16:00'), end: at(D, '17:00'), path: '/mystery', texts: ['what is this'] },
        { source: 'claude', start: at(D, '18:00'), end: at(D, '19:00'), path: '/tmp/scratch', texts: ['scratch'] },
      ],
    });
    const [day] = await engine.days(D, D);
    assert.deepEqual(day.other?.map((b) => [b.kind, b.paths]), [['personal', ['/home/side']], ['unassigned', ['/mystery']]]);
    assert.equal(day.realTotal, 4);
    const [cached] = await engine.days(D, D);
    assert.deepEqual(cached.other, JSON.parse(JSON.stringify(day.other)), 'survives the store');
  });

  it('caches final days and does not recompute them', async () => {
    const { engine, counts } = setup();
    await engine.days(D, D);
    await engine.days(D, D, { target: 6 });
    assert.deepEqual(counts(), { claudeCalls: 1, classifyCalls: 1 });
    const [day] = await engine.days(D, D, { target: 6 });
    assert.equal(day.total, 6);
    await engine.days(D, D, { refresh: true });
    assert.deepEqual(counts(), { claudeCalls: 2, classifyCalls: 2 });
  });

  it('reuses the classification when a recompute yields the same blocks', async () => {
    const { engine, store, counts } = setup();
    await engine.days(D, D);
    // Another setting in the fingerprint changes (so the day is recomputed) without moving any block.
    const other = new Engine({ config: { ...engine.config, historyTailMinutes: engine.config.historyTailMinutes + 1 }, store, classifier: async () => { throw new Error('should not be asked'); }, today: () => '2026-09-30', sources: (engine as any).sources });
    const [day] = await other.days(D, D);
    assert.equal(counts().claudeCalls, 2, 'recomputed');
    assert.equal(day.status, 'final');
    assert.equal(day.summary, '- tested');
    assert.deepEqual(day.entries.map((e) => e.category), ['Testing', 'Team Meeting']);
  });

  it('counts recorded minutes without lead-ins, padding or gap bridging', async () => {
    const { engine } = setup({
      claude: [
        // Prompt at 09:05 (5-minute lead-in assumed), last reply 10:00.
        { source: 'claude', start: at(D, '09:00'), end: at(D, '10:00'), measured: [[at(D, '09:05'), at(D, '10:00')]], path: '/work/repo', texts: ['a'] },
        // Bridged gap 10:00–10:20, then another session 10:20–10:30.
        { source: 'claude', start: at(D, '10:15'), end: at(D, '10:30'), measured: [[at(D, '10:20'), at(D, '10:30')]], path: '/work/repo', texts: ['b'] },
        // A commit: all lead-in, nothing recorded.
        { source: 'git', start: at(D, '10:45'), end: at(D, '11:00'), measured: [], path: '/work/repo', texts: ['fix'], commit: 'abc' },
      ],
    });
    const [day] = await engine.days(D, D);
    const work = day.blocks.find((b) => b.kind === 'work')!;
    assert.equal(work.end - work.start, 2 * 3_600_000, 'booked block spans 09:00–11:00');
    assert.equal(work.measured, 65);
    assert.equal(day.blocks.find((b) => b.kind === 'meeting')!.measured, 60);
    assert.equal(day.measuredTotal, 125);
    assert.deepEqual(day.entries.map((e) => [e.category, e.measured]), [['Testing', 65], ['Team Meeting', 60]]);
  });

  it('marks days with unclassified paths partial and warns', async () => {
    const { engine, counts } = setup({ claude: [{ source: 'claude', start: at(D, '09:00'), end: at(D, '10:00'), path: '/mystery', texts: [] }] });
    const [day] = await engine.days(D, D);
    assert.equal(day.status, 'partial');
    assert.match(day.warnings.join(), /unclassified path \/mystery/);
    await engine.days(D, D);
    assert.equal(counts().claudeCalls, 1, 'waits for a scope change instead of re-running');
  });

  it('falls back to hints and stays partial when classification fails', async () => {
    const { engine } = setup({ classifier: async () => { throw new Error('boom'); } });
    const [day] = await engine.days(D, D);
    assert.equal(day.status, 'partial');
    assert.deepEqual(day.entries.map((e) => e.category), ['Development', 'Team Meeting']);
    assert.match(day.warnings.join(), /boom/);
  });

  it('does not cache hint-only results as final when run without the LLM', async () => {
    const { engine } = setup({ classifier: null });
    const [day] = await engine.days(D, D);
    assert.equal(day.status, 'partial');
  });

  it('does not normalize out-of-office days', async () => {
    const { engine } = setup({
      calendar: [{ source: 'calendar', start: at(D, '00:00'), end: at('2026-09-16', '00:00'), texts: ['OOO'], outOfOffice: true }],
    });
    const [day] = await engine.days(D, D);
    assert.equal(day.target, null);
    assert.equal(day.total, 3);
  });

  it('applies overrides and block recategorization on report', async () => {
    const { engine, store } = setup();
    await engine.days(D, D);
    store.setBlockOverride(D, 1, 'Development');
    store.setOverride(D, 'Default', 'Team Meeting', 1);
    const [day] = await engine.days(D, D);
    assert.deepEqual(day.entries.map((e) => [e.category, e.hours]), [['Development', 6], ['Team Meeting', 1]]);
  });

  it('skips future days in a range', async () => {
    const { engine } = setup();
    const days = await engine.days('2026-09-29', '2026-10-05');
    assert.deepEqual(days.map((d) => d.date), ['2026-09-29', '2026-09-30']);
    assert.equal(days[1].status, 'today');
  });
});

describe('web api', () => {
  it('serves reports and accepts overrides', async () => {
    const { engine } = setup();
    const server = createServer(createApp({ engine, save: () => {} }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await fetch(base + '/');
      assert.match(await page.text(), /<title>Timesheet<\/title>/);
      const rep = await (await fetch(`${base}/api/report?view=day&at=${D}&wait=true`)).json();
      assert.match(rep.paste.daily, /Testing\t6/);
      const h = { 'x-timesheet': '1' };
      const blocked = await fetch(base + '/api/override', { method: 'POST', body: JSON.stringify({ date: D, project: 'Default', category: 'Testing', hours: 1 }) });
      assert.equal(blocked.status, 403, 'writes without the X-Timesheet header are rejected');
      await fetch(base + '/api/override', { method: 'POST', headers: h, body: JSON.stringify({ date: D, project: 'Default', category: 'Testing', hours: 5 }) });
      const again = await (await fetch(base + '/api/report', { method: 'POST', headers: h, body: JSON.stringify({ view: 'week', at: D }) })).json();
      assert.match(again.paste.grid, /Default\tTesting\t\t5\t/);
      const cfg = await (await fetch(base + '/api/config')).json();
      const bad = await fetch(base + '/api/config', { method: 'PUT', headers: h, body: JSON.stringify({ config: { ...cfg.config, target: -1 } }) });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).errors.join(), /target/);
      const ok = await fetch(base + '/api/config', { method: 'PUT', headers: h, body: JSON.stringify({ config: { ...cfg.config, target: 7 } }) });
      assert.equal(ok.status, 200);
      // fetch drops a custom Host header, so use http.request to simulate DNS rebinding.
      const status = await new Promise<number>((resolve) =>
        request(base + '/api/meta', { headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode!); }).end(),
      );
      assert.equal(status, 403, 'non-loopback Host is rejected');
    } finally {
      server.close();
    }
  });
});

describe('cache invalidation', () => {
  it('recomputes cached days when the compute key changes', async () => {
    const store = new Store(':memory:');
    let calls = 0;
    const make = (cfg: ReturnType<typeof testConfig>) =>
      new Engine({ config: cfg, store, classifier: null, today: () => '2026-09-30', sources: { claude: async () => (calls++, []), opencode: async () => [], git: () => [], calendar: null } });
    const base = testConfig({ classifier: { ...testConfig().classifier, enabled: false } });
    await make(base).days(D, D);
    await make(base).days(D, D);
    assert.equal(calls, 1, 'second run uses the cache');
    await make({ ...base, gapMinutes: 45 }).days(D, D);
    assert.equal(calls, 2, 'changed timing settings recompute');
  });
});

describe('jobs', () => {
  const dates = ['2026-09-14', '2026-09-15', '2026-09-16'];
  function jobSetup(store = new Store(':memory:'), classify: Classifier = async ({ blocks }) => ({ allocations: Object.fromEntries(blocks.map((b) => [b.id, [{ category: 'Testing', fraction: 1 }]])), summary: '- ok' })) {
    const engine = new Engine({
      config: testConfig(),
      store,
      classifier: classify,
      today: () => '2026-09-30',
      sources: {
        claude: async (from, to) => dates.filter((d) => at(d, '09:00') >= from && at(d, '09:00') < to).map((d) => ({ source: 'claude' as const, start: at(d, '09:00'), end: at(d, '11:00'), path: '/work/repo', texts: ['x'] })),
        opencode: async () => [],
        git: () => [],
        calendar: null,
      },
    });
    return { engine, store, runner: new JobRunner(() => engine, store) };
  }

  it('computes a range in the background and reports progress', async () => {
    const { runner } = jobSetup();
    const [job] = runner.ensure(dates[0], dates[2]);
    assert.deepEqual(job.dates, dates);
    const done = await runner.wait(job.id);
    assert.equal(done?.status, 'done');
    assert.deepEqual(done?.remaining, []);
    assert.deepEqual(runner.ensure(dates[0], dates[2]), [], 'nothing left to compute');
  });

  it('pauses without saving the unfinished day and resumes where it stopped', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const slow: Classifier = (input, opts) =>
      new Promise((resolve, reject) => {
        calls++;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        opts?.signal?.addEventListener('abort', fail);
        release = () => resolve({ allocations: Object.fromEntries(input.blocks.map((b) => [b.id, [{ category: 'Testing', fraction: 1 }]])), summary: '- ok' });
      });
    const { runner, engine } = jobSetup(new Store(':memory:'), slow);
    (engine.config.classifier as { concurrency: number }).concurrency = 1;
    const [job] = runner.ensure(dates[0], dates[2]);
    await new Promise((r) => setTimeout(r, 10));
    release(); // first day finishes
    await new Promise((r) => setTimeout(r, 10));
    runner.pause(job.id); // second day is mid-classification
    const paused = await runner.wait(job.id);
    assert.equal(paused?.status, 'paused');
    assert.deepEqual(paused?.done, [dates[0]]);
    runner.resume(job.id);
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      release();
    }
    const finished = await runner.wait(job.id);
    assert.equal(finished?.status, 'done');
    assert.equal(calls, 4, 'the interrupted day is classified again, finished days are not');
  });

  it('marks jobs of a dead process interrupted and continues them', async () => {
    const store = new Store(':memory:');
    const { runner } = jobSetup(store);
    const now = new Date().toISOString();
    store.saveJob({ id: 'crashed', from: dates[0], to: dates[2], refresh: false, dates, status: 'running', createdAt: now, updatedAt: now, pid: 999_999 });
    const found = runner.reconcile();
    assert.deepEqual(found.map((j) => [j.id, j.status]), [['crashed', 'interrupted']]);
    runner.resume('crashed');
    assert.equal((await runner.wait('crashed'))?.status, 'done');
  });
});
