import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { Billing, Budgets, Context, History, Limit, Limits, LiveAgent, LiveTask, Periods, Route, Sample, SavingCategory, Savings, Spend } from '../types'

/**
 * The folder the mods share (data, configs, event log): $CLAUDE_MODS_HOME, else ~/.claude-shared when it
 * already exists (installs from before the variable), else ~/.claude-mods. Profiles are told apart inside it.
 */
let modsHomeDir = ''
async function modsHome($: EngineInterface) {
  if (modsHomeDir) return modsHomeDir
  const set = await $.env.get('CLAUDE_MODS_HOME')
  const home = (await $.env.get('HOME')) ?? ''
  modsHomeDir = set ? set.replace(/\/+$/, '') : (await $.fs.exists(`${home}/.claude-shared`).catch(() => false)) ? `${home}/.claude-shared` : `${home}/.claude-mods`
  return modsHomeDir
}

// ---- mods hub -------------------------------------------------------------
/**
 * The mods hub: the same block in every mod of my-mods ($ cannot cross files). Edit shared/mods-hub.ts and
 * run scripts/sync-shared.sh; scripts/check.sh fails while a copy differs.
 *
 * At session start each mod records itself in <mods home>/mods/installed/<profile>/<mod>.json: version,
 * plugin root, a status line and its setup wizard. From those records any installed mod can:
 *   - answer `/mods` (status, setup, doctor, changes, pause, update, install, uninstall); where several
 *     are installed, the one with the newest hub answers;
 *   - show one toast for every first run and update in a session instead of one per mod (the mod whose
 *     name sorts first speaks for the others), with a line from each mod's CHANGELOG.md;
 *   - warn, once per change, when profiles run different versions of a mod.
 * `/mods pause` and each mod's `off <duration>` write <mods home>/mods/pause.json; the mods that can pause
 * re-read it every 30 seconds.
 */
const HUB = 1
const MODS = ['budget-guard', 'lean-tools', 'lsp-first', 'no-attribution', 'timesheet', 'usage-analytics']
const DAY_MS = 86_400_000

type HubEntry = {
  mod: string
  version: string
  hub: number
  root: string
  profile: string
  configDir: string
  session: string
  at: number
  command: string
  status: string
  setup: string
  pausable: boolean
  /** a first run or a new version no toast has mentioned yet */
  pending?: 'welcome' | 'update'
  from?: string
  welcome?: string
  noticed?: string
}
type HubSpec = {
  mod: string
  command: string
  firstRun: boolean
  pausable: boolean
  /** a few words for the first-run toast, e.g. "installed global git hooks" */
  welcome?: () => string
  status: () => Promise<string> | string
  setup: () => Promise<string> | string
  /** a pause started or ended (also on a timer, when its time runs out) */
  onPause?: (paused: boolean) => Promise<void> | void
}
type HubPause = { all?: number; mods?: Record<string, number> }

let hubSpec: HubSpec | null = null
let hubSelf: HubEntry | null = null
let hubPauseFile: HubPause = {}
let hubSessionOff = false
let hubWasPaused = false

const hubDir = async ($: EngineInterface) => `${await modsHome($)}/mods`
const hubEntryPath = async ($: EngineInterface, profile: string, mod: string) => `${await hubDir($)}/installed/${profile}/${mod}.json`

async function hubJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return null
  }
}

/** -1, 0 or 1, comparing dotted versions numerically. */
function semverCmp(a: string, b: string) {
  const x = a.split('.').map(n => parseInt(n, 10) || 0)
  const y = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** "30m", "2h", "1d", "90" (minutes) in ms; 0 when it is not a duration. */
function parseDuration(s: string | undefined) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/i.exec(String(s ?? '').trim())
  if (!m) return 0
  const n = Number(m[1])
  const unit = (m[2] ?? 'm').toLowerCase()
  return Math.round(n * (unit === 'd' ? DAY_MS : unit === 'h' ? 3_600_000 : 60_000))
}

const hubClock = (t: number) => {
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return t - Date.now() > DAY_MS / 2 ? `${d.toDateString().slice(4, 10)} ${hm}` : hm
}

/** When this mod's pause ends (0: not paused; Infinity: for this session). */
function hubPausedUntil(mod = hubSpec?.mod ?? '') {
  if (hubSessionOff && mod === hubSpec?.mod) return Infinity
  const now = Date.now()
  const until = Math.max(hubPauseFile.all ?? 0, hubPauseFile.mods?.[mod] ?? 0)
  return until > now ? until : 0
}
const hubPaused = () => !!hubSpec?.pausable && hubPausedUntil() > 0

/** Re-reads pause.json and tells the mod when its pause started or ended. */
async function hubPoll($: EngineInterface) {
  hubPauseFile = (await hubJson<HubPause>($, `${await hubDir($)}/pause.json`)) ?? {}
  const now = hubPaused()
  if (now !== hubWasPaused) {
    hubWasPaused = now
    await hubSpec?.onPause?.(now)
  }
}

/** Pauses (until > now), or resumes (until 0), one mod or all of them; `session` pauses this mod in this session only. */
async function hubSetPause($: EngineInterface, mod: string | 'all', until: number | 'session') {
  if (until === 'session') hubSessionOff = true
  else {
    if (until === 0 && (mod === 'all' || mod === hubSpec?.mod)) hubSessionOff = false
    const path = `${await hubDir($)}/pause.json`
    const p: HubPause = (await hubJson<HubPause>($, path)) ?? {}
    if (mod === 'all') {
      p.all = until || undefined
      if (!until) p.mods = {}
    } else p.mods = { ...p.mods, [mod]: until }
    for (const [k, v] of Object.entries(p.mods ?? {})) if (!v || v < Date.now()) delete p.mods![k]
    await $.fs.write(path, JSON.stringify(p) + '\n')
  }
  await hubPoll($)
}

/** The lines under each version heading of a CHANGELOG.md, newest first, for versions after `from` up to `to`. */
async function hubChanges($: EngineInterface, root: string, from: string | undefined, to: string, max = 3) {
  const text = String(await $.fs.read(`${root}/CHANGELOG.md`).catch(() => ''))
  const out: { version: string; lines: string[] }[] = []
  let cur: { version: string; lines: string[] } | null = null
  for (const line of text.split('\n')) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line)
    if (h) {
      const v = h[1]!
      cur = semverCmp(v, to) <= 0 && (from ? semverCmp(v, from) > 0 : v === to) ? { version: v, lines: [] } : null
      if (cur) out.push(cur)
    } else if (cur && /^\s*[-*]\s+/.test(line)) cur.lines.push(line.replace(/^\s*[-*]\s+/, '').trim())
  }
  return out.slice(0, max)
}

async function hubEntries($: EngineInterface, profile?: string): Promise<HubEntry[]> {
  const dir = `${await hubDir($)}/installed`
  const profiles = profile ? [profile] : (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'dir').map(e => e.name)
  const out: HubEntry[] = []
  for (const p of profiles) {
    for (const f of await $.fs.list(`${dir}/${p}`).catch(() => [])) {
      if (!f.name.endsWith('.json')) continue
      const e = await hubJson<HubEntry>($, `${dir}/${p}/${f.name}`)
      if (e?.mod) out.push(e)
    }
  }
  return out
}

/** Writes this mod's record (status and setup recomputed); a pending notice another mod already showed is dropped. */
async function hubSave($: EngineInterface) {
  if (!hubSelf || !hubSpec) return
  const path = await hubEntryPath($, hubSelf.profile, hubSelf.mod)
  const disk = await hubJson<HubEntry>($, path)
  const shown = disk?.noticed === hubSelf.version && disk.session === hubSelf.session
  hubSelf = {
    ...hubSelf,
    status: String(await Promise.resolve(hubSpec.status()).catch(() => '')),
    setup: String(await Promise.resolve(hubSpec.setup()).catch(() => '')),
    ...(shown ? { pending: undefined, noticed: hubSelf.version } : {}),
  }
  await $.fs.write(path, JSON.stringify(hubSelf, null, 1) + '\n').catch(() => {})
}

/** Call from session.start once the mod's config is loaded. */
async function hubStart($: EngineInterface, spec: HubSpec) {
  hubSpec = spec
  hubSessionOff = false
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\/+$/, '')
  const profile = configDir.split('/').pop()!.replace(/^\./, '')
  const version = (await hubJson<{ version?: string }>($, `${$.plugin.root}/.claude-plugin/plugin.json`))?.version ?? '0.0.0'
  const prev = await hubJson<HubEntry>($, await hubEntryPath($, profile, spec.mod))
  let pending: HubEntry['pending']
  let from: string | undefined
  if (!prev) {
    // New in this profile: a first run, an update from before the hub, or a profile added to an install
    // (another profile already runs this version: nothing to announce).
    const elsewhere = (await hubEntries($)).some(x => x.mod === spec.mod && x.version === version)
    pending = spec.firstRun ? 'welcome' : elsewhere ? undefined : 'update'
  }
  else if (prev.pending && prev.noticed !== version) (pending = prev.pending), (from = prev.from)
  else if (semverCmp(prev.version, version) !== 0) (pending = 'update'), (from = prev.version)
  hubSelf = {
    mod: spec.mod,
    version,
    hub: HUB,
    root: $.plugin.root,
    profile,
    configDir,
    session: await $.session.id().catch(() => 'unknown'),
    at: Date.now(),
    command: spec.command,
    status: '',
    setup: '',
    pausable: spec.pausable,
    pending,
    from,
    welcome: pending === 'welcome' ? spec.welcome?.() : undefined,
    noticed: prev?.noticed,
  }
  await hubPoll($).catch(() => {})
  await hubSave($)
  await $.command.register({
    name: 'mods',
    description: 'my-mods: status · setup [mod…] · doctor · changes · pause <30m|2h|1d> · resume · update · install [mod…] · uninstall',
    argumentHint: '[status | setup [mod…] | doctor | changes | pause <duration> | resume | update | install [mod…] | uninstall [confirm] [purge]]',
  }).catch(() => {})
  try {
    $.clock.after(3000, () => void hubNotices($).catch(() => {}))
  } catch {
    // no timers (tests)
  }
}

/** Versions that differ between profiles: "budget-guard 0.9.0 in claude-work (0.10.0 here)". */
async function hubDrift($: EngineInterface, profile: string) {
  const all = (await hubEntries($)).filter(e => Date.now() - e.at < 60 * DAY_MS)
  const out: string[] = []
  for (const mine of all.filter(e => e.profile === profile)) {
    for (const other of all.filter(e => e.mod === mine.mod && e.profile !== profile)) {
      if (semverCmp(other.version, mine.version) !== 0) out.push(`${mine.mod} ${other.version} in ${other.profile} (${mine.version} here)`)
    }
  }
  return out
}

