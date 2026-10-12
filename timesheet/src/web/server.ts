import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, normalize } from 'node:path';
import { CONFIG_PATH, categoryTone, computeKey, configExists, contractHome, defaultConfig, expandDirs, saveConfig, validateConfig } from '../core/config.ts';
import { execFileSync } from 'node:child_process';
import { openCodeAvailable } from '../core/collectors/opencode.ts';
import { repoRoot, repoWebUrl } from '../core/collectors/git.ts';
import type { Config } from '../core/config.ts';
import { authorize, disconnect, isConnected, listCalendars, loadClient, parseClientJson, saveClient } from '../core/collectors/gcal.ts';
import { addDays, monthRange, resolveDate, resolveMonth, resolveWeek, today, weekStart } from '../core/dates.ts';
import type { Engine } from '../core/engine.ts';
import { render } from '../core/format.ts';
import { describeBackend } from '../core/secrets.ts';
import { activeTokens, addToken, removeToken } from '../core/collectors/github.ts';
import { packageRoot } from '../core/paths.ts';
import { listClaudeCommandsAsync, runClaude } from '../core/claude-runner.ts';
import { JobRunner } from '../core/jobs.ts';
import { categoryHues } from '../core/palette.ts';
import type { Store } from '../core/store.ts';
import { applySettingsChange, blockEditProblem, hoursEditProblem } from '../core/edits.ts';
import type { DayReport } from '../core/types.ts';
import { daysBetween } from '../core/dates.ts';
import { CLASSIFIER_CWD } from '../core/config.ts';
import { chromeAvailable, PROFILE_DIR } from '../core/submit/browser.ts';
import { capture, INSPECT_DIR } from '../core/submit/inspect.ts';
import { buildPlan, describeTarget } from '../core/submit/plan.ts';
import { isSystem, listCaptures, startUrl, SubmitSession } from '../core/submit/session.ts';
import { Abort } from '../core/submit/adapter.ts';
import { Busy, SubmitRunner } from '../core/submit/run.ts';
import { SYSTEMS, type SubmitRule, type SystemId } from '../core/submit/types.ts';

