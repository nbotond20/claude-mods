import type { EngineInterface, Register } from 'claude-code'

/**
 * usage-analytics: a raw event log of everything that costs tokens, from every profile, in one place.
 *
 * Every session appends immutable JSONL chunks under
 *   ~/.claude-shared/usage-analytics/events/<profile>/<YYYY-MM-DD>/<session>.<stamp>.jsonl
 * so concurrent sessions never write the same file. `bin/claude-usage` folds these chunks and the
 * profiles' own transcripts into one SQLite database for analysis.
 */

type Ev = Record<string, unknown>

type Config = {
  /** keep the full text of each prompt (else its length only) */
  storePrompts: boolean
  /** characters of each tool call's input kept (0: none) */
  maxInputChars: number
  /** characters of each tool result kept (0: none) */
  maxResultChars: number
  /** characters of each model answer kept (0: none) */
  maxAnswerChars: number
  /** snapshot the /context breakdown every N main-loop turns (0: never) */
  breakdownEvery: number
  /** fold new data into the database in the background */
  autoIngest: boolean
  /** minutes between background ingests */
  ingestEveryMin: number
  /** record OpenTelemetry collector records the engine emits */
  captureOtel: boolean
}

const DEFAULTS: Config = {
  storePrompts: true,
  maxInputChars: 4000,
  maxResultChars: 0,
  maxAnswerChars: 2000,
  breakdownEvery: 3,
  autoIngest: true,
  ingestEveryMin: 30,
  captureOtel: true,
}

const FLUSH_MS = 15_000
const FLUSH_AT = 400
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

// Module state: a reload starts these over, which only costs the unflushed buffer's position.
let buf: Ev[] = []
let root = ''
let profile = ''
let sid: string | null = null
let cfg: Config = DEFAULTS
let chunk = 0
let mainTurns = 0
let lastPromptSig = ''
const tag = Math.random().toString(36).slice(2, 8)
const agentsSeen = new Set<string>()
const describedTools = new Set<string>()

const localDay = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
const clip = (s: unknown, n: number) => {
  if (n <= 0 || s === undefined || s === null) return undefined
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  return str.length > n ? `${str.slice(0, n)}…[+${str.length - n}]` : str
}
const size = (s: unknown) => (s === undefined || s === null ? 0 : typeof s === 'string' ? s.length : JSON.stringify(s).length)
const host = (url: string | undefined) => {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return 'unparsed'
  }
}

async function sessionId($: EngineInterface) {
  if (!sid) sid = await $.session.id().catch(() => 'unknown')
  return sid
}

async function emit($: EngineInterface, ev: string, data: Ev) {
  if (!root) return
  buf.push({ ts: await $.clock.now(), ev, sid: await sessionId($), profile, ...data })
  if (buf.length >= FLUSH_AT) void flush($).catch(() => {})
}

// Secrets that show up in commands, tool output and telemetry are blanked before anything is written.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, '[REDACTED]'],
  [/\b((?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED]'],
  [/([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|credential|authorization)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)(?![0-9.]+(?:\W|$))[^\s"',;&|}]{6,}/gi, '$1[REDACTED]'],
  [/(:\/\/[^\s/:@]+:)[^\s/@]{3,}@/g, '$1[REDACTED]@'],
]
const SECRET_KEY = /(token|secret|passw(or)?d|api[_-]?key|access[_-]?key|credential|authorization|cookie)$/i

function redact(text: string): string {
  let out = text
  for (const [re, by] of SECRET_PATTERNS) out = out.replace(re, by)
  return out
}

function scrub(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return SECRET_KEY.test(key) && v.length >= 6 ? '[REDACTED]' : redact(v)
  if (Array.isArray(v)) return v.map(x => scrub(x))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]))
  return v
}

async function flush($: EngineInterface) {
  if (!root || buf.length === 0) return
  const batch = buf
  buf = []
  const first = batch[0]!
  const t = first.ts as number
  const path = `${root}/events/${profile}/${localDay(t)}/${first.sid}.${t}.${tag}${chunk++}.jsonl`
  try {
    await $.fs.write(path, batch.map(x => JSON.stringify(scrub(x))).join('\n') + '\n')
  } catch {
    buf = batch.concat(buf)
  }
}

async function loadConfig($: EngineInterface) {
  const path = `${root}/config.json`
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
  } catch {
    cfg = DEFAULTS
    await $.fs.write(path, JSON.stringify(DEFAULTS, null, 2) + '\n').catch(() => {})
  }
}

async function git($: EngineInterface, cwd: string, args: string[]) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

const TABS = ['overview', 'cost', 'context', 'tools', 'agents', 'projects', 'prompts', 'health', 'engine', 'impact', 'savings', 'sql']
const cli = (pluginRoot: string, args: string[]) => ['python3', `${pluginRoot}/bin/claude-usage`, ...args]