/** The session's one toast: first runs, updates, and profiles that drifted apart. Only the first mod by name speaks. */
async function hubNotices($: EngineInterface) {
  const me = hubSelf
  if (!me) return
  const here = (await hubEntries($, me.profile)).filter(e => e.session === me.session)
  if (here.map(e => e.mod).sort()[0] !== me.mod) return
  const parts: string[] = []
  const welcome = here.filter(e => e.pending === 'welcome')
  if (welcome.length) {
    const names = welcome.map(e => (e.welcome ? `${e.mod} (${e.welcome})` : e.mod)).join(', ')
    parts.push(`Mods on: ${names}. /mods status shows them, /mods setup tailors them.`)
  }
  const updates: string[] = []
  for (const e of here.filter(x => x.pending === 'update')) {
    const news = await hubChanges($, e.root, e.from, e.version, 1)
    updates.push(`${e.mod} ${e.version}${news[0]?.lines[0] ? `: ${news[0].lines[0]}` : ''}`)
  }
  if (updates.length) parts.push(`Updated ${updates.join(' · ')} (/mods changes)`)
  const drift = await hubDrift($, me.profile)
  const driftFile = `${await hubDir($)}/installed/${me.profile}/drift.txt`
  const sig = drift.join('\n')
  if (sig && sig !== String(await $.fs.read(driftFile).catch(() => ''))) {
    parts.push(`Profiles out of step: ${drift.slice(0, 3).join('; ')}. /mods update updates every profile.`)
  }
  await $.fs.write(driftFile, sig).catch(() => {})
  for (const e of here.filter(x => x.pending)) {
    const next = { ...e, pending: undefined, welcome: undefined, noticed: e.version }
    if (e.mod === me.mod) hubSelf = { ...me, pending: undefined, welcome: undefined, noticed: me.version }
    await $.fs.write(await hubEntryPath($, e.profile, e.mod), JSON.stringify(next, null, 1) + '\n').catch(() => {})
  }
  if (parts.length) $.ui.toast(parts.join(' '), { timeoutMs: 12_000 })
}

/** Runs the hub's shell script (install, update, uninstall) from this mod's copy. */
async function hubScript($: EngineInterface, args: string[], timeoutMs = 600_000) {
  const r = await $.process
    .run(['sh', `${$.plugin.root}/bin/mods`, ...args], { timeoutMs, env: { CLAUDE_MODS_HOME: await modsHome($) } })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  return (r.stdout + (r.exitCode === 0 ? '' : `\n${r.stderr || `exited ${r.exitCode}`}`)).trim()
}

