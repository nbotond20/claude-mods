import type { EngineInterface, Register } from 'claude-code'

// A local observability platform for Claude Code: Grafana, Tempo, Loki and Prometheus in one container on
// this machine (bin/claude-obs), fed by Claude Code's own OpenTelemetry from every profile.
//
// - session.start: the profile's settings.json gets the telemetry environment (it is read when Claude Code
//   starts, so it takes effect from the next session), tagged with the profile's name; the stack is started
//   in the background when Docker is there.
// - /obs: status, open a dashboard, start/stop the stack, replay old transcripts, telemetry and content on/off.
//
// Free and local only: every port listens on 127.0.0.1 and nothing phones home.

/**
 * The folder the mods share: $CLAUDE_MODS_HOME, else ~/.claude-shared when it already exists, else ~/.claude-mods.
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
const MODS = ['budget-guard', 'lean-tools', 'lsp-first', 'no-attribution', 'observability', 'timesheet', 'usage-analytics']
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

type Config = {
  /** write the telemetry environment into each profile's settings.json */
  telemetry: boolean
  /** keep prompt text, tool inputs (commands, paths) and error text in the local store */
  content: boolean
  /** also keep full tool outputs (large) */
  toolContent: boolean
  /** hook spans and other detailed beta tracing */
  detailedTracing: boolean
  /** start the stack in the background at session start when Docker is running */
  autostart: boolean
  grafanaPort: number
  otlpHttpPort: number
  otlpGrpcPort: number
  retentionDays: number
}
export const DEFAULTS: Config = {
  telemetry: true,
  content: true,
  toolContent: false,
  detailedTracing: true,
  autostart: true,
  grafanaPort: 3301,
  otlpHttpPort: 4318,
  otlpGrpcPort: 4317,
  retentionDays: 90,
}
let cfg: Config = DEFAULTS
let firstRun = false

/** Marks the settings env keys this mod wrote, so it only ever changes or removes its own. */
export const MARK = 'CLAUDE_OBS_MANAGED'
/** Every key the mod may write; removing telemetry removes exactly these. */
export const KEYS = [
  MARK,
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
]

/** The environment a profile's settings get. */
export function telemetryEnv(c: Config, profile: string): Record<string, string> {
  const endpoint = `http://127.0.0.1:${c.otlpHttpPort}`
  const env: Record<string, string> = {
    [MARK]: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    // Prometheus stores cumulative counters; delta would arrive as unrelated samples.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    OTEL_METRICS_INCLUDE_VERSION: 'true',
    OTEL_RESOURCE_ATTRIBUTES: `claude.profile=${profile.replace(/[^\w.-]/g, '_')}`,
  }
  if (c.content) Object.assign(env, { OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_TOOL_DETAILS: '1' })
  if (c.content && c.toolContent) env.OTEL_LOG_TOOL_CONTENT = '1'
  if (c.detailedTracing) Object.assign(env, { ENABLE_BETA_TRACING_DETAILED: '1', BETA_TRACING_ENDPOINT: endpoint })
  return env
}

export type EnvPlan =
  | { action: 'none' }
  | { action: 'write'; env: Record<string, string>; added: boolean }
  | { action: 'remove'; env: Record<string, string> }
  | { action: 'foreign'; endpoint: string }

/**
 * What to do with a settings env: add or update our keys, remove them, or leave alone an OpenTelemetry
 * setup someone else made (an exporter or endpoint without our mark).
 */
export function planEnv(current: Record<string, string> | undefined, want: Record<string, string> | null): EnvPlan {
  const env = { ...(current ?? {}) }
  const ours = env[MARK] === '1'
  if (!ours) {
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    const exporter = ['OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_TRACES_EXPORTER'].some(k => env[k] && env[k] !== 'none')
    if (endpoint || exporter) return want ? { action: 'foreign', endpoint: endpoint || 'another exporter' } : { action: 'none' }
  }
  if (!want) {
    if (!ours) return { action: 'none' }
    for (const k of KEYS) delete env[k]
    return { action: 'remove', env }
  }
  const next = { ...env }
  for (const k of KEYS) if (ours && !(k in want)) delete next[k]
  Object.assign(next, want)
  if (JSON.stringify(Object.entries(next).sort()) === JSON.stringify(Object.entries(env).sort())) return { action: 'none' }
  return { action: 'write', env: next, added: !ours }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return null
  }
}

