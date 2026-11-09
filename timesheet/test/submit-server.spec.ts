import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { at, testConfig } from './helpers.ts';
import { Engine } from '../src/core/engine.ts';
import { Store } from '../src/core/store.ts';
import { createApp } from '../src/web/server.ts';
import { listCaptures, SubmitSession } from '../src/core/submit/session.ts';
import type { BrowserSession } from '../src/core/submit/browser.ts';
import type { Config } from '../src/core/config.ts';
import { chromeAvailable } from '../src/core/submit/browser.ts';

const WEEK = '2026-09-14'; // Monday, in the past
const D = '2026-09-15';

function setup(config: Partial<Config> = {}) {
  let collects = 0;
  const store = new Store(':memory:');
  const engine = new Engine({
    config: testConfig({ classifier: { ...testConfig().classifier, enabled: false }, ...config }),
    store,
    classifier: null,
    today: () => '2026-09-30',
    sources: {
      claude: async (from) => {
        collects++;
        return from <= at(D, '09:00') ? [{ source: 'claude', start: at(D, '09:00'), end: at(D, '12:00'), path: '/work/repo', texts: ['write tests'] }] : [];
      },
      opencode: async () => [],
      git: () => [],
      calendar: null,
    },
  });
  return { engine, store, collects: () => collects };
}

/** A session whose opener must never run: tests do not open a real browser. */
const noBrowser = () =>
  new SubmitSession(async () => {
    throw new Error('test must not open a browser');
  });

async function serve(engine: Engine, submit = noBrowser()) {
  const server = createServer(createApp({ engine, save: () => {}, submit }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'x-timesheet': '1' }, body: JSON.stringify(body) });
  return { base, post, close: () => server.close() };
}

const rules = { url: 'https://redmine.example.com/work_time/index', fillOnly: true, rules: [{ project: 'Default', category: '*', target: { issueId: 42, activity: 'Development' } }] };

