import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { CONFIG_PATH, configExists, contractHome, expandDirs, expandHome, loadConfig, saveConfig, validateConfig } from './core/config.ts';
import { describeBackend } from './core/secrets.ts';
import { packageRoot } from './core/paths.ts';
import { listClaudeCommands, resolveInvocation } from './core/claude-runner.ts';
import { JobRunner } from './core/jobs.ts';
import { openCodeAvailable } from './core/collectors/opencode.ts';
import type { Config } from './core/config.ts';
import { collectClaude } from './core/collectors/claude.ts';
import { collectOpenCode } from './core/collectors/opencode.ts';
import { repoRoot } from './core/collectors/git.ts';
import { authorize, disconnect, importClientFile, isConnected, listCalendars, loadClient, saveClient } from './core/collectors/gcal.ts';
import { GithubApi, activeTokens, addToken, removeToken, storedTokens } from './core/collectors/github.ts';
import { githubTokenHelp, githubTokenUrl } from './core/github-token.ts';
import { addDays, dayBounds, monthRange, resolveDate, resolveMonth, resolveWeek, today } from './core/dates.ts';
import { Engine } from './core/engine.ts';
import { FORMATS, render } from './core/format.ts';
import type { Format } from './core/format.ts';
import { Scope } from './core/scope.ts';
import { Store } from './core/store.ts';
import { chromeAvailable, PROFILE_DIR } from './core/submit/browser.ts';
import { buildPlan, describeTarget } from './core/submit/plan.ts';
import { SYSTEMS } from './core/submit/types.ts';
import type { SubmitRule, SystemId } from './core/submit/types.ts';

const ROOT = packageRoot();

const USAGE = `timesheet — NetSuite timesheets from Claude sessions, git, GitHub and Google Calendar

Usage:
  timesheet init [--web]                 setup wizard in the terminal, or in the browser with --web
  timesheet day [date]                   today | yesterday | -N | YYYY-MM-DD
  timesheet week [week]                  this | last | -N | any date in the week
  timesheet month [month]                this | last | YYYY-MM
  timesheet scope [list|review]          show or classify work / personal paths
  timesheet scope add work <glob> [project]
  timesheet scope add personal <glob>
  timesheet edit <date> <category> <hours|clear> [--project P]   override booked hours
  timesheet block <date> <blockId> <category|clear>               recategorize a time block
  timesheet auth [--client-file F]       connect Google Calendar (client + token go to the OS keychain)
  timesheet auth --logout | --forget     remove the token | token and OAuth client
  timesheet config [path|show|get K|set K V|edit|reset]   view or edit every option
  timesheet calendars                    choose which calendars count
  timesheet github [status]              GitHub tokens and what is tracked (issues, reviews, releases, approvals)
  timesheet github token [owner] [--open] which permissions a token needs, with a pre-filled link to create it
  timesheet github add <owner>           store a read-only token for an account or org (asked hidden)
  timesheet github remove <label>        remove a stored token
  timesheet submit login <redmine|netsuite>     log in once in the submission browser (SSO/MFA); the session is kept
  timesheet submit inspect <redmine|netsuite>   save sanitized snapshots of pages you open (for building the automation)
  timesheet submit plan [week]                  what would be entered in Redmine and NetSuite (read-only, --json)
  timesheet submit week [week] --system redmine  compare with the site, confirm, then enter the week (interactive)
  timesheet serve [--port 4280] [--open] local web app: timesheet, calendar, settings
  timesheet install-skill                install the /timesheet Claude Code skill
  timesheet doctor                       check sources, credentials storage and setup

Report options:
  --format grid|lines|daily|internal     output format (default: day → internal+daily, week/month → grid)
  --target <hours>                       normalize to this many hours per day (default from config)
  --real                                 book real rounded hours instead of normalized ones
  --copy                                 copy the NetSuite output to the clipboard
  --no-header                            omit header rows (paste straight into grid cells)
  --refresh                              recompute cached days
  --no-llm                               skip the Claude classification call (hints only)
  --json                                 machine-readable output`;

// Relative offsets like -2 would be read as flags; shield them and restore them as positionals.
const OFFSET = /^[+-]\d+$/;
const OPTIONS = {
    format: { type: 'string' },
    target: { type: 'string' },
    real: { type: 'boolean' },
    copy: { type: 'boolean' },
    'no-header': { type: 'boolean' },
    refresh: { type: 'boolean' },
    'no-llm': { type: 'boolean' },
    json: { type: 'boolean' },
    project: { type: 'string' },
    port: { type: 'string' },
    logout: { type: 'boolean' },
    forget: { type: 'boolean' },
    'client-file': { type: 'string' },
    open: { type: 'boolean' },
    web: { type: 'boolean' },
    system: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
} as const;

