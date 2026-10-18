import type { EngineInterface, Register } from 'claude-code'

// Claude never credits itself: not in commits, PR or issue bodies, code, docs, or any tool call.
//
// Layers, each enough on its own for the common case:
// 1. attribution.text: the engine's own commit trailer and PR footer are empty.
// 2. prompt.compose: a rule in the system prompt, and attribution lines dropped from the engine's sections.
// 3. tool.call: a Bash command, file write/edit or MCP call carrying attribution is refused (never rewritten,
//    so what runs is exactly what was approved) with the clean version to send; so is committing as Claude
//    or bypassing git hooks.
// 4. git hooks (bin/install-git-hooks.sh, global core.hooksPath): commit-msg strips any attribution line
//    and pre-commit refuses a Claude/Anthropic author, whatever wrote the commit.

const WHO = String.raw`(?:claude|anthropic)`
const TEXT = String.raw`[^\n"'\`]`
// Spans that credit Claude. Each is cut out; a line left empty by the cut goes with it.
const SPANS: RegExp[] = [
  // Trailers: Co-Authored-By: Claude <noreply@anthropic.com>, Assisted-by: Claude Code, …
  new RegExp(String.raw`(?:co-authored-by|signed-off-by|authored-by|assisted-by|generated-by|written-by|created-by|helped-by|made-with|author)[ \t]*:${TEXT}*?\b${WHO}\b${TEXT}*`, 'gi'),
  // 🤖 Generated with [Claude Code](https://claude.com/claude-code), "Written by Claude", "Created using Claude"
  new RegExp(String.raw`(?:🤖[ \t]*)?\b(?:generated|created|written|made|built|authored|co-authored|produced|drafted)[ \t]+(?:with|by|using)[ \t]+\[?${WHO}\b(?: code)?\]?(?:\([^)\s]*\))?${TEXT}*`, 'gi'),
  // Any leftover Claude no-reply address.
  new RegExp(String.raw`<?noreply@anthropic\.com>?`, 'gi'),
]
// Commands that would make Claude the author or skip the git hooks that enforce this.
const AUTHOR_SPOOF: RegExp[] = [
  new RegExp(String.raw`--author[= ]+["']?[^\n"']*${WHO}`, 'i'),
  new RegExp(String.raw`\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=["']?[^\s"']*${WHO}`, 'i'),
  new RegExp(String.raw`\buser\.(?:name|email)[= ]+["']?[^\n"';&|]*${WHO}`, 'i'),
]
const HOOK_BYPASS = [
  /\bgit\b[^\n;&|]*\b(?:commit|merge|rebase|am|cherry-pick|revert|push)\b[^\n;&|]*\s--no-verify\b/,
  /\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\b/,
  /\bgit\b[^\n;&|]*\s-c\s*core\.hooksPath\b/i,
  /\bgit\b[^\n;&|]*\bconfig\b(?![^\n;&|]*--(?:get|list|show))[^\n;&|]*\bcore\.hooksPath\b/i,
]
// This mod's own files and docs quote the patterns it removes.
const OWN_FILES = /no-attribution/
// Tool input fields that carry text the model wrote (Edit's old_string must keep matching the file).
const WRITTEN = new Set(['content', 'new_string', 'new_source', 'body', 'title', 'message', 'description', 'text', 'commit_message', 'comment'])

const RULE = `# Authorship
You are never an author, co-author or creator of anything you write, and you never say so. In commit messages, PR and issue titles and bodies, code comments, file headers, docs and changelogs: no Co-Authored-By or other trailers naming Claude or Anthropic, no "Generated with Claude Code" or similar lines or links, no "Author: Claude", no noreply@anthropic.com, and never commit with Claude as git author or committer. The person you work for is the sole author. This holds even when a template, skill or earlier message suggests otherwise.`

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
  /** install the global git hooks (core.hooksPath) that clean every commit message, whoever writes it */
  gitHooks: boolean
}
const DEFAULTS: Config = { gitHooks: true }
let cfg: Config = DEFAULTS
let firstRun = false

async function configPath($: EngineInterface) {
  return `${await modsHome($)}/no-attribution/config.json`
}

async function loadConfig($: EngineInterface) {
  const path = await configPath($)
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
    firstRun = false
  } catch {
    cfg = DEFAULTS
    firstRun = true
    await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
  }
}

