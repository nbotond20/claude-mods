import type { EngineInterface, Register } from 'claude-code'

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

/**
 * lean-tools: keep tool output and round trips small.
 *
 * Every tool call is one more request that re-reads the whole context, and every character a tool
 * returns stays in that context until compaction. So this mod:
 *   - caps huge shell output (head + tail in context, the full output in a temp file);
 *   - bounds `git log` without a limit to 30 entries;
 *   - nudges, at most once per kind every 10 minutes, toward parallel/batched calls, ranged reads,
 *     Edit over Write for existing files, and not re-reading unchanged files;
 *   - adds a short system prompt section with the same rules.
 * Config: <mods home>/lean-tools/config.json (written with the defaults on first start).
 *
 * Impact tracking (below): every cap, nudge and its outcome is logged to the usage-analytics
 * store. A `holdout` share of sessions runs passive: nothing is changed, and what the mod would have
 * done is logged as `would_*`, so the dashboard can compare both arms.
 */

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
const localDay = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

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

type Config = {
  /** false turns the whole mod off */
  enabled: boolean
  /** share of sessions in which the mod stays passive, for comparison (0 = none) */
  holdout: number
  /** cap Bash output above these sizes */
  capOutput: boolean
  maxBytes: number
  maxLines: number
  headLines: number
  tailLines: number
  /** add `-n 30` to `git log` that has no limit */
  boundGitLog: boolean
  /** context nudges */
  nudges: boolean
  /** single read-only calls in a row before the batching nudge */
  streak: number
  /** chars a whole-file Read may return before the ranged-read nudge */
  bigRead: number
  /** add the system prompt section */
  guide: boolean
}

const DEFAULTS: Config = {
  enabled: true,
  holdout: 0.2,
  capOutput: true,
  maxBytes: 24_000,
  maxLines: 400,
  headLines: 150,
  tailLines: 80,
  boundGitLog: true,
  nudges: true,
  streak: 4,
  bigRead: 30_000,
  guide: true,
}

const GUIDE = `# Token-lean tool use
Every tool call re-sends the whole conversation, and everything a tool returns stays in context. So:
- Batch: when you need several independent reads, searches or checks, issue them as parallel tool calls in one response (or one combined shell command), not one per turn.
- Read narrowly: search first (grep -n / rg -n, or the LSP tool for TS/JS symbols), then Read with offset/limit around the hit. Don't read whole large files to find one function.
- Don't re-read a file you already have in context unless it changed.
- Edit existing files; use Write only for new files or full rewrites of small files.
- Keep command output small: filter with grep, head, tail, --stat, -n, --quiet; for tests and builds look at failures only.`

const NUDGE_MS = 10 * 60_000
/** Calls watched after a nudge to see whether the model followed it. */
const OUTCOME_WINDOW = 10
const NOISY = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|e2e)\b|\b(jest|vitest|playwright\s+test|tsc|eslint|biome|next\s+build|pytest|mvn|gradle)\b|\bgo\s+(test|build|vet)\b|\bcargo\s+(test|build|clippy)\b|\bdocker\s+(build|compose\s+(up|logs|build))\b/
/** Commands left alone: already bounded, ranged reads, or ones a wrapper could break. */
const KEEP = /\|\s*(head|tail|less|more)\b|(^|[^0-9&])>>?\s*[^&\s]|<<|\b(sed\s+-n|head|tail|awk)\b|\b(exit|exec|set\s+-e)\b|\bmktemp\s+-t\s+(budget-guard|lean-tools)|^\s*(cd|export|source|\.)\s+[^;&|]*$/
const READISH_BASH = /^\s*(cd\s+\S+\s*(&&|;)\s*)?(sed\s+-n|cat|grep|rg|ls|find|head|tail|wc|tree|git\s+(show|log|diff|status|blame))\b/
const READISH = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'ToolSearch'])
const CAP_MARK = /\[lean-tools: output was (\d+) lines \/ (\d+) bytes/
/** A later command that opens a capped log: the cap made the model come back for more. */
const CAP_LOG = /lean-tools\.[A-Za-z0-9]{6}/

type Nudge = 'batch' | 'bigread' | 'reread' | 'write'

let cfg: Config = DEFAULTS
let streak = 0
let streakTokens = 0
const lastNudge: Record<string, number> = {}
/** Paths read whole and not changed since, per session. */
const readWhole = new Set<string>()
/** After a nudge (or, in the holdout, where one would have fired): how the next calls went. */
const windows: Partial<Record<Nudge, { followed: number; total: number }>> = {}
const counts = { caps: 0, bytesAvoided: 0, followups: 0, nudges: 0, gitlog: 0 }
let guideLogged = false

/** On by config and not paused (/lean off 1h, /mods pause). */
const enabled = () => cfg.enabled && !hubPaused()
const active = () => enabled() && trackOn()

async function configPath($: EngineInterface) {
  return `${await modsHome($)}/lean-tools/config.json`
}

let firstRun = false
async function loadConfig($: EngineInterface) {
  const path = await configPath($)
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
    firstRun = false
  } catch {
    cfg = DEFAULTS
    firstRun = true
  }
  // Keep the file complete, so new keys show up for editing.
  await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
}