/** Parses argv; a mistyped option prints a one-line error with the closest match instead of a stack trace. */
function parseCli() {
  try {
    return parseArgs({ args: process.argv.slice(2).map((a) => (OFFSET.test(a) ? `@offset${a}` : a)), allowPositionals: true, options: OPTIONS });
  } catch (e) {
    const bad = /option '([^']+)'/.exec((e as Error).message)?.[1] ?? '';
    const name = bad.replace(/^-+/, '').replace(/[^a-z-]/g, '');
    const guess = Object.keys(OPTIONS).find((o) => o === name || o.startsWith(name) || name.startsWith(o));
    console.error(`timesheet: unknown option ${bad || (e as Error).message}${guess ? ` (did you mean --${guess}?)` : ''}\nRun \`timesheet --help\` for all options.`);
    process.exit(1);
  }
}

const { values: flags, positionals: rawPositionals } = parseCli();

const positionals = rawPositionals.map((a) => a.replace(/^@offset/, ''));
const [command, ...args] = positionals;

function fail(msg: string): never {
  console.error(`timesheet: ${msg}`);
  process.exit(1);
}

function copy(text: string) {
  spawnSync('pbcopy', { input: text });
  console.error('(copied to clipboard)');
}

function engine(config = loadConfig()): Engine {
  return new Engine({
    config,
    store: new Store(),
    classifier: flags['no-llm'] ? null : undefined,
    log: flags.json ? undefined : (m) => console.error(m),
  });
}

/**
 * Computes missing days as a persisted job: Ctrl+C pauses it (finished days are kept), and
 * the same command later continues where it stopped, also after a crash.
 */
async function computeResumable(e: Engine, from: string, to: string, refresh: boolean) {
  const runner = new JobRunner(() => e, e.store);
  runner.reconcile();
  const job = runner.startOrResume(from, to, refresh);
  if (!job) return;
  if (job.elsewhere) {
    console.error('Another timesheet process (e.g. the web app) is computing these days; waiting for it…');
    while (runner.get(job.id)?.status === 'running') await new Promise((r) => setTimeout(r, 2000));
    return;
  }
  else if (job.done.length) console.error(`Continuing: ${job.done.length}/${job.dates.length} days already done.`);
  const onInt = () => {
    runner.pause(job.id);
    const v = runner.get(job.id);
    console.error(`\nPaused (${v?.done.length ?? 0}/${job.dates.length} days done). Run the same command to continue.`);
    process.exit(130);
  };
  process.once('SIGINT', onInt);
  try {
    await runner.wait(job.id);
  } finally {
    process.off('SIGINT', onInt);
  }
}

function rangeFor(cmd: string, arg: string | undefined): [string, string] {
  if (cmd === 'day') {
    const d = resolveDate(arg);
    return [d, d];
  }
  if (cmd === 'week') {
    const monday = resolveWeek(arg);
    return [monday, addDays(monday, 6)];
  }
  return monthRange(resolveMonth(arg));
}

async function report(cmd: 'day' | 'week' | 'month') {
  if (!configExists()) console.error('No config yet; using defaults. Run `timesheet init` to set up work repos.\n');
  const [from, to] = rangeFor(cmd, args[0]);
  if (from > today()) fail(`${from} is in the future`);
  const target = flags.target !== undefined ? Number(flags.target) : undefined;
  if (target !== undefined && !(target >= 0)) fail('--target must be a non-negative number');
  const format = flags.format as Format | undefined;
  if (format && !FORMATS.includes(format)) fail(`--format must be one of ${FORMATS.join(', ')}`);

  const e = engine();
  await computeResumable(e, from, to, !!flags.refresh);
  const reports = await e.days(from, to, { target });
  const opts = { header: !flags['no-header'], real: flags.real };
  const pasteFormat: Format = format && format !== 'internal' ? format : cmd === 'day' ? 'daily' : 'grid';
  const paste = render(pasteFormat, reports, e.config, opts);

  if (flags.json) {
    console.log(JSON.stringify({ from, to, format: pasteFormat, paste, internal: render('internal', reports, e.config), days: reports }, null, 2));
  } else if (format) {
    console.log(render(format, reports, e.config, opts));
  } else if (cmd === 'day') {
    console.log(render('internal', reports, e.config));
    console.log(`\nNetSuite:\n${paste || '(nothing to book)'}`);
  } else {
    console.log(paste || '(nothing to book)');
    const total = reports.reduce((s, r) => s + r.total, 0);
    const real = reports.reduce((s, r) => s + r.realTotal, 0);
    const partial = reports.filter((r) => r.status === 'partial').map((r) => r.date);
    console.error(`\n${from} → ${to}: booked ${total}h, real ${real.toFixed(2)}h${partial.length ? ` · partial: ${partial.join(', ')}` : ''}`);
    const warnings = [...new Set(reports.flatMap((r) => r.warnings))];
    for (const w of warnings) console.error(`⚠ ${w}`);
  }
  if (flags.copy) copy(paste);
}

// ---------- submission ----------

