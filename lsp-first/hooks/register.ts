import type { EngineInterface, Register } from 'claude-code'

/**
 * lsp-first: make the model reach for the TypeScript language server.
 *
 * 1. The LSP tool's schema sits in the prompt's tool list instead of behind ToolSearch,
 *    so using it costs no extra round trip.
 * 2. A short system prompt section says when it beats Grep/Read.
 * 3. A Grep for a bare identifier over TS/JS gets a one-line reminder, at most every 10 minutes.
 * Config: ~/.claude-shared/lsp-first/config.json. Command: /lsp-first.
 *
 * Impact tracking (below): symbol searches, LSP calls, nudges and whether LSP followed are logged to
 * the usage-analytics store; a `holdout` share of sessions runs passive for comparison.
 */

// ---- impact tracking ------------------------------------------------------
/**
 * Mod-impact tracking (the same block in budget-guard, lean-tools and lsp-first; $ cannot cross files).
 *
 * Every action a mod takes is logged as `{ ev: 'mod', mod, kind, arm, ... }` into the usage-analytics
 * event store (~/.claude-shared/usage-analytics/events/<profile>/<day>/), which `claude-usage ingest`
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
  profile = (configDir ?? `${home}/.claude`).replace(/\/+$/, '').split('/').pop()!.replace(/^\./, '')
  root = `${home}/.claude-shared/usage-analytics`
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
  /** keep the LSP tool's schema loaded instead of deferred */
  upfront: boolean
  guide: boolean
  nudges: boolean
}

const DEFAULTS: Config = { enabled: true, holdout: 0.2, upfront: true, guide: true, nudges: true }

const GUIDE = `# Code navigation in TypeScript/JavaScript
An LSP tool backed by typescript-language-server is available. For TS/JS/TSX/JSX code, prefer it over Grep + Read when the question is about a symbol:
- where something is defined: LSP goToDefinition (or workspaceSymbol with the name as query when you have no position)
- who uses / calls it: LSP findReferences, incomingCalls, outgoingCalls
- what a value's type or signature is: LSP hover, instead of reading the declaring file
- what a file contains: LSP documentSymbol, instead of reading the whole file
- implementations of an interface or abstract method: LSP goToImplementation
It returns exact locations with little output, so it is both more precise and cheaper than grepping and reading files. Keep grep/rg for text that is not a symbol (strings, comments, config, log messages) and for non-TS/JS files.`