/** The React app, prebuilt into web/dist so installs never need the UI toolchain. */
const DIST = join(packageRoot(), 'web', 'dist');
const FALLBACK_PAGE = join(packageRoot(), 'web', 'fallback.html');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function range(view: string, at: string | null): [string, string] {
  if (view === 'day') {
    const d = resolveDate(at ?? undefined);
    return [d, d];
  }
  if (view === 'week') {
    const m = resolveWeek(at ?? undefined);
    return [m, addDays(m, 6)];
  }
  return monthRange(resolveMonth(at ? at.slice(0, 7) : undefined));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

/**
 * The API only answers same-machine requests from its own page:
 * - Host must be loopback (blocks DNS-rebinding attacks from other sites),
 * - writes need the X-Timesheet header, which a cross-site form or fetch cannot
 *   send without a CORS preflight this server never approves.
 */
function allowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  if (req.method !== 'GET' && req.headers['x-timesheet'] !== '1') return false;
  return true;
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
  if (!existsSync(DIST)) {
    if (pathname !== '/') return false;
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(readFileSync(FALLBACK_PAGE));
    return true;
  }
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes(`${join(DIST, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(file));
  return true;
}

/** What the setup wizard can prefill: every Claude profile found, OpenCode, and the git identity. */
async function detect(config: Config) {
  let gitEmail = '';
  try {
    gitEmail = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    /* no global identity */
  }
  const dirs = expandDirs([...new Set([...config.claudeDirs, ...defaultConfig().claudeDirs])]);
  return {
    claudeDirs: dirs.map((dir) => {
      const sessions = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .reduce((n, d) => n + readdirSync(join(dir, d.name)).filter((f) => f.endsWith('.jsonl')).length, 0);
      const history = join(dir, '..', 'history.jsonl');
      const prompts = existsSync(history) ? readFileSync(history, 'utf8').split('\n').filter(Boolean).length : 0;
      return { dir, sessions, prompts, included: expandDirs(config.claudeDirs).includes(dir) };
    }),
    opencode: openCodeAvailable({ ...config, opencodeDirs: [...new Set([...config.opencodeDirs, ...defaultConfig().opencodeDirs])] }),
    gitEmail,
    claudeCommands: await listClaudeCommandsAsync(),
  };
}

export interface AppOptions {
  engine: Engine;
  /** Builds a fresh engine after the config changes. */
  rebuild?: (config: Config) => Engine;
  /** Where config edits are persisted; defaults to the real config file. */
  save?: (config: Config) => void;
  /** The submission browser; tests pass one with a fake opener. */
  submit?: SubmitSession;
}

/** A client mistake (bad input, wrong state), answered with its status instead of 500. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApp(opts: AppOptions) {
  let engine = opts.engine;
  const save = opts.save ?? saveConfig;
  const store: Store = engine.store;
  const runner = new JobRunner(() => engine, store, (m) => console.log(m));
  // Pick up work a previous run (or a CLI that was closed or crashed) left unfinished.
  const adoptOrphans = () => {
    for (const j of runner.reconcile()) {
      console.log(`Resuming interrupted computation ${j.from} → ${j.to}`);
      runner.resume(j.id);
    }
  };
  adoptOrphans();

  let detected: { at: number; key: string; value: Promise<unknown> } | null = null;
  function detectCached() {
    const key = JSON.stringify([engine.config.claudeDirs, engine.config.opencodeDirs]);
    if (!detected || detected.key !== key || Date.now() - detected.at > 60_000) detected = { at: Date.now(), key, value: detect(engine.config) };
    return detected.value;
  }

  const flag = (v: unknown) => v === true || v === 'true';
  const submit = opts.submit ?? new SubmitSession();

  function submitStatus() {
    const config = engine.config;
    return {
      chrome: chromeAvailable(),
      profile: contractHome(PROFILE_DIR),
      folder: contractHome(INSPECT_DIR),
      browser: { open: submit.open },
      systems: Object.fromEntries(
        SYSTEMS.map((system) => {
          const s = config.submit[system];
          return [system, { url: s.url, fillOnly: s.fillOnly, rules: Array.isArray(s.rules) ? s.rules.length : 0, folder: contractHome(join(INSPECT_DIR, system)), captures: listCaptures(join(INSPECT_DIR, system)) }];
        }),
      ) as Record<SystemId, unknown>,
    };
  }

  const systemOf = (v: unknown): SystemId => {
    if (!isSystem(v)) throw new HttpError(400, `system must be one of ${SYSTEMS.join(', ')}`);
    return v;
  };

  /**
   * The week's days a submission may use: cached days only, never starting a computation. Days
   * that are missing, out of date or still being computed are left out (with the reason), so a
   * plan is blocked for them rather than built from hours that may change.
   */
  function weekReports(week: string) {
    const now = today();
    const busy = new Set(runner.list(0).filter((j) => !['done', 'failed', 'cancelled'].includes(j.status)).flatMap((j) => j.remaining));
    const reports: DayReport[] = [];
    const outdated = new Map<string, string>();
    for (const d of daysBetween(week, addDays(week, 6))) {
      if (d > now) break;
      const s = store.getDay(d);
      if (!s) continue;
      if (busy.has(d)) outdated.set(d, 'still being computed');
      else if (engine.isStale(s)) outdated.set(d, 'out of date; open the week to recompute it');
      else reports.push(engine.report(s));
    }
    return { reports, outdated };
  }

  const submitRunner = new SubmitRunner({
    store,
    config: () => engine.config,
    today,
    session: submit,
    reports: async (week) => weekReports(week),
  });

  const weekOf = (v: unknown): string => {
    const raw = String(v ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) throw new HttpError(400, 'week must be a date (YYYY-MM-DD)');
    return weekStart(raw);
  };

  /** (project, category) pairs booked in the last weeks, for the mapping editor. */
  function bookedPairs(weeks = 8) {
    const from = addDays(today(), -7 * weeks);
    const pairs = new Map<string, { project: string; category: string; hours: number; days: number; last: string }>();
    for (const d of store.cachedDates()) {
      if (d < from || d > today()) continue;
      const s = store.getDay(d);
      if (!s) continue;
      for (const e of engine.report(s).entries) {
        if (!(e.hours > 0)) continue;
        const key = `${e.project}\u0000${e.category}`;
        const p = pairs.get(key) ?? { project: e.project, category: e.category, hours: 0, days: 0, last: d };
        p.hours = Math.round((p.hours + e.hours) * 100) / 100;
        p.days++;
        if (d > p.last) p.last = d;
        pairs.set(key, p);
      }
    }
    return [...pairs.values()].sort((a, b) => a.project.localeCompare(b.project) || a.category.localeCompare(b.category));
  }

  /** Recent runs of a week, without the bulky snapshots. */
  function runSummary(system: SystemId | undefined, week: string | undefined) {
    return store.submitRuns(system, week).slice(0, 10).map((r) => ({
      id: r.id, system: r.system, week: r.week, status: r.status, fillOnly: r.fillOnly, error: r.error ?? null,
      written: Array.isArray(r.written) ? r.written.length : 0, screenshots: r.screenshots.map(contractHome), createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  }

  /**
   * Read-only preview of what would be entered for a week (see weekReports for which days count).
   */
  function submitPlan(q: Record<string, any>) {
    const raw = String(q.week ?? '');
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new HttpError(400, 'week must be a date (YYYY-MM-DD)');
    const week = weekStart(raw || today());
    const now = today();
    const { reports, outdated } = weekReports(week);
    const systems = SYSTEMS.map((system) => {
      const cfg = engine.config.submit[system];
      const result = buildPlan({ system, week, reports, today: now, rules: cfg.rules as SubmitRule<object>[] });
      if (!result.ok) {
        const reasons = result.reasons.map((r) => {
          const date = r.slice(0, 10);
          return r === `${date}: not computed yet` && outdated.has(date) ? `${date}: ${outdated.get(date)}` : r;
        });
        return { system, fillOnly: cfg.fillOnly, ok: false as const, reasons };
      }
      return {
        system,
        fillOnly: cfg.fillOnly,
        ok: true as const,
        plan: { ...result.plan, cells: result.plan.cells.map((c) => ({ ...c, label: describeTarget(system, c.target) })) },
      };
    });
    return { week, systems };
  }

  /**
   * Reports never block on computation: cached days come back right away (stale ones
   * flagged pending), and missing or stale days are queued as a background job that the
   * page follows through /api/jobs. `wait` blocks until they are computed.
   */
  async function reportPayload(q: Record<string, any>) {
    const config = engine.config;
    const [from, to] = q.from && q.to ? [resolveDate(q.from), resolveDate(q.to)] : range(q.view ?? 'week', q.at ?? null);
    const target = q.target !== undefined && q.target !== '' && q.target !== null ? Number(q.target) : undefined;
    const real = flag(q.real);
    let jobs = from > today() || q.compute === false ? runner.list(0).filter((j) => j.dates.some((d) => d >= from && d <= to) && j.remaining.length) : runner.ensure(from, to, flag(q.refresh));
    if (flag(q.wait)) {
      for (const j of jobs) await runner.wait(j.id);
      jobs = [];
    }
    const pendingSet = new Set(jobs.filter((j) => !['failed', 'cancelled'].includes(j.status)).flatMap((j) => j.remaining));
    const days: (DayReport & { pending?: boolean })[] = [];
    for (const d of daysBetween(from, to)) {
      if (d > today()) break;
      const s = store.getDay(d);
      if (s) days.push({ ...engine.report(s, target), pending: pendingSet.has(d) || undefined });
    }
    const fopts = { real };
    // Folder of each block → its repo and web URL, so the UI can link blocks to repos and commits.
    const repos: Record<string, { root: string; name: string; url: string | null }> = {};
    for (const d of days)
      for (const b of [...d.blocks, ...(d.other ?? [])])
        for (const p of [...b.paths, ...(b.commits ?? []).map((c) => c.repo), ...(b.items ?? []).flatMap((it) => it.alsoPaths ?? [])]) {
          if (repos[p]) continue;
          const root = repoRoot(p) ?? p;
          repos[p] = { root: contractHome(root), name: basename(root), url: repoWebUrl(root) };
        }
    return {
      from,
      to,
      days,
      repos,
      pending: [...pendingSet].filter((d) => d >= from && d <= to).sort(),
      jobs,
      paste: {
        grid: render('grid', days, config, fopts),
        gridNoHeader: render('grid', days, config, { ...fopts, header: false }),
        lines: render('lines', days, config, fopts),
        daily: render('daily', days, config, fopts),
      },
    };
  }

  function meta() {
    const config = engine.config;
    const hues = categoryHues(config.categories);
    return {
      today: today(),
      target: config.target,
      rounding: config.rounding,
      dateFormat: config.dateFormat,
      projects: config.projects,
      defaultProject: config.defaultProject,
      categories: config.categories.map((c) => ({ ...c, tone: categoryTone(c), hue: hues.get(c.name) ?? null })),
    };
  }

  function authStatus() {
    return { hasClient: loadClient() !== null, connected: isConnected(), backend: describeBackend(), calendarEnabled: engine.config.calendar.enabled };
  }

  function githubStatus() {
    const { tokens, source } = activeTokens();
    // Labels and logins only: tokens never leave the server.
    return { backend: describeBackend(), source, tokens: tokens.map((t) => ({ label: t.label, login: t.login ?? null })), enabled: engine.config.github.enabled };
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!allowed(req)) return json(res, 403, { error: 'forbidden' });
      const { pathname } = url;
      if (!pathname.startsWith('/api/')) {
        if (req.method === 'GET' && serveStatic(res, pathname)) return;
        return json(res, 404, { error: 'not found' });
      }
      const q = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);

      switch (`${req.method} ${pathname}`) {
        case 'GET /api/meta':
          return json(res, 200, meta());
        case 'GET /api/report':
        case 'POST /api/report':
          return json(res, 200, await reportPayload(q));
        case 'POST /api/override': {
          const date = String(q.date ?? '');
          const hours = q.hours === null || q.hours === '' || q.hours === undefined ? null : Number(q.hours);
          const problem = hoursEditProblem(engine.config, engine.store, date, String(q.project ?? ''), String(q.category ?? ''), hours);
          if (problem) return json(res, engine.store.isLocked(date) ? 409 : 400, { error: problem });
          engine.store.editHours(date, String(q.project), String(q.category), hours);
          return json(res, 200, { ok: true });
        }
        case 'POST /api/block': {
          const date = String(q.date ?? '');
          const category = q.category ? String(q.category) : null;
          const problem = blockEditProblem(engine.config, engine.store, date, Number(q.blockId), category);
          if (problem) return json(res, engine.store.isLocked(date) ? 409 : 400, { error: problem });
          engine.store.editBlock(date, Number(q.blockId), category);
          return json(res, 200, { ok: true });
        }
        case 'POST /api/confirm': {
          const date = String(q.date ?? '');
          if (!engine.store.getDay(date)) return json(res, 400, { error: `${date} is not computed yet` });
          if (engine.store.isLocked(date)) return json(res, 409, { error: `${date} is locked; unlock it first` });
          engine.store.editConfirm(date, q.confirmed !== false);
          return json(res, 200, { ok: true });
        }
        case 'POST /api/lock':
        case 'POST /api/unlock': {
          const on = pathname === '/api/lock';
          const dates: unknown[] = Array.isArray(q.dates) ? q.dates : [q.date];
          if (!dates.length || dates.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) return json(res, 400, { error: 'expected date or dates (YYYY-MM-DD)' });
          const changed: string[] = [];
          for (const d of dates as string[]) {
            if ((on && !engine.store.getDay(d)) || engine.store.isLocked(d) === on) continue;
            engine.store.setMark(d, 'locked', on, on ? 'locked by hand' : '');
            changed.push(d);
          }
          return json(res, 200, { ok: true, changed });
        }
        case 'POST /api/undo': {
          const date = typeof q.date === 'string' && q.date ? q.date : undefined;
          const next = engine.store.edits(date, 500).find((x) => !x.undone);
          if (!next) return json(res, 404, { error: 'nothing to undo' });
          if (engine.store.isLocked(next.date)) return json(res, 409, { error: `the last edit is on ${next.date}, which is locked` });
          return json(res, 200, { ok: true, edit: engine.store.undo(date) });
        }
        case 'GET /api/history':
          return json(res, 200, { edits: engine.store.edits(q.date || undefined) });

        case 'GET /api/config':
          return json(res, 200, { config: engine.config, defaults: defaultConfig(), path: contractHome(CONFIG_PATH), exists: configExists() });
        case 'GET /api/detect':
          return json(res, 200, await detectCached());

        case 'GET /api/jobs':
          adoptOrphans();
          return json(res, 200, { jobs: runner.list() });
        case 'POST /api/jobs/pause':
          return json(res, 200, { job: runner.pause(String(q.id)) });
        case 'POST /api/jobs/resume':
          return json(res, 200, { job: runner.resume(String(q.id)) });
        case 'POST /api/jobs/cancel':
          return json(res, 200, { job: runner.cancel(String(q.id)) });
        case 'PUT /api/config': {
          const next = q.config as Config;
          const errors = validateConfig(next);
          if (errors.length) return json(res, 400, { errors });
          const from = typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : undefined;
          if (q.from && !from) return json(res, 400, { errors: ['from must be a date (YYYY-MM-DD)'] });
          const oldKey = engine.key;
          save(next);
          engine = opts.rebuild ? opts.rebuild(next) : engine;
          const impact = applySettingsChange(engine.store, oldKey, computeKey(next), from);
          runner.restart();
          return json(res, 200, { ok: true, config: next, impact });
        }
        case 'POST /api/config/validate': {
          const errors = validateConfig(q.config);
          // What saving would do: count without changing anything.
          let recompute = 0;
          let locked = 0;
          if (!errors.length) {
            const key = computeKey(q.config);
            for (const d of engine.store.cachedDates()) {
              if (engine.store.isLocked(d)) locked++;
              else if (key !== engine.key && engine.store.getDay(d)?.computeKey !== key) recompute++;
            }
          }
          return json(res, 200, { errors, recompute, locked });
        }
        case 'POST /api/classifier/test': {
          const c = { ...engine.config.classifier, ...(q.classifier ?? {}) };
          const started = Date.now();
          try {
            const reply = await runClaude('Reply with exactly this JSON and nothing else: {"ok":true}', { command: c.command, model: c.model, cwd: CLASSIFIER_CWD, timeoutSeconds: Math.min(c.timeoutSeconds, 120) });
            return json(res, 200, { ok: /"ok"\s*:\s*true/.test(reply), seconds: (Date.now() - started) / 1000, reply: reply.slice(0, 200) });
          } catch (e) {
            return json(res, 200, { ok: false, seconds: (Date.now() - started) / 1000, error: (e as Error).message });
          }
        }
        case 'GET /api/paths':
        case 'POST /api/paths':
          return json(res, 200, { paths: await engine.unclassifiedPaths(Number(q.days ?? 60), q.config ?? engine.config) });

        case 'GET /api/auth':
          return json(res, 200, authStatus());
        case 'POST /api/auth/client': {
          const client = q.json ? parseClientJson(String(q.json)) : parseClientJson(JSON.stringify({ client_id: q.clientId, client_secret: q.clientSecret }));
          saveClient(client);
          return json(res, 200, authStatus());
        }
        case 'POST /api/auth/connect':
          await authorize(() => {});
          return json(res, 200, authStatus());
        case 'POST /api/auth/disconnect':
          disconnect({ forgetClient: q.forgetClient === true });
          return json(res, 200, authStatus());
        case 'GET /api/github':
          return json(res, 200, githubStatus());
        case 'POST /api/github/token':
          await addToken(String(q.label ?? ''), String(q.token ?? ''));
          return json(res, 200, githubStatus());
        case 'POST /api/github/remove':
          removeToken(String(q.label));
          return json(res, 200, githubStatus());
        case 'GET /api/calendars':
          return json(res, 200, { calendars: await listCalendars() });

        case 'GET /api/submit':
          return json(res, 200, submitStatus());
        case 'GET /api/submit/plan':
          return json(res, 200, submitPlan(q));
        case 'POST /api/submit/open': {
          const system = systemOf(q.system);
          if (submitRunner.running) throw new HttpError(409, 'A submission is running in the browser: wait for it or cancel it first');
          const target = engine.config.submit[system].url;
          if (!target) throw new HttpError(400, `Set the ${system === 'redmine' ? 'Redmine' : 'NetSuite'} address in Settings → Submission first`);
          const start = startUrl(system, target);
          if (!chromeAvailable()) throw new HttpError(400, 'Google Chrome is required for submission; install it from google.com/chrome');
          const session = await submit.ensure();
          let page = session.current();
          if (page.isClosed()) page = await session.context.newPage();
          await page.goto(start);
          await page.bringToFront().catch(() => {});
          return json(res, 200, submitStatus());
        }
        case 'POST /api/submit/close':
          if (submitRunner.running) throw new HttpError(409, 'A submission is running: cancel it first');
          await submit.close();
          return json(res, 200, submitStatus());
        case 'GET /api/submit/catalog': {
          const system = systemOf(q.system);
          const c = store.submitCatalog(system);
          return json(res, 200, { system, catalog: c?.data ?? null, discoveredAt: c?.discoveredAt ?? null });
        }
        case 'GET /api/submit/pairs':
          return json(res, 200, { pairs: bookedPairs() });
        case 'POST /api/submit/discover': {
          const system = systemOf(q.system);
          return json(res, 200, await submitRunner.discover(system));
        }
        case 'POST /api/submit/prepare': {
          const system = systemOf(q.system);
          const week = weekOf(q.week);
          return json(res, 200, await submitRunner.prepare(system, week));
        }
        case 'POST /api/submit/execute': {
          const system = systemOf(q.system);
          const week = weekOf(q.week);
          if (typeof q.fingerprint !== 'string') throw new HttpError(400, 'fingerprint is required: prepare first');
          return json(res, 200, { progress: submitRunner.execute(system, week, q.fingerprint) });
        }
        case 'POST /api/submit/cancel':
          return json(res, 200, { progress: submitRunner.cancel() });
        case 'GET /api/submit/run': {
          const system = q.system ? systemOf(q.system) : undefined;
          const week = q.week ? weekOf(q.week) : undefined;
          const progress = submitRunner.progress();
          const mine = progress && (!system || progress.system === system) && (!week || progress.week === week) ? progress : null;
          return json(res, 200, { progress: mine ? { ...mine, screenshots: mine.screenshots.map(contractHome) } : null, runs: runSummary(system, week) });
        }
        case 'POST /api/submit/capture': {
          const system = systemOf(q.system);
          const page = submit.current();
          if (!page || page.isClosed()) throw new HttpError(409, 'Open the browser first');
          await capture(page, system, String(q.label ?? '').slice(0, 80));
          return json(res, 200, submitStatus());
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof Busy ? 409 : e instanceof Abort ? 400 : 500;
      json(res, status, { error: (e as Error).message });
    }
  };
  return Object.assign(handler, {
    runner,
    submit,
    submitRunner,
    shutdown: async () => {
      runner.shutdown();
      submitRunner.cancel();
      await submit.close().catch(() => {});
    },
  });
}

export function serve(opts: AppOptions, port: number, open = false): Promise<void> {
  return new Promise((resolve) => {
    const app = createApp(opts);
    const server = createServer(app);
    // Closing mid-computation keeps the job: it is marked interrupted and resumes on the next start.
    // The submission browser gets a moment to close cleanly, but never holds the exit up.
    const stop = () => {
      Promise.race([app.shutdown(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`Timesheet: ${url}  (Ctrl+C to stop)`);
      if (open) execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], () => {});
    });
    server.on('close', resolve);
  });
}