function systemArg(value: string | undefined): SystemId {
  if (value === 'redmine' || value === 'netsuite') return value;
  fail('expected redmine or netsuite');
}

async function submitPlan(arg: string | undefined) {
  const monday = resolveWeek(arg);
  const sunday = addDays(monday, 6);
  if (monday > today()) fail(`${monday} is in the future`);
  const e = engine();
  await computeResumable(e, monday, sunday, false);
  const reports = await e.days(monday, sunday);
  const results = SYSTEMS.map((system) => ({
    system,
    ...buildPlan({ system, week: monday, reports, today: today(), rules: e.config.submit[system].rules as SubmitRule<object>[] }),
  }));
  if (flags.json) {
    console.log(JSON.stringify({ week: monday, systems: results }, null, 2));
    return;
  }
  for (const r of results) {
    console.log(`\n${r.system}${e.config.submit[r.system].fillOnly ? ' (fill only)' : ''}:`);
    if (!r.ok) {
      for (const reason of r.reasons) console.log(`  ✗ ${reason}`);
      continue;
    }
    if (!r.plan.cells.length) console.log('  (nothing to enter)');
    for (const c of r.plan.cells) console.log(`  ${c.date}  ${describeTarget(r.system, c.target).padEnd(44)} ${c.hours.toFixed(2)}`);
    for (const n of r.plan.notes) console.log(`  ⚠ ${n}`);
  }
}

/** Prepares a week, shows the comparison, asks for confirmation and enters it; never without a terminal. */
async function submitWeek(arg: string | undefined) {
  const system = systemArg(typeof flags.system === 'string' ? flags.system : 'redmine');
  if (flags.json) fail('submit week cannot be scripted; use `timesheet submit plan --json` to look at a plan');
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('submit week is interactive: run it in a terminal');
  const monday = resolveWeek(arg);
  if (monday > today()) fail(`${monday} is in the future`);
  const e = engine();
  const last = addDays(monday, 6) < today() ? addDays(monday, 6) : today();
  await computeResumable(e, monday, last, false);
  const reports = await e.days(monday, last);
  const { interruptHandler, SubmitRunner } = await import('./core/submit/run.ts');
  const { SubmitSession } = await import('./core/submit/session.ts');
  const session = new SubmitSession();
  const runner = new SubmitRunner({ store: e.store, config: () => e.config, today, reports: async () => ({ reports }), session });
  const rl = prompter();
  const prompt = (q: string) => Promise.race([Promise.resolve().then(() => rl.question(q)).catch(() => null), rl.closed.then(() => null)]);
  const list = (cells: { date: string; label: string; hours: number }[]) => {
    for (const c of cells) console.log(`  ${c.date}  ${c.label.padEnd(60)} ${c.hours.toFixed(2)}`);
  };
  // Ctrl+C (from readline in raw mode, or a real SIGINT) and Ctrl-D cancel the run; the process never
  // quits while it runs, since an Update may be in flight: it waits for the run to settle and report.
  let settled = false;
  const onInterrupt = interruptHandler(runner, (m) => console.error(m));
  const onClose = () => {
    if (!settled && runner.running) onInterrupt();
  };
  let offInterrupt = () => {};
  try {
    let prep = await runner.prepare(system, monday);
    while (prep.state === 'login') {
      console.log(`${system}: ${prep.reason}`);
      const answer = await prompt('Log in in the browser window, then press Enter (q to quit) ');
      if (answer === null || answer.trim() === 'q') return;
      prep = await runner.prepare(system, monday);
    }
    console.log(`\n${system}, week of ${monday}:`);
    if (prep.state === 'blocked' || prep.state === 'conflict') {
      for (const r of prep.reasons) console.log(`  ✗ ${r}`);
      console.log(prep.state === 'conflict' ? 'The site holds other values: nothing written. Fix it on the site or in the timesheet, then retry.' : 'Nothing written.');
      process.exitCode = 1;
      return;
    }
    if (prep.state === 'aborted') {
      console.log(`  ✗ ${prep.reason}`);
      for (const s of prep.screenshots) console.log(`  screenshot: ${contractHome(s)}`);
      process.exitCode = 1;
      return;
    }
    if (prep.state === 'noop') {
      console.log('  Everything is already entered.');
      return;
    }
    for (const n of prep.notes) console.log(`  ⚠ ${n}`);
    if (prep.unchanged) console.log(`  ${prep.unchanged} already entered, unchanged.`);
    console.log(`  To enter (${prep.write.length}):`);
    list(prep.write);
    console.log(prep.fillOnly ? '\nFill only: each day is filled in and you press Update in the browser window.' : '\nEach day is filled in and saved (Update pressed) automatically, then checked.');
    const answer = await prompt('Type yes to continue: ');
    if (answer?.trim() !== 'yes') {
      console.log('Nothing written.');
      return;
    }
    process.on('SIGINT', onInterrupt);
    offInterrupt = rl.onInterrupt(onInterrupt);
    void rl.closed.then(onClose);
    runner.execute(system, monday, prep.fingerprint);
    let shown = '';
    const timer = setInterval(() => {
      const p = runner.progress();
      if (p && p.message !== shown && p.status === 'running') console.log(`  … ${(shown = p.message)}`);
    }, 300);
    const done = await runner.wait();
    settled = true;
    clearInterval(timer);
    if (!done) return;
    for (const u of done.units) console.log(`  ${u.unit}: ${u.state}`);
    if (done.status === 'saved') console.log(`Done: ${done.message.toLowerCase()}.`);
    else {
      console.log(done.status === 'failed' ? `✗ Failed: ${done.error}\nCheck ${system} by hand; nothing is retried.` : `✗ Stopped: ${done.error}`);
      for (const s of done.screenshots) console.log(`  screenshot: ${contractHome(s)}`);
      process.exitCode = 1;
    }
  } finally {
    // Also when something above threw: never close the browser under a running submission.
    await runner.wait().catch(() => null);
    settled = true;
    process.off('SIGINT', onInterrupt);
    offInterrupt();
    rl.close();
    await session.close();
  }
}