describe('submit api', () => {
  it('reports the status of both systems without opening a browser', async () => {
    const { engine } = setup({ submit: { redmine: rules, netsuite: { url: '', fillOnly: false, rules: [] } } });
    const app = await serve(engine);
    try {
      const s = await (await fetch(app.base + '/api/submit')).json();
      assert.equal(typeof s.chrome, 'boolean');
      assert.equal(typeof s.profile, 'string');
      assert.deepEqual(s.browser, { open: false });
      assert.equal(s.systems.redmine.url, rules.url);
      assert.equal(s.systems.redmine.fillOnly, true);
      assert.equal(s.systems.redmine.rules, 1);
      assert.deepEqual(s.systems.redmine.captures, []);
      assert.deepEqual({ ...s.systems.netsuite, folder: undefined }, { url: '', fillOnly: false, rules: 0, captures: [], folder: undefined });
    } finally {
      app.close();
    }
  });

  it('opens Redmine at the bare Worktime page (never the configured query), NetSuite at its address', { skip: !chromeAvailable() && 'Google Chrome not installed' }, async () => {
    const visited: string[] = [];
    const page = { isClosed: () => false, goto: async (u: string) => void visited.push(u), bringToFront: async () => {} };
    const context = new EventEmitter();
    const submit = new SubmitSession(async () => ({ context, page, current: () => page, close: async () => {} }) as unknown as BrowserSession);
    const { engine } = setup({
      submit: {
        redmine: { ...rules, url: 'https://redmine.example.com/work_time/index?ticket_del=closed&year=2026#memo' },
        netsuite: { url: 'https://1234.app.netsuite.com/app/accounting/transactions/timebill.nl?id=7', fillOnly: true, rules: [] },
      },
    });
    const app = await serve(engine, submit);
    try {
      assert.equal((await app.post('/api/submit/open', { system: 'redmine' })).status, 200);
      assert.equal((await app.post('/api/submit/open', { system: 'netsuite' })).status, 200);
      assert.deepEqual(visited, ['https://redmine.example.com/work_time/index', 'https://1234.app.netsuite.com/app/accounting/transactions/timebill.nl?id=7']);
    } finally {
      app.close();
    }
  });

  it('refuses to open without a URL, an unknown system, capture without a browser, and writes without the header', async () => {
    const { engine } = setup();
    const app = await serve(engine);
    try {
      const noUrl = await app.post('/api/submit/open', { system: 'netsuite' });
      assert.equal(noUrl.status, 400);
      assert.match((await noUrl.json()).error, /NetSuite address/);
      const bad = await app.post('/api/submit/open', { system: 'jira' });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /system must be one of redmine, netsuite/);
      const cap = await app.post('/api/submit/capture', { system: 'redmine', label: 'worktime' });
      assert.equal(cap.status, 409);
      assert.match((await cap.json()).error, /Open the browser first/);
      const badCap = await app.post('/api/submit/capture', { system: '../x', label: 'x' });
      assert.equal(badCap.status, 400);
      const forged = await fetch(app.base + '/api/submit/open', { method: 'POST', body: JSON.stringify({ system: 'redmine' }) });
      assert.equal(forged.status, 403);
      const closed = await app.post('/api/submit/close', {});
      assert.equal(closed.status, 200);
      assert.equal((await closed.json()).browser.open, false);
    } finally {
      app.close();
    }
  });

  it('plans from cached days only: missing days block, nothing is computed', async () => {
    const { engine, store, collects } = setup({ submit: { redmine: rules, netsuite: { url: '', fillOnly: true, rules: [] } } });
    await engine.days(D, D);
    const before = collects();
    const app = await serve(engine);
    try {
      const r = await (await fetch(`${app.base}/api/submit/plan?week=2026-09-17`)).json();
      assert.equal(r.week, WEEK);
      assert.equal(collects(), before, 'the plan never collects or computes');
      assert.equal(store.getDay('2026-09-14'), null, 'and stores nothing');
      const redmine = r.systems.find((s: any) => s.system === 'redmine');
      assert.equal(redmine.ok, false);
      assert.equal(redmine.fillOnly, true);
      assert.ok(redmine.reasons.includes('2026-09-14: not computed yet'));
      assert.ok(!redmine.reasons.some((x: string) => x.startsWith(D)), 'the cached day itself is fine');
      const netsuite = r.systems.find((s: any) => s.system === 'netsuite');
      assert.equal(netsuite.ok, false);
      assert.ok(netsuite.reasons.some((x: string) => x.startsWith(`${D}: no netsuite mapping for Default / `)));
      const bad = await fetch(`${app.base}/api/submit/plan?week=nope`);
      assert.equal(bad.status, 400);
    } finally {
      app.close();
    }
  });

  it('plans cells with labels once the whole week is computed', async () => {
    const { engine, collects } = setup({ submit: { redmine: rules, netsuite: { url: '', fillOnly: true, rules: [] } } });
    await engine.days(WEEK, '2026-09-20');
    const before = collects();
    const app = await serve(engine);
    try {
      const r = await (await fetch(`${app.base}/api/submit/plan?week=${WEEK}`)).json();
      assert.equal(collects(), before);
      const redmine = r.systems.find((s: any) => s.system === 'redmine');
      assert.equal(redmine.ok, true, JSON.stringify(redmine.reasons));
      assert.equal(redmine.plan.cells.length, 1);
      assert.deepEqual({ ...redmine.plan.cells[0], hours: undefined }, { date: D, target: { issueId: 42, activity: 'Development' }, label: '#42 · Development', hours: undefined });
      assert.ok(redmine.plan.cells[0].hours > 0);
    } finally {
      app.close();
    }
  });

  it('treats out-of-date cached days as not ready', async () => {
    const { engine, store } = setup({ submit: { redmine: rules, netsuite: { url: '', fillOnly: true, rules: [] } } });
    await engine.days(WEEK, '2026-09-20');
    const other = new Engine({ config: { ...engine.config, gapMinutes: engine.config.gapMinutes + 5 }, store, classifier: null, today: () => '2026-09-30', sources: (engine as any).sources });
    const app = await serve(other);
    try {
      const r = await (await fetch(`${app.base}/api/submit/plan?week=${WEEK}`)).json();
      const redmine = r.systems.find((s: any) => s.system === 'redmine');
      assert.equal(redmine.ok, false);
      assert.ok(redmine.reasons.includes(`${D}: out of date; open the week to recompute it`), JSON.stringify(redmine.reasons));
    } finally {
      app.close();
    }
  });
});