async function ingest($: EngineInterface) {
  await flush($).catch(() => {})
  await $.process.run(cli($.plugin.root, ['ingest', '--quiet']), { timeoutMs: 600_000 }).catch(() => {})
}

/** What a tool call was about, pulled out of its input so the database can group by it. */
function facets(tool: string, input: Record<string, unknown>): Ev {
  const f: Ev = {}
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const file = s('file_path') ?? s('filePath') ?? s('notebook_path') ?? s('path')
  if (file) {
    f.file = file
    const m = /\.([A-Za-z0-9]+)$/.exec(file)
    if (m) f.ext = m[1]!.toLowerCase()
  }
  if (tool === 'Bash') {
    const cmd = s('command') ?? ''
    f.cmd = cmd.trim().split(/\s+/).slice(0, 2).join(' ')
    f.bg = input.run_in_background === true
  }
  if (tool === 'Grep' || tool === 'Glob') f.pattern = s('pattern')
  if (tool === 'Agent') (f.subagent = s('subagent_type') ?? 'general-purpose'), (f.agentModel = s('model'))
  if (tool === 'Skill') f.skill = s('skill')
  if (tool === 'WebFetch') f.host = host(s('url'))
  if (tool === 'WebSearch') f.query = s('query')
  if (tool === 'LSP') f.op = s('operation')
  if (tool === 'Edit') (f.oldChars = size(input.old_string)), (f.newChars = size(input.new_string)), (f.replaceAll = input.replace_all === true)
  if (tool === 'Write') f.contentChars = size(input.content)
  if (tool === 'Read') (f.offset = input.offset), (f.limit = input.limit)
  if (tool.startsWith('mcp__')) f.mcpServer = tool.split('__')[1]
  return f
}

async function breakdown($: EngineInterface, why: string) {
  const u = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const b = u?.context.breakdown
  if (!b) return
  const byServer: Record<string, { tools: number; tokens: number }> = {}
  for (const t of b.mcpTools) {
    const s = (byServer[t.serverName] ??= { tools: 0, tokens: 0 })
    s.tools += 1
    s.tokens += t.tokens
  }
  await emit($, 'context', {
    why,
    model: b.model,
    totalTokens: b.totalTokens,
    rawMaxTokens: b.rawMaxTokens,
    percentage: b.percentage,
    autoCompactThreshold: b.autoCompactThreshold,
    categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, deferred: c.isDeferred })),
    memoryFiles: b.memoryFiles,
    mcpServers: byServer,
    mcpTools: b.mcpTools.map(t => ({ name: t.name, server: t.serverName, tokens: t.tokens })),
    agents: b.agents,
    skills: b.skills,
    slashCommands: b.slashCommands,
    apiUsage: b.apiUsage,
  })
}