async function submitCmd() {
  const [sub, arg] = args;
  const problems = validateConfig(loadConfig());
  if (problems.length) fail(`fix the config first (timesheet doctor):\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
  if (sub === 'plan') return submitPlan(arg);
  if (sub === 'week') return submitWeek(arg);
  if (sub !== 'login' && sub !== 'inspect') fail('usage: timesheet submit login|inspect <redmine|netsuite> | plan [week] | week [week] --system redmine');
  const system = systemArg(arg);
  if (!process.stdin.isTTY) fail(`submit ${sub} is interactive: run it in a terminal`);
  const url = loadConfig().submit[system].url;
  if (!url) fail(`set the ${system} address first: timesheet config set submit.${system}.url https://…`);
  const { openBrowser } = await import('./core/submit/browser.ts');
  const { capture, INSPECT_DIR } = await import('./core/submit/inspect.ts');
  const { startUrl } = await import('./core/submit/session.ts');
  const start = startUrl(system, url);
  const session = await openBrowser();
  const rl = prompter();
  // Ctrl-D / Ctrl-C close the prompt; a pending question would otherwise never settle (null = closed).
  const prompt = (q: string) => Promise.race([Promise.resolve().then(() => rl.question(q)).catch(() => null), rl.closed.then(() => null)]);
  try {
    await session.page.goto(start);
    if (sub === 'login') {
      if ((await prompt(`Log in to ${system} in the browser window, then press Enter here. `)) !== null) console.log(`Session kept in ${contractHome(PROFILE_DIR)}.`);
      return;
    }
    console.error('Log in if needed and open a page to capture (Redmine: Worktime for a day; NetSuite: the weekly timesheet in edit mode).');
    console.error('Then type a short label and press Enter. An empty line finishes.');
    for (;;) {
      const label = (await prompt('label> '))?.trim();
      if (!label) break;
      const files = await capture(session.current(), system, label);
      console.error(`  saved ${contractHome(files.html)} (+ .png)`);
    }
    console.error(`Look through ${contractHome(join(INSPECT_DIR, system))} before sharing: screenshots show your own data.`);
  } finally {
    rl.close();
    await session.close();
  }
}

// ---------- setup ----------

interface Prompter {
  question: (q: string) => Promise<string>;
  hidden: (q: string) => Promise<string>;
  /** Settles when the interface closes (Ctrl-D, Ctrl-C or close()) */
  closed: Promise<void>;
  close: () => void;
  /**
   * Calls fn on Ctrl+C. In a terminal readline reads Ctrl+C itself (raw mode), so the process gets
   * no SIGINT: without a listener readline just closes. Returns a function that removes it.
   */
  onInterrupt: (fn: () => void) => () => void;
}

/** Readline prompts, with a hidden variant for secrets (typed characters are not echoed). */
function prompter(): Prompter {
  let muted = false;
  const output = new Writable({
    write(chunk, enc, cb) {
      if (!muted) process.stdout.write(chunk, enc);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const closed = new Promise<void>((resolve) => rl.once('close', resolve));
  return {
    closed,
    question: (q) => rl.question(q),
    hidden: async (q) => {
      process.stdout.write(q);
      muted = true;
      try {
        return await rl.question('');
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
    onInterrupt: (fn) => {
      rl.on('SIGINT', fn);
      return () => {
        rl.off('SIGINT', fn);
      };
    },
  };
}

async function ask(rl: Prompter, q: string, dflt = ''): Promise<string> {
  const a = (await rl.question(`${q}${dflt ? ` [${dflt}]` : ''}: `)).trim();
  return a || dflt;
}

const GOOGLE_HELP = `Google Calendar needs an OAuth "Desktop app" client (created once per team or per person):
  1. https://console.cloud.google.com → project → APIs & Services → enable "Google Calendar API"
  2. Google Auth Platform → Audience: Internal (Workspace) or External + add yourself as test user
     Data access: add scope .../auth/calendar.readonly
  3. Clients → Create client → Desktop app → Download JSON
The client is stored in ${'${describeBackend()}'}; the downloaded file is deleted after import.`;

/** Stores an OAuth client if none is configured, then runs the browser consent flow. Returns false if skipped. */
async function connectGoogle(rl: Prompter, clientFile?: string): Promise<boolean> {
  if (clientFile) {
    importClientFile(expandHome(clientFile));
    console.log(`Stored the OAuth client in ${describeBackend()} and deleted ${clientFile}.`);
  } else if (!loadClient()) {
    console.log('\n' + GOOGLE_HELP.replace('${describeBackend()}', describeBackend()) + '\n');
    const a = await ask(rl, 'Path to the downloaded client JSON (Enter = type ID/secret, "skip" = later)');
    if (a.toLowerCase() === 'skip') return false;
    if (a) {
      importClientFile(expandHome(a.replace(/^['"]|['"]$/g, '')));
      console.log(`Stored in ${describeBackend()}; deleted the plaintext file.`);
    } else {
      const client_id = await ask(rl, 'Client ID');
      const client_secret = (await rl.hidden('Client secret (hidden): ')).trim();
      saveClient({ client_id, client_secret });
      console.log(`Stored in ${describeBackend()}.`);
    }
  }
  await authorize();
  console.log(`Connected. Token stored in ${describeBackend()}.`);
  return true;
}

function gitEmail(): string {
  try {
    return execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Repo roots (or cwds outside repos) seen in Claude sessions over the last `days` days, with session-span counts. */
async function seenPaths(config: Config, days: number): Promise<Map<string, number>> {
  const to = dayBounds(today())[1];
  const from = to - days * 86_400_000;
  const events = [...(await collectClaude(config, from, to)), ...(await collectOpenCode(config, from, to).catch(() => []))];
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (!ev.path) continue;
    const p = repoRoot(ev.path) ?? ev.path;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

async function chooseProject(rl: Prompter, config: Config): Promise<string> {
  if (config.projects.length === 1) return config.projects[0];
  const list = config.projects.map((p, i) => `${i + 1}) ${p}`).join('  ');
  const a = await ask(rl, `  project? ${list}`, '1');
  return config.projects[Number(a) - 1] ?? (config.projects.includes(a) ? a : config.defaultProject);
}

async function reviewScope(rl: Prompter, config: Config, paths: Map<string, number>) {
  const scope = new Scope(config);
  const unknown = [...paths].filter(([p]) => scope.resolve(p).kind === 'unknown');
  if (!unknown.length) {
    console.log('Every path seen in your Claude sessions is already classified.');
    return;
  }
  const groups = new Map<string, [string, number][]>();
  for (const [p, n] of unknown) {
    const parent = dirname(p);
    groups.set(parent, [...(groups.get(parent) ?? []), [p, n]]);
  }
  console.log('\nClassify where you work. w = work, p = personal, e = decide per repo, s = skip for now.');
  for (const [parent, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const n = items.reduce((s, [, c]) => s + c, 0);
    const names = items.slice(0, 6).map(([p]) => p.slice(parent.length + 1) || '.').join(', ');
    const a = (await ask(rl, `${contractHome(parent)}/ (${items.length} dirs, ${n} session spans: ${names}${items.length > 6 ? ', …' : ''}) w/p/e/s`, items.length > 1 ? 'e' : 's')).toLowerCase();
    if (a === 'w') config.scope.work.push({ path: `${contractHome(parent)}/**`, project: await chooseProject(rl, config) });
    else if (a === 'p') config.scope.personal.push(`${contractHome(parent)}/**`);
    else if (a === 'e') {
      for (const [p, c] of items) {
        const b = (await ask(rl, `  ${contractHome(p)} (${c}) w/p/s`, 's')).toLowerCase();
        if (b === 'w') config.scope.work.push({ path: `${contractHome(p)}/**`, project: await chooseProject(rl, config) });
        else if (b === 'p') config.scope.personal.push(`${contractHome(p)}/**`);
      }
    }
  }
}

async function chooseCalendars(rl: Prompter, config: Config) {
  const cals = await listCalendars();
  cals.forEach((c, i) => console.log(`  ${i + 1}) ${c.summary}${c.primary ? ' (primary)' : ''}  ${c.id}`));
  const primary = cals.findIndex((c) => c.primary) + 1;
  const a = await ask(rl, 'Which calendars count as work? (comma-separated numbers)', String(primary || 1));
  config.calendar.calendarIds = a.split(',').map((x) => cals[Number(x.trim()) - 1]?.id).filter(Boolean) as string[];
  config.calendar.enabled = config.calendar.calendarIds.length > 0;
}

async function init() {
  const config = loadConfig();
  const rl = prompter();
  try {
    console.log(`Setting up ${contractHome(CONFIG_PATH)}\n`);
    console.log('Activity sources found on this machine:');
    for (const d of expandDirs(config.claudeDirs)) console.log(`  ✓ Claude Code ${contractHome(d)}`);
    console.log(`  ${openCodeAvailable(config) ? '✓' : '·'} OpenCode ${config.opencodeDirs.map(contractHome).join(', ')}`);
    console.log('  (edit later with `timesheet config edit` or in `timesheet serve` → Settings)\n');
    const emails = await ask(rl, 'Your git author emails (comma-separated)', config.authorEmails.join(', ') || gitEmail());
    config.authorEmails = emails.split(',').map((s) => s.trim()).filter(Boolean);
    const projects = await ask(rl, 'NetSuite projects you book on (comma-separated, first is default)', config.projects.join(', '));
    config.projects = projects.split(',').map((s) => s.trim()).filter(Boolean);
    config.defaultProject = config.projects[0] ?? 'Default';
    config.target = Number(await ask(rl, 'Target hours per workday', String(config.target))) || config.target;
    config.decimalSeparator = (await ask(rl, 'Decimal separator for NetSuite (. or ,)', config.decimalSeparator)) === ',' ? ',' : '.';
    config.dateFormat = await ask(rl, 'Date format for pasted lines', config.dateFormat);

    console.log('\nScanning Claude sessions from the last 90 days…');
    await reviewScope(rl, config, await seenPaths(config, 90));

    if ((await ask(rl, '\nTrack GitHub actions (issues, reviews, releases, deployment approvals)? y/n', config.github.enabled ? 'n' : 'y')).toLowerCase() === 'y') {
      if (await addGithubToken(rl)) config.github.enabled = true;
    }

    if ((await ask(rl, '\nConnect Google Calendar now? y/n', isConnected() ? 'n' : 'y')).toLowerCase() === 'y') {
      if (await connectGoogle(rl)) await chooseCalendars(rl, config);
      else console.log('Skipped. Run `timesheet auth` whenever you are ready.');
    }
    saveConfig(config);
    console.log(`\nSaved ${contractHome(CONFIG_PATH)}. Try: timesheet day yesterday`);
  } finally {
    rl.close();
  }
}

async function scopeCmd() {
  const config = loadConfig();
  const [sub, kind, glob, project] = args;
  if (!sub || sub === 'list') {
    console.log('Work:');
    for (const r of config.scope.work) console.log(`  ${r.path} → ${r.project ?? config.defaultProject}`);
    console.log('Personal:');
    for (const p of config.scope.personal) console.log(`  ${p}`);
    const unknown = await engine(config).unclassifiedPaths(30);
    if (unknown.length) {
      console.log('Unclassified (last 30 days) — run `timesheet scope review`:');
      for (const u of unknown.slice(0, 20)) console.log(`  ${contractHome(u.path)} (${u.sessions})`);
    }
    return;
  }
  if (sub === 'add') {
    if (!glob || (kind !== 'work' && kind !== 'personal')) fail('usage: timesheet scope add work|personal <glob> [project]');
    const path = contractHome(expandHome(glob).replace(/\/$/, ''));
    const full = path.includes('*') ? path : `${path}/**`;
    if (kind === 'work') {
      if (project && !config.projects.includes(project)) config.projects.push(project);
      config.scope.work.push({ path: full, project: project ?? config.defaultProject });
    } else config.scope.personal.push(full);
    saveConfig(config);
    console.log(`Added ${kind}: ${full}. Cached days touching it will be recomputed.`);
    return;
  }
  if (sub === 'review') {
    const rl = prompter();
    try {
      await reviewScope(rl, config, await seenPaths(config, 60));
      saveConfig(config);
    } finally {
      rl.close();
    }
    return;
  }
  fail(`unknown scope command "${sub}"`);
}

async function editCmd() {
  const [date, category, hours] = args;
  if (!date || !category || hours === undefined) fail('usage: timesheet edit <date> <category> <hours|clear> [--project P]');
  const config = loadConfig();
  if (!config.categories.some((c) => c.name === category)) fail(`unknown category "${category}"`);
  const store = new Store();
  store.setOverride(resolveDate(date), flags.project ?? config.defaultProject, category, hours === 'clear' ? null : Number(hours));
  console.log('Saved.');
}

async function blockCmd() {
  const [date, id, category] = args;
  if (!date || !id || !category) fail('usage: timesheet block <date> <blockId> <category|clear>');
  const config = loadConfig();
  if (category !== 'clear' && !config.categories.some((c) => c.name === category)) fail(`unknown category "${category}"`);
  new Store().setBlockOverride(resolveDate(date), Number(id), category === 'clear' ? null : category);
  console.log('Saved.');
}

async function authCmd() {
  if (flags.logout || flags.forget) {
    disconnect({ forgetClient: flags.forget });
    console.log(flags.forget ? 'Removed the Google token and OAuth client.' : 'Removed the Google token.');
    return;
  }
  const rl = prompter();
  try {
    if (!(await connectGoogle(rl, flags['client-file']))) return;
    const config = loadConfig();
    await chooseCalendars(rl, config);
    saveConfig(config);
  } finally {
    rl.close();
  }
}

function openUrl(url: string) {
  spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
}

/** Asks for tokens until the user stops, showing how to create each one; returns whether any was stored. */
async function addGithubToken(rl: Prompter, label?: string): Promise<boolean> {
  let added = false;
  for (;;) {
    const name = label ?? (await ask(rl, 'GitHub account or organization for this token ("skip" = later)', storedTokens().length || added ? 'skip' : ''));
    if (!name || name.toLowerCase() === 'skip') return added;
    console.log(`\n${githubTokenHelp(name)}\n\nThe token is stored in ${describeBackend()}.\n`);
    if ((await ask(rl, 'Open the link in your browser? y/n', 'y')).toLowerCase() === 'y') openUrl(githubTokenUrl(name));
    const token = (await rl.hidden('Token (hidden): ')).trim();
    try {
      const t = await addToken(name, token);
      console.log(`Stored "${t.label}" (acts as ${t.login}).`);
      added = true;
    } catch (e) {
      console.error(`Not stored: ${(e as Error).message}`);
    }
    if (label) return added;
  }
}

async function githubCmd() {
  const [sub = 'status', label] = args;
  const config = loadConfig();
  if (sub === 'add') {
    const rl = prompter();
    try {
      if (await addGithubToken(rl, label) && !config.github.enabled) {
        config.github.enabled = true;
        saveConfig(config);
        console.log('GitHub tracking enabled.');
      }
    } finally {
      rl.close();
    }
    return;
  }
  if (sub === 'token') {
    console.log(githubTokenHelp(label));
    if (flags.open) openUrl(githubTokenUrl(label));
    return;
  }
  if (sub === 'remove') {
    if (!label) fail('usage: timesheet github remove <label>');
    if (!removeToken(label)) fail(`no stored token "${label}" (see \`timesheet github\`)`);
    console.log(`Removed "${label}".`);
    return;
  }
  if (sub !== 'status') fail(`unknown github command "${sub}"`);
  console.log(`GitHub tracking: ${config.github.enabled ? 'on' : 'off (timesheet config set github.enabled true)'}`);
  console.log(`Extra repos: ${config.github.repos.join(', ') || '(none; clones and repos you acted in are found automatically)'}`);
  const { tokens, source } = activeTokens();
  if (!tokens.length) {
    console.log('No token. Run `timesheet github add <owner>` (or `timesheet github token <owner>` to see how to create one).');
    return;
  }
  console.log(`Tokens (${source === 'stored' ? describeBackend() : source === 'env' ? 'TIMESHEET_GITHUB_TOKEN' : 'gh CLI'}):`);
  const api = new GithubApi(tokens);
  for (const t of tokens) {
    const who = await api.rest<{ login: string }>(t, '/user').then((u) => `✓ ${u.login}`, (e: Error) => `✗ ${e.message}`);
    console.log(`  ${t.label}: ${who}`);
  }
}

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce((o, k) => (o[k] ??= {}), obj);
  parent[last] = value;
}

function saveValidated(config: Config) {
  const errors = validateConfig(config);
  if (errors.length) fail(`config not saved:\n  - ${errors.join('\n  - ')}`);
  saveConfig(config);
}

async function configCmd() {
  const [sub, key, ...rest] = args;
  const config = loadConfig();
  if (!sub || sub === 'path') {
    console.log(CONFIG_PATH);
    return;
  }
  if (sub === 'show' || (sub === 'get' && !key)) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (sub === 'get') {
    const v = getPath(config, key);
    if (v === undefined) fail(`no config key "${key}"`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    return;
  }
  if (sub === 'set') {
    if (!key || !rest.length) fail('usage: timesheet config set <key.path> <value>   (value is JSON, or a plain string)');
    const raw = rest.join(' ');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    setPath(config, key, value);
    saveValidated(config);
    console.log(`Set ${key}.`);
    return;
  }
  if (sub === 'edit') {
    if (!configExists()) saveConfig(config);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    for (;;) {
      spawnSync(editor, [CONFIG_PATH], { stdio: 'inherit', shell: true });
      let errors: string[];
      try {
        errors = validateConfig({ ...loadConfig() });
      } catch (e) {
        errors = [`invalid JSON: ${(e as Error).message}`];
      }
      if (!errors.length) {
        console.log('Config saved and valid.');
        return;
      }
      console.error(`Config has problems:\n  - ${errors.join('\n  - ')}`);
      const rl = prompter();
      const again = await ask(rl, 'Edit again? (n restores the previous version)', 'y');
      rl.close();
      if (again.toLowerCase() !== 'y') {
        saveConfig(config);
        console.log('Restored the previous config.');
        return;
      }
    }
  }
  if (sub === 'reset') {
    writeFileSync(CONFIG_PATH + '.bak', existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH) : '{}');
    const { defaultConfig } = await import('./core/config.ts');
    saveConfig(defaultConfig());
    console.log(`Reset to defaults (previous saved as ${contractHome(CONFIG_PATH)}.bak).`);
    return;
  }
  fail(`unknown config command "${sub}"`);
}

function doctor() {
  const config = loadConfig();
  const mark = (ok: boolean) => (ok ? '✓' : '·');
  const line = (ok: boolean, text: string) => console.log(`  ${mark(ok)} ${text}`);
  console.log(`Config: ${contractHome(CONFIG_PATH)}${configExists() ? '' : ' (not created yet: run `timesheet init`)'}`);
  const problems = configExists() ? validateConfig(config) : [];
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log('Sources:');
  const profiles = expandDirs(config.claudeDirs);
  line(profiles.length > 0, `Claude Code: ${profiles.length} profile(s) from ${config.claudeDirs.join(', ')}${config.claudeHistory ? ' + history.jsonl' : ''}`);
  for (const d of profiles) console.log(`      ${contractHome(d)}`);
  line(openCodeAvailable(config), `OpenCode ${config.opencodeDirs.map(contractHome).join(', ') || '(off)'}`);
  line(spawnSync('git', ['--version']).status === 0, 'git');
  const known = listClaudeCommands();
  line(known.includes(config.classifier.command) || resolveInvocation(config.classifier.command, []).viaShell === false, `classifier command "${config.classifier.command}"${known.length ? ` (available: ${known.join(', ')})` : ''}`);
  console.log(`Work scope: ${config.scope.work.length} work rule(s), ${config.scope.personal.length} personal rule(s)`);
  console.log(`Credentials storage: ${describeBackend()}`);
  line(loadClient() !== null, 'Google OAuth client stored');
  line(isConnected(), `Google Calendar connected${config.calendar.enabled ? '' : ' (calendar disabled in config)'}`);
  const gh = activeTokens();
  line(gh.tokens.length > 0, `GitHub: ${gh.tokens.length ? `${gh.tokens.length} token(s) from ${gh.source === 'stored' ? 'the secret store' : gh.source === 'env' ? 'TIMESHEET_GITHUB_TOKEN' : 'the gh CLI'}` : 'no token'}${config.github.enabled ? '' : ' (disabled in config)'}`);
  console.log('Submission:');
  for (const s of SYSTEMS) {
    const c = config.submit?.[s];
    const rules = Array.isArray(c?.rules) ? `${c.rules.length} mapping rule(s)` : 'rules are not a list';
    line(!!c?.url, `${s}: ${c?.url || 'no address (submit.' + s + '.url)'} · ${rules} · ${c?.fillOnly ? 'fill only' : 'saves'}`);
  }
  line(chromeAvailable(), `Google Chrome${chromeAvailable() ? '' : ' not found (needed for submission)'}`);
  line(existsSync(PROFILE_DIR), `browser profile ${contractHome(PROFILE_DIR)}${existsSync(PROFILE_DIR) ? '' : ' (created by `timesheet submit login`)'}`);
  if (problems.length) process.exitCode = 1;
}

function installSkill() {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const target = join(configDir, 'skills', 'timesheet');
  mkdirSync(target, { recursive: true });
  cpSync(join(ROOT, 'skills', 'timesheet', 'SKILL.md'), join(target, 'SKILL.md'));
  console.log(`Installed skill to ${contractHome(target)}`);
}

async function main() {
  if (flags.help || !command) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case 'day':
    case 'week':
    case 'month':
      return report(command);
    case 'init':
      if (flags.web) {
        const { serve } = await import('./web/server.ts');
        return serve({ engine: engine(), rebuild: (config) => engine(config) }, Number(flags.port ?? 4280), true);
      }
      return init();
    case 'scope':
      return scopeCmd();
    case 'edit':
      return editCmd();
    case 'block':
      return blockCmd();
    case 'auth':
      return authCmd();
    case 'config':
      return configCmd();
    case 'github':
      return githubCmd();
    case 'submit':
      return submitCmd();
    case 'calendars': {
      const config = loadConfig();
      const rl = prompter();
      try {
        await chooseCalendars(rl, config);
      } finally {
        rl.close();
      }
      saveConfig(config);
      console.log(`Calendar ${config.calendar.enabled ? 'enabled' : 'disabled'}: ${config.calendar.calendarIds.join(', ')}`);
      return;
    }
    case 'serve': {
      const { serve } = await import('./web/server.ts');
      return serve({ engine: engine(), rebuild: (config) => engine(config) }, Number(flags.port ?? 4280), flags.open);
    }
    case 'install-skill':
      return installSkill();
    case 'doctor':
      return doctor();
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((e: Error) => fail(e.message));