async function configPath($: EngineInterface) {
  return `${await modsHome($)}/observability/config.json`
}

async function loadConfig($: EngineInterface) {
  const path = await configPath($)
  const saved = await readJson<Partial<Config>>($, path)
  firstRun = !saved
  cfg = { ...DEFAULTS, ...(saved ?? {}) }
  if (!saved) await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
}

async function saveConfig($: EngineInterface, patch: Partial<Config>) {
  cfg = { ...cfg, ...patch }
  const path = await configPath($)
  const saved = (await readJson<Record<string, unknown>>($, path)) ?? {}
  await $.fs.write(path, JSON.stringify({ ...saved, ...patch }, null, 2) + '\n')
}

type Profile = { name: string; dir: string }

async function thisProfile($: EngineInterface): Promise<Profile> {
  const home = (await $.env.get('HOME')) ?? ''
  const dir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\/+$/, '')
  return { name: dir.split('/').pop()!.replace(/^\./, ''), dir }
}

/** ~/.claude and every ~/.claude-* folder that is a profile (has settings.json or projects/). */
async function allProfiles($: EngineInterface): Promise<Profile[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const out: Profile[] = []
  for (const e of await $.fs.list(home).catch(() => [])) {
    if (!/^\.claude(-[\w.-]+)?$/.test(e.name) || e.name === '.claude-shared' || e.name === '.claude-mods') continue
    const dir = `${home}/${e.name}`
    if ((await $.fs.exists(`${dir}/settings.json`).catch(() => false)) || (await $.fs.exists(`${dir}/projects`).catch(() => false))) {
      out.push({ name: e.name.replace(/^\./, ''), dir })
    }
  }
  const mine = await thisProfile($)
  if (!out.some(p => p.dir === mine.dir)) out.push(mine)
  return out
}

/** Brings one profile's settings.json in line with the config. Returns what was done. */
async function applyProfile($: EngineInterface, p: Profile, on = cfg.telemetry): Promise<EnvPlan['action']> {
  const path = `${p.dir}/settings.json`
  const exists = await $.fs.exists(path).catch(() => false)
  const settings = exists ? await readJson<Record<string, unknown>>($, path) : {}
  if (!settings) return 'none' // unreadable JSON: never overwrite it
  const plan = planEnv(settings.env as Record<string, string> | undefined, on ? telemetryEnv(cfg, p.name) : null)
  if (plan.action === 'write' || plan.action === 'remove') {
    const next = { ...settings, env: plan.env }
    if (!Object.keys(plan.env).length) delete next.env
    await $.fs.write(path, JSON.stringify(next, null, 2) + '\n')
  }
  return plan.action
}

// ---- the stack --------------------------------------------------------------------------------------

type Status = {
  docker: boolean
  running: boolean
  current: boolean
  grafana: boolean
  otlp: boolean
  url: string
  dataSize?: string
  data?: string
  retentionDays?: number
}

async function obs($: EngineInterface, args: string[], timeoutMs = 30_000) {
  return $.process.run(['sh', `${$.plugin.root}/bin/claude-obs`, ...args], { timeoutMs, env: { CLAUDE_MODS_HOME: await modsHome($) } })
}

async function stackStatus($: EngineInterface): Promise<Status | null> {
  try {
    const r = await obs($, ['status', '--json'], 20_000)
    return JSON.parse(r.stdout.trim().split('\n').pop() || '') as Status
  } catch {
    return null
  }
}

let starting: Promise<string> | null = null
/** Starts (or replaces an outdated) stack; one at a time. Resolves with what happened. */
function stackUp($: EngineInterface): Promise<string> {
  starting ??= (async () => {
    try {
      const r = await obs($, ['up'], 300_000)
      return r.exitCode === 0 ? r.stdout.trim().split('\n').pop() || 'up' : `failed: ${(r.stderr || r.stdout).trim().slice(-400)}`
    } catch (err) {
      return `failed: ${String(err).slice(0, 300)}`
    } finally {
      starting = null
    }
  })()
  return starting
}

let lastStatus: Status | null = null
let profileState: EnvPlan['action'] | 'off' = 'none'
let liveHere = false

