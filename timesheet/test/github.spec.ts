import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
process.env.TIMESHEET_SECRETS = 'file';
const { at, testConfig } = await import('./helpers.ts');
const { GithubApi, addToken, collectGithub, removeToken, resetGithubRateLimits, storedTokens } = await import('../src/core/collectors/github.ts');
const { computeKey } = await import('../src/core/config.ts');
const { Engine } = await import('../src/core/engine.ts');
const { Store } = await import('../src/core/store.ts');
const { GITHUB_PERMISSIONS, githubTokenUrl } = await import('../src/core/github-token.ts');

const D = '2026-09-15';
const iso = (hhmm: string) => new Date(at(D, hhmm)).toISOString();

type Route = (url: URL, token: string, body: any) => unknown;

/** A fake api.github.com: `routes` maps "METHOD /path" to a handler; unknown paths are 404. */
function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const route = routes[`${init.method ?? 'GET'} ${url.pathname}`];
    const out = route?.(url, token, init.body ? JSON.parse(String(init.body)) : null);
    const status = out === undefined ? 404 : typeof out === 'number' ? out : 200;
    return new Response(JSON.stringify(status === 200 ? out : { message: 'Not Found' }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const graphql: Route = (_url, _token, body) => {
  const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] as unknown[] };
  const c = { issueContributions: empty, pullRequestContributions: empty, pullRequestReviewContributions: empty };
  if (body.query.includes('issueContributions'))
    c.issueContributions = { ...empty, nodes: [{ occurredAt: iso('09:30'), issue: { title: 'Broken login', number: 7, url: 'https://github.com/acme/app/issues/7', repository: { nameWithOwner: 'acme/app' } } }] };
  return { data: { viewer: { contributionsCollection: c } } };
};

const routes: Record<string, Route> = {
  'GET /user': () => ({ login: 'me' }),
  'POST /graphql': graphql,
  'GET /users/me/events': () => [],
  'GET /repos/acme/app/releases': () => [
    { draft: false, name: 'v1.2.0', tag_name: 'v1.2.0', author: { login: 'me' }, created_at: iso('10:55'), published_at: iso('11:00'), html_url: 'https://github.com/acme/app/releases/v1.2.0' },
    { draft: false, name: 'v1.1.9', tag_name: 'v1.1.9', author: { login: 'release-bot' }, created_at: iso('08:00'), published_at: iso('08:00'), html_url: 'https://github.com/acme/app/releases/v1.1.9' },
  ],
  'GET /repos/acme/app/actions/runs': (url) => {
    assert.equal(url.searchParams.get('actor'), 'me');
    return {
      workflow_runs: [
        { event: 'workflow_dispatch', name: 'Deploy', head_branch: 'main', run_attempt: 1, run_started_at: iso('13:00'), created_at: iso('13:00'), html_url: 'https://github.com/acme/app/actions/runs/1' },
        { event: 'push', name: 'CI', head_branch: 'main', run_attempt: 1, run_started_at: iso('12:00'), created_at: iso('12:00'), html_url: 'https://github.com/acme/app/actions/runs/2' },
      ],
    };
  },
  'GET /repos/acme/app/environments': () => ({ environments: [{ name: 'production', protection_rules: [{ type: 'required_reviewers' }] }, { name: 'dev', protection_rules: [] }] }),
  'GET /repos/acme/app/deployments': (url) => {
    assert.equal(url.searchParams.get('environment'), 'production');
    return [{ id: 55, ref: 'main', environment: 'production', created_at: iso('13:05') }];
  },
  'GET /repos/acme/app/deployments/55/statuses': () => [
    { state: 'success', created_at: iso('14:20'), target_url: 'https://github.com/acme/app/actions/runs/1/job/9' },
    { state: 'queued', created_at: iso('14:00'), target_url: 'https://github.com/acme/app/actions/runs/1/job/9' },
    { state: 'waiting', created_at: iso('13:05'), target_url: 'https://github.com/acme/app/actions/runs/1/job/9' },
  ],
  'GET /repos/acme/app/actions/runs/1/approvals': () => [{ state: 'approved', user: { login: 'Me' }, environments: [{ name: 'production' }] }],
};

