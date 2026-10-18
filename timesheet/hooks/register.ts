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
 * timesheet as a mod: the CLI and web app ship inside the plugin and run from it. At session start the
 * mod points ~/.local/bin/timesheet at this version (the launcher reads <mods home>/timesheet/entry, so it
 * survives updates), and the bundled skill teaches Claude to use the CLI. /timesheet answers status,
 * setup, doctor and open itself and hands anything else (week last, fix Tuesday…) to Claude and the skill.
 */
const DEFAULT_PORT = 4280
/** TIMESHEET_PORT picks another port when 4280 is taken (the CLI's `serve --port` reads it too). */
const webPort = async ($: EngineInterface) => Number(await $.env.get('TIMESHEET_PORT')) || DEFAULT_PORT

let launcher = ''
let firstRun = false

const tsHome = async ($: EngineInterface) => (await $.env.get('TIMESHEET_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.timesheet`
const entryFile = async ($: EngineInterface) => `${await modsHome($)}/timesheet/entry`

type TsConfig = { target?: number; calendar?: { enabled?: boolean }; github?: { enabled?: boolean }; submit?: Record<string, { url?: string }>; scope?: { work?: unknown[] } }

async function tsConfig($: EngineInterface) {
  return hubJson<TsConfig>($, `${await tsHome($)}/config.json`)
}

/** Node's version when it can run timesheet (>= 22.18), else a reason. */
export function nodeOk(version: string) {
  const [a = 0, b = 0] = version.replace(/^v/, '').split('.').map(Number)
  return a > 22 || (a === 22 && b >= 18)
}

async function nodeState($: EngineInterface) {
  const r = await hubRun($, ['node', '-p', 'process.versions.node'])
  const v = r.exitCode === 0 ? r.stdout.trim() : ''
  return { version: v, ok: !!v && nodeOk(v) }
}

/** Puts the launcher in place; returns installed | updated | current | foreign | failed, and a PATH note. */
async function installLauncher($: EngineInterface, force = false) {
  const r = await hubRun($, ['sh', `${$.plugin.root}/scripts/install-launcher.sh`, await entryFile($), ...(force ? ['--force'] : [])], 10_000)
  const [state, ...rest] = r.stdout.trim().split('\n')
  launcher = r.exitCode === 0 && state ? state : 'failed'
  return { state: launcher, path: rest.find(l => l.startsWith('path:'))?.slice(6) }
}

/** The version this plugin ships (the web app reports the same from its package.json). */
async function ourVersion($: EngineInterface) {
  return (await hubJson<{ version?: string }>($, `${$.plugin.root}/package.json`))?.version ?? '0.0.0'
}

/** What answers on the web app's port: nothing, a timesheet server (and its version), or something else. */
async function webState($: EngineInterface, port: number): Promise<{ kind: 'free' } | { kind: 'timesheet'; version: string | null } | { kind: 'other' }> {
  const r = await hubRun($, ['curl', '-s', '-m', '1', '-w', '\n%{http_code}', `http://127.0.0.1:${port}/api/version`])
  const [body = '', code = ''] = (() => {
    const s = r.stdout.trimEnd()
    const i = s.lastIndexOf('\n')
    return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)]
  })()
  if (!code || code === '000') return { kind: 'free' }
  try {
    const v = JSON.parse(body) as { app?: string; version?: string }
    if (code === '200' && v.app === 'timesheet') return { kind: 'timesheet', version: v.version ?? null }
  } catch {}
  // servers before 0.3.3 have no /api/version
  const m = await hubRun($, ['curl', '-s', '-m', '1', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${port}/api/meta`])
  return m.stdout.trim() === '200' && code === '404' ? { kind: 'timesheet', version: null } : { kind: 'other' }
}

async function webLine($: EngineInterface) {
  const port = await webPort($)
  const s = await webState($, port)
  if (s.kind === 'free') return 'off (/timesheet open)'
  if (s.kind === 'other') return `port ${port} is taken by another program (TIMESHEET_PORT picks another)`
  const ours = await ourVersion($)
  const old = !s.version || semverCmp(s.version, ours) < 0
  return `on http://127.0.0.1:${port}/ (${s.version ?? 'old'}${old ? `, older than ${ours}: /timesheet open replaces it` : ''})`
}

/** The CLI with the plugin's own entry point (the launcher may be someone else's). */
const cli = ($: EngineInterface, args: string[], timeoutMs = 60_000) =>
  hubRun($, ['node', '--experimental-sqlite', '--no-warnings', `${$.plugin.root}/bin/timesheet.js`, ...args], timeoutMs)

async function statusLine($: EngineInterface) {
  const c = await tsConfig($)
  if (!c) return 'not set up (/timesheet setup)'
  const parts = [`${c.target ?? 8}h/day`, `calendar ${c.calendar?.enabled ? 'on' : 'off'}`, `GitHub ${c.github?.enabled === false ? 'off' : 'on'}`]
  if (launcher === 'foreign') parts.push('~/.local/bin/timesheet is not ours')
  if (launcher === 'failed') parts.push('no launcher (/timesheet install)')
  return parts.join(' · ')
}

export function setupPrompt(configured: boolean, node: { version: string; ok: boolean }) {
  return [
    'Help me set up timesheet (NetSuite timesheets from my Claude Code sessions, git, GitHub and Google Calendar). Use the timesheet skill and these rules:',
    node.ok ? '' : `- Node.js ${node.version || 'is missing'}; timesheet needs Node 22.18 or newer. Tell me how to install it for my OS (e.g. \`brew install node\`, or \`fnm install 22\`) and stop until it is there.`,
    '1. Run `timesheet doctor` and read it back to me in short.',
    configured
      ? '2. The config exists. Ask me (AskUserQuestion) which part to revisit: work/personal scope, daily target, Google Calendar, GitHub, categories, or submission. Change settings only with `timesheet config set <key> <value>` or `timesheet scope add …`.'
      : '2. There is no config yet. Ask me (AskUserQuestion) whether to run the setup wizard in the browser or in the terminal. Browser: run `timesheet init --web` in the background and tell me it opened. Terminal: the wizard asks questions you cannot answer for me, so tell me to type `! timesheet init`.',
    '3. Google Calendar and GitHub tokens are entered hidden: tell me to run `! timesheet auth` or `! timesheet github add <owner>` myself. Never ask me for, print or store a client secret or token.',
    '4. Never run `timesheet submit week`, `submit login` or `submit inspect`; tell me the command instead. `timesheet submit plan` is fine.',
    '5. Finish with `timesheet day yesterday` so I see it work, and mention /timesheet open for the web app.',
  ].filter(Boolean).join('\n')
}

/** The submission browser automation needs playwright-core: installed next to the plugin, once per version. */
async function ensureDeps($: EngineInterface) {
  const root = $.plugin.root
  if (await $.fs.exists(`${root}/node_modules/playwright-core/package.json`).catch(() => false)) return 'present'
  const c = await tsConfig($)
  if (!c?.submit || !Object.values(c.submit).some(s => s?.url)) return 'unused'
  const key = `timesheet:deps:${root}`
  if (await $.store.get(key)) return 'tried'
  await $.store.set(key, true)
  const r = await $.process.run(['npm', 'install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: root, timeoutMs: 300_000 }).catch(() => null)
  return r?.exitCode === 0 ? 'installed' : 'failed'
}

/**
 * Opens the web app in whatever state it is in. The CLI's `serve` makes the call (see decide in src/web/port.ts):
 * it reuses a server of this version or newer, replaces an older one or one whose install is gone, and refuses
 * a port held by another program. This waits until a new enough server answers, or reports why none does.
 */
async function openWeb($: EngineInterface, sleepMs = 400, tries = 50) {
  const port = await webPort($)
  const url = `http://127.0.0.1:${port}/`
  const ours = await ourVersion($)
  const before = await webState($, port)
  const log = `${await modsHome($)}/timesheet/web.log`
  const entry = `${$.plugin.root}/bin/timesheet.js`
  // Appended, never truncated: a running server keeps writing to this file.
  const start = await hubRun($, [
    'sh', '-c',
    'mkdir -p "$(dirname "$2")"; o=0; [ -f "$2" ] && o=$(wc -c <"$2" | tr -d " "); nohup node --experimental-sqlite --no-warnings "$0" serve --port "$1" --open >>"$2" 2>&1 & echo "$! $o"',
    entry, String(port), log,
  ])
  const [pid, offset] = start.stdout.trim().split(/\s+/)
  if (start.exitCode !== 0 || !pid) return `Could not start the web app: ${start.stderr.trim() || 'unknown error'}. Try \`timesheet serve --open\` in a terminal.`
  for (let i = 0; i < tries; i++) {
    const now = await webState($, port)
    if (now.kind === 'timesheet' && now.version && semverCmp(now.version, ours) >= 0) {
      if (before.kind === 'timesheet' && before.version === now.version) return `The timesheet web app ${now.version} was already running on ${url} (opened it in your browser).`
      if (before.kind === 'timesheet') return `Replaced the timesheet web app ${before.version ?? '(old)'} with ${now.version} on ${url} (opened it in your browser).`
      return `Started the timesheet web app ${now.version} on ${url} (opened it in your browser; log: ${log}).`
    }
    const alive = (await hubRun($, ['kill', '-0', pid])).exitCode === 0
    if (!alive) break
    await hubRun($, ['sleep', String(sleepMs / 1000)])
  }
  const out = (await hubRun($, ['sh', '-c', 'tail -c +$(($1 + 1)) "$0" | tail -n 5', log, offset || '0'])).stdout.trim()
  const err = out.split('\n').reverse().find(l => /error|in use|taken|did not stop/i.test(l))?.replace(/^.*?Error:\s*/, '').replace(/^timesheet:\s*/, '')
  return `Could not start the web app on ${url}: ${err || out || 'it did not answer'}. Log: ${log}.`
}

type Review = {
  week: string
  missing?: string[]
  days: { date: string; locked: boolean; flags: string[]; status: string; target: number | null; total: number }[]
  systems: { system: string; ok: boolean }[]
}

/**
 * The weekly nudge for last week, or '' when it needs nothing: days not computed or flagged, or
 * (when a submission system is set up) workdays not entered yet. Submitted days lock themselves.
 */
export function reminderText(r: Review) {
  const flagged = r.days.filter(d => d.flags.length && !d.locked).length
  const open = r.days.filter(d => !d.locked && d.target).length
  const parts = [
    r.missing?.length ? `${r.missing.length} day(s) not computed` : '',
    flagged ? `${flagged} day(s) to check` : '',
    r.systems.length && open ? `${open} workday(s) not submitted` : '',
  ].filter(Boolean)
  return parts.length ? `timesheet: week of ${r.week}: ${parts.join(', ')}. /timesheet review last week` : ''
}

/** Once a week, a toast when last week still needs something; reads cached days only, never classifies. */
async function remind($: EngineInterface) {
  if (!(await tsConfig($))) return
  const r = await cli($, ['review', 'last', '--cached', '--json'], 20_000)
  if (r.exitCode !== 0) return
  let review: Review
  try {
    review = JSON.parse(r.stdout)
  } catch {
    return
  }
  const key = `timesheet:reminded:${review.week}`
  if (await $.store.get(key)) return
  const text = reminderText(review)
  if (!text) return
  await $.store.set(key, true)
  $.ui.toast(text, { timeoutMs: 15_000 })
}

export const USAGE = 'Usage: /timesheet [status | setup | doctor | open | install | day|week|month [when] | <anything to ask about your hours>]'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    firstRun = !(await $.fs.exists(await entryFile($)).catch(() => false))
    await $.command.register({
      name: 'timesheet',
      description: 'timesheet: day|week|month [when] · status · setup · doctor · open (web app) · install, or ask anything about your hours',
      argumentHint: '[week last | day yesterday | status | setup | doctor | open | install | …]',
    })
    const node = await nodeState($)
    const { state } = await installLauncher($).catch(() => ({ state: 'failed' }))
    await hubStart($, {
      mod: 'timesheet',
      command: 'timesheet',
      firstRun,
      pausable: false,
      welcome: () =>
        !node.ok
          ? `needs Node 22.18+ (found ${node.version || 'none'})`
          : state === 'installed' || state === 'updated'
            ? 'the `timesheet` command is in ~/.local/bin; /timesheet setup connects your sources'
            : '/timesheet setup connects your sources',
      status: () => statusLine($),
      setup: async () => setupPrompt(!!(await tsConfig($)), node),
    })
    try {
      $.clock.after(60_000, () => void ensureDeps($).catch(() => {}))
      if (node.ok) $.clock.after(30_000, () => void remind($).catch(() => {}))
    } catch {
      // no timers (tests)
    }
    return r
  })

  hubHooks(on)

  on('command.run', { command: 'timesheet' }, async ($, e) => {
    const args = e.args.trim()
    const [what] = args.split(/\s+/)
    // Every command first points ~/.local/bin/timesheet at the newest installed version (a plugin update
    // mid-session would otherwise leave it on a deleted folder until the next session).
    if (what !== 'install') await installLauncher($).catch(() => {})
    const ask = (text: string, note: string) => {
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: note }
    }
    if (!what || what === 'status') {
      const node = await nodeState($)
      const c = await tsConfig($)
      const lines = [
        `timesheet ${hubSelf?.version ?? ''} · ${await statusLine($)}`,
        `node ${node.version || 'missing'}${node.ok ? '' : ' (needs 22.18+)'} · launcher ~/.local/bin/timesheet: ${launcher || 'unknown'} · web app ${await webLine($)}`,
        `data in ${await tsHome($)}`,
      ]
      if (!c) lines.push('Not set up yet: /timesheet setup')
      lines.push(USAGE)
      return { text: lines.join('\n') }
    }
    if (what === 'setup') return ask(setupPrompt(!!(await tsConfig($)), await nodeState($)), 'Starting the timesheet setup…')
    if (what === 'doctor') {
      const node = await nodeState($)
      if (!node.ok) return { text: `timesheet needs Node 22.18 or newer (found ${node.version || 'none'}): \`brew install node\` or \`fnm install 22\`.` }
      const r = await cli($, ['doctor'])
      return { text: (r.stdout + r.stderr).trim() || 'timesheet doctor printed nothing' }
    }
    if (what === 'open' || what === 'serve' || what === 'web') return { text: await openWeb($) }
    if (what === 'install') {
      const { state, path } = await installLauncher($, args.includes('--force'))
      const deps = await ensureDeps($).catch(() => 'failed')
      const lines = [
        state === 'foreign'
          ? '~/.local/bin/timesheet exists and is not timesheet\'s launcher; left alone. /timesheet install --force replaces it.'
          : state === 'failed'
            ? 'Could not write ~/.local/bin/timesheet.'
            : `Launcher ~/.local/bin/timesheet: ${state}.`,
        deps === 'failed' ? 'Could not install playwright-core (needed only for `timesheet submit`): run `npm install --omit=dev` in ' + $.plugin.root : '',
        path ? path.charAt(0).toUpperCase() + path.slice(1) : '',
      ]
      return { text: lines.filter(Boolean).join('\n') }
    }
    if (what === 'help') return { text: USAGE }
    const report = /^(day|week|month)$/.test(what)
    return ask(
      report ? `Use the timesheet skill to show my timesheet: ${args}` : `Use the timesheet skill for this: ${args}`,
      report ? `Building your timesheet (${args})…` : 'Asking Claude with the timesheet skill…',
    )
  })
}