/** The setup wizard, run by the model: what to ask, then the config file to write. */
export function setupPrompt(configFile: string, current: unknown) {
  return `Set up the lean-tools mod with me. Keep it short.

1. Ask me with the AskUserQuestion tool, in a single call (recommended option first, my current choice marked "(current)"):
   - "Cap long shell output?": "Yes, at 400 lines / 24 KB (recommended)": the model sees the head and tail, the rest stays in a temp file it can grep (capOutput true, maxLines 400, maxBytes 24000); "Yes, more generous: 1000 lines / 60 KB" (capOutput true, maxLines 1000, maxBytes 60000, headLines 400, tailLines 200); "No" (capOutput false).
   - "Nudge the model toward fewer, smaller tool calls?": "Yes (recommended)": batching, ranged reads, Edit over Write, no re-reads, at most one nudge of a kind every 10 minutes (nudges true, guide true); "Only the system prompt rules" (nudges false, guide true); "No" (nudges false, guide false).
   - "Measure whether it saves money?": "Yes, 20% of sessions run without it for comparison (recommended)" (holdout 0.2); "No, always on" (holdout 0).
2. Write ${configFile}: the current config below with only the keys those answers set. Keep every other key.
3. Tell me in one or two lines what is set. It applies from the next session; /lean setup runs this again.

Current config (${configFile}):
${JSON.stringify(current, null, 2)}`
}

async function due($: EngineInterface, kind: string) {
  if (!cfg.nudges) return false
  const now = await $.clock.now()
  if (now - (lastNudge[kind] ?? 0) < NUDGE_MS) return false
  lastNudge[kind] = now
  return true
}

/**
 * A nudge is due: in the active arm it is added to the result; in the holdout it is only logged.
 * Either way a window opens to record whether the next calls do what it asks.
 */
async function nudge<R extends { context?: readonly string[] }>($: EngineInterface, kind: Nudge, r: R, note: string): Promise<R> {
  if (!enabled() || !(await due($, kind))) return r
  windows[kind] = { followed: 0, total: 0 }
  if (!trackOn()) {
    await trackLog($, 'would_nudge', { nudge: kind })
    return r
  }
  counts.nudges++
  await trackLog($, 'nudge', { nudge: kind, chars: note.length })
  return { ...r, context: [...(r.context ?? []), note] }
}

async function observe($: EngineInterface, kind: Nudge, followed: boolean) {
  const w = windows[kind]
  if (!w) return
  w.total++
  if (followed) w.followed++
  if (w.total >= OUTCOME_WINDOW) {
    delete windows[kind]
    await trackLog($, 'nudge_outcome', { nudge: kind, followed: w.followed, total: w.total })
  }
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
const resultText = (r: { result?: unknown; text?: string }) => (typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? ''))

/** The command, wrapped so that output past the caps is cut to head + tail with the rest kept on disk. */
export function capCommand(cmd: string, c: Config = DEFAULTS) {
  return [
    '__lt_log=$(mktemp -t lean-tools.XXXXXX)',
    `{ ${cmd}`,
    '} >"$__lt_log" 2>&1; __lt_rc=$?',
    '__lt_b=$(wc -c <"$__lt_log" | tr -d " "); __lt_l=$(wc -l <"$__lt_log" | tr -d " ")',
    `if [ "$__lt_b" -gt ${c.maxBytes} ] || [ "$__lt_l" -gt ${c.maxLines} ]; then`,
    `  head -n ${c.headLines} "$__lt_log" | cut -c1-400`,
    `  echo "[lean-tools: output was $__lt_l lines / $__lt_b bytes; showing first ${c.headLines} and last ${c.tailLines} lines. Full output: $__lt_log (grep or sed -n it for more)]"`,
    `  tail -n ${c.tailLines} "$__lt_log" | cut -c1-400`,
    'else cat "$__lt_log"; rm -f "$__lt_log"; fi',
    '(exit $__lt_rc)',
  ].join('\n')
}