describe('github collector', () => {
  const config = testConfig({ github: { enabled: true, repos: [], leadMinutes: 10 } });
  const [from, to] = [at(D, '00:00'), at('2026-09-16', '00:00')];

  it('collects issues, own releases, manual runs and approvals as point events with a lead-in', async () => {
    const api = new GithubApi([{ label: 'acme', token: 't1' }], fakeFetch(routes));
    const { events, denied } = await collectGithub(config, [], from, to, api);
    assert.deepEqual(denied, {});
    assert.deepEqual(
      events.map((e) => [e.action!.kind, e.texts[0], new Date(e.end).toISOString(), (e.end - e.start) / 60_000, e.path]),
      [
        ['issue', 'Opened issue #7: Broken login', iso('09:30'), 10, 'github.com/acme/app'],
        ['release', 'Released v1.2.0', iso('11:00'), 10, 'github.com/acme/app'],
        ['workflow', 'Ran Deploy on main', iso('13:00'), 10, 'github.com/acme/app'],
        ['approval', 'Approved deployment of main to production', iso('14:00'), 10, 'github.com/acme/app'],
      ],
    );
  });

  it('places events at the local clone of the repo', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gh-clone-')));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git']);
    const api = new GithubApi([{ label: 'acme', token: 't1' }], fakeFetch(routes));
    const { events } = await collectGithub(config, [repo], from, to, api);
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.path === repo));
  });

  it('reads each owner with the token that can see it and reports repos none can', async () => {
    const tokenRoutes = Object.fromEntries(Object.entries(routes).map(([k, fn]) => [k, ((url, token, body) => (k.includes('/repos/acme/') && token !== 't2' ? 404 : fn(url, token, body))) as Route]));
    const api = new GithubApi([{ label: 'personal', token: 't1' }, { label: 'acme', token: 't2' }], fakeFetch(tokenRoutes));
    const { events, denied } = await collectGithub({ ...config, github: { ...config.github, repos: ['other/secret'] } }, [], from, to, api);
    assert.equal(events.filter((e) => e.action!.kind === 'approval').length, 1);
    assert.deepEqual(denied, { 'other/secret': 'github.com/other/secret' });
  });

  it('fails loudly on a bad token or a rate limit', async () => {
    const bad = new GithubApi([{ label: 'acme', token: 't1' }], fakeFetch({ 'GET /user': () => 401 }));
    await assert.rejects(collectGithub(config, [], from, to, bad), /token "acme" is invalid/);
    const limited = new GithubApi([{ label: 'acme', token: 't1' }], fakeFetch({ 'GET /user': () => 429 }));
    await assert.rejects(collectGithub(config, [], from, to, limited), /rate limit/);
    resetGithubRateLimits();
  });

  it('stops asking GitHub until a rate limit resets', async () => {
    let calls = 0;
    const reset = Math.floor(Date.now() / 1000) + 600;
    const limitedFetch = (async () => {
      calls++;
      return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    }) as typeof fetch;
    const api = new GithubApi([{ label: 'gh', token: 't-limited' }], limitedFetch);
    await assert.rejects(collectGithub(config, [], from, to, api), /rate limit reached \(resets at/);
    await assert.rejects(collectGithub(config, [], from, to, api), /rate limit reached/);
    assert.equal(calls, 1, 'the second collection never reached GitHub');
    resetGithubRateLimits();
    await assert.rejects(collectGithub(config, [], from, to, api), /rate limit/);
    assert.equal(calls, 2);
    resetGithubRateLimits();
  });

  it('stores tokens after checking them, by label', async () => {
    const f = fakeFetch({ 'GET /user': () => ({ login: 'me' }) });
    await assert.rejects(addToken('acme', 'not-a-token', f), /does not look like/);
    await addToken('acme', 'github_pat_abc', f);
    await addToken('acme', 'github_pat_def', f);
    assert.deepEqual(storedTokens(), [{ label: 'acme', token: 'github_pat_def', login: 'me' }]);
    assert.equal(removeToken('acme'), true);
    assert.deepEqual(storedTokens(), []);
  });
});

describe('github token helper', () => {
  it('links to a pre-filled read-only token form for the owner', () => {
    const url = new URL(githubTokenUrl('acme'));
    assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
    assert.equal(url.searchParams.get('target_name'), 'acme');
    assert.equal(url.searchParams.get('name'), 'timesheet acme');
    assert.equal(url.searchParams.get('expires_in'), '366');
    for (const p of GITHUB_PERMISSIONS) assert.equal(url.searchParams.get(p.param), 'read');
    assert.equal(new URL(githubTokenUrl()).searchParams.has('target_name'), false);
  });
});

describe('github in the engine', () => {
  it('books GitHub actions in scope, including repos matched by a github.com rule', async () => {
    const config = testConfig({
      github: { enabled: true, repos: [], leadMinutes: 10 },
      scope: { work: [{ path: '/work/**', project: 'Default' }, { path: 'github.com/acme/**', project: 'Default' }], personal: ['/home/**'] },
    });
    const action = (repo: string, hhmm: string) => ({ source: 'github' as const, start: at(D, hhmm) - 600_000, end: at(D, hhmm), path: `github.com/${repo}`, texts: [`Released ${repo}`], action: { kind: 'release' as const, repo, title: `Released ${repo}`, url: `https://github.com/${repo}` } });
    const engine = new Engine({
      config,
      store: new Store(':memory:'),
      classifier: null,
      today: () => '2026-09-30',
      sources: {
        claude: async () => [],
        opencode: async () => [],
        git: () => [],
        calendar: null,
        github: async () => ({ events: [action('acme/app', '10:00'), action('stranger/lib', '15:00')], denied: { 'acme/infra': 'github.com/acme/infra' } }),
      },
    });
    const [day] = await engine.days(D, D);
    assert.equal(day.activity?.github, 1);
    assert.deepEqual(day.blocks.map((b) => [b.sources, b.actions?.map((a) => a.repo), b.summary]), [[['github'], ['acme/app'], 'Released acme/app']]);
    assert.ok(day.warnings.some((w) => w.includes('stranger/lib') && w.includes('github.com/stranger/**')));
    assert.ok(day.warnings.some((w) => w.includes('no token can read acme/infra')));
  });

  it('leaves the compute key alone while GitHub is off', () => {
    const off = testConfig();
    assert.equal(computeKey({ ...off, github: { ...off.github, repos: ['acme/*'] } }), computeKey(off));
    assert.notEqual(computeKey({ ...off, github: { ...off.github, enabled: true } }), computeKey(off));
  });
});
