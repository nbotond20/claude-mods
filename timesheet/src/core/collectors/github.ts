import { spawnSync } from 'node:child_process';
import type { Config } from '../config.ts';
import { deleteSecret, getSecret, setSecret } from '../secrets.ts';
import type { GithubAction, RawEvent } from '../types.ts';
import { discoverRepos, repoWebUrl } from './git.ts';

/**
 * What you did on GitHub that leaves no local commit: issues and PRs opened, reviews, comments,
 * releases you published, workflows you ran by hand (manual deploys/releases) and deployments
 * you approved or rejected in protected environments.
 *
 * Read-only fine-grained tokens, one per resource owner (your account, each organization),
 * live in the secret store under `github-tokens`. TIMESHEET_GITHUB_TOKEN (comma-separated)
 * wins; with neither, the `gh` CLI's token is used if it is logged in.
 */

const API = 'https://api.github.com';
const DAY = 86_400_000;
/** The public events feed only reaches this far back; older comments and tags are not visible. */
const EVENTS_DAYS = 90;
/** An approval can come days after the deployment was created (environments wait up to 30 days). */
const APPROVAL_LOOKBACK = 3 * DAY;
/** `owner/*` in github.repos covers repos pushed to within this long before the period. */
const OWNER_PUSH_WINDOW = 30 * DAY;

export interface GithubToken {
  label: string;
  token: string;
  /** The GitHub user the token acts as, filled in when it is added */
  login?: string;
}

export type TokenSource = 'stored' | 'env' | 'gh';

export function storedTokens(): GithubToken[] {
  const raw = getSecret('github-tokens');
  return raw ? (JSON.parse(raw) as GithubToken[]) : [];
}