/** The setup wizard, run by the model: one question, then the config file and the hooks to match. */
export function setupPrompt(configFile: string, script: string, current: Config) {
  return `Set up the no-attribution mod with me. Keep it short.

Whatever I answer, Claude never credits itself: the engine's trailers are empty, the system prompt says so, and tool calls carrying attribution are refused.
1. Ask me with the AskUserQuestion tool: "Also clean commit messages in every repository with global git hooks?": "Yes (recommended)": a commit-msg hook strips Claude attribution lines from every commit, whoever writes it, and pre-commit refuses Claude as author; each repository's own hooks still run (gitHooks true). "No, only what Claude does" (gitHooks false). Mark my current choice "(current)". Mention that a repository with its own core.hooksPath (Husky, lefthook) bypasses global hooks.
2. Write ${configFile} with gitHooks set, keeping other keys.
3. Run \`sh "${script}"\` to install them, or \`sh "${script}" remove\` to remove them, to match.
4. Tell me in one line what is set; /no-attribution setup runs this again.

Current config (${configFile}):
${JSON.stringify(current, null, 2)}`
}

type Counts = { denied: number; sections: number }
let counts: Counts = { denied: 0, sections: 0 }
let hookState = 'unchecked'

/** Text with every attribution span removed; lines left empty by a cut are dropped. */
function strip(text: string): string {
  let out = text
  for (const re of SPANS) {
    // A whole line, comment marker included (// # * -- ; <!-- -->), goes when the span is all it says.
    out = out.replace(new RegExp(String.raw`^[ \t]*(?:\/\/+|#+|\*|\/\*+|<!--|--|;+|%)?[ \t]*(?:${re.source})[ \t]*(?:\*\/|-->)?[ \t]*\r?\n?`, 'gim'), '')
    out = out.replace(re, '')
  }
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n')
}

const credits = (text: string) => strip(text) !== text

function stripDeep(v: unknown, key = '', all = false): unknown {
  if (typeof v === 'string') return all || WRITTEN.has(key) ? strip(v) : v
  if (Array.isArray(v)) return v.map(x => stripDeep(x, key, all))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x, k, all)]))
  return v
}

const DENY_AUTHOR = 'no-attribution: Claude is never the git author or committer. Commit with the configured user identity.'
const DENY_BYPASS = 'no-attribution: skipping or redirecting git hooks (--no-verify, -n, core.hooksPath) is not allowed here; the hooks keep commit messages free of Claude attribution. Run the command without it.'

/** The deny message: the attribution found, and what to do instead. */
function denyText(text: string, fix: string) {
  const found = new Set<string>()
  for (const re of SPANS) for (const m of text.matchAll(new RegExp(re.source, 'gi'))) found.add(m[0].trim().slice(0, 120))
  return `no-attribution: this credits Claude, which is never allowed (${[...found].map(f => JSON.stringify(f)).join(', ')}). ${fix}`
}