async function hubRun($: EngineInterface, argv: string[], timeoutMs = 5000) {
  return $.process.run(argv, { timeoutMs }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
}

/** Today's spend across profiles, from budget-guard's per-session ledgers (written as sessions run). */
async function hubToday($: EngineInterface) {
  const dir = `${await modsHome($)}/budget-guard/sessions`
  const t = new Date()
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  let usd = 0
  let found = false
  for (const f of await $.fs.list(dir).catch(() => [])) {
    if (!f.name.endsWith('.json') || Date.now() - (f.mtimeMs ?? 0) > 1.5 * DAY_MS) continue
    const s = await hubJson<{ day?: string; spent?: number }>($, `${dir}/${f.name}`)
    if (s?.day === today) (usd += Number(s.spent) || 0), (found = true)
  }
  return found ? usd : null
}

async function hubDashboard($: EngineInterface) {
  const cfg = await hubJson<{ port?: number; dashboard?: boolean }>($, `${await modsHome($)}/usage-analytics/config.json`)
  const port = Number(cfg?.port) || 8787
  const r = await hubRun($, ['curl', '-s', '-m', '1', `http://127.0.0.1:${port}/api/ping`], 3000)
  const ping = (() => {
    try {
      return JSON.parse(r.stdout) as { app?: string; version?: string; progress?: { running?: boolean; done?: number; total?: number } }
    } catch {
      return null
    }
  })()
  return { port, wanted: cfg?.dashboard !== false, running: ping?.app === 'claude-usage', version: ping?.version, progress: ping?.progress }
}

async function hubStatus($: EngineInterface) {
  const me = hubSelf!
  await hubSave($)
  await hubPoll($)
  const entries = await hubEntries($, me.profile)
  // The newest record per mod: this session's, else the last one any session wrote.
  const byMod = new Map<string, HubEntry>()
  for (const e of entries.sort((a, b) => a.at - b.at)) byMod.set(e.mod, e)
  const lines = [`my-mods · profile ${me.profile} · data in ${await modsHome($)}`]
  const w = Math.max(...[...byMod.keys()].map(m => m.length), 10)
  for (const e of [...byMod.values()].sort((a, b) => a.mod.localeCompare(b.mod))) {
    const until = e.pausable ? hubPausedUntil(e.mod) : 0
    const paused = until === Infinity ? 'paused for this session · ' : until ? `paused until ${hubClock(until)} · ` : ''
    const stale = e.session === me.session ? '' : ' (not loaded in this session)'
    lines.push(`  ${e.mod.padEnd(w)}  ${e.version.padEnd(7)} ${paused}${e.status}${stale}  /${e.command}`)
  }
  const missing = MODS.filter(m => !byMod.has(m))
  if (missing.length) lines.push(`  not installed here: ${missing.join(', ')} (/mods install adds them)`)
  const today = await hubToday($)
  if (today !== null) lines.push(`  today: $${today.toFixed(2)} across profiles (budget-guard ledgers)`)
  if (byMod.has('usage-analytics')) {
    const d = await hubDashboard($)
    const prog = d.progress?.running ? ` · importing ${d.progress.done ?? 0}/${d.progress.total ?? '?'} files` : ''
    lines.push(`  dashboard: ${d.running ? `http://127.0.0.1:${d.port}/ (${d.version ?? '?'})${prog}` : d.wanted ? 'not running (/dashboard starts it)' : 'off (/dashboard starts it)'}`)
  }
  if (hubPauseFile.all && hubPauseFile.all > Date.now()) lines.push(`  all mods paused until ${hubClock(hubPauseFile.all)} (/mods resume)`)
  const drift = await hubDrift($, me.profile)
  if (drift.length) lines.push(`  out of step: ${drift.join('; ')} (/mods update)`)
  return lines.join('\n')
}

async function hubDoctor($: EngineInterface) {
  const me = hubSelf!
  const ok = (s: string) => `✓ ${s}`
  const warn = (s: string, fix: string) => `! ${s}\n    → ${fix}`
  const bad = (s: string, fix: string) => `✗ ${s}\n    → ${fix}`
  const home = await modsHome($)
  const entries = (await hubEntries($, me.profile)).filter(e => e.session === me.session)
  const has = (m: string) => entries.some(e => e.mod === m)
  const out: string[] = [`my-mods doctor · profile ${me.profile} (${me.configDir})`]
  const darwin = (await hubRun($, ['uname'])).stdout.trim() === 'Darwin'

  // The data folder.
  const probe = `${home}/mods/.doctor`
  const wrote = await $.fs.write(probe, String(Date.now())).then(() => true, () => false)
  out.push(wrote ? ok(`data folder writable: ${home}`) : bad(`cannot write to ${home}`, `check its permissions, or set CLAUDE_MODS_HOME to a writable folder`))
  if (home.endsWith('/.claude-shared')) out.push(ok('using ~/.claude-shared (an older install); new installs use ~/.claude-mods, and CLAUDE_MODS_HOME overrides both'))

  // python3, for usage-analytics.
  const py = await hubRun($, ['python3', '-c', 'import sys,sqlite3;sqlite3.connect(":memory:").execute("select json_extract(\'{}\',\'$\')");print(sys.version.split()[0])'])
  const pyFix = darwin ? 'install it: `xcode-select --install` or `brew install python`' : 'install it: `sudo apt install python3` (or your distribution\'s package)'
  if (py.exitCode === 0) {
    const v = py.stdout.trim()
    out.push(semverCmp(v, '3.8') >= 0 ? ok(`python3 ${v} with SQLite JSON`) : warn(`python3 ${v} is old`, `usage-analytics needs 3.8 or newer; ${pyFix}`))
  } else if (/json_extract|no such function/i.test(py.stderr)) out.push(bad('python3 has SQLite without JSON support', pyFix))
  else out.push((has('usage-analytics') ? bad : warn)('python3 not found on PATH', `usage-analytics needs it for its database and dashboard; ${pyFix}`))

  // The dashboard.
  if (has('usage-analytics')) {
    const d = await hubDashboard($)
    const ua = entries.find(e => e.mod === 'usage-analytics')!
    if (!d.running) out.push(d.wanted ? warn(`dashboard not running on port ${d.port}`, '/dashboard starts it; `/mods doctor` again after') : ok('dashboard off by config (/dashboard starts it)'))
    else if (d.version && semverCmp(d.version, ua.version) < 0) out.push(warn(`dashboard runs ${d.version}, installed is ${ua.version}`, 'it is replaced at the next session start, or now with /analytics stop then /dashboard'))
    else out.push(ok(`dashboard on http://127.0.0.1:${d.port}/ (${d.version ?? '?'})`))
    const unit = darwin ? `${(await $.env.get('HOME')) ?? ''}/Library/LaunchAgents/dev.claude-mods.usage-dashboard.plist` : `${(await $.env.get('HOME')) ?? ''}/.config/systemd/user/claude-usage-dashboard.service`
    out.push(ok(`dashboard at login: ${(await $.fs.exists(unit).catch(() => false)) ? 'on' : 'off'}`))
  }

  // Global git hooks.
  const hooksPath = (await hubRun($, ['git', 'config', '--global', '--get', 'core.hooksPath'])).stdout.trim()
  const ours = `${home}/no-attribution/git-hooks`
  if (has('no-attribution')) {
    const na = await hubJson<{ gitHooks?: boolean }>($, `${home}/no-attribution/config.json`)
    if (na?.gitHooks === false) out.push(ok('no-attribution git hooks off by config'))
    else if (hooksPath === ours) out.push(ok('no-attribution git hooks installed (global core.hooksPath)'))
    else if (hooksPath) out.push(warn(`global core.hooksPath is ${hooksPath} (another tool)`, 'no-attribution left it alone: Claude\'s own commits are still guarded, plain `git commit` is not'))
    else out.push(warn('no-attribution git hooks missing', '/no-attribution hooks on installs them'))
  } else if (hooksPath === ours) {
    out.push(bad('global core.hooksPath still points at no-attribution\'s hooks, but the mod is not loaded', '`git config --global --unset core.hooksPath`, or /mods install no-attribution'))
  }

  // The language server, for lsp-first.
  if (has('lsp-first')) {
    const ls = await hubRun($, ['typescript-language-server', '--version'])
    out.push(ls.exitCode === 0 ? ok(`typescript-language-server ${ls.stdout.trim()}`) : warn('typescript-language-server not found on PATH', 'lsp-first needs it for TS/JS: `npm i -g typescript-language-server typescript`'))
  }

  // Node and the launcher, for timesheet.
  if (has('timesheet')) {
    const nv = (await hubRun($, ['node', '-p', 'process.versions.node'])).stdout.trim()
    const [a = 0, b = 0] = nv.split('.').map(Number)
    const nodeFix = darwin ? '`brew install node`, or `fnm install 22`' : 'your package manager, or `fnm install 22`'
    out.push(!nv ? bad('node not found on PATH', `timesheet needs Node 22.18 or newer: ${nodeFix}`) : a > 22 || (a === 22 && b >= 18) ? ok(`node ${nv}`) : bad(`node ${nv} is too old`, `timesheet needs 22.18 or newer: ${nodeFix}`))
    const which = (await hubRun($, ['sh', '-c', 'command -v timesheet'])).stdout.trim()
    out.push(which ? ok(`timesheet command: ${which}`) : warn('`timesheet` is not on PATH', '/timesheet install puts it in ~/.local/bin; add that folder to PATH'))
    const old = `${me.configDir}/skills/timesheet/SKILL.md`
    if (await $.fs.exists(old).catch(() => false)) out.push(warn(`an older copy of the timesheet skill is at ${old}`, `the plugin ships the skill now: \`rm -r ${old.replace(/\/SKILL\.md$/, '')}\` (it may be a shared folder linked into other profiles)`))
  }

  // The claude CLI, for /mods update and install.
  const cli = await hubRun($, ['claude', '--version'])
  out.push(cli.exitCode === 0 ? ok(`claude CLI ${cli.stdout.trim().split(/\s/)[0]}`) : warn('`claude` not on PATH for subprocesses', '/mods update and /mods install need it; run `claude plugin update <mod>@my-mods` yourself'))

  // Versions.
  const drift = await hubDrift($, me.profile)
  out.push(drift.length ? warn(`profiles out of step: ${drift.join('; ')}`, '/mods update updates every profile') : ok('same versions in every profile that ran a session'))
  const missing = MODS.filter(m => !has(m))
  if (missing.length) out.push(ok(`not loaded here: ${missing.join(', ')} (/mods install adds them)`))
  return out.join('\n')
}

/** The combined setup: which mods to tailor, then their questions together, as few prompts as it takes. */
async function hubSetup($: EngineInterface, only: string[]) {
  const me = hubSelf!
  await hubSave($)
  let entries = (await hubEntries($, me.profile)).filter(e => e.session === me.session && e.setup)
  if (only.length) entries = entries.filter(e => only.some(o => e.mod === o || e.command === o || e.mod.startsWith(o)))
  if (!entries.length) return null
  const pick = only.length
    ? ''
    : `First ask me with AskUserQuestion (multiSelect) which of these mods to set up: ${entries.map(e => e.mod).join(', ')}. Then run only the chosen mods' setups below.\n`
  return `Set up my Claude Code mods with me. Keep it short.
${pick}Each mod's setup below has its own questions and files. Ask all the chosen mods' questions together, in as few AskUserQuestion calls as possible (up to four questions per call), then do each setup's writes and commands. The current configs quoted below may be stale: read each config file again before writing it. Finish with one line per mod saying what is set.

${entries.map(e => `<setup mod="${e.mod}">\n${e.setup}\n</setup>`).join('\n\n')}`
}

async function hubChangesText($: EngineInterface) {
  const me = hubSelf!
  const entries = (await hubEntries($, me.profile)).filter(e => e.session === me.session)
  const out: string[] = []
  for (const e of entries.sort((a, b) => a.mod.localeCompare(b.mod))) {
    const ch = await hubChanges($, e.root, '0.0.0', e.version, 3)
    out.push(`${e.mod} ${e.version}`)
    for (const c of ch) out.push(`  ${c.version}: ${c.lines.slice(0, 3).join(' · ') || '-'}`)
  }
  return out.join('\n') || 'No mods recorded in this session yet.'
}

/** /mods. `defer` hands the command to a mod with a newer hub. */
async function hubCommand($: EngineInterface, args: string, defer: () => Promise<{ text: string }>): Promise<{ text: string }> {
  if (!hubSelf) return defer()
  const here = (await hubEntries($, hubSelf.profile)).filter(e => e.session === hubSelf!.session)
  if (here.some(e => e.hub > HUB)) return defer()
  const [sub = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  switch (sub) {
    case 'status':
      return { text: await hubStatus($) }
    case 'doctor':
      return { text: await hubDoctor($) }
    case 'changes':
      return { text: await hubChangesText($) }
    case 'setup': {
      const text = await hubSetup($, rest)
      if (!text) return { text: `No setup for ${rest.join(' ') || 'these mods'}. Installed here: ${here.map(e => e.mod).join(', ')}` }
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the mods setup…' }
    }
    case 'pause': {
      const ms = parseDuration(rest[0])
      if (!ms) return { text: 'Usage: /mods pause <30m | 2h | 1d>: budget-guard, lean-tools and lsp-first step aside until then (in every session); /mods resume ends it' }
      await hubSetPause($, 'all', Date.now() + ms)
      return { text: `Mods paused until ${hubClock(Date.now() + ms)}: budget-guard's levers, lean-tools and lsp-first step aside in every session (within 30 seconds). usage-analytics keeps recording; no-attribution keeps guarding. /mods resume ends it.` }
    }
    case 'resume':
      await hubSetPause($, 'all', 0)
      return { text: 'Mods resumed.' }
    case 'update': {
      const out = await hubScript($, ['update'])
      return { text: `${out}\nRestart running sessions to load the new versions.` }
    }
    case 'install': {
      const out = await hubScript($, ['install', ...(rest.length ? ['--only', rest.join(',')] : [])])
      return { text: `${out}\nNew mods load in sessions started from now on.` }
    }
    case 'uninstall': {
      const purge = rest.includes('purge')
      if (!rest.includes('confirm')) {
        const plan = await hubScript($, ['uninstall', '--dry-run', ...(purge ? ['--purge'] : [])], 60_000)
        return { text: `${plan}\n\nNothing changed yet. /mods uninstall confirm${purge ? ' purge' : ''} does this.${purge ? '' : ` Add purge to also delete ${await modsHome($)} (your usage database and configs).`}` }
      }
      // Run from memory: the script's own folder is removed while it runs.
      const script = String(await $.fs.read(`${$.plugin.root}/bin/mods`))
      const r = await $.process
        .run(['sh', '-c', script, 'mods', 'uninstall', '--yes', ...(purge ? ['--purge'] : [])], { timeoutMs: 600_000, env: { CLAUDE_MODS_HOME: await modsHome($) } })
        .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      return { text: `${r.stdout}${r.exitCode ? `\n${r.stderr}` : ''}\nRestart Claude Code to unload the mods from running sessions.`.trim() }
    }
    default:
      return { text: 'Usage: /mods [status | setup [mod…] | doctor | changes | pause <30m|2h|1d> | resume | update | install [mod…] | uninstall [confirm] [purge]]' }
  }
}

/** Call from register: serves /mods. */
function hubHooks(on: Parameters<Register>[0]) {
  on('command.run', { command: 'mods' }, async ($, e, next) => hubCommand($, e.args, async () => next(e) as Promise<{ text: string }>)).catch(($, e, next) => next(e))
}
// ---- end mods hub ---------------------------------------------------------

// ---- impact tracking ------------------------------------------------------
/**
 * Mod-impact tracking (the same block in budget-guard, lean-tools and lsp-first; $ cannot cross files).
 *
 * Every action a mod takes is logged as `{ ev: 'mod', mod, kind, arm, ... }` into the usage-analytics
 * event store (<mods home>/usage-analytics/events/<profile>/<day>/), which `claude-usage ingest`
 * folds into the `events` table (view `v_mod_actions`).
 *
 * The holdout: each session is put in arm `holdout` with probability `holdout`, from a hash of the mod
 * name and the session id, so the arm is stable across reloads and independent between mods. In the
 * holdout the mod stays passive and only logs, so sessions with and without it can be compared.
 */
type Arm = 'on' | 'holdout'

const FLUSH_AT = 50

let mod = ''
let buf: Record<string, unknown>[] = []
let root = ''
let profile = ''
let sid = ''
let chunk = 0
let arm: Arm = 'on'
const tag = Math.random().toString(36).slice(2, 8)

/** FNV-1a, scaled to [0, 1). */
function bucket(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 2 ** 32
}

/** This session's arm. */
const trackArm = () => arm
/** Whether the mod acts in this session (not the holdout). */
const trackOn = () => arm === 'on'

/** Call from session.start, after `next`. Picks the arm and logs it with the mod's settings. */
async function trackStart($: EngineInterface, name: string, holdout: number, settings: Record<string, unknown> = {}) {
  await trackFlush($).catch(() => {})
  mod = name
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  profile = (configDir || `${home}/.claude`).replace(/\/+$/, '').split('/').pop()!.replace(/^\./, '')
  root = `${await modsHome($)}/usage-analytics`
  sid = await $.session.id().catch(() => 'unknown')
  arm = bucket(`${mod}:${sid}`) < holdout ? 'holdout' : 'on'
  await trackLog($, 'arm', { holdout, version: $.plugin.root.split('/').pop(), settings })
  return arm
}

async function trackLog($: EngineInterface, kind: string, data: Record<string, unknown> = {}) {
  if (!root) return
  buf.push({ ts: await $.clock.now(), ev: 'mod', sid, profile, mod, kind, arm, ...data })
  if (buf.length >= FLUSH_AT) void trackFlush($).catch(() => {})
}

async function trackFlush($: EngineInterface) {
  if (!root || buf.length === 0) return
  const batch = buf
  buf = []
  const first = batch[0]!.ts as number
  const path = `${root}/events/${profile}/${localDay(first)}/${sid}.${first}.${mod}-${tag}${chunk++}.jsonl`
  try {
    await $.fs.write(path, batch.map(x => JSON.stringify(x)).join('\n') + '\n')
  } catch {
    buf = batch.concat(buf)
  }
}
// ---- end impact tracking --------------------------------------------------

/**
 * The holdout: in this share of sessions (config `holdout`, <mods home>/budget-guard/config.json)
 * the cost levers are off (routing, trimming, keep-alive, new-task check, subagent cap, read guards)
 * so their sessions can be compared with the rest. The rules stay on in every session: the Opus
 * effort cap, compaction at `compactAt`, the band, budgets and the hold at `block`.
 */
const HOLDOUT_DEFAULT = 0.1
const HOLDOUT_PATCH: Partial<Limits> = { route: false, routeAgents: false, trimOutput: false, keepAlive: false, newTaskAt: Number.MAX_SAFE_INTEGER, maxAgents: 1_000_000, allowImages: true }
/** Haiku calls the mod makes, logged by input size so analytics can price them. */
async function logClassify($: EngineInterface, purpose: string, chars: number) {
  await trackLog($, 'classify', { purpose, model: 'claude-haiku-5-5', inputChars: chars })
}
async function configPath($: EngineInterface) {
  return `${await modsHome($)}/budget-guard/config.json`
}
/** What this mod keeps across sessions; /budget changes the running session only, /budget setup these. */
type Config = {
  holdout: number
  /** the session limits every session starts from (the rest come from the defaults) */
  limits: Partial<Limits>
  /** the highest effort Opus may run at: medium saves the most; max means no cap */
  opusMaxEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** context size (tokens) the conversation is compacted at, whatever settings.json says; 0 leaves it to the engine */
  compactAt: number
  /** LiteLLM key spend polling on a gateway: auto (stops if the gateway has no /key/info), on, off */
  litellm: 'auto' | 'on' | 'off'
}
const CONFIG_DEFAULTS: Config = { holdout: HOLDOUT_DEFAULT, limits: {}, opusMaxEffort: 'medium', compactAt: 200_000, litellm: 'auto' }
let conf: Config = CONFIG_DEFAULTS
let firstRun = false

async function loadConfig($: EngineInterface): Promise<Config> {
  const path = await configPath($)
  let saved: Partial<Config> | null = null
  try {
    saved = JSON.parse(String(await $.fs.read(path)))
  } catch {
    // first run: the defaults
  }
  firstRun = saved === null
  conf = { ...CONFIG_DEFAULTS, ...saved, limits: { ...(saved?.limits ?? {}) } }
  if (!(conf.opusMaxEffort in EFFORT_RANK)) conf.opusMaxEffort = 'medium'
  if (!(Number(conf.compactAt) >= 0)) conf.compactAt = CONFIG_DEFAULTS.compactAt
  if (!saved || Object.keys(CONFIG_DEFAULTS).some(k => !(k in saved!))) await saveConfig($)
  return conf
}

async function saveConfig($: EngineInterface) {
  await $.fs.write(await configPath($), JSON.stringify(conf, null, 2) + '\n').catch(() => {})
}

/** The setup wizard, run by the model: what to ask, and the two files the answers go to. */
export function setupPrompt(configFile: string, budgetsFile: string, profile: string, current: Config, budget: Budgets | null) {
  return `Set up the budget-guard mod with me. Keep it short.

1. Ask me with the AskUserQuestion tool, in a single call (recommended option first, my current choice marked "(current)"):
   - "Spending limits for the ${profile} profile?" (soft: shown as gauges, never blocking): "None", "$10 a day / $200 a month", "$25 a day / $500 a month"; Other lets me type my own.
   - "Pick the model per task?": "Auto (recommended)": the first prompt decides, quick questions go to Sonnet at low effort, the rest to Opus (limits.route true); "Off": always the session's own model (limits.route false).
   - "Cap Opus effort?": "Medium (recommended, cheapest)", "High", "No cap" (opusMaxEffort "medium", "high", "max").
   - "Compact the conversation at?": "200k tokens (recommended)", "150k", "Engine default" (compactAt 200000, 150000, 0).
   - "Hold prompts when the context gets this large?": "300k tokens (recommended)", "200k", "500k" (limits.block; set limits.warn to half of it).
2. Write ${configFile}: the current config below with only limits.route, limits.block, limits.warn, opusMaxEffort and compactAt changed. Keep every other key.
3. Write the limits to ${budgetsFile}: it is {"profiles": {"<profile>": {"daily": <dollars or null>, "monthly": <dollars or null>}}}; set "${profile}" and keep the other profiles. Create the file if it is missing.
4. Tell me in one or two lines what is set. It applies from the next session; /budget setup runs this again.

Current config (${configFile}):
${JSON.stringify(current, null, 2)}
Current limits for ${profile}: ${budget ? JSON.stringify(budget) : 'none'}`
}

/** The session limits a session starts from: the defaults with the config's own on top. */
const startLimits = (): Limits => ({ ...DEFAULTS, ...conf.limits })

const DEFAULTS: Limits = {
  warn: 150_000,
  block: 300_000,
  maxAgents: 3,
  bigTurn: 50_000,
  allowImages: false,
  route: true,
  routeAgents: true,
  newTaskAt: 60_000,
  keepAlive: true,
  trimOutput: true,
}

const limits = atom({ plugin: 'budget-guard', key: 'limits' } as const, DEFAULTS)
const context = atom({ plugin: 'budget-guard', key: 'context' } as const, null)
const costUsd = atom({ plugin: 'budget-guard', key: 'costUsd' } as const, null)
const lastTokens = atom({ plugin: 'budget-guard', key: 'lastTokens' } as const, 0)
const lastDelta = atom({ plugin: 'budget-guard', key: 'lastDelta' } as const, 0)
const agents = atom({ plugin: 'budget-guard', key: 'agents' } as const, 0)
const screenshots = atom({ plugin: 'budget-guard', key: 'screenshots' } as const, 0)
const litellm = atom({ plugin: 'budget-guard', key: 'litellm' } as const, null)
const route = atom({ plugin: 'budget-guard', key: 'route' } as const, null)
const routeDecided = atom({ plugin: 'budget-guard', key: 'routeDecided' } as const, false)
const agentModels = atom({ plugin: 'budget-guard', key: 'agentModels' } as const, {})
const prompts = atom({ plugin: 'budget-guard', key: 'prompts' } as const, [])
const pending = atom({ plugin: 'budget-guard', key: 'pending' } as const, null)
const savings = atom({ plugin: 'budget-guard', key: 'savings' } as const, {})
const history = atom({ plugin: 'budget-guard', key: 'history' } as const, null)
const billing = atom({ plugin: 'budget-guard', key: 'billing' } as const, 'unknown')
const samples = atom({ plugin: 'budget-guard', key: 'samples' } as const, [])
const limitsNow = atom({ plugin: 'budget-guard', key: 'limitsNow' } as const, [])
const mainModel = atom({ plugin: 'budget-guard', key: 'mainModel' } as const, null)
const liveAgents = atom({ plugin: 'budget-guard', key: 'liveAgents' } as const, [])
const liveTasks = atom({ plugin: 'budget-guard', key: 'liveTasks' } as const, [])
const budgets = atom({ plugin: 'budget-guard', key: 'budgets' } as const, { daily: null, monthly: null })
const periods = atom({ plugin: 'budget-guard', key: 'periods' } as const, null)

// The current generation only.
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'

/** $/MTok: input, output, cache read. Cache writes are priced at 1.25x input (the 5-minute TTL). */
const PRICE = { opus: [4, 20, 0.2], sonnet: [2, 10, 0.2], haiku: [0.1, 0.5, 0.01] } as const
const family = (model: string) => (/haiku/.test(model) ? 'haiku' : /sonnet/.test(model) ? 'sonnet' : 'opus')
const costOf = (u: ModelUsage, model: string) => {
  const [inp, out, rd] = PRICE[family(model)]
  return (u.input_tokens * inp + u.output_tokens * out + u.cache_read_input_tokens * rd + u.cache_creation_input_tokens * inp * 1.25) / 1e6
}
/** What re-sending `tokens` of context costs as a cache read, and as a cold cache write. */
const readCost = (tokens: number, model: string) => (tokens * PRICE[family(model)][2]) / 1e6
const writeCost = (tokens: number, model: string) => (tokens * PRICE[family(model)][0] * 1.25) / 1e6
/** Calls a session typically still makes after a point we act at; keeps the context estimates conservative. */
const FUTURE_CALLS = 10

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i
const GENERATED = /(^|\/)(node_modules|dist|build|\.next|coverage)\/|(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.min\.(js|css)|\.map|\.log)$/
const SCREENSHOT = /take_screenshot|screenshot$/
const FORCE = /^force:\s*/i
const NOISY = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|e2e)\b|\b(jest|vitest|playwright\s+test|tsc|eslint|biome|next\s+build|pytest|mvn|gradle)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|clippy)\b|\bdocker\s+(build|compose\s+(up|logs|build))\b/
const KEEP_LINES = 300
const TRIM_MARK = /\[budget-guard: kept (\d+) of (\d+) bytes/
/** Subagent types that mostly search and read: Haiku does them. Forks share the parent's cache and keep its model. */
const HAIKU_AGENTS = /^(explore|claude-code-guide|statusline-setup)$/i
const KEEP_AGENT_MODEL = /^fork$/i
/** Gateway spend and burn-rate readings; off a gateway the tick makes no request. */
const LITELLM_POLL_MS = 60_000
const KEEPALIVE_MS = 270_000
const KEEPALIVE_MAX = 6
const FLUSH_MS = 60_000
const PANE = 'budget-savings'

/** Opus never thinks harder than this, whatever the session (holdout included), a route or a subagent asks. */
const opusMax = () => conf.opusMaxEffort
const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 } as const
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
/** The effort a request may go out with: on Opus, anything above medium (or unset, or numeric) becomes medium. */
const capEffort = (model: string, effort: Effort | undefined): Effort | undefined => {
  if (family(model) !== 'opus' || hubPaused()) return effort
  if (opusMax() === 'max' && effort !== undefined) return effort
  if (typeof effort === 'string' && EFFORT_RANK[effort] <= EFFORT_RANK[opusMax()]) return effort
  return opusMax()
}

const TIERS = {
  quick: { label: 'quick question, explanation, lookup, or a tiny one-file edit', model: SONNET, effort: 'low' },
  normal: { label: 'normal coding task: a feature, a bug fix, a refactor across a few files', model: OPUS, effort: 'medium' },
  hard: { label: 'hard: architecture or design, deep debugging, large multi-step or ambiguous work', model: OPUS, effort: 'medium' },
} as const

const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}k` : `${n}`)
const usd = (n: number) => `$${Math.abs(n) < 10 ? n.toFixed(2) : n.toFixed(0)}`
const short = (model: string) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

// Module-level: timers die with the module on reload, which is what they should do.
let keepAliveTimer: Timer | null = null
let pings = { count: 0, cost: 0, tokens: 0, model: OPUS }
let lastMainModel = OPUS
/** Where compaction starts: the mod's compactAt, else settings' autoCompactWindow (for the band). */
let compactAt = 250_000
/** The model each subagent's requests actually went out on, for the band. */
const agentModelSeen: Record<string, string> = {}
const TOAST_MS = 12_000
const AGENT_POLL_MS = 3_000

async function addSaving($: EngineInterface, cat: SavingCategory, usdSaved: number) {
  if (!(usdSaved > 0)) return
  await update($, savings, s => {
    const was = s[cat] ?? { usd: 0, count: 0 }
    return { ...s, [cat]: { usd: was.usd + usdSaved, count: was.count + 1 } }
  })
}

const BURN_WINDOW_MS = 20 * 60_000
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}

/** Change per hour of one figure over the last 20 minutes; null until two readings a minute apart. */
function perHour(list: Sample[], pick: (s: Sample) => number | null) {
  const pts = list.filter(s => pick(s) !== null)
  if (pts.length < 2) return null
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  if (b.t - a.t < 60_000) return null
  return ((pick(b)! - pick(a)!) * 3_600_000) / (b.t - a.t)
}

/** Who pays, decided from what the session talks to: never from secrets' values, only whether they are set. */
async function detectBilling($: EngineInterface, rateLimits: readonly { kind: string }[]): Promise<Billing> {
  if (await isGateway($)) return 'gateway'
  if (rateLimits.some(r => r.kind === 'five_hour' || r.kind === 'seven_day')) return 'subscription'
  if (await $.env.get('ANTHROPIC_API_KEY')) return 'api-key'
  return (await read($, billing)) === 'unknown' ? 'unknown' : await read($, billing)
}

async function addSample($: EngineInterface) {
  const t = await $.clock.now()
  const lim = await read($, limitsNow)
  const s = await read($, litellm)
  const sample: Sample = {
    t,
    cost: await read($, costUsd),
    key: s && !s.error ? s.spend : null,
    fiveHour: lim.find(l => l.kind === 'five_hour')?.percent ?? null,
    sevenDay: lim.find(l => l.kind === 'seven_day')?.percent ?? null,
  }
  await update($, samples, list => [...list.filter(x => t - x.t <= BURN_WINDOW_MS), sample].slice(-120))
}

/** Running subagents with the model each one runs on. Local and cheap: polled every few seconds. */
async function refreshAgents($: EngineInterface) {
  const models = await read($, agentModels)
  const list = (await $.agent.list().catch(() => []))
    .filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
    .map((a): LiveAgent => ({ id: a.id, type: a.type, status: a.status, model: agentModelSeen[a.id] || models[a.id] || '', description: a.description.slice(0, 60) }))
  const before = await read($, liveAgents)
  if (JSON.stringify(before) !== JSON.stringify(list)) await update($, liveAgents, () => list)
}

async function ledgerDir($: EngineInterface) {
  return `${await modsHome($)}/budget-guard/sessions`
}

/** The local calendar day, `YYYY-MM-DD`. */
const localDay = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

async function profileName($: EngineInterface) {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  return dir.replace(/\/+$/, '').split('/').pop()!.replace(/^\./, '')
}

/**
 * Each session writes only its own file, so concurrent sessions never race. Cost growth since the
 * last write lands on today, so a session that runs past midnight splits across both days.
 */
async function flush($: EngineInterface) {
  const saved = await read($, savings)
  const spent = (await read($, costUsd)) ?? 0
  if (Object.keys(saved).length === 0 && !spent) return
  const profile = await profileName($)
  const id = await $.session.id()
  const day = localDay(await $.clock.now())
  const path = `${await ledgerDir($)}/${profile}-${id}.json`
  let byDay: Record<string, number> = {}
  let before = 0
  try {
    const was = JSON.parse(String(await $.fs.read(path)))
    byDay = was.spentByDay ?? (was.day ? { [was.day]: was.spent ?? 0 } : {})
    before = was.spent ?? 0
  } catch {
    // first write of this session
  }
  byDay[day] = (byDay[day] ?? 0) + Math.max(0, spent - before)
  await $.fs.write(path, JSON.stringify({ profile, id, day, spent, spentByDay: byDay, saved, arm: trackArm() }))
}

/** Spend today and this month for this profile, with the soft-limit alerts. */
async function refreshPeriods($: EngineInterface) {
  const now = await $.clock.now()
  const today = localDay(now)
  const month = today.slice(0, 7)
  const s = await read($, litellm)
  let p: Periods

  if ((await read($, billing)) === 'gateway' && s && !s.error) {
    // The key only reports a lifetime total: remember where it stood when each day and month began.
    const path = `${await modsHome($)}/budget-guard/key-baselines.json`
    let b: { day?: { date: string; spend: number }; month?: { ym: string; spend: number }; since?: string } = {}
    try {
      b = JSON.parse(String(await $.fs.read(path)))
    } catch {
      // first reading ever
    }
    let changed = false
    if (b.day?.date !== today) (b.day = { date: today, spend: s.spend }), (changed = true)
    if (b.month?.ym !== month) (b.month = { ym: month, spend: s.spend }), (changed = true)
    if (!b.since) (b.since = today), (changed = true)
    if (changed) await $.fs.write(path, JSON.stringify(b))
    p = { kind: 'real', today: s.spend - b.day!.spend, month: s.spend - b.month!.spend, since: b.since!.slice(0, 7) === month ? b.since! : null }
  } else {
    await flush($).catch(() => {})
    const dir = await ledgerDir($)
    const profile = await profileName($)
    let t = 0
    let m = 0
    for (const f of (await $.fs.exists(dir)) ? await $.fs.list(dir) : []) {
      if (!f.name.startsWith(`${profile}-`) || !f.name.endsWith('.json')) continue
      try {
        const x = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)))
        const byDay: Record<string, number> = x.spentByDay ?? (x.day ? { [x.day]: x.spent ?? 0 } : {})
        for (const [d, v] of Object.entries(byDay)) {
          if (d === today) t += v
          if (d.startsWith(month)) m += v
        }
      } catch {
        // skip unreadable files
      }
    }
    p = { kind: 'api-equiv', today: t, month: m, since: null }
  }
  await update($, periods, () => p)

  // Heads-up at 80% and 100%, once per period per profile.
  const b = await read($, budgets)
  const alerted = ((await $.store.get('alerted')) as string[] | undefined) ?? []
  const fresh: string[] = []
  for (const [name, used, cap, key] of [['Daily', p.today, b.daily, today], ['Monthly', p.month, b.monthly, month]] as const) {
    if (!cap) continue
    for (const at of [100, 80]) {
      const id = `${key}:${at}`
      if ((100 * used) / cap >= at && !alerted.includes(id)) {
        fresh.push(id)
        $.ui.toast(`${name} budget ${at === 100 ? 'reached' : '80% used'}: ${usd(used)} of ${usd(cap)}${p.kind === 'api-equiv' ? ' (API-equivalent)' : ''}`, { timeoutMs: TOAST_MS })
        break
      }
    }
  }
  if (fresh.length) await $.store.set('alerted', [...alerted.filter(a => a.startsWith(month)), ...fresh])
}

async function loadHistory($: EngineInterface): Promise<History> {
  const dir = await ledgerDir($)
  const h: History = { days: {}, byCategory: {}, byProfile: {}, sessions: 0, loadedAt: await $.clock.now() }
  const files = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  for (const f of files) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    try {
      const s = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)))
      const saved = Object.values((s.saved ?? {}) as Savings).reduce((a, c) => a + (c?.usd ?? 0), 0)
      const day = (h.days[s.day] ??= { saved: 0, spent: 0 })
      day.saved += saved
      for (const [d, v] of Object.entries((s.spentByDay ?? { [s.day]: s.spent ?? 0 }) as Record<string, number>)) {
        ;(h.days[d] ??= { saved: 0, spent: 0 }).spent += v
      }
      const prof = (h.byProfile[s.profile] ??= { saved: 0, spent: 0 })
      prof.saved += saved
      prof.spent += s.spent ?? 0
      for (const [cat, v] of Object.entries((s.saved ?? {}) as Savings)) {
        const was = h.byCategory[cat as SavingCategory] ?? { usd: 0, count: 0 }
        h.byCategory[cat as SavingCategory] = { usd: was.usd + (v?.usd ?? 0), count: was.count + (v?.count ?? 0) }
      }
      h.sessions += 1
    } catch {
      // a half-written or foreign file: skip it
    }
  }
  return h
}

async function refreshSpend($: EngineInterface) {
  const s = await fetchLiteLLM($).catch(() => null)
  await update($, litellm, prev => (s && prev && !prev.error && !s.error ? { ...s, baseline: prev.baseline } : s))
}

async function isGateway($: EngineInterface) {
  const base = await $.env.get('ANTHROPIC_BASE_URL')
  return !!base && !/anthropic\.com/.test(base)
}

/** Lifetime spend of the LiteLLM key this session runs through; null when it talks to Anthropic directly. */
let noLiteLLM = false
async function fetchLiteLLM($: EngineInterface): Promise<Spend | null> {
  const base = await $.env.get('ANTHROPIC_BASE_URL')
  const token = await $.env.get('ANTHROPIC_AUTH_TOKEN')
  if (!base || !token || /anthropic\.com/.test(base) || conf.litellm === 'off' || noLiteLLM) return null

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  const custom = (await $.env.get('ANTHROPIC_CUSTOM_HEADERS')) ?? ''
  for (const line of custom.split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }

  const at = await $.clock.now()
  try {
    const r = await $.http.fetch(`${base.replace(/\/+$/, '')}/key/info`, { headers })
    // A gateway that is not LiteLLM has no /key/info: stop asking (config litellm "on" keeps trying).
    if ((r.status === 404 || r.status === 405) && conf.litellm === 'auto') {
      noLiteLLM = true
      return null
    }
    if (!r.ok) return { spend: 0, baseline: 0, maxBudget: null, resetAt: null, at, error: `HTTP ${r.status}` }
    const info = JSON.parse(r.text)?.info ?? {}
    return {
      spend: Number(info.spend ?? 0),
      baseline: Number(info.spend ?? 0),
      maxBudget: info.max_budget == null ? null : Number(info.max_budget),
      resetAt: info.budget_reset_at ?? null,
      at,
      error: null,
    }
  } catch (err) {
    return { spend: 0, baseline: 0, maxBudget: null, resetAt: null, at, error: String(err).slice(0, 60) }
  }
}

/** Idle with a warm 5-minute cache: refresh it with a one-word fork so the next prompt reads instead of re-writing. */
function scheduleKeepAlive($: EngineInterface) {
  keepAliveTimer?.cancel()
  keepAliveTimer = $.clock.after(KEEPALIVE_MS, () => {
    void (async () => {
      const l = await read($, limits)
      const tokens = (await read($, context))?.tokens ?? 0
      if (!l.keepAlive || pings.count >= KEEPALIVE_MAX || tokens < 30_000 || !(await isGateway($))) return
      const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
      if (r.isAnswered === false && r.reason === 'nothing-to-fork') return
      pings = { count: pings.count + 1, cost: pings.cost + costOf(r.usage, lastMainModel), tokens, model: lastMainModel }
      await trackLog($, 'keepalive', { model: lastMainModel, tokens, cacheRead: r.usage.cache_read_input_tokens, cacheWrite: r.usage.cache_creation_input_tokens,
        input: r.usage.input_tokens, output: r.usage.output_tokens, costUsd: costOf(r.usage, lastMainModel), hit: r.usage.cache_read_input_tokens >= tokens * 0.5 })
      if (r.usage.cache_read_input_tokens < tokens * 0.5) {
        // The fork did not hit the conversation's cache: pinging costs without helping.
        await update($, limits, x => ({ ...x, keepAlive: false }))
        $.ui.toast('budget-guard: keep-alive missed the cache here; turned it off for this session', { timeoutMs: TOAST_MS })
        return
      }
      scheduleKeepAlive($)
    })()
  })
}

/** The prompt came back: if pings kept the cache warm, the first call reads it instead of writing it again. */
async function settleKeepAlive($: EngineInterface) {
  keepAliveTimer?.cancel()
  keepAliveTimer = null
  if (pings.count > 0) {
    await addSaving($, 'keep-alive', writeCost(pings.tokens, pings.model) - readCost(pings.tokens, pings.model) - pings.cost)
  }
  pings = { count: 0, cost: 0, tokens: 0, model: lastMainModel }
}

async function classifyFirstPrompt($: EngineInterface, text: string, engineModel: string) {
  const labels = Object.values(TIERS).map(t => t.label)
  await logClassify($, 'route', Math.min(text.length, 4000) + labels.join('').length)
  const picked = await $.model.classify(text.slice(0, 4000), labels, { model: HAIKU }).catch(() => undefined)
  const tier = (Object.keys(TIERS) as (keyof typeof TIERS)[]).find(t => TIERS[t].label === picked) ?? 'normal'
  const r: Route = { tier, model: TIERS[tier].model, effort: tier === 'hard' ? opusMax() : TIERS[tier].effort, engineModel }
  return r
}

async function looksLikeNewTask($: EngineInterface, previous: string[], text: string) {
  const sample = `EARLIER REQUESTS IN THIS SESSION:\n${previous.map(p => `- ${p.slice(0, 600)}`).join('\n')}\n\nNEW REQUEST:\n${text.slice(0, 1500)}`
  await logClassify($, 'new_task', sample.length)
  const picked = await $.model
    .classify(sample, ['continues or follows up the earlier work', 'an unrelated new task'], { model: HAIKU })
    .catch(() => undefined)
  return picked === 'an unrelated new task'
}

/** The engine's own auto-compact must stay on: compactAt only adds an earlier, prompt-time compaction. */
async function ensureAutoCompact($: EngineInterface) {
  const row = (await $.config.list().catch(() => [])).find(r => r.key === 'autoCompact')
  if (row && row.value === false && !row.isLocked) {
    const r = await $.config.set({ key: 'autoCompact', value: true }).catch(() => ({ deny: 'failed' }))
    if (!r.deny) $.ui.toast('budget-guard turned auto-compact back on', { timeoutMs: TOAST_MS })
  }
}

/** Over compactAt at the end of a turn: compact then, so the next prompt starts small. Returns the new size. */
async function compactNow($: EngineInterface, tokens: number): Promise<number> {
  $.ui.toast(`Context ${k(tokens)} is over ${k(conf.compactAt)}: compacting`, { timeoutMs: TOAST_MS })
  const r = await $.session.compact().catch(() => null)
  const after = r && 'tokensAfter' in r && r.tokensAfter !== undefined ? r.tokensAfter : ((await $.session.usage().catch(() => null))?.context.tokens ?? tokens)
  await trackLog($, 'compact', { reason: 'compactAt', before: tokens, after })
  if (after < tokens) await update($, context, c => (c ? { ...c, tokens: after, percent: Math.round((100 * after) / c.window) } : c))
  return after
}

/** The held new-task prompt: clear or compact first (both shrink every later call), or send it as is. */
async function resolvePending($: EngineInterface, how: 'clear' | 'compact' | 'keep') {
  const p = await read($, pending)
  if (!p) return
  await update($, pending, () => null)
  await trackLog($, 'resolve', { how, tokens: p.tokens })
  if (how === 'clear') {
    await $.command.run({ command: 'clear' })
    await update($, prompts, () => [])
    await addSaving($, 'new-task', FUTURE_CALLS * readCost(p.tokens, lastMainModel))
  } else if (how === 'compact') {
    const before = p.tokens
    await $.session.compact({ instructions: 'The next request starts a new task; keep only what it may need.' })
    const after = (await $.session.usage()).context.tokens ?? before
    await addSaving($, 'new-task', FUTURE_CALLS * readCost(Math.max(0, before - after), lastMainModel))
  }
  await $.prompt.submit({ text: p.text })
}

async function openSavings($: EngineInterface) {
  await flush($).catch(() => {})
  await update($, history, () => null)
  const h = await loadHistory($)
  await update($, history, () => h)
  return $.ui.open({ id: PANE, title: 'Budget savings', focus: true })
}

/** `day $12/$50 24%` and its color: yellow from 80%, red from 100%. */
function gauge(label: string, used: number, cap: number) {
  const pct = Math.round((100 * used) / cap)
  return { text: `${label} ${usd(used)}/${usd(cap)} ${pct}%`, color: pct >= 100 ? 'red' : pct >= 80 ? 'yellow' : undefined }
}

/** Limits by profile in one shared file: `{ "profiles": { "claude-infi": { "daily": 25, "monthly": 500 } } }`. */
async function budgetsPath($: EngineInterface) {
  return `${await modsHome($)}/budget-guard/budgets.json`
}

async function readBudgetsFile($: EngineInterface): Promise<{ profiles: Record<string, Budgets> }> {
  try {
    const f = JSON.parse(String(await $.fs.read(await budgetsPath($))))
    return { profiles: f.profiles ?? {} }
  } catch {
    return { profiles: {} }
  }
}

/** A profile with no entry shows no limits. */
async function loadBudgets($: EngineInterface) {
  {
    const b: Partial<Budgets> = (await readBudgetsFile($)).profiles[await profileName($)] ?? {}
    const next: Budgets = { daily: Number(b.daily) > 0 ? Number(b.daily) : null, monthly: Number(b.monthly) > 0 ? Number(b.monthly) : null }
    const was = await read($, budgets)
    if (was.daily !== next.daily || was.monthly !== next.monthly) await update($, budgets, () => next)
  }
}

async function budgetLine($: EngineInterface) {
  const b = await read($, budgets)
  const p = await read($, periods)
  if (!b.daily && !b.monthly) return 'limits none set (/budget daily <$>, /budget monthly <$>; this profile only)'
  const part = (name: string, used: number | undefined, cap: number | null) =>
    cap ? `${name} ${used === undefined ? '?' : usd(used)} of ${usd(cap)}${used === undefined ? '' : ` (${Math.round((100 * used) / cap)}%)`}` : `${name} no limit`
  const note = !p ? '' : p.kind === 'real' ? `  real LiteLLM $${p.since ? `, counted since ${p.since}` : ''}` : '  API-equivalent $ from this profile\'s sessions'
  return `limits ${part('today', p?.today, b.daily)}  ${part('month', p?.month, b.monthly)}${note}  (soft: never blocks)`
}

/** The limits from before a pause (/budget pause, /mods pause), put back when it ends. */
let beforePause: Limits | null = null

export const register: Register = on => {
  hubHooks(on)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'budget',
      description: 'Budget guard: status, setup, savings, pause <30m|2h|1d|session>, resume, route opus|sonnet|auto|off, warn|block|agents|bigturn|newtask <n>, images|keepalive|trim|agentroute on|off, compact <n>|off, holdout <0-1>, reset',
    })
    await loadConfig($)
    await update($, limits, () => startLimits())
    await trackStart($, 'budget-guard', conf.holdout, { ...(await read($, limits)), holdout: conf.holdout })
    if (!trackOn()) await update($, limits, l => ({ ...l, ...HOLDOUT_PATCH }))
    beforePause = null
    await hubStart($, {
      mod: 'budget-guard',
      command: 'budget',
      firstRun,
      pausable: true,
      status: async () => {
        const l = await read($, limits)
        const cost = await read($, costUsd)
        return `route ${l.route ? 'auto' : 'off'} · Opus effort ≤ ${opusMax()} · compact at ${conf.compactAt > 0 ? k(conf.compactAt) : 'engine'}${cost != null ? ` · session ${usd(cost)}` : ''}${trackOn() ? '' : ' · holdout this session'}`
      },
      setup: async () => setupPrompt(await configPath($), await budgetsPath($), await profileName($), conf, (await readBudgetsFile($)).profiles[await profileName($)] ?? null),
      onPause: async paused => {
        if (paused) {
          beforePause = await read($, limits)
          await update($, limits, l => ({ ...l, ...HOLDOUT_PATCH }))
        } else {
          const saved = beforePause
          beforePause = null
          await update($, limits, () => saved ?? (trackOn() ? startLimits() : { ...startLimits(), ...HOLDOUT_PATCH }))
        }
      },
    })
    $.clock.every(30_000, () => void trackFlush($).then(() => hubPoll($)).catch(() => {}))
    const st = (await $.settings.read().catch(() => ({}))) as { autoCompactWindow?: number }
    if (Number(st.autoCompactWindow) > 0) compactAt = Number(st.autoCompactWindow)
    if (conf.compactAt > 0) {
      compactAt = Math.min(compactAt, conf.compactAt)
      await ensureAutoCompact($)
    }
    const model = await $.session.model().catch(() => '')
    if (model) await update($, mainModel, m => m ?? { model, effort: null })
    await update($, billing, () => 'unknown')
    await loadBudgets($)
    const tick = async () => {
      await refreshSpend($)
      await loadBudgets($)
      const b = await detectBilling($, await read($, limitsNow))
      await update($, billing, () => b)
      await addSample($)
      await refreshPeriods($)
    }
    void tick().catch(() => {})
    $.clock.every(LITELLM_POLL_MS, () => void tick().catch(() => {}))
    $.clock.every(AGENT_POLL_MS, () => void refreshAgents($).catch(() => {}))
    $.clock.every(FLUSH_MS, () => void flush($).catch(() => {}))
    return r
  })

  // Background work in flight, as the engine reports it at each stop.
  on('classic.Stop', async ($, e, next) => {
    const tasks = ((e as any).background_tasks ?? []) as { id: string; type: string; status: string; description: string; command?: string }[]
    const live: LiveTask[] = tasks.map(t => ({ id: t.id, type: t.type, status: t.status, description: (t.command ?? t.description).slice(0, 60) }))
    await update($, liveTasks, () => live)
    await refreshAgents($).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => {})
    await trackLog($, 'session_summary', { costUsd: await read($, costUsd), saved: await read($, savings), agents: await read($, agents), route: await read($, route) })
    await trackFlush($).catch(() => {})
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const c = e.context
    if (c.tokens !== undefined) {
      const value: Context = { tokens: c.tokens, window: c.window, percent: c.percent ?? Math.round((100 * c.tokens) / c.window) }
      await update($, context, () => value)
    }
    if (e.cost) await update($, costUsd, () => e.cost!.usd)
    if (e.rateLimits.length > 0) {
      const lim: Limit[] = e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt ?? null }))
      await update($, limitsNow, () => lim)
      const b = await detectBilling($, e.rateLimits)
      await update($, billing, () => b)
    }
    if (e.changed.includes('cost') || e.changed.includes('rateLimits')) await addSample($).catch(() => {})
    return next(e)
  })

  // Every user prompt: keep-alive accounting, first-prompt routing, new-task detection, the context hold.
  on('prompt.submit', async ($, e, next) => {
    await settleKeepAlive($)
    if (e.origin.kind !== 'composer') return next(e)
    if (FORCE.test(e.text)) {
      await trackLog($, 'force', {})
      return next({ ...e, text: e.text.replace(FORCE, '') })
    }

    const l = await read($, limits)
    const tokens = (await read($, context))?.tokens ?? 0

    if (tokens >= l.block) {
      await trackLog($, 'hold', { reason: 'block', tokens })
      return { drop: `budget-guard: context is ${k(tokens)} (limit ${k(l.block)}). Run /compact or /clear, or prefix the prompt with "force:" to send it anyway.` }
    }

    if (!(await read($, routeDecided)) && tokens === 0) {
      await update($, routeDecided, () => true)
      if (l.route) {
        const r = await classifyFirstPrompt($, e.text, '')
        await update($, route, () => r)
        await trackLog($, 'route', { tier: r.tier, model: r.model, effort: r.effort })
      }
    }

    const previous = await read($, prompts)
    const isSubstantial = e.text.trim().length >= 25 && !/^(yes|no|ok|go|continue|do it|apply|proceed)\b/i.test(e.text.trim())
    if (tokens >= l.newTaskAt && previous.length > 0 && isSubstantial && (await looksLikeNewTask($, previous, e.text))) {
      await update($, pending, () => ({ text: e.text, tokens }))
      await trackLog($, 'hold', { reason: 'new_task', tokens })
      return { drop: `budget-guard: this looks like a new task with ${k(tokens)} of earlier context loaded. Pick in the band: [c] clear, [k] compact, [y] keep and send.` }
    }

    if (isSubstantial) await update($, prompts, p => [...p, e.text].slice(-3))
    if (tokens >= l.warn) $.ui.toast(`Context ${k(tokens)}, consider /compact`, { timeoutMs: TOAST_MS })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await settleKeepAlive($)
    return next(e)
  })

  // Model and effort per request: the routed session model on the main loop, Haiku/Sonnet in subagents.
  on('turn.step', async function* ($, e, next) {
    const l = await read($, limits)

    if (e.agentId === undefined) {
      let r = await read($, route)
      if (r && r.engineModel === '') {
        r = { ...r, engineModel: e.model }
        await update($, route, () => r)
      }
      const apply = l.route && r !== null && r.engineModel === e.model && /opus/.test(e.model)
      const model = apply ? r!.model : e.model
      const sentEffort = capEffort(model, apply ? r!.effort : e.effort)
      const effort = sentEffort === undefined ? null : String(sentEffort)
      lastMainModel = model
      const shown = await read($, mainModel)
      if (shown?.model !== model || shown?.effort !== effort) await update($, mainModel, () => ({ model, effort }))
      const res = yield* next({ ...e, model, effort: sentEffort })
      if (apply && res.usage && family(model) !== 'opus') {
        await addSaving($, 'route-session', costOf(res.usage, OPUS) - costOf(res.usage, model))
      }
      return res
    }

    agentModelSeen[e.agentId] = e.model
    if (!l.routeAgents) return yield* next({ ...e, effort: capEffort(e.model, e.effort) })
    const known = await read($, agentModels)
    let model = known[e.agentId]
    if (model === undefined) {
      const info = (await $.agent.list().catch(() => [])).find(a => a.id === e.agentId)
      // Engine forks (compaction, memory) are in no list: leave them be.
      model = !info || KEEP_AGENT_MODEL.test(info.type) ? '' : HAIKU_AGENTS.test(info.type) ? HAIKU : SONNET
      const pinned = model
      await update($, agentModels, m => ({ ...m, [e.agentId!]: pinned }))
      await trackLog($, 'agent_route', { agentType: info?.type ?? null, from: e.model, to: model || e.model })
    }
    if (model) agentModelSeen[e.agentId] = model
    if (e.index === 0) await refreshAgents($).catch(() => {})
    if (!model) return yield* next({ ...e, effort: capEffort(e.model, e.effort) })
    const res = yield* next({ ...e, model, effort: capEffort(model, e.effort) })
    if (res.usage) await addSaving($, 'route-agents', costOf(res.usage, OPUS) - costOf(res.usage, model))
    return res
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const l = await read($, limits)
    const used = await read($, agents)
    if (used >= l.maxAgents) {
      await trackLog($, 'deny', { what: 'agents', used })
      return { deny: `budget-guard: subagent budget used (${used}/${l.maxAgents}). Do this inline, or ask the user to raise it with /budget agents <n>.` }
    }
    await update($, agents, n => n + 1)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const path = e.file_path
    if (IMAGE.test(path) && !(await read($, limits)).allowImages) {
      await trackLog($, 'deny', { what: 'image' })
      return { deny: `budget-guard: reading images is off (they stay in context every turn). Describe what to check, use a text snapshot, or ask the user to run /budget images on.` }
    }
    if (GENERATED.test(path)) {
      if (!trackOn()) {
        await trackLog($, 'would_deny', { what: 'generated' })
        return next(e)
      }
      await trackLog($, 'deny', { what: 'generated' })
      return { deny: `budget-guard: ${path} is generated/vendored/huge. Use Grep for what you need.` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Noisy build/test output: keep the tail in context, the whole log on disk.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    const eligible = NOISY.test(cmd) && !/[|>]|<<|\btail\b|\bhead\b/.test(cmd) && !e.run_in_background
    const wrap = (await read($, limits)).trimOutput && eligible
    if (!wrap) {
      if (!eligible || trackOn()) return next(e)
      const ran = await next(e)
      const out = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
      if (out.split('\n').length > KEEP_LINES) await trackLog($, 'would_trim', { bytesAll: out.length })
      return ran
    }

    const wrapped = [
      '__bg_log=$(mktemp -t budget-guard.XXXXXX)',
      `{ ${cmd}`,
      '} >"$__bg_log" 2>&1; __bg_rc=$?',
      `tail -n ${KEEP_LINES} "$__bg_log"`,
      `__bg_all=$(wc -c <"$__bg_log" | tr -d ' '); __bg_kept=$(tail -n ${KEEP_LINES} "$__bg_log" | wc -c | tr -d ' ')`,
      `[ "$__bg_all" -gt "$__bg_kept" ] && echo "[budget-guard: kept $__bg_kept of $__bg_all bytes (last ${KEEP_LINES} lines); full log: $__bg_log]"`,
      '(exit $__bg_rc)',
    ].join('\n')
    const ran = await next({ ...e, command: wrapped })
    const m = TRIM_MARK.exec(JSON.stringify(ran.result ?? ran.text ?? ''))
    if (m) {
      const trimmedTokens = Math.round((Number(m[2]) - Number(m[1])) / 4)
      await trackLog($, 'trim', { bytesAll: Number(m[2]), bytesKept: Number(m[1]) })
      await addSaving($, 'output-trim', writeCost(trimmedTokens, lastMainModel) + FUTURE_CALLS * readCost(trimmedTokens, lastMainModel))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (SCREENSHOT.test(e.tool)) {
      const n = (await read($, screenshots)) + 1
      await update($, screenshots, () => n)
      if (n % 10 === 0) $.ui.toast(`${n} screenshots this session; prefer take_snapshot (text)`, { timeoutMs: TOAST_MS })
    }
    const ran = await next(e)
    const size = JSON.stringify(ran.result ?? '').length
    if (size > 30_000) $.ui.toast(`${e.tool} returned ~${k(Math.round(size / 4))} tokens; it stays in context`, { timeoutMs: TOAST_MS })
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    let tokens = (await $.session.usage()).context.tokens ?? 0
    if (conf.compactAt > 0 && tokens >= conf.compactAt && !e.isAborted && !hubPaused()) tokens = await compactNow($, tokens)
    const before = await read($, lastTokens)
    const delta = tokens - before
    await update($, lastTokens, () => tokens)
    await update($, lastDelta, () => delta)
    if (delta > (await read($, limits)).bigTurn) $.ui.toast(`Heavy turn: +${k(delta)} tokens of context`, { timeoutMs: TOAST_MS })
    scheduleKeepAlive($)
    return r
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    const num = Number(String(val ?? '').replace(/^\$/, '').replace(/k$/i, '000'))
    const set = async (patch: Partial<Limits>) => update($, limits, l => ({ ...l, ...patch }))
    const onOff = val === 'on'

    if (what === 'setup') {
      const text = setupPrompt(await configPath($), await budgetsPath($), await profileName($), conf, (await readBudgetsFile($)).profiles[await profileName($)] ?? null)
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the budget-guard setup…' }
    }
    if (what === 'pause') {
      const ms = val === 'session' ? 'session' : parseDuration(val)
      if (!ms) return { text: 'Usage: /budget pause <30m | 2h | 1d | session>: routing, the Opus effort cap, compaction, trimming and keep-alive step aside; budgets and the context hold stay. /budget resume ends it.' }
      await hubSetPause($, 'budget-guard', ms === 'session' ? 'session' : Date.now() + ms)
      return { text: `budget-guard paused ${ms === 'session' ? 'for this session' : `until ${hubClock(Date.now() + ms)}`}: routing, the Opus effort cap, compaction, trimming and keep-alive step aside; budgets and the context hold stay. /budget resume ends it.` }
    }
    if (what === 'resume') {
      await hubSetPause($, 'budget-guard', 0)
      return { text: 'budget-guard resumed.' }
    }
    if (what === 'savings') {
      const opened = await openSavings($)
      if (opened.isPlaced) return { text: 'Savings pane opened.' }
      const h = (await read($, history))!
      const total = Object.values(h.byCategory).reduce((a, c) => a + (c?.usd ?? 0), 0)
      return { text: `Saved ~${usd(total)} over ${h.sessions} sessions. ${Object.entries(h.byCategory).map(([c, v]) => `${c} ${usd(v!.usd)}`).join(', ')}` }
    }
    if (what === 'route') {
      if (val === 'off') await set({ route: false })
      else if (val === 'auto') await set({ route: true })
      else if (val === 'opus' || val === 'sonnet') {
        const r = await read($, route)
        const pick: Route = val === 'opus'
          ? { tier: 'hard', model: OPUS, effort: opusMax(), engineModel: r?.engineModel ?? '' }
          : { tier: 'quick', model: SONNET, effort: 'low', engineModel: r?.engineModel ?? '' }
        await update($, route, () => pick)
        await set({ route: true })
      }
    } else if (what === 'warn' && num > 0) await set({ warn: num })
    else if (what === 'block' && num > 0) await set({ block: num })
    else if (what === 'agents' && num >= 0) await set({ maxAgents: num })
    else if (what === 'bigturn' && num > 0) await set({ bigTurn: num })
    else if (what === 'newtask' && num > 0) await set({ newTaskAt: num })
    else if (what === 'daily' || what === 'monthly') {
      const cap = val === 'off' ? null : num > 0 ? num : undefined
      if (cap === undefined) return { text: `Usage: /budget ${what} <dollars|off>` }
      const next = { ...(await read($, budgets)), [what]: cap }
      await update($, budgets, () => next)
      const file = await readBudgetsFile($)
      file.profiles[await profileName($)] = next
      await $.fs.write(await budgetsPath($), JSON.stringify(file, null, 2))
      await refreshPeriods($).catch(() => {})
    }
    else if (what === 'images') await set({ allowImages: onOff })
    else if (what === 'keepalive') await set({ keepAlive: onOff })
    else if (what === 'trim') await set({ trimOutput: onOff })
    else if (what === 'agentroute') await set({ routeAgents: onOff })
    else if (what === 'compact' && (val === 'off' || num >= 50_000)) {
      conf = { ...conf, compactAt: val === 'off' ? 0 : num }
      await saveConfig($)
      if (conf.compactAt > 0) {
        compactAt = conf.compactAt
        await ensureAutoCompact($)
      }
      return { text: conf.compactAt > 0 ? `budget-guard compacts at ${k(conf.compactAt)} from now on` : 'budget-guard leaves compaction to the engine (settings.json autoCompactWindow)' }
    }
    else if (what === 'holdout' && Number(val) >= 0 && Number(val) <= 1) {
      conf = { ...conf, holdout: Number(val) }
      await saveConfig($)
      return { text: `budget-guard holdout share set to ${Math.round(Number(val) * 100)}% (applies to new sessions)` }
    }
    else if (what === 'reset') {
      await update($, limits, () => (trackOn() ? startLimits() : { ...startLimits(), ...HOLDOUT_PATCH }))
      await update($, agents, () => 0)
    } else if (what === 'refresh') {
      await refreshSpend($)
    } else if (what) {
      return { text: 'Usage: /budget [setup] [savings] [pause <30m|2h|1d|session> | resume] [route opus|sonnet|auto|off] [daily|monthly <$|off>] [warn|block|agents|bigturn|newtask <n>] [images|keepalive|trim|agentroute on|off] [compact <n>|off] [holdout <0-1>] [reset] [refresh]' }
    }

    const l = await read($, limits)
    const c = await read($, context)
    const s = await read($, litellm)
    const r = await read($, route)
    const cost = await read($, costUsd)
    const sv = await read($, savings)
    const savedNow = Object.values(sv).reduce((a, x) => a + (x?.usd ?? 0), 0)
    return {
      text: [
        `context ${c ? `${k(c.tokens)} (${c.percent}%)` : 'n/a'}  warn ${k(l.warn)}  hold ${k(l.block)}  new-task check from ${k(l.newTaskAt)}`,
        `rules (every session): Opus effort ≤ ${opusMax() === 'max' ? 'no cap' : opusMax()}  compact at ${conf.compactAt > 0 ? k(conf.compactAt) : `engine's ${k(compactAt)}`}`,
        `route ${l.route ? (r ? `${r.tier} → ${short(r.model)} · ${r.effort}` : 'decides on the first prompt') : 'off'}  subagents ${l.routeAgents ? 'Explore→Haiku, rest→Sonnet' : 'not routed'}`,
        `subagents ${await read($, agents)}/${l.maxAgents}  images ${l.allowImages ? 'on' : 'off'}  trim ${l.trimOutput ? 'on' : 'off'}  keep-alive ${l.keepAlive ? 'on (gateway only)' : 'off'}  screenshots ${await read($, screenshots)}`,
        await budgetLine($),
        `session cost ${cost == null ? 'n/a' : usd(cost)}  saved this session ~${usd(savedNow)}  (/budget savings for history)`,
        ...(hubPaused() ? [`PAUSED ${hubPausedUntil() === Infinity ? 'for this session' : `until ${hubClock(hubPausedUntil())}`}: levers, effort cap and compaction step aside (/budget resume)`] : []),
        trackOn() ? 'impact: this session is in the active arm (/analytics impact compares it with the holdout)' : 'impact: this session is in the HOLDOUT arm: cost levers are off so their effect can be measured (/budget route auto etc. still work)',
        s ? (s.error ? `LiteLLM: ${s.error}` : `LiteLLM this session +${usd(s.spend - s.baseline)}, key total ${usd(s.spend)}${s.maxBudget ? ` / ${usd(s.maxBudget)}` : ' (no max_budget set)'}${s.resetAt ? `, resets ${s.resetAt.slice(0, 10)}` : ''}`) : 'LiteLLM: not in use',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, pending)

    if (p) {
      return (
        <Box paddingX={1} flexDirection="column">
          <Text color="yellow">New task with {k(p.tokens)} of earlier context loaded. Every call re-reads it.</Text>
          <Box>
            <Button key="clear" label="Clear and send" hotkey="c" onPress={() => resolvePending($, 'clear')} />
            <Text> </Text>
            <Button key="compact" label="Compact and send" hotkey="k" onPress={() => resolvePending($, 'compact')} />
            <Text> </Text>
            <Button key="keep" label="Keep and send" hotkey="y" onPress={() => resolvePending($, 'keep')} />
          </Box>
        </Box>
      )
    }

    const c = await read($, context)
    const m = await read($, mainModel)
    if (!c && !m) return next(e)
    const l = await read($, limits)
    const delta = await read($, lastDelta)
    const cost = await read($, costUsd)
    const s = await read($, litellm)
    const bill = await read($, billing)
    const smp = await read($, samples)
    const lim = await read($, limitsNow)
    const ags = await read($, liveAgents)
    const tasks = (await read($, liveTasks)).filter(t => t.type !== 'subagent' && t.status !== 'completed')
    const sv = await read($, savings)
    const saved = Object.values(sv).reduce((a, x) => a + (x?.usd ?? 0), 0)
    const per = await read($, periods)
    const caps = await read($, budgets)

    const sessionRate = perHour(smp, x => x.cost)
    const keyRate = perHour(smp, x => x.key)
    const fiveRate = perHour(smp, x => x.fiveHour)
    const five = lim.find(x => x.kind === 'five_hour')
    const seven = lim.find(x => x.kind === 'seven_day')
    const ctxColor = !c ? undefined : c.tokens >= l.block ? 'red' : c.tokens >= l.warn ? 'yellow' : 'green'
    const sOver = s && !s.error && s.maxBudget ? s.spend / s.maxBudget : 0
    const rate = (r: number | null) => (r === null ? '' : ` · ${usd(Math.max(0, r))}/h`)

    // What the money means depends on who pays: real dollars on a gateway or an API key, limit headroom on a plan.
    let pay: any = null
    if (bill === 'gateway' && s && !s.error) {
      pay = (
        <Text color={sOver >= 0.9 ? 'red' : sOver >= 0.7 ? 'yellow' : undefined}>
          LiteLLM +{usd(s.spend - s.baseline)}{keyRate !== null ? ` · key ${usd(Math.max(0, keyRate))}/h` : ''}
          {s.maxBudget ? ` · ${Math.round(100 * sOver)}% of ${usd(s.maxBudget)}` : ''}
        </Text>
      )
    } else if (bill === 'gateway' && s?.error) {
      pay = <Text color="yellow">LiteLLM {s.error}</Text>
    } else if (bill === 'subscription' && five) {
      const eta = fiveRate && fiveRate > 0.5 ? ((100 - five.percent) / fiveRate) * 3_600_000 : null
      const resetMs = five.resetsAt ? Date.parse(five.resetsAt) - (smp[smp.length - 1]?.t ?? 0) : null
      const hitsFirst = eta !== null && (resetMs === null || eta < resetMs)
      pay = (
        <Text>
          <Text color={five.percent >= 90 ? 'red' : five.percent >= 70 ? 'yellow' : undefined}>5h {Math.round(five.percent)}%</Text>
          {hitsFirst ? <Text color="yellow"> full in ~{dur(eta!)}</Text> : resetMs !== null && resetMs > 0 ? <Text dimColor> resets {dur(resetMs)}</Text> : null}
          {seven ? <Text dimColor> · 7d {Math.round(seven.percent)}%</Text> : null}
        </Text>
      )
    } else if (bill === 'api-key') {
      pay = <Text dimColor>API key, billed per token</Text>
    }

    return (
      <Box paddingX={1} flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text>
            <Text color="cyan" bold>◆ {m ? short(m.model) : '…'}</Text>
            {m?.effort ? <Text color="cyan"> · {m.effort}</Text> : null}
          </Text>
          <Text>
            <Text dimColor>│ </Text>
            {bill === 'subscription' ? '≈' : ''}{cost == null ? '$0.00' : usd(cost)}
            <Text dimColor>{rate(sessionRate)}{bill === 'subscription' ? ' API-equiv' : ''}</Text>
          </Text>
          {per
            ? [caps.daily ? gauge('day', per.today, caps.daily) : null, caps.monthly ? gauge('month', per.month, caps.monthly) : null]
                .filter(g => g !== null)
                .map((g, i) => (
                  <Text key={`gauge${i}`}>
                    <Text dimColor>│ </Text>
                    <Text color={g!.color} dimColor={!g!.color}>{g!.text}</Text>
                    {per.kind === 'api-equiv' ? <Text dimColor> ≈</Text> : null}
                  </Text>
                ))
            : null}
          {pay ? (
            <Text>
              <Text dimColor>│ </Text>
              {pay}
            </Text>
          ) : null}
          {saved > 0 ? <Text color="green">saved ~{usd(saved)}</Text> : null}
        </Box>
        {c ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text>
              <Text color={ctxColor} bold>● {k(c.tokens)} ctx</Text>
              <Text dimColor> ({c.percent}%)</Text>
            </Text>
            {delta !== 0 ? <Text dimColor={delta < l.bigTurn} color={delta >= l.bigTurn ? 'yellow' : undefined}>{delta > 0 ? '▲' : '▼'}{k(Math.abs(delta))} last turn</Text> : null}
            <Text dimColor>│ compacts ~{k(compactAt)} · hold {k(l.block)}</Text>
          </Box>
        ) : null}
        {ags.length > 0 ? (
          <Text wrap="wrap">
            <Text color="magenta">⚙ {ags.length} agent{ags.length > 1 ? 's' : ''}</Text>
            {ags.map(a => (
              <Text key={a.id}>
                <Text dimColor>  │ </Text>
                <Text>{a.type}</Text>
                <Text dimColor>·{a.model ? short(a.model) : 'inherits'}{a.status !== 'running' ? ` (${a.status})` : ''} {a.description}</Text>
              </Text>
            ))}
          </Text>
        ) : null}
        {tasks.length > 0 ? (
          <Text wrap="wrap">
            <Text color="blue">▶ {tasks.length} task{tasks.length > 1 ? 's' : ''}</Text>
            {tasks.map(t => (
              <Text key={t.id}>
                <Text dimColor>  │ {t.type}</Text>
                <Text> {t.description}</Text>
              </Text>
            ))}
          </Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const h = await read($, history)
    if (!h) return <Text dimColor>Loading savings…</Text>

    const days = Object.keys(h.days).sort().slice(-14)
    const maxDay = Math.max(0.01, ...days.map(d => h.days[d]!.saved))
    const width = Math.max(10, Math.min(40, (e.viewport?.columns ?? 60) - 28))
    const totalSaved = Object.values(h.byCategory).reduce((a, c) => a + (c?.usd ?? 0), 0)
    const totalSpent = Object.values(h.byProfile).reduce((a, p) => a + p.spent, 0)
    const pct = totalSpent + totalSaved > 0 ? Math.round((100 * totalSaved) / (totalSpent + totalSaved)) : 0

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Saved ~{usd(totalSaved)} · spent {usd(totalSpent)} · {pct}% less than without the guard</Text>
        <Text dimColor>{h.sessions} sessions across profiles · estimates at list prices</Text>
        <Text> </Text>
        <Text bold>Last 14 days (saved)</Text>
        {days.map(d => (
          <Text key={d}>
            <Text dimColor>{d.slice(5)} </Text>
            <Text color="green">{'█'.repeat(Math.max(h.days[d]!.saved > 0 ? 1 : 0, Math.round((width * h.days[d]!.saved) / maxDay)))}</Text>
            <Text dimColor> {usd(h.days[d]!.saved)} / spent {usd(h.days[d]!.spent)}</Text>
          </Text>
        ))}
        <Text> </Text>
        <Text bold>By lever</Text>
        {Object.entries(h.byCategory).sort((a, b) => b[1]!.usd - a[1]!.usd).map(([cat, v]) => (
          <Text key={cat}>{cat.padEnd(14)} {usd(v!.usd).padStart(8)} <Text dimColor>({v!.count}×)</Text></Text>
        ))}
        <Text> </Text>
        <Text bold>By profile</Text>
        {Object.entries(h.byProfile).map(([p, v]) => (
          <Text key={p}>{p.padEnd(14)} saved {usd(v.saved).padStart(8)}  <Text dimColor>spent {usd(v.spent)}</Text></Text>
        ))}
        <Text> </Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => openSavings($)} />
      </Box>
    )
  })
}