const NUDGE_EVERY_MS = 10 * 60_000
/** Tool calls watched after a nudge for an LSP call. */
const OUTCOME_WINDOW = 10
const IDENT = /^(\\b)?[A-Za-z_$][\w$]*(\\b)?(\\\()?$|^(function|class|interface|type|const|let|enum)\s+\\?[A-Za-z_$][\w$]*/
const TSJS = /\.(c|m)?(t|j)sx?\b|\b(ts|tsx|js|jsx)\b/

let cfg: Config = DEFAULTS
let started = false
let lastNudge = 0
let window: { total: number; used: boolean } | null = null
const logged = new Set<string>()
const counts = { searches: 0, lspCalls: 0, nudges: 0 }

const active = () => cfg.enabled && trackOn()

async function configPath($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/.claude-shared/lsp-first/config.json`
}

/** Config and arm, once per session; tool.describe can run before session.start. */
async function ensureStarted($: EngineInterface) {
  if (started) return
  started = true
  const path = await configPath($)
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
  } catch {
    cfg = DEFAULTS
  }
  await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
  await trackStart($, 'lsp-first', cfg.enabled ? cfg.holdout : 0, cfg)
}

async function once($: EngineInterface, kind: string, data: Record<string, unknown>) {
  if (logged.has(kind)) return
  logged.add(kind)
  await trackLog($, kind, data)
}

async function closeWindow($: EngineInterface, partial = false) {
  if (!window) return
  await trackLog($, 'nudge_outcome', { nudge: 'lsp', followed: window.used ? 1 : 0, total: 1, calls: window.total, partial })
  window = null
}

const unquote = (t: string) => t.replace(/^(['"])(.*)\1$/, '$2')
const bare = (p: string) => p.replace(/^(function|class|interface|type|const|let|enum)\s+/, '').replace(/\\[bs(<>]/g, '').replace(/\\/g, '')

/** The symbol a Grep call or a grep/rg command looks up in TS/JS code, or undefined. */
export function symbolSearch(e: Record<string, unknown>): string | undefined {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  if (e.tool === 'Grep') {
    const pattern = str('pattern')
    return IDENT.test(pattern) && TSJS.test(`${str('glob')} ${str('type')} ${str('path')}`) ? bare(pattern) : undefined
  }
  if (e.tool !== 'Bash') return undefined
  const cmd = str('command')
  const m = /(?:^|[|;&]\s*|\s)(?:rg|grep|egrep|git\s+grep|ag)\s+(.*)$/.exec(cmd.split('\n')[0]!)
  if (!m || !TSJS.test(cmd)) return undefined
  const tokens = m[1]!.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '|' || t === '&&' || t === ';') break
    if (t.startsWith('-')) {
      // flags whose value is the next token
      if (/^(-[tTgAmBCef]|--type|--glob|--include|--exclude|--max-count|-[A-Z]?C)$/.test(t)) i++
      if (t === '-e') return IDENT.test(unquote(tokens[i] ?? '')) ? bare(unquote(tokens[i]!)) : undefined
      continue
    }
    const pat = unquote(t)
    return IDENT.test(pat) && pat.length >= 3 ? bare(pat) : undefined
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    started = false
    logged.clear()
    window = null
    Object.assign(counts, { searches: 0, lspCalls: 0, nudges: 0 })
    await ensureStarted($)
    $.clock.every(30_000, () => void trackFlush($).catch(() => {}))
    await $.command.register({
      name: 'lsp-first',
      description: 'lsp-first: status | on | off | holdout <0-1> | nudges on|off | guide on|off',
      argumentHint: '[status | on | off | holdout <0-1> | nudges|guide on|off]',
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    await closeWindow($, true)
    await trackLog($, 'session_summary', { ...counts })
    await trackFlush($).catch(() => {})
    return next(e)
  })

  on('tool.describe', { tool: 'LSP' }, async ($, e, next) => {
    await ensureStarted($)
    const r = await next(e)
    if (!active() || !cfg.upfront) return r
    // Loaded up front, the schema is paid on every request: log its size once.
    await once($, 'schema_upfront', { chars: r.description.length, wasDeferred: e.isDeferred ?? null })
    return { ...r, isDeferred: false }
  })

  on('prompt.compose', async ($, e, next) => {
    await ensureStarted($)
    const r = await next(e)
    if (!active() || !cfg.guide || !e.tools.includes('LSP') || r.sections.some(s => s.id === 'lsp-first:guide')) return r
    await once($, 'guide', { chars: GUIDE.length })
    return { sections: [...r.sections, { id: 'lsp-first:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // This build searches through Bash (grep/rg); older builds have a Grep tool. Both are read here.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!cfg.enabled) return r
    if (e.tool === 'LSP') {
      counts.lspCalls++
      const op = (e as unknown as { operation?: string }).operation
      await trackLog($, 'lsp_call', { op: op ?? null, resultChars: (r.text ?? '').length, error: !!r.isError })
      if (window) window.used = true
      await closeWindow($)
      return r
    }
    if (window && ++window.total >= OUTCOME_WINDOW) await closeWindow($)
    if (r.deny !== undefined || r.isError) return r
    const name = symbolSearch(e as unknown as Record<string, unknown>)
    if (!name) return r
    counts.searches++
    await trackLog($, 'symbol_search', { symbol: name, resultChars: (r.text ?? '').length })
    if (!cfg.nudges) return r
    const now = await $.clock.now()
    if (now - lastNudge < NUDGE_EVERY_MS) return r
    lastNudge = now
    await closeWindow($, true)
    window = { total: 0, used: false }
    if (!trackOn()) {
      await trackLog($, 'would_nudge', { nudge: 'lsp' })
      return r
    }
    counts.nudges++
    const note = `That search looked up the symbol "${name}" in TS/JS code. The LSP tool answers this exactly and with less output: workspaceSymbol (query "${name}") to find it, then goToDefinition / findReferences / hover at its position.`
    await trackLog($, 'nudge', { nudge: 'lsp', chars: note.length })
    return { ...r, context: [...(r.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'lsp-first' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    const save = async (patch: Partial<Config>) => {
      cfg = { ...cfg, ...patch }
      await $.fs.write(await configPath($), JSON.stringify(cfg, null, 2) + '\n')
    }
    if (what === 'on' || what === 'off') await save({ enabled: what === 'on' })
    else if (what === 'holdout' && Number(val) >= 0 && Number(val) <= 1) await save({ holdout: Number(val) })
    else if (what === 'nudges') await save({ nudges: val === 'on' })
    else if (what === 'guide') await save({ guide: val === 'on' })
    else if (what && what !== 'status') return { text: 'Usage: /lsp-first [status | on | off | holdout <0-1> | nudges|guide on|off]' }
    return {
      text: [
        `lsp-first ${cfg.enabled ? 'on' : 'OFF'} · this session: ${trackOn() ? 'active' : 'holdout (passive, for comparison)'} · holdout share ${Math.round(cfg.holdout * 100)}%`,
        `LSP schema up front ${cfg.upfront ? 'on' : 'off'} · guide ${cfg.guide ? 'on' : 'off'} · nudges ${cfg.nudges ? 'on' : 'off'}`,
        `this session: ${counts.lspCalls} LSP calls, ${counts.searches} grep/rg symbol searches in TS/JS, ${counts.nudges} nudges`,
        'Settings changes apply to new sessions. Impact across sessions: /analytics impact, or /dashboard impact',
      ].join('\n'),
    }
  })
}