async function autostart($: EngineInterface) {
  lastStatus = await stackStatus($)
  if (!lastStatus?.docker || (lastStatus.running && lastStatus.current && lastStatus.grafana)) return
  const r = await stackUp($)
  lastStatus = await stackStatus($)
  if (r.startsWith('failed')) $.ui.toast(`observability: the stack did not start (${r.slice(8, 160)}). /obs status for details.`)
}

function statusLine() {
  const s = lastStatus
  const stack = !s ? 'stack unknown' : !s.docker ? 'Docker not running' : s.running && s.grafana ? `stack up · ${s.url}` : starting ? 'stack starting' : 'stack down'
  const tel = !cfg.telemetry ? 'telemetry off' : liveHere ? 'this session reporting' : profileState === 'foreign' ? 'profile has another OTEL setup' : 'reporting from next session'
  return `${stack} · ${tel}`
}

async function statusText($: EngineInterface) {
  lastStatus = await stackStatus($)
  const s = lastStatus
  const me = await thisProfile($)
  const lines: string[] = []
  if (!s) lines.push('Stack: could not run bin/claude-obs.')
  else if (!s.docker) {
    const r = await obs($, ['up', '--quiet'], 15_000).catch(() => null)
    lines.push(`Stack: Docker is not available. ${(r?.stderr || '').replace(/^claude-obs: /, '').trim()}`)
  } else {
    lines.push(
      s.running && s.grafana
        ? `Stack: up at ${s.url}${s.current ? '' : ' (outdated: /obs up replaces it)'} · data ${s.dataSize?.trim() ?? '?'} in ${s.data} · kept ${s.retentionDays} days`
        : starting
          ? 'Stack: starting…'
          : 'Stack: down (/obs up starts it)',
    )
  }
  lines.push(
    `This session (${me.name}): ${liveHere ? 'reporting telemetry' : cfg.telemetry ? 'not reporting yet; the next session in this profile will' : 'telemetry off'}`,
  )
  const rows: string[] = []
  for (const p of await allProfiles($)) {
    const env = ((await readJson<{ env?: Record<string, string> }>($, `${p.dir}/settings.json`))?.env ?? {}) as Record<string, string>
    const plan = planEnv(env, telemetryEnv(cfg, p.name))
    rows.push(
      `  ${p.name}: ${
        env[MARK] === '1' ? (plan.action === 'none' ? 'on' : 'on (settings out of date)') : plan.action === 'foreign' ? `another OpenTelemetry setup (${plan.endpoint}), left alone` : 'off'
      }`,
    )
  }
  lines.push('Profiles:', ...rows)
  lines.push(
    `Content: ${cfg.content ? `prompts, tool inputs and errors are kept${cfg.toolContent ? ', and full tool outputs' : ''}` : 'only counts and timings (no prompt or command text)'} · only on this machine`,
  )
  lines.push('', 'Dashboards: /obs open [overview | traces | time | errors | logs | sessions | tools | explore]')
  return lines.join('\n')
}

const USAGE =
  'Usage: /obs [status | open [overview|traces|time|errors|logs|sessions|tools|explore] | up | down | backfill [--days N] [--profile P] [--dry-run] | telemetry on|off [all] | content on|off | setup]'