async function noteAgent($: EngineInterface, agentId: string) {
  if (agentsSeen.has(agentId)) return
  agentsSeen.add(agentId)
  const a = (await $.agent.list().catch(() => [])).find(x => x.id === agentId)
  await emit($, 'agent', a
    ? { agentId, type: a.type, description: a.description, parentId: a.parentId, name: a.name, spawnedBy: a.spawnedBy, teammateId: a.teammateId }
    : { agentId, type: null, note: 'not listed (engine fork: compaction, memory, workflow)' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
    profile = (configDir ?? `${home}/.claude`).replace(/\/+$/, '').split('/').pop()!.replace(/^\./, '')
    root = `${home}/.claude-shared/usage-analytics`
    sid = null
    await loadConfig($)

    await $.command.register({
      name: 'analytics',
      description: 'Usage analytics across all profiles: dashboard [tab] · impact (are the mods saving money?) · status · ingest · stop · or a report: overview|daily|models|projects|tools|agents|sessions|context|hours [--days N] [--profile P]',
      argumentHint: '[dashboard [tab] | impact | status | ingest | stop | <report>] [--days N] [--profile P]',
    })
    await $.command.register({
      name: 'dashboard',
      description: `Open the usage dashboard in the browser (starts it if needed). Tabs: ${TABS.join(', ')}`,
      argumentHint: '[tab]',
    })

    const settings = (await $.settings.read().catch(() => ({}))) as Record<string, any>
    const cwd = e.cwd
    const [version, model, usage, branch, top, remote] = await Promise.all([
      $.session.version().catch(() => null),
      $.session.model().catch(() => null),
      $.session.usage().catch(() => null),
      git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git($, cwd, ['rev-parse', '--show-toplevel']),
      git($, cwd, ['config', '--get', 'remote.origin.url']),
    ])
    await emit($, 'session_start', {
      cwd,
      surface: e.surface,
      isInteractive: e.isInteractive,
      configDir,
      version,
      model,
      startedAt: usage?.startedAt,
      git: { branch, root: top, remote },
      // Who pays, never a secret's value: only the gateway's host and which credentials are set.
      gatewayHost: host((await $.env.get('ANTHROPIC_BASE_URL')) ?? undefined),
      hasAuthToken: !!((await $.env.get('ANTHROPIC_AUTH_TOKEN')) ?? undefined),
      hasApiKey: !!((await $.env.get('ANTHROPIC_API_KEY')) ?? undefined),
      env: {
        subagentModel: (await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ?? undefined,
        opus: (await $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')) ?? undefined,
        sonnet: (await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')) ?? undefined,
        haiku: (await $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')) ?? undefined,
        entrypoint: (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? undefined,
        term: (await $.env.get('TERM_PROGRAM')) ?? undefined,
      },
      settings: {
        model: settings.model,
        effortLevel: settings.effortLevel,
        modelSettings: settings.modelSettings,
        outputStyle: settings.outputStyle,
        defaultMode: settings.permissions?.defaultMode,
        autoCompactWindow: settings.autoCompactWindow,
        plugins: Object.entries(settings.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k),
      },
    })

    $.clock.every(FLUSH_MS, () => void flush($).catch(() => {}))
    if (cfg.autoIngest) {
      $.clock.after(45_000, () => void ingest($))
      $.clock.every(Math.max(5, cfg.ingestEveryMin) * 60_000, () => void ingest($))
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await emit($, 'session_end', { reason: e.reason, endingSid: e.sessionId, resume: e.resume })
    await flush($).catch(() => {})
    const r = await next(e)
    // After /clear the process goes on under a new id, with no session.start.
    sid = null
    mainTurns = 0
    lastPromptSig = ''
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    await emit($, 'prompt', {
      text: cfg.storePrompts ? e.text : undefined,
      chars: e.text.length,
      lines: e.text.split('\n').length,
      origin: e.origin.kind,
      intoTurn: e.turnId,
      attachments: e.attachments?.map(a => (a as any).type ?? (a as any).kind ?? 'item'),
      contextChars: size(e.context),
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await emit($, 'turn_start', { turnId: e.turnId, chars: e.text.length })
    return next(e)
  })

  // One record per model request: the core of where tokens go.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) await noteAgent($, e.agentId).catch(() => {})
    const t0 = await $.clock.now()
    let firstAt: number | null = null
    let chunks = 0
    const s = next(e)
    try {
      for await (const c of s) {
        if (firstAt === null) firstAt = await $.clock.now()
        chunks++
        yield c
      }
    } catch (err) {
      await emit($, 'step_error', { turnId: e.turnId, index: e.index, agentId: e.agentId, model: e.model, error: String(err).slice(0, 300), ms: (await $.clock.now()) - t0 })
      throw err
    }
    const r = await s.result
    const t1 = await $.clock.now()
    await emit($, 'step', {
      turnId: e.turnId,
      index: e.index,
      agentId: e.agentId,
      model: e.model,
      answeredBy: r.usage?.model,
      effort: e.effort,
      messageCount: e.messageCount,
      usage: r.usage ? { in: r.usage.input_tokens, out: r.usage.output_tokens, cr: r.usage.cache_read_input_tokens, cw: r.usage.cache_creation_input_tokens } : null,
      stop: r.stopReason,
      ms: t1 - t0,
      ttftMs: firstAt === null ? null : firstAt - t0,
      chunks,
      answerChars: r.answer.length,
      answer: clip(r.answer, cfg.maxAnswerChars),
      tools: r.toolUses.map(u => ({ name: u.name, inChars: size(u.input) })),
      serverTools: r.serverToolUses?.map(u => ({ name: u.name, ms: u.endedAt ? u.endedAt - u.startedAt : null })),
    })
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await emit($, 'turn_complete', {
      turnId: e.turnId,
      agentId: e.agentId,
      ms: e.durationMs,
      aborted: e.isAborted,
      reason: e.reason,
      refusal: e.reason === 'refusal' ? e.refusal : undefined,
      usage: e.usage ? { in: e.usage.input_tokens, out: e.usage.output_tokens, cr: e.usage.cache_read_input_tokens, cw: e.usage.cache_creation_input_tokens, model: e.usage.model } : null,
      answerChars: e.answer.length,
    })
    if (!e.agentId) {
      mainTurns++
      if (cfg.breakdownEvery > 0 && (mainTurns === 1 || mainTurns % cfg.breakdownEvery === 0)) void breakdown($, `turn ${mainTurns}`).catch(() => {})
    }
    return r
  })

  // Every tool call: what it was, how long it ran, how much it put into the context.
  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const r = await next(e)
    const ms = (await $.clock.now()) - t0
    const input: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) input[k] = v
    const text = 'text' in r && typeof r.text === 'string' ? r.text : undefined
    const resultChars = text !== undefined ? text.length : 'result' in r ? size(r.result) : 0
    await emit($, 'tool', {
      tool: e.tool,
      id: e.tool_use_id,
      agentId: e.agentId,
      ms,
      inChars: size(input),
      input: clip(input, cfg.maxInputChars),
      ...facets(e.tool, input),
      resultChars,
      resultLines: text ? text.split('\n').length : undefined,
      result: clip(text, cfg.maxResultChars),
      isError: 'isError' in r && r.isError === true,
      error: 'isError' in r && r.isError ? clip(text, 400) : undefined,
      denied: 'deny' in r && r.deny ? clip(r.deny, 400) : undefined,
      readOnly: 'isReadOnly' in r && r.isReadOnly === true,
      contextChars: 'context' in r ? size(r.context) : 0,
    })
    return r
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await emit($, 'measure', {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      costUsd: e.cost?.usd,
      rateLimits: e.rateLimits,
      changed: e.changed,
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (!e.agentId && e.trigger !== 'precompute') await breakdown($, `before compact (${e.trigger})`).catch(() => {})
    const t0 = await $.clock.now()
    const r = await next(e)
    await emit($, 'compact', {
      trigger: e.trigger,
      agentId: e.agentId,
      messages: e.messages.length,
      instructionsChars: e.instructions?.length ?? 0,
      ms: (await $.clock.now()) - t0,
      skipped: r.skip,
      kept: r.messages?.length,
      tokensBefore: r.messages ? r.tokensBefore : undefined,
      tokensAfter: r.messages ? r.tokensAfter : undefined,
      usage: r.messages ? r.usage : undefined,
    })
    return r
  }).catch(($, e, next) => next(e))

  // The system prompt's sections and the tool list, recorded whenever their sizes change.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const sections = r.sections.map(s => ({ id: s.id, scope: s.scope, chars: s.text.length }))
    const sig = `${e.model}|${e.tools.length}|${sections.map(s => `${s.id}:${s.chars}`).join(',')}`
    if (sig !== lastPromptSig && !e.traits.includes('analysis')) {
      lastPromptSig = sig
      await emit($, 'system_prompt', { model: e.model, chars: sections.reduce((a, s) => a + s.chars, 0), sections, tools: e.tools, traits: e.traits, outputStyle: e.outputStyle?.name })
    }
    return r
  })

  // Each tool's description as the model reads it: what the tool list costs, per tool.
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    const key = `${e.tool}:${r.description.length}:${r.isDeferred ?? e.isDeferred ?? false}`
    if (!describedTools.has(key)) {
      describedTools.add(key)
      await emit($, 'tool_schema', { tool: e.tool, chars: r.description.length, deferred: r.isDeferred ?? e.isDeferred ?? false, provider: e.provider })
    }
    return r
  })

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    await emit($, 'skill', { skill: e.skill, chars: r.text.length })
    return r
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'analytics') await emit($, 'command', { command: e.command, args: clip(e.args, 300), origin: e.origin.kind })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('telemetry.log', { to: 'collector' }, async ($, e, next) => {
    if (cfg.captureOtel) await emit($, 'otel', { event: e.event, attributes: e.attributes, loggedAt: e.loggedAt })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'analytics' }, async ($, e) => {
    await flush($).catch(() => {})
    const [sub, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    return { text: await analytics($, sub, rest) }
  })

  on('command.run', { command: 'dashboard' }, async ($, e) => {
    await flush($).catch(() => {})
    return { text: await analytics($, 'dashboard', e.args.trim().split(/\s+/).filter(Boolean)) }
  })
}

/** Runs one /analytics subcommand through the claude-usage CLI and returns its output. */
async function analytics($: EngineInterface, sub: string | undefined, rest: string[]) {
  const run = async (args: string[], timeoutMs: number) => {
    const r = await $.process.run(cli($.plugin.root, args), { timeoutMs })
    return (r.stdout || r.stderr || `claude-usage exited ${r.exitCode}`).trimEnd()
  }
  switch (sub) {
    // The dashboard runs detached on 127.0.0.1:8787 and outlives the session; a second call just opens it.
    case 'dashboard': {
      const tab = rest[0] && !rest[0].startsWith('-') ? rest.shift()! : undefined
      if (tab && !TABS.includes(tab)) return `Unknown tab "${tab}". Tabs: ${TABS.join(', ')}`
      return run(['serve', '--daemon', '--open', ...(tab ? ['--tab', tab] : []), ...rest], 30_000)
    }
    case 'impact': return run(['impact', '--ingest', ...rest], 600_000)
    case 'status': return run(['status'], 30_000)
    case 'ingest': return (await run(['ingest', ...rest], 600_000)) || 'ingested'
    case 'stop': return run(['stop'], 30_000)
    default: return run(['report', '--ingest', ...(sub ? [sub] : []), ...rest], 600_000)
  }
}