describe('submit run api', () => {
  it('validates input, refuses forged writes and never opens a browser for a blocked plan', async () => {
    const { engine } = setup({ submit: { redmine: rules, netsuite: { url: '', fillOnly: true, rules: [] } } });
    const app = await serve(engine);
    try {
      assert.equal((await app.post('/api/submit/prepare', { system: 'jira', week: WEEK })).status, 400);
      assert.equal((await app.post('/api/submit/prepare', { system: 'redmine', week: 'nope' })).status, 400);
      assert.equal((await app.post('/api/submit/execute', { system: 'redmine', week: WEEK })).status, 400);
      const badFp = await app.post('/api/submit/execute', { system: 'redmine', week: WEEK, fingerprint: 'x' });
      assert.equal(badFp.status, 400);
      assert.match((await badFp.json()).error, /prepare again/);
      const forged = await fetch(app.base + '/api/submit/execute', { method: 'POST', body: JSON.stringify({ system: 'redmine', week: WEEK, fingerprint: '0123456789abcdeff' }) });
      assert.equal(forged.status, 403);

      // Day 2026-09-14 is not computed: blocked before any browser is needed.
      const prep = await (await app.post('/api/submit/prepare', { system: 'redmine', week: '2026-09-16' })).json();
      assert.equal(prep.state, 'blocked');
      assert.equal(prep.week, WEEK);
      assert.ok(prep.reasons.includes('2026-09-14: not computed yet'));
      const ns = await (await app.post('/api/submit/prepare', { system: 'netsuite', week: WEEK })).json();
      assert.equal(ns.state, 'blocked');
      assert.deepEqual(ns.reasons, ['set the netsuite address in Settings → Submission first']);
      const discoverNs = await app.post('/api/submit/discover', { system: 'netsuite' });
      assert.equal(discoverNs.status, 400);

      const run = await (await fetch(`${app.base}/api/submit/run?system=redmine&week=${WEEK}`)).json();
      assert.equal(run.progress, null);
      assert.deepEqual(run.runs.map((r: any) => r.status), ['blocked']);
      assert.deepEqual((await (await app.post('/api/submit/cancel', {})).json()).progress, null);
      assert.deepEqual(await (await fetch(`${app.base}/api/submit/catalog?system=redmine`)).json(), { system: 'redmine', catalog: null, discoveredAt: null });
      assert.equal((await fetch(`${app.base}/api/submit/catalog?system=x`)).status, 400);
    } finally {
      app.close();
    }
  });

  it('lists the (project, category) pairs booked recently', async () => {
    const { engine } = setup();
    await engine.days(D, D);
    const app = await serve(engine);
    try {
      const r = await (await fetch(`${app.base}/api/submit/pairs`)).json();
      assert.equal(r.pairs.length, 1);
      assert.equal(r.pairs[0].project, 'Default');
      assert.equal(r.pairs[0].last, D);
      assert.ok(r.pairs[0].hours > 0);
    } finally {
      app.close();
    }
  });
});

describe('submit session', () => {
  function fakeSession() {
    const context = new EventEmitter();
    let closed = 0;
    const session = {
      context,
      page: {},
      current: () => ({}),
      close: async () => {
        closed++;
        context.emit('close');
      },
    } as unknown as BrowserSession;
    return { session, context, closed: () => closed };
  }

  it('launches once for concurrent callers, drops the session when the window closes', async () => {
    const fake = fakeSession();
    let launches = 0;
    const s = new SubmitSession(async () => {
      launches++;
      return fake.session;
    });
    assert.equal(s.open, false);
    assert.equal(s.current(), null);
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    assert.equal(a, b);
    assert.equal(launches, 1);
    assert.equal(s.open, true);
    fake.context.emit('close');
    assert.equal(s.open, false);
    assert.equal(s.current(), null);
  });

  it('closes the browser and tolerates a failed launch', async () => {
    const fake = fakeSession();
    const s = new SubmitSession(async () => fake.session);
    await s.ensure();
    await s.close();
    assert.equal(fake.closed(), 1);
    assert.equal(s.open, false);
    const failing = new SubmitSession(async () => {
      throw new Error('no chrome');
    });
    await assert.rejects(failing.ensure(), /no chrome/);
    assert.equal(failing.open, false);
    await failing.close();
  });

  it('lists captures newest first with their screenshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'captures-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a-old.html'), '');
    writeFileSync(join(dir, 'a-old.png'), '');
    writeFileSync(join(dir, 'b-new.html'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    utimesSync(join(dir, 'a-old.html'), new Date('2026-09-01'), new Date('2026-09-01'));
    const list = listCaptures(dir);
    assert.deepEqual(list.map((c) => [c.file, c.png]), [['b-new.html', null], ['a-old.html', 'a-old.png']]);
    assert.equal(list[1].at, new Date('2026-09-01').toISOString());
    assert.deepEqual(listCaptures(join(dir, 'missing')), []);
  });
});
