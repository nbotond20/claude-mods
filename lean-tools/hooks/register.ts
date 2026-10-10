import type { EngineInterface, Register } from 'claude-code'

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
 * Config: ~/.claude-shared/lean-tools/config.json (written with the defaults on first start).
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

const active = () => cfg.enabled && trackOn()

async function configPath($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/.claude-shared/lean-tools/config.json`
}

async function loadConfig($: EngineInterface) {
  const path = await configPath($)
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
  } catch {
    cfg = DEFAULTS
  }
  // Keep the file complete, so new keys show up for editing.
  await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
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
  if (!cfg.enabled || !(await due($, kind))) return r
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
    $.clock.every(30_000, () => void trackFlush($).catch(() => {}))
    await $.command.register({
      name: 'lean',
      description: 'lean-tools: status | on | off | holdout <0-1> | cap on|off | nudges on|off | guide on|off',
      argumentHint: '[status | on | off | holdout <0-1> | cap|nudges|guide on|off]',
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
    if (!cfg.enabled) return next(e)
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

  on('command.run', { command: 'lean' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    const save = async (patch: Partial<Config>) => {
      cfg = { ...cfg, ...patch }
      await $.fs.write(await configPath($), JSON.stringify(cfg, null, 2) + '\n')
    }
    const onOff = val === 'on'
    if (what === 'on' || what === 'off') await save({ enabled: what === 'on' })
    else if (what === 'holdout' && Number(val) >= 0 && Number(val) <= 1) await save({ holdout: Number(val) })
    else if (what === 'cap') await save({ capOutput: onOff })
    else if (what === 'nudges') await save({ nudges: onOff })
    else if (what === 'guide') await save({ guide: onOff })
    else if (what && what !== 'status') return { text: 'Usage: /lean [status | on | off | holdout <0-1> | cap|nudges|guide on|off]' }
    return {
      text: [
        `lean-tools ${cfg.enabled ? 'on' : 'OFF'} · this session: ${trackOn() ? 'active' : 'holdout (passive, for comparison)'} · holdout share ${Math.round(cfg.holdout * 100)}%`,
        `cap ${cfg.capOutput ? `on (>${k(cfg.maxBytes)} bytes or >${cfg.maxLines} lines)` : 'off'} · git log bound ${cfg.boundGitLog ? 'on' : 'off'} · nudges ${cfg.nudges ? 'on' : 'off'} · guide ${cfg.guide ? 'on' : 'off'}`,
        `this session: ${counts.caps} caps (~${k(Math.round(counts.bytesAvoided / 4))} tokens kept out), ${counts.followups} re-opened a capped log, ${counts.nudges} nudges, ${counts.gitlog} git logs bounded`,
        'Settings changes apply to new sessions. Impact across sessions: /analytics impact, or /dashboard impact',
      ].join('\n'),
    }
  })
}