export function setupPrompt(configFile: string, cli: string, current: Config) {
  return `Set up the observability mod with me. Keep it short.

It runs Grafana, Tempo, Loki and Prometheus locally in Docker (127.0.0.1 only, nothing leaves this machine) and points Claude Code's OpenTelemetry at it from every profile.
1. Run \`sh "${cli}" status --json\`. If docker is false, tell me how to get a free Docker runtime (on macOS: \`brew install colima docker && colima start\`, or OrbStack) and stop here.
2. Ask me with the AskUserQuestion tool, marking my current choices "(current)":
   a. "Keep prompt text, commands and file paths in the local store?": "Yes (recommended)": full-text search and readable traces (content true). "No, only counts and timings" (content false).
   b. "Which profiles report?": "All profiles (recommended)" or "Only this one".
3. Write ${configFile} with content set, keeping other keys.
4. Run /obs telemetry on all, or /obs telemetry on, to match; then \`sh "${cli}" up\`.
5. Offer to replay past sessions with \`sh "${cli}" backfill --days 30\` so the dashboards start with history.
6. Tell me in one line where Grafana is and that live data starts with the next session in each profile.

Current config (${configFile}):
${JSON.stringify(current, null, 2)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'obs', description: 'Local observability: status · open dashboards · up/down · backfill · telemetry/content on|off', argumentHint: '[status | open <dashboard> | up | down | backfill | telemetry on|off [all] | content on|off | setup]' })
    await loadConfig($)
    const me = await thisProfile($)
    liveHere = (await $.env.get('CLAUDE_CODE_ENABLE_TELEMETRY')) === '1' && ((await $.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')) ?? '').includes(`127.0.0.1:${cfg.otlpHttpPort}`)
    profileState = cfg.telemetry ? await applyProfile($, me).catch(() => 'none' as const) : 'off'
    if (profileState === 'write' && !liveHere) $.ui.toast(`observability: telemetry is on for ${me.name} from the next session. /obs open shows the dashboards.`)
    if (profileState === 'foreign') $.ui.toast(`observability: ${me.name} already sends OpenTelemetry elsewhere, so its settings were left alone.`)
    await hubStart($, {
      mod: 'observability',
      command: 'obs',
      firstRun,
      pausable: false,
      welcome: () => 'Grafana dashboards for every profile; /obs open',
      status: () => statusLine(),
      setup: async () => setupPrompt(await configPath($), `${$.plugin.root}/bin/claude-obs`, cfg),
    })
    if (cfg.autostart && cfg.telemetry) {
      try {
        $.clock.after(1500, () => void autostart($).catch(() => {}))
      } catch {
        // no timers (tests)
      }
    }
    return next(e)
  })

  hubHooks(on)

  on('command.run', { command: 'obs' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const [what, val, scope] = args
    if (!what || what === 'status') return { text: await statusText($) }
    if (what === 'open') {
      const r = await obs($, ['open', val || 'overview'], 300_000)
      return { text: r.exitCode === 0 ? `Opened ${r.stdout.trim().split('\n').pop()}` : `Could not open Grafana: ${(r.stderr || r.stdout).trim().slice(-400)}` }
    }
    if (what === 'up') return { text: `claude-obs: ${await stackUp($)}` }
    if (what === 'down') {
      const r = await obs($, ['down'], 60_000)
      return { text: r.exitCode === 0 ? 'Stack stopped; data kept (/obs up starts it again).' : r.stderr.trim() }
    }
    if (what === 'backfill') {
      const r = await obs($, args, 600_000)
      return { text: (r.stdout + (r.exitCode ? `\n${r.stderr}` : '')).trim().slice(-3000) || 'Nothing to replay.' }
    }
    if (what === 'setup') {
      const text = setupPrompt(await configPath($), `${$.plugin.root}/bin/claude-obs`, cfg)
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the observability setup…' }
    }
    if ((what === 'telemetry' || what === 'env') && (val === 'on' || val === 'off')) {
      await saveConfig($, { telemetry: val === 'on' })
      const targets = scope === 'all' ? await allProfiles($) : [await thisProfile($)]
      const done: string[] = []
      for (const p of targets) {
        const a = await applyProfile($, p, val === 'on').catch(err => `failed (${String(err).slice(0, 80)})`)
        done.push(`${p.name}: ${a === 'write' ? 'on' : a === 'remove' ? 'off' : a === 'foreign' ? 'left alone (another OpenTelemetry setup)' : a === 'none' ? (val === 'on' ? 'already on' : 'already off') : a}`)
      }
      return { text: `${done.join('\n')}\nTakes effect when a session starts in that profile.` }
    }
    if (what === 'content' && (val === 'on' || val === 'off')) {
      await saveConfig($, { content: val === 'on' })
      const done: string[] = []
      if (cfg.telemetry) for (const p of await allProfiles($)) if ((await applyProfile($, p).catch(() => 'none')) === 'write') done.push(p.name)
      return { text: `Content ${val === 'on' ? 'kept' : 'not kept'} (prompts, commands, paths, errors)${done.length ? `; updated ${done.join(', ')}` : ''}. Takes effect from the next session.` }
    }
    return { text: USAGE }
  })
}