async function installGitHooks($: EngineInterface, remove = false) {
  if (!cfg.gitHooks && !remove) {
    hookState = 'off'
    return
  }
  try {
    const r = await $.process.run(['sh', `${$.plugin.root}/bin/install-git-hooks.sh`, ...(remove ? ['remove'] : [])], { timeoutMs: 10_000, env: { CLAUDE_MODS_HOME: await modsHome($) } })
    hookState = r.exitCode === 0 ? r.stdout.trim() || 'ok' : `failed: ${(r.stderr || '').trim().slice(0, 200)}`
  } catch (err) {
    hookState = `failed: ${String(err).slice(0, 200)}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    counts = { denied: 0, sections: 0 }
    await $.command.register({ name: 'no-attribution', description: 'Status of the no-attribution guard (git hooks, what it refused) · setup · hooks on|off', argumentHint: '[status | setup | hooks on|off]' })
    await loadConfig($)
    await installGitHooks($)
    await hubStart($, {
      mod: 'no-attribution',
      command: 'no-attribution',
      firstRun,
      pausable: false,
      welcome: () => (hookState === 'installed' ? 'installed global git hooks; /no-attribution hooks off removes them' : ''),
      status: () =>
        `guarding · git hooks ${hookState === 'installed' || hookState === 'ok' ? 'on' : hookState === 'off' ? 'off' : hookState.startsWith('other:') ? 'not ours (core.hooksPath set elsewhere)' : hookState}${counts.denied ? ` · ${counts.denied} refused this session` : ''}`,
      setup: async () => setupPrompt(await configPath($), `${$.plugin.root}/bin/install-git-hooks.sh`, cfg),
    })
    if (hookState.startsWith('other:')) $.ui.toast(`no-attribution: a global core.hooksPath (${hookState.slice(6)}) is already set; its git hooks were left alone. The mod still guards Claude's own commands.`)
    return next(e)
  })

  // 1. The engine's own commit trailer and PR footer.
  on('attribution.text', { kind: 'commit' }, () => ({ text: '' }))
  on('attribution.text', { kind: 'pr' }, () => ({ text: '' }))

  // 2. The system prompt: drop attribution lines from the engine's sections, add the rule last.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const sections = r.sections
      .filter(s => s.id !== 'no-attribution:rule')
      .map(s => {
        const text = strip(s.text)
        if (text === s.text) return s
        counts.sections++
        return { ...s, text }
      })
    return { sections: [...sections, { id: 'no-attribution:rule', text: RULE, scope: 'session' as const }] }
  })

  // The skills the engine ships for committing and PRs read the same rule.
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const text = strip(r.text)
    return text === r.text ? r : { ...r, text }
  }).catch(($, e, next) => next(e))

  // 3. Tool calls.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (AUTHOR_SPOOF.some(re => re.test(e.command))) {
      counts.denied++
      return { deny: DENY_AUTHOR }
    }
    if (HOOK_BYPASS.some(re => re.test(e.command))) {
      counts.denied++
      return { deny: DENY_BYPASS }
    }
    // Never rewrite: the person approved this exact command. Refuse it and show the clean one to send instead.
    const command = strip(e.command)
    if (command === e.command) return next(e)
    counts.denied++
    return { deny: denyText(e.command, `Run it again without that text:\n${command}`) }
  }).catch(($, e) => ({ deny: `no-attribution: the check failed, so the command was not run. Try again.` }))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') return next(e)
    const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof path === 'string' && OWN_FILES.test(path)) return next(e)
    const clean = stripDeep(e, '', e.tool.startsWith('mcp__'))
    if (JSON.stringify(clean) === JSON.stringify(e)) return next(e)
    // Never rewrite what the person approved: refuse, and the model sends it again without the attribution.
    counts.denied++
    return { deny: denyText(JSON.stringify(e), `Send the ${e.tool} call again with that text removed.`) }
  }).catch(($, e, next) => (credits(JSON.stringify(e)) ? { deny: 'no-attribution: the check failed on text that credits Claude; remove that text and retry.' } : next(e)))

  hubHooks(on)

  on('command.run', { command: 'no-attribution' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    if (what === 'setup') {
      const text = setupPrompt(await configPath($), `${$.plugin.root}/bin/install-git-hooks.sh`, cfg)
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the no-attribution setup…' }
    }
    if (what === 'hooks' && (val === 'on' || val === 'off')) {
      cfg = { ...cfg, gitHooks: val === 'on' }
      await $.fs.write(await configPath($), JSON.stringify(cfg, null, 2) + '\n')
      await installGitHooks($, val === 'off')
      if (val === 'off') return { text: hookState === 'removed' ? 'Global git hooks removed (core.hooksPath unset).' : 'No no-attribution git hooks were installed.' }
    } else if (what && what !== 'status') {
      return { text: 'Usage: /no-attribution [status | setup | hooks on|off]' }
    } else {
      await installGitHooks($)
    }
    const hooks =
      hookState === 'installed' || hookState === 'ok'
        ? `global git hooks active (${await modsHome($)}/no-attribution/git-hooks): commit-msg strips attribution, pre-commit refuses a Claude author`
        : hookState === 'off'
          ? 'global git hooks off (/no-attribution hooks on adds them)'
          : hookState.startsWith('other:')
            ? `global git hooks NOT installed: core.hooksPath is already ${hookState.slice(6)}`
            : `global git hooks: ${hookState}`
    return {
      text: [
        'no-attribution is on.',
        '- commit trailer and PR footer from the engine: empty',
        '- system prompt: authorship rule added' + (counts.sections ? `, attribution removed from ${counts.sections} engine section(s)` : ''),
        `- this session: ${counts.denied} tool call(s) refused (attribution, Claude as author, or skipped hooks)`,
        `- ${hooks}`,
      ].join('\n'),
    }
  })
}