function ghCliToken(): string | null {
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Tokens to use, in order: env, stored, `gh` CLI. */
export function activeTokens(): { tokens: GithubToken[]; source: TokenSource | null } {
  const env = process.env.TIMESHEET_GITHUB_TOKEN?.split(',').map((t) => t.trim()).filter(Boolean);
  if (env?.length) return { tokens: env.map((token, i) => ({ label: `env ${i + 1}`, token })), source: 'env' };
  const stored = storedTokens();
  if (stored.length) return { tokens: stored, source: 'stored' };
  const gh = ghCliToken();
  return gh ? { tokens: [{ label: 'gh CLI', token: gh }], source: 'gh' } : { tokens: [], source: null };
}

/** Checks a token against GitHub and stores it under `label` (replacing one with the same label). */
export async function addToken(label: string, token: string, fetchFn: typeof fetch = fetch): Promise<GithubToken> {
  label = label.trim();
  token = token.trim();
  if (!label) throw new Error('A label is required, e.g. the account or organization name');
  if (!/^(github_pat_|ghp_|gho_|ghu_)[\w]+$/.test(token)) throw new Error('That does not look like a GitHub token (github_pat_…)');
  const user = await new GithubApi([{ label, token }], fetchFn).rest<{ login: string }>({ label, token }, '/user');
  const entry = { label, token, login: user.login };
  setSecret('github-tokens', JSON.stringify([...storedTokens().filter((t) => t.label !== label), entry]));
  return entry;
}

export function removeToken(label: string): boolean {
  const all = storedTokens();
  const rest = all.filter((t) => t.label !== label);
  if (rest.length === all.length) return false;
  if (rest.length) setSecret('github-tokens', JSON.stringify(rest));
  else deleteSecret('github-tokens');
  return true;
}

export class GithubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** REST and GraphQL over several tokens: each owner's repos are read with the first token that can see them. */
export class GithubApi {
  readonly tokens: GithubToken[];
  private fetchFn: typeof fetch;
  private byOwner = new Map<string, GithubToken | null>();

  constructor(tokens: GithubToken[], fetchFn: typeof fetch = fetch) {
    this.tokens = tokens;
    this.fetchFn = fetchFn;
  }

  private async request<T>(token: GithubToken, url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'timesheet',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'))
      throw new GithubError('GitHub rate limit reached; the day is retried later', res.status);
    if (res.status === 401) throw new GithubError(`GitHub token "${token.label}" is invalid or expired; replace it with \`timesheet github add ${token.label}\``, 401);
    if (!res.ok) throw new GithubError(`GitHub ${res.status}: ${body.message ?? 'request failed'}`, res.status);
    if (body.errors?.length && !body.data) throw new GithubError(`GitHub GraphQL: ${body.errors[0].message}`, 400);
    return body as T;
  }

  rest<T>(token: GithubToken, path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(API + path);
    url.search = new URLSearchParams(params).toString();
    return this.request<T>(token, url.toString());
  }

  graphql<T>(token: GithubToken, query: string, variables: Record<string, unknown>): Promise<T> {
    return this.request<{ data: T }>(token, `${API}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }) }).then((b) => b.data);
  }

  /**
   * A repo request with the token that can see `owner/…`: tried in order and remembered.
   * Returns null when no token has access (403/404).
   */
  async repo<T>(repo: string, path: string, params: Record<string, string> = {}): Promise<T | null> {
    const owner = repo.split('/')[0].toLowerCase();
    const known = this.byOwner.get(owner);
    const candidates = known ? [known, ...this.tokens.filter((t) => t !== known)] : known === null ? [] : this.tokens;
    for (const token of candidates) {
      try {
        const body = await this.rest<T>(token, `/repos/${repo}${path}`, params);
        this.byOwner.set(owner, token);
        return body;
      } catch (e) {
        if (!(e instanceof GithubError) || (e.status !== 403 && e.status !== 404)) throw e;
      }
    }
    if (!known) this.byOwner.set(owner, null);
    return null;
  }

  /** Pages of a repo list endpoint until `more` says the rest is older than needed (or `max` pages). */
  async repoPages<T>(repo: string, path: string, params: Record<string, string>, pick: (body: any) => T[], more: (page: T[]) => boolean, max = 5): Promise<T[] | null> {
    const out: T[] = [];
    for (let page = 1; page <= max; page++) {
      const body = await this.repo<any>(repo, path, { per_page: '100', ...params, page: String(page) });
      if (body === null) return page === 1 ? null : out;
      const items = pick(body);
      out.push(...items);
      if (items.length < 100 || !more(items)) break;
    }
    return out;
  }
}

interface Found {
  at: number;
  action: GithubAction;
}

const inRange = (t: number, from: number, to: number) => t >= from && t < to;
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

const CONTRIBUTIONS: Record<'issue' | 'pull' | 'review', { field: string; node: string; title: (n: any) => [string, any] }> = {
  issue: {
    field: 'issueContributions',
    node: 'occurredAt issue { title number url repository { nameWithOwner } }',
    title: (n) => [`Opened issue #${n.issue.number}: ${n.issue.title}`, n.issue],
  },
  pull: {
    field: 'pullRequestContributions',
    node: 'occurredAt pullRequest { title number url repository { nameWithOwner } }',
    title: (n) => [`Opened PR #${n.pullRequest.number}: ${n.pullRequest.title}`, n.pullRequest],
  },
  review: {
    field: 'pullRequestReviewContributions',
    node: 'occurredAt pullRequestReview { url } pullRequest { title number url repository { nameWithOwner } }',
    title: (n) => [`Reviewed PR #${n.pullRequest.number}: ${n.pullRequest.title}`, { ...n.pullRequest, url: n.pullRequestReview?.url ?? n.pullRequest.url }],
  },
};

/** Issues and PRs opened and reviews given, from the contribution graph (any date range). */
async function contributions(api: GithubApi, token: GithubToken, from: number, to: number): Promise<Found[]> {
  const out: Found[] = [];
  // contributionsCollection spans at most a year.
  for (let start = from; start < to; start += 360 * DAY) {
    const end = Math.min(to, start + 360 * DAY);
    for (const [kind, c] of Object.entries(CONTRIBUTIONS) as [GithubAction['kind'], (typeof CONTRIBUTIONS)['issue']][]) {
      let after: string | null = null;
      do {
        const data: any = await api.graphql(
          token,
          `query($from: DateTime!, $to: DateTime!, $after: String) { viewer { contributionsCollection(from: $from, to: $to) { ${c.field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${c.node} } } } } }`,
          { from: iso(start), to: iso(end), after },
        );
        const conn = data.viewer.contributionsCollection[c.field];
        for (const n of conn.nodes ?? []) {
          const [title, target] = c.title(n);
          out.push({ at: Date.parse(n.occurredAt), action: { kind, repo: target.repository.nameWithOwner, title, url: target.url } });
        }
        after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      } while (after);
    }
  }
  return out;
}

/** Comments and tags from the user's recent events feed (the last 90 days, at most 300 events). */
async function recentEvents(api: GithubApi, token: GithubToken, login: string, from: number, to: number): Promise<Found[]> {
  if (to < Date.now() - EVENTS_DAYS * DAY) return [];
  const out: Found[] = [];
  for (let page = 1; page <= 3; page++) {
    const events = await api.rest<any[]>(token, `/users/${login}/events`, { per_page: '100', page: String(page) });
    for (const e of events) {
      const at = Date.parse(e.created_at);
      if (!inRange(at, from, to)) continue;
      const repo = e.repo?.name as string;
      const p = e.payload ?? {};
      if (e.type === 'IssueCommentEvent' && p.action === 'created') {
        out.push({ at, action: { kind: 'comment', repo, title: `Commented on #${p.issue.number}: ${p.issue.title}`, url: p.comment.html_url } });
      } else if (e.type === 'PullRequestReviewCommentEvent' && p.action === 'created') {
        out.push({ at, action: { kind: 'comment', repo, title: `Commented on PR #${p.pull_request.number}: ${p.pull_request.title}`, url: p.comment.html_url } });
      } else if (e.type === 'CreateEvent' && p.ref_type === 'tag') {
        out.push({ at, action: { kind: 'tag', repo, title: `Tagged ${p.ref}`, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(p.ref)}` } });
      }
    }
    if (events.length < 100 || Date.parse(events[events.length - 1].created_at) < from) break;
  }
  return out;
}

/** Releases published by one of `logins`. */
async function releases(api: GithubApi, repo: string, logins: Set<string>, from: number, to: number): Promise<Found[] | null> {
  const list = await api.repoPages<any>(repo, '/releases', {}, (b) => b, (page) => Date.parse(page[page.length - 1].created_at) >= from);
  if (!list) return null;
  return list
    .filter((r) => !r.draft && r.published_at && logins.has(r.author?.login?.toLowerCase()) && inRange(Date.parse(r.published_at), from, to))
    .map((r) => ({ at: Date.parse(r.published_at), action: { kind: 'release', repo, title: `Released ${r.name || r.tag_name}`, url: r.html_url } }));
}

/** Workflows started by hand (manual releases and deploys) and re-runs. Runs started by a push are already counted as commits. */
async function workflowRuns(api: GithubApi, repo: string, login: string, from: number, to: number): Promise<Found[] | null> {
  const list = await api.repoPages<any>(repo, '/actions/runs', { actor: login, created: `${iso(from)}..${iso(to)}` }, (b) => b.workflow_runs ?? [], () => true, 10);
  if (!list) return null;
  const out: Found[] = [];
  for (const r of list) {
    const rerun = r.run_attempt > 1 && r.triggering_actor?.login?.toLowerCase() === login.toLowerCase();
    if (r.event !== 'workflow_dispatch' && !rerun) continue;
    const at = Date.parse(rerun ? r.updated_at : (r.run_started_at ?? r.created_at));
    if (!inRange(at, from, to)) continue;
    out.push({ at, action: { kind: 'workflow', repo, title: `${rerun ? 'Re-ran' : 'Ran'} ${r.name}${r.head_branch ? ` on ${r.head_branch}` : ''}`, url: r.html_url } });
  }
  return out;
}

/**
 * Deployments one of `logins` approved or rejected. An approval has no timestamp of its own, so
 * it is dated by the deployment's first status after it stopped "waiting" for review.
 */
async function approvals(api: GithubApi, repo: string, logins: Set<string>, from: number, to: number): Promise<Found[] | null> {
  const envs = await api.repo<{ environments?: any[] }>(repo, '/environments', { per_page: '100' });
  if (envs && !envs.environments?.length) return [];
  // Environments with required reviewers; if they cannot be listed, look at every deployment.
  const names: (string | undefined)[] = envs ? envs.environments!.filter((e) => e.protection_rules?.some((r: any) => r.type === 'required_reviewers')).map((e) => e.name) : [undefined];
  const out: Found[] = [];
  const runApprovals = new Map<string, any[] | null>();
  for (const environment of names) {
    const deployments = await api.repoPages<any>(repo, '/deployments', environment ? { environment } : {}, (b) => b, (page) => Date.parse(page[page.length - 1].created_at) >= from - APPROVAL_LOOKBACK);
    if (!deployments) return null;
    for (const d of deployments) {
      const created = Date.parse(d.created_at);
      if (created < from - APPROVAL_LOOKBACK || created >= to) continue;
      const statuses = ((await api.repo<any[]>(repo, `/deployments/${d.id}/statuses`, { per_page: '100' })) ?? []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const waiting = statuses.findIndex((s) => s.state === 'waiting');
      if (waiting < 0) continue;
      const decided = statuses.slice(waiting + 1).find((s) => s.state !== 'waiting');
      if (!decided) continue;
      const at = Date.parse(decided.created_at);
      if (!inRange(at, from, to)) continue;
      const runId = statuses.map((s) => /\/actions\/runs\/(\d+)/.exec(`${s.target_url ?? ''} ${s.log_url ?? ''}`)?.[1]).find(Boolean);
      if (!runId) continue;
      if (!runApprovals.has(runId)) runApprovals.set(runId, await api.repo<any[]>(repo, `/actions/runs/${runId}/approvals`));
      const review = (runApprovals.get(runId) ?? []).find(
        (a) => logins.has(a.user?.login?.toLowerCase()) && (a.environments ?? []).some((e: any) => e.name === d.environment),
      );
      if (!review) continue;
      out.push({
        at,
        action: {
          kind: 'approval',
          repo,
          title: `${review.state === 'rejected' ? 'Rejected' : 'Approved'} deployment of ${d.ref} to ${d.environment}`,
          url: `https://github.com/${repo}/actions/runs/${runId}`,
        },
      });
    }
  }
  return out;
}

/** `owner/*` entries: the owner's repos pushed to since shortly before the period. */
async function ownerRepos(api: GithubApi, owner: string, logins: Set<string>, from: number): Promise<string[]> {
  const out: string[] = [];
  for (const token of api.tokens) {
    const path = logins.has(owner.toLowerCase()) ? '/user/repos' : `/orgs/${owner}/repos`;
    const params: Record<string, string> = logins.has(owner.toLowerCase()) ? { affiliation: 'owner', sort: 'pushed' } : { sort: 'pushed' };
    try {
      for (let page = 1; page <= 10; page++) {
        const repos = await api.rest<any[]>(token, path, { ...params, per_page: '100', page: String(page) });
        const recent = repos.filter((r) => Date.parse(r.pushed_at) >= from - OWNER_PUSH_WINDOW);
        out.push(...recent.map((r) => r.full_name as string));
        if (repos.length < 100 || recent.length < repos.length) break;
      }
      return out;
    } catch (e) {
      if (!(e instanceof GithubError) || (e.status !== 403 && e.status !== 404)) throw e;
    }
  }
  return out;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

export interface GithubResult {
  events: RawEvent[];
  /** Repos no token can read, with the path their events would have: `owner/name` → path */
  denied: Record<string, string>;
}

/** owner/name of a local clone whose origin is on github.com, lowercased. */
function githubName(root: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/i.exec(repoWebUrl(root) ?? '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * GitHub actions in [from, to) as point events with a lead-in, like commits. Each is placed at the
 * local clone of its repo (so work scope applies as usual) or at `github.com/owner/name` when there
 * is no clone, which scope rules can match too (e.g. "github.com/acme/**").
 */
export async function collectGithub(config: Config, localRepos: string[], from: number, to: number, api = new GithubApi(activeTokens().tokens)): Promise<GithubResult> {
  if (!api.tokens.length) throw new Error('No GitHub token; run `timesheet github add <label>`');
  const found: Found[] = [];
  const logins = new Set<string>();
  for (const token of api.tokens) {
    const login = (await api.rest<{ login: string }>(token, '/user')).login;
    logins.add(login.toLowerCase());
    found.push(...(await contributions(api, token, from, to)), ...(await recentEvents(api, token, login, from, to)));
  }
  const login = [...logins][0];

  const clones = new Map<string, string>();
  for (const root of localRepos) {
    const name = githubName(root);
    if (name && !clones.has(name)) clones.set(name, root);
  }
  const repos = new Map<string, string>(); // lowercase → as written
  const addRepo = (r: string) => repos.has(r.toLowerCase()) || repos.set(r.toLowerCase(), r);
  for (const name of clones.keys()) addRepo(name);
  for (const f of found) addRepo(f.action.repo);
  for (const r of config.github.repos) {
    if (r.endsWith('/*')) for (const x of await ownerRepos(api, r.slice(0, -2), logins, from)) addRepo(x);
    else addRepo(r);
  }

  const denied: Record<string, string> = {};
  const pathOf = (repo: string) => clones.get(repo.toLowerCase()) ?? `github.com/${repo}`;
  await pool([...repos.values()], 6, async (repo) => {
    const parts = [await releases(api, repo, logins, from, to), await workflowRuns(api, repo, login, from, to), await approvals(api, repo, logins, from, to)];
    if (parts.every((p) => p === null)) denied[repo] = pathOf(repo);
    for (const p of parts) if (p) found.push(...p);
  });

  const lead = config.github.leadMinutes * 60_000;
  const seen = new Set<string>();
  const events: RawEvent[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const key = `${f.action.kind}:${f.action.url}`;
    if (seen.has(key) || !inRange(f.at, from, to)) continue;
    seen.add(key);
    events.push({ source: 'github', start: Math.max(from, f.at - lead), end: f.at, measured: [], path: pathOf(f.action.repo), texts: [f.action.title], action: f.action });
  }
  return { events, denied };
}

/** Local repos to match GitHub activity against: the clones behind the given paths and the work scope. */
export function githubCollector(config: Config) {
  return (paths: string[], from: number, to: number) => collectGithub(config, discoverRepos(config, paths), from, to);
}