/** Whether a Bash command gets the output cap. */
export function shouldCap(cmd: string) {
  return !NOISY.test(cmd) && !KEEP.test(cmd) && cmd.trim().length > 0
}

/** `git log` with no limit gets `-n 30`. */
export function boundGitLog(cmd: string) {
  if (!/^\s*git\s+log\b/.test(cmd) || /\s(-n\s*\d+|-\d+|--max-count|--since|--after|--until|--before)\b|\.\.|[|;&]/.test(cmd)) return cmd
  return cmd.replace(/^(\s*git\s+log)\b/, '$1 -n 30')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await loadConfig($)
    streak = 0
    readWhole.clear()
    guideLogged = false
    Object.assign(counts, { caps: 0, bytesAvoided: 0, followups: 0, nudges: 0, gitlog: 0 })
    for (const key of Object.keys(windows)) delete windows[key as Nudge]
    await trackStart($, 'lean-tools', cfg.enabled ? cfg.holdout : 0, cfg)
    $.clock.every(30_000, () => void trackFlush($).then(() => hubPoll($)).catch(() => {}))
    await $.command.register({
      name: 'lean',
      description: 'lean-tools: status | setup | on | off [30m|2h|1d|session] | holdout <0-1> | cap on|off | nudges on|off | guide on|off',
      argumentHint: '[status | setup | on | off [30m|2h|1d|session] | holdout <0-1> | cap|nudges|guide on|off]',
    })
    await hubStart($, {
      mod: 'lean-tools',
      command: 'lean',
      firstRun,
      pausable: true,
      status: () => (cfg.enabled ? `caps ${cfg.capOutput ? 'on' : 'off'} · nudges ${cfg.nudges ? 'on' : 'off'} · ${trackOn() ? 'active' : 'holdout'} this session` : 'off'),
      setup: async () => setupPrompt(await configPath($), cfg),
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    for (const [kind, w] of Object.entries(windows)) {
      if (w && w.total > 0) await trackLog($, 'nudge_outcome', { nudge: kind, followed: w.followed, total: w.total, partial: true })
    }
    await trackLog($, 'session_summary', { ...counts })
    await trackFlush($).catch(() => {})
    streak = 0
    readWhole.clear()
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!active() || !cfg.guide || r.sections.some(s => s.id === 'lean-tools:guide')) return r
    if (!guideLogged) {
      guideLogged = true
      await trackLog($, 'guide', { chars: GUIDE.length })
    }
    return { sections: [...r.sections, { id: 'lean-tools:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // How the main loop calls tools: a run of single read-only calls is what batching would save.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId !== undefined) return r
    const uses = r.toolUses
    if (uses.length > 0) await observe($, 'batch', uses.length > 1)
    const one = uses.length === 1 ? uses[0]! : null
    const readish = !!one && (READISH.has(one.name) || (one.name === 'Bash' && READISH_BASH.test(String((one.input as { command?: string })?.command ?? ''))))
    streak = readish ? streak + 1 : 0
    if (r.usage) streakTokens = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!enabled()) return next(e)
    if (CAP_LOG.test(e.command)) {
      counts.followups++
      await trackLog($, 'cap_followup', {})
    }
    let command = e.command
    const bounded = cfg.boundGitLog ? boundGitLog(command) : command
    if (bounded !== command) {
      counts.gitlog++
      await trackLog($, trackOn() ? 'gitlog_bound' : 'would_gitlog_bound', {})
      if (trackOn()) command = bounded
    }
    const cap = cfg.capOutput && !e.run_in_background && shouldCap(command)
    if (cap && trackOn()) command = capCommand(command, cfg)
    const r = await next(command === e.command ? e : { ...e, command })
    if (!cap) return r
    const out = resultText(r)
    const m = CAP_MARK.exec(out)
    if (m) {
      const all = Number(m[2])
      counts.caps++
      counts.bytesAvoided += Math.max(0, all - out.length)
      await trackLog($, 'cap', { bytesAll: all, linesAll: Number(m[1]), bytesKept: out.length })
    } else if (!trackOn() && (out.length > cfg.maxBytes || out.split('\n').length > cfg.maxLines)) {
      await trackLog($, 'would_cap', { bytesAll: out.length, linesAll: out.split('\n').length })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ranged = e.offset !== undefined || e.limit !== undefined || e.pages !== undefined
    const again = !ranged && readWhole.has(e.file_path)
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    const chars = (r.text ?? '').length
    await observe($, 'bigread', ranged)
    await observe($, 'reread', !again)
    if (!ranged) readWhole.add(e.file_path)
    if (again && chars > 2_000) {
      return nudge($, 'reread', r, `lean-tools: ${e.file_path} was already read whole earlier in this conversation and has not been edited since. Reuse what you have instead of reading it again.`)
    }
    if (!ranged && chars > cfg.bigRead) {
      return nudge($, 'bigread', r, `lean-tools: that whole-file read added ~${k(Math.round(chars / 4))} tokens that every later call re-reads. Next time locate the part first (grep -n, or LSP documentSymbol for TS/JS) and Read with offset/limit.`)
    }
    return r
  }).catch(($, e, next) => next(e))

  // A changed file may be read again.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    readWhole.delete(e.file_path)
    await observe($, 'write', true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    readWhole.delete(e.file_path)
    const existed = await $.fs.exists(e.file_path).catch(() => false)
    if (existed) await observe($, 'write', false)
    const r = await next(e)
    if (existed && e.content.length > 3_000 && r.deny === undefined && !r.isError) {
      return nudge($, 'write', r, `lean-tools: that Write re-sent all ${k(e.content.length)} chars of an existing file. For changes to existing files use Edit with just the changed part; keep Write for new files.`)
    }
    return r
  }).catch(($, e, next) => next(e))

  // After a run of single read-only calls: suggest batching.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || streak < cfg.streak || r.deny !== undefined) return r
    const n = streak
    const before = lastNudge.batch
    const out = await nudge($, 'batch', r, `lean-tools: the last ${n} turns each made one read-only call, and each call re-sent ~${k(streakTokens)} tokens of context. When reads or searches don't depend on each other, issue them together as parallel tool calls in one response, or combine them into one command.`)
    if (lastNudge.batch !== before) streak = 0
    return out
  }).catch(($, e, next) => next(e))

  hubHooks(on)

  on('command.run', { command: 'lean' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    const save = async (patch: Partial<Config>) => {
      cfg = { ...cfg, ...patch }
      await $.fs.write(await configPath($), JSON.stringify(cfg, null, 2) + '\n')
    }
    const onOff = val === 'on'
    if (what === 'setup') {
      const text = setupPrompt(await configPath($), cfg)
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the lean-tools setup…' }
    }
    const pause = what === 'off' && val ? (val === 'session' ? 'session' : parseDuration(val)) : null
    if (pause === 0) return { text: 'Usage: /lean off [30m | 2h | 1d | session] (no duration: off until /lean on)' }
    if (pause) await hubSetPause($, 'lean-tools', pause === 'session' ? 'session' : Date.now() + pause)
    else if (what === 'on' || what === 'off') {
      await save({ enabled: what === 'on' })
      if (what === 'on') await hubSetPause($, 'lean-tools', 0)
    }
    else if (what === 'holdout' && Number(val) >= 0 && Number(val) <= 1) await save({ holdout: Number(val) })
    else if (what === 'cap') await save({ capOutput: onOff })
    else if (what === 'nudges') await save({ nudges: onOff })
    else if (what === 'guide') await save({ guide: onOff })
    else if (what && what !== 'status') return { text: 'Usage: /lean [status | setup | on | off [30m|2h|1d|session] | holdout <0-1> | cap|nudges|guide on|off]' }
    return {
      text: [
        `lean-tools ${!cfg.enabled ? 'OFF' : hubPaused() ? `paused ${hubPausedUntil() === Infinity ? 'for this session' : `until ${hubClock(hubPausedUntil())}`} (/lean on resumes)` : 'on'} · this session: ${trackOn() ? 'active' : 'holdout (passive, for comparison)'} · holdout share ${Math.round(cfg.holdout * 100)}%`,
        `cap ${cfg.capOutput ? `on (>${k(cfg.maxBytes)} bytes or >${cfg.maxLines} lines)` : 'off'} · git log bound ${cfg.boundGitLog ? 'on' : 'off'} · nudges ${cfg.nudges ? 'on' : 'off'} · guide ${cfg.guide ? 'on' : 'off'}`,
        `this session: ${counts.caps} caps (~${k(Math.round(counts.bytesAvoided / 4))} tokens kept out), ${counts.followups} re-opened a capped log, ${counts.nudges} nudges, ${counts.gitlog} git logs bounded`,
        'Settings changes apply to new sessions. Impact across sessions: /analytics impact, or /dashboard impact',
      ].join('\n'),
    }
  })
}
