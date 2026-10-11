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

/**
 * usage-analytics: a raw event log of everything that costs tokens, from every profile, in one place.
 *
 * Every session appends immutable JSONL chunks under
 *   <mods home>/usage-analytics/events/<profile>/<YYYY-MM-DD>/<session>.<stamp>.jsonl
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
  /** keep the dashboard server (one per machine, on 127.0.0.1) running: started at session start and by /analytics */
  dashboard: boolean
  /** the dashboard's port on 127.0.0.1 */
  port: number
  /** Claude config dirs to read transcripts from; empty: every ~/.claude* dir plus each one a session ran from */
  profileDirs: string[]
  /** days between the advisor's background research runs (0: only on /analytics advise) */
  advisorEveryDays: number
  /** the model the background advisor runs on (an alias or a full id) */
  advisorModel: string
  /** toast when an applied recommendation gets a verdict (improved, regressed, …) */
  advisorNotify: boolean
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
  dashboard: true,
  port: 8787,
  profileDirs: [],
  advisorEveryDays: 7,
  advisorModel: 'sonnet',
  advisorNotify: true,
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
  const ts = await $.clock.now()
  buf.push({ ts, ev, sid: await sessionId($), profile, ...data })
  if (LIVE.has(ev)) void pulse($, ev, ts).catch(() => {})
  else if (buf.length >= FLUSH_AT) void flush($).catch(() => {})
}

// Live dashboard: after every prompt, model request, tool call and turn, flush and touch live/<profile>.json.
// The dashboard server watches that file, ingests the new transcript lines and pushes the update to the page.
const LIVE = new Set(['prompt', 'step', 'tool', 'turn_complete', 'session_start', 'session_end', 'compact'])
const PULSE_MS = 750
let lastPulse = 0

async function pulse($: EngineInterface, ev: string, ts: number) {
  if (ev !== 'turn_complete' && ts - lastPulse < PULSE_MS) return
  lastPulse = ts
  await flush($)
  await $.fs.write(`${root}/live/${profile}.json`, JSON.stringify({ ts, ev, sid: await sessionId($), profile }) + '\n')
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

/** Reads the config, and writes it back complete so new keys show up for editing. True on the very first run. */
async function loadConfig($: EngineInterface) {
  const path = `${root}/config.json`
  let saved: Partial<Config> | null = null
  try {
    saved = JSON.parse(String(await $.fs.read(path)))
  } catch {
    // first run, or an unreadable file: the defaults
  }
  cfg = { ...DEFAULTS, ...saved }
  if (!saved || Object.keys(DEFAULTS).some(k => !(k in saved!))) await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
  return saved === null
}

async function git($: EngineInterface, cwd: string, args: string[]) {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 3000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

const TABS = ['live', 'overview', 'cost', 'context', 'tools', 'agents', 'projects', 'prompts', 'health', 'engine', 'advisor', 'impact', 'savings', 'sql']
/** Runs the claude-usage CLI (Python 3, standard library only) on the same data folder as this mod. */
async function cli($: EngineInterface, args: string[], timeoutMs: number) {
  return $.process.run(['python3', `${$.plugin.root}/bin/claude-usage`, ...args], { timeoutMs, env: { CLAUDE_USAGE_DIR: root } })
}

let pythonWarned = false
/** Starts the dashboard server unless one already answers (the CLI holds a machine-wide lock while deciding). */
async function ensureDashboard($: EngineInterface) {
  if (!cfg.dashboard) return
  const r = await cli($, ['serve', '--daemon', '--quiet'], 15_000).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0 && !pythonWarned && /python3|ENOENT|not found|No such file/i.test(r.stderr)) {
    pythonWarned = true
    $.ui.toast('usage-analytics needs python3 on PATH for its database and dashboard; events are still recorded.')
  }
}

async function ingest($: EngineInterface) {
  await flush($).catch(() => {})
  await cli($, ['ingest', '--quiet'], 600_000).catch(() => {})
}

// ---------- advisor: research → recommend → apply → verify, and back ----------

/** The advisor's workflow, for the background agent (its system prompt) and for a run in the main loop. */
export const ADVISOR_PROMPT = `You are the usage advisor for this person's Claude Code usage. Find the few changes that make it cheaper, use fewer tokens, faster or more reliable for this person, and learn from how earlier advice turned out. Every claim you make is checked: numbers against the database, sources against their dates, and every change you recommend is measured afterwards.

Tools (the usage-analytics mod's; load them with ToolSearch if they are deferred):
- advisor_brief: the data. Metrics per goal with 8-week trends (Theil-Sen slope, Mann-Kendall p, the smallest change the data can detect: mde) and the last 7 days vs the 28 before (95% bootstrap intervals); segments (by project, profile and entrypoint: where each metric is high or low); deterministic findings; the setup per profile; setting changes; every earlier recommendation with status, measured verdict, evidence grade and method; the track record (success rate per goal and kind of change); earlier research notes (with checked dates; stale ones flagged); pace (sessions per day); top models, agents, tools, sessions; a sample of prompts.
- advisor_sql: read-only SQL over the usage database (tables requests, tool_uses, prompts, sessions, agents, system_events, events; views v_requests, v_context, v_mod_steps, …).
- WebSearch, WebFetch: current guidance.
- advisor_record: stores the result. Call it once, at the end.

Rules of evidence:
- This person's data beats web advice. A technique that helps on average can hurt here; a segment where a metric is bad is a lead, a single session is an anecdote.
- Every number you state comes from a query: put each as { claim, sql } in evidence. The query is re-run when you record and stored with its result, so anyone can reproduce it. Never quote a number you did not query.
- Sources: primary first (Anthropic's docs, pricing page, the Claude Code changelog and release notes, the anthropics GitHub repos); for each note give the published date if shown and today as checked. Advice changes fast: check the changelog for the version in setup, re-check notes flagged stale, and drop advice that newer releases made moot. A blog post or forum thread alone is a lead, not evidence.
- Look for evidence against each idea too (counter_evidence): where it would not help or could backfire.
- Use trackRecord: if a kind of change keeps measuring no_effect or regressed for this person, do not propose it again without a new reason.

Workflow:
1. Call advisor_brief. Read trackRecord and recommendations first. improved: it works; build on it. regressed or tradeoff: propose reverting or adjusting it, quoting the measured numbers. no_effect: say so; propose reverting it if it costs anything. dismissed: do not propose it again unless the evidence changed. collecting: leave it.
2. Pick the three or four biggest levers by dollars or tokens at stake (not by how many findings there are). Quantify each with advisor_sql, and look at segments: which projects, profiles, entrypoints (automated vs interactive) carry it. Personalize: if the lever lives in a few projects or one profile, scope the recommendation to them.
3. Read samplePrompts (language, length, pasted logs, vague vs specific asks, instructions repeated in every prompt that belong in CLAUDE.md, routine tasks a cheaper model could take). Raise it only if the numbers show it matters.
4. Research each lever on the web, checked against the Claude Code version in setup. Read notes first so you do not redo research.
5. Recommend three to six changes, best expected value first. Each:
   - metric: one metricCatalog key, the one it moves most directly. Prefer a proximal metric (whole_file_reads, tool_error_rate, a cache metric) over a distal one (cost_per_prompt) when the brief's mde shows the distal one cannot detect the effect; say the cost consequence in expected.
   - expected_effect: the relative change you predict in that metric, a number (-0.2 for -20%), and expected: the same in words.
   - hypothesis: one sentence, falsifiable: "If <change>, <metric> drops by about X% in <scope> because <mechanism>."
   - exposure_sql: a query returning one number in [0,1], the share of the metric's volume the change can touch.
   - scope: { projects: [...], profiles: [...] } when it should only apply there (project names as in the data, e.g. "~/code/app"); omit for everything.
   - instruction: when the change is how the model should behave (read ranges, batch calls, use a cheaper subagent, …), the exact text to add to the system prompt, at most a few sentences. The person can then run it as an A/B trial: the mod adds it to a random half of sessions and compares. Leave it out for settings, files and habits.
   - action (the exact setting, file, command or habit; never generic advice like "be concise"), rationale, evidence [{claim, sql}], counter_evidence, risk (what could get worse), effort, apply_kind, sources (urls), supersedes (an earlier id, optional).
6. Call advisor_record with { summary, recommendations, notes }. Notes: { topic, finding, source, published, checked }. It answers with each recommendation's evidence grade, estimated $/month, how many sessions until a verdict, and warnings (a failed query, no primary source, an effect too small to detect). Fix what it warns about by recording a corrected recommendation that supersedes it, once.
7. Answer with the summary and the list: id, title, expected effect, grade, sessions to a verdict, and "trial" for those that can run as an A/B trial.

Never change files or settings yourself, and never put secrets or whole prompts into notes or recommendations.`

const ADVISOR_TOOLS = [
  {
    name: 'advisor_brief',
    description: 'usage-analytics advisor: everything known about this machine\'s Claude usage (metrics with trends, findings, setup, setting changes, earlier recommendations and their measured verdicts, track record, notes, top tools/sessions, sample prompts), as JSON.',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'period in days (default 30)' }, profile: { type: 'string', description: 'only this profile (comma-separated for several)' } } },
  },
  {
    name: 'advisor_sql',
    description: 'usage-analytics advisor: run one read-only SQL query on the usage database (SQLite). Returns { cols, rows } (at most 200 rows) or { error }.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'advisor_record',
    description: 'usage-analytics advisor: store a research run\'s summary, recommendations and notes. Each recommendation: title, goal (cost|tokens|speed|reliability), metric (a metricCatalog key), expected (words), expected_effect (relative change, e.g. -0.2), hypothesis, evidence ([{claim, sql}], re-run and stored), exposure_sql (one number in [0,1]), scope ({projects, profiles}, optional), instruction (system-prompt text, for an A/B trial; optional), action, rationale, counter_evidence, apply_kind (settings|claude_md|mod_config|env|habit|workflow|instruction|other), effort, risk, sources (urls), supersedes (an earlier id, optional). Notes: topic, finding, source, published, checked. Answers with each recommendation\'s grade, $/month at stake, sessions to a verdict and warnings.',
    inputSchema: {
      type: 'object',
      required: ['summary', 'recommendations'],
      properties: {
        summary: { type: 'string' },
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'metric', 'action', 'expected_effect', 'evidence'],
            properties: {
              title: { type: 'string' },
              goal: { type: 'string', enum: ['cost', 'tokens', 'speed', 'reliability'] },
              metric: { type: 'string' },
              expected: { type: 'string' },
              expected_effect: { type: 'number', description: 'predicted relative change of the metric, e.g. -0.2' },
              hypothesis: { type: 'string' },
              evidence: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, sql: { type: 'string' } }, required: ['claim'] } },
              exposure_sql: { type: 'string' },
              scope: { type: 'object', properties: { projects: { type: 'array', items: { type: 'string' } }, profiles: { type: 'array', items: { type: 'string' } } } },
              instruction: { type: 'string' },
              action: { type: 'string' },
              rationale: { type: 'string' },
              counter_evidence: { type: 'string' },
              apply_kind: { type: 'string' },
              effort: { type: 'string' },
              risk: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
              supersedes: { type: 'string' },
            },
          },
        },
        notes: { type: 'array', items: { type: 'object', properties: { topic: { type: 'string' }, finding: { type: 'string' }, source: { type: 'string' }, published: { type: 'string' }, checked: { type: 'string' } } } },
      },
    },
  },
  {
    name: 'advisor_set',
    description: 'usage-analytics advisor: change a recommendation\'s status: accepted, trial (A/B: its instruction goes into a random half of sessions), applied (starts measuring its effect; an instruction keeps a 10% holdout), dismissed, reverted or proposed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['proposed', 'accepted', 'trial', 'applied', 'dismissed', 'reverted'] }, note: { type: 'string' } }, required: ['id', 'status'] },
  },
]

let advisorAgent = ''
/** The advisor tools' full names (as registered) to their short names. */
const advisorTools = new Map<string, string>()
/** The research run the main loop or the background agent is filling (its id from `advise due --claim`). */
let advisorRun = ''
/** The background advisor agent and its run, until its turn completes. */
let advisorBg: { agentId: string; runId: string } | null = null
let advisorRecorded = 0

// ---------- advisor trials: an instruction in a random share of sessions, the rest the control ----------

type Trial = { id: string; instruction: string; share: number; scope?: { projects?: string[]; profiles?: string[] } | null }
/** The session the arms below were drawn for, its project, and the instructions it got. */
let trialSid = ''
let trialProject = ''
let trialText = ''

/** FNV-1a, scaled to [0, 1): the same hash the other mods' holdouts use. */
function bucket(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 2 ** 32
}

/** The project name the database uses for a cwd: worktrees folded into their repo, home as ~. */
export function projectOf(cwd: string, home: string) {
  const p = cwd.split(/\/\.claude\/worktrees\/|\/\.worktrees\/|-worktrees\/|\/worktrees\//)[0]!
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

export function inScope(t: Trial, project: string, prof: string) {
  const s = t.scope
  if (!s) return true
  if (s.profiles?.length && !s.profiles.includes(prof)) return false
  return !s.projects?.length || s.projects.some(p => project === p || project.startsWith(p.replace(/\/+$/, '') + '/'))
}

/** The arm of one session in one trial: deterministic, so a resumed session keeps it. */
export const trialArm = (id: string, session: string, share: number) => (bucket(`advisor:${id}:${session}`) < share ? 'on' : 'holdout')

/** Draws this session's arms (once per session id) and logs them; returns the instructions it gets. */
async function trialInstructions($: EngineInterface) {
  const s = await sessionId($)
  if (s === trialSid) return trialText
  trialSid = s
  trialText = ''
  let trials: Trial[] = []
  try {
    trials = (JSON.parse(await $.fs.read(`${root}/advisor-trials.json`)) as { trials?: Trial[] }).trials ?? []
  } catch {
    return ''
  }
  const on: string[] = []
  for (const t of trials) {
    if (!t.id || !t.instruction || !inScope(t, trialProject, profile)) continue
    const arm = trialArm(t.id, s, t.share)
    await emit($, 'advisor_arm', { rec: t.id, arm, share: t.share })
    if (arm === 'on') on.push(t.instruction.trim())
  }
  trialText = on.join('\n\n')
  return trialText
}

async function advise($: EngineInterface, args: string[], timeoutMs = 120_000) {
  const r = await cli($, ['advise', ...args], timeoutMs)
  return { ok: r.exitCode === 0, text: (r.stdout || r.stderr || `claude-usage exited ${r.exitCode}`).trimEnd() }
}

async function claimRun($: EngineInterface, trigger: string, force: boolean) {
  const r = await advise($, ['due', '--every', force ? '0' : String(cfg.advisorEveryDays), '--claim', '--trigger', trigger, '--model', trigger === 'manual' ? 'session' : cfg.advisorModel])
  try {
    return (JSON.parse(r.text) as { runId?: string }).runId ?? ''
  } catch {
    return ''
  }
}

/** Starts the research in the background on the advisor agent; its turn.complete reports back. */
async function adviseInBackground($: EngineInterface, trigger: 'schedule' | 'manual') {
  if (advisorBg) return 'The advisor is already researching in the background.'
  if (!advisorAgent) return 'The advisor agent is not registered in this session.'
  const runId = await claimRun($, trigger, trigger === 'manual')
  if (!runId) return 'A research run is already in progress (or not due).'
  let agentId = ''
  let deny = ''
  try {
    const r = await $.agent.spawn({ subagentType: advisorAgent, description: 'Usage advisor research', prompt: `Run the advisor workflow now. Run id: ${runId}.`, model: cfg.advisorModel })
    if ('deny' in r && typeof r.deny === 'string') deny = r.deny
    else agentId = (r as { agentId?: string }).agentId ?? ''
  } catch (err) {
    deny = String(err)
  }
  if (deny) {
    await advise($, ['fail', runId, deny])
    return `Could not start the advisor: ${deny}`
  }
  advisorBg = { agentId, runId }
  advisorRun = runId
  advisorRecorded = 0
  return `The advisor is researching your usage in the background (${cfg.advisorModel}); you'll get a toast when its recommendations are in.`
}

/** Toasts each applied recommendation whose measured verdict changed. */
async function notifyVerdicts($: EngineInterface) {
  if (!cfg.advisorNotify) return
  const r = await advise($, ['notify'], 300_000)
  let changed: { id: string; title: string; status: string; verdict: string; grade?: string; diff?: number; sideEffects: string[] }[] = []
  try {
    changed = JSON.parse(r.text)
  } catch {
    return
  }
  const word: Record<string, string> = { improved: 'helped', regressed: 'made it worse', tradeoff: 'helped, at a cost', no_effect: 'made no measurable difference', changed: 'changed the metric' }
  for (const c of changed.slice(0, 3)) {
    const pct = typeof c.diff === 'number' ? ` (${c.diff > 0 ? '+' : ''}${Math.round(c.diff * 100)}%)` : ''
    const worse = c.sideEffects.length ? `; worse: ${c.sideEffects.join(', ')}` : ''
    const grade = c.grade ? ` [evidence ${c.grade}]` : ''
    const next =
      c.status !== 'trial' ? '/dashboard advisor'
      : c.verdict === 'improved' ? `adopt with /analytics advise applied ${c.id}`
      : c.verdict === 'regressed' || c.verdict === 'no_effect' ? `stop with /analytics advise dismiss ${c.id}`
      : '/dashboard advisor'
    $.ui.toast(`Advisor${c.status === 'trial' ? ' trial' : ''}: "${c.title}" ${word[c.verdict] ?? c.verdict}${pct}${worse}${grade}. ${next}`)
  }
}

async function registerAdvisor($: EngineInterface) {
  for (const t of ADVISOR_TOOLS) advisorTools.set((await $.tool.register(t)).tool, t.name)
  const names = [...advisorTools.keys()]
  advisorAgent = (await $.agent.register({
    name: 'advisor',
    description: 'Researches this machine\'s Claude usage and current guidance on the web, and records recommendations (started by usage-analytics).',
    prompt: ADVISOR_PROMPT,
    tools: ['WebSearch', 'WebFetch', 'ToolSearch', ...names],
    model: cfg.advisorModel,
    // In the background nobody answers a permission prompt: what is not pre-approved is refused instead.
    permissionMode: 'dontAsk',
    omitClaudeMd: true,
    maxTurns: 60,
  })).agent
}

/** Serves the advisor's tools by running the CLI on the shared data folder. */
async function advisorTool($: EngineInterface, name: string, input: Record<string, unknown>) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  switch (name) {
    case 'advisor_brief': {
      const args = ['brief', '--ingest', '--days', String(typeof input.days === 'number' ? input.days : 30)]
      if (str('profile')) args.push('--profile', str('profile')!)
      return advise($, args, 600_000)
    }
    case 'advisor_sql':
      return advise($, ['sql', '--', str('query') ?? ''])
    case 'advisor_record': {
      const runId = advisorRun || (await claimRun($, 'manual', true))
      const path = `${root}/advisor-runs/${runId || Date.now()}.json`
      await $.fs.write(path, JSON.stringify(input, null, 2) + '\n')
      const model = advisorBg?.runId === runId ? cfg.advisorModel : 'session'
      const r = await advise($, ['record', path, ...(runId ? ['--run', runId] : []), '--model', model])
      advisorRecorded = (input.recommendations as unknown[] | undefined)?.length ?? 0
      if (advisorBg?.runId !== runId) advisorRun = ''
      return { ok: r.ok, text: `${r.text}\nThe person applies one with /analytics advise apply <id>, marks one done with /analytics advise applied <id>, or dismisses it with /analytics advise dismiss <id>; each applied one is re-measured and its verdict reported.` }
    }
    case 'advisor_set':
      return advise($, ['set', str('id') ?? '', str('status') ?? '', ...(str('note') ? ['--note', str('note')!] : [])])
  }
  return { ok: false, text: `unknown tool ${name}` }
}

async function serveAdvisorTool($: EngineInterface, name: string, e: Record<string, unknown>) {
  // The background agent's id, when its spawn did not say: its first call of these tools carries it.
  if (advisorBg && !advisorBg.agentId && typeof e.agentId === 'string') advisorBg.agentId = e.agentId
  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(e)) if (!RESERVED.has(k)) input[k] = v
  const r = await advisorTool($, name, input).catch((err: unknown) => ({ ok: false, text: String(err) }))
  return { result: r.text, isError: !r.ok } as any
}

/** /analytics advise …: run the research here or in the background, show the state, or move a recommendation. */
async function adviseCommand($: EngineInterface, rest: string[]) {
  const [act, id, ...note] = rest
  const verbs: Record<string, string> = { accept: 'accepted', accepted: 'accepted', trial: 'trial', applied: 'applied', done: 'applied', dismiss: 'dismissed', dismissed: 'dismissed', revert: 'reverted', reverted: 'reverted', reopen: 'proposed' }
  if (!act || act === 'now') {
    const runId = await claimRun($, 'manual', true)
    advisorRun = runId
    const text = `${ADVISOR_PROMPT}\n\nRun the advisor workflow now${runId ? ` (run id ${runId})` : ''}. I'm watching: keep progress notes to a line each. After the list, tell me: /analytics advise apply <id> applies one with my approval, /analytics advise applied <id> marks one I did myself, /analytics advise dismiss <id> drops one; /dashboard advisor shows the trends and verdicts.`
    $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
    return 'Starting the usage advisor…'
  }
  if (act === 'bg' || act === 'background') return adviseInBackground($, 'manual')
  if (act === 'show' || act === 'status') return (await advise($, ['show', '--ingest', ...rest.slice(1)], 600_000)).text
  if (act === 'reproduce' || act === 'check') {
    if (!id) return 'Usage: /analytics advise reproduce <id>'
    return (await advise($, ['reproduce', id], 600_000)).text
  }
  if (act === 'apply') {
    if (!id) return 'Usage: /analytics advise apply <id>'
    const r = await advise($, ['get', id])
    if (!r.ok) return r.text
    const rec = JSON.parse(r.text)
    const text = `Apply usage-advisor recommendation ${rec.id}: "${rec.title}".
Action: ${rec.action}
Expected: ${rec.expected ?? 'n/a'} (metric: ${rec.metric}). Risk: ${rec.risk ?? 'n/a'}.${rec.instruction ? `
This one is a model instruction, so it can run as an A/B trial instead: the mod adds it to a random half of new sessions and compares them with the other half. Offer that as the first option ("Trial it (A/B)": call advisor_set with status "trial"; no file changes).` : ''}
Show me the exact change (file and diff, setting, or command) and ask me with AskUserQuestion before making it. If I approve, make it, then call the advisor_set tool (usage-analytics; load it with ToolSearch) with id ${rec.id}, status "applied" and a one-line note of what changed: that starts measuring its effect. If I decline, call it with status "dismissed" and my reason as the note.`
    $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
    return `Applying ${rec.id}…`
  }
  if (verbs[act]) {
    if (!id) return `Usage: /analytics advise ${act} <id> [note]`
    return (await advise($, ['set', id, verbs[act]!, ...(note.length ? ['--note', note.join(' ')] : [])])).text
  }
  return 'Usage: /analytics advise [now | bg | show | apply <id> | trial <id> | applied <id> | accept <id> | dismiss <id> [why] | revert <id> | reproduce <id>]'
}

/** The setup wizard: hands the model what to detect, what to ask and where to write the answers. */
export function setupPrompt(pluginRoot: string, dataDir: string, current: Config) {
  const run = `CLAUDE_USAGE_DIR="${dataDir}" python3 "${pluginRoot}/bin/claude-usage"`
  return `Set up the usage-analytics mod with me. Keep it short.

1. Run \`${run} setup --json\` to see what was detected: the Claude config dirs (profiles) with history on disk, what is already in the database, and the dashboard.
2. Ask me with the AskUserQuestion tool, in a single call (recommended option first, my current choice marked "(current)"):
   - "Which profiles should be tracked?" (multiSelect): one option per detected config dir, with its transcript count and how far back it goes. Choosing all of them means auto (an empty "profileDirs", which also picks up new profiles); otherwise "profileDirs" lists the chosen dirs.
   - "Keep the text of your prompts?": "Full text (searchable in the dashboard)" (storePrompts true) or "Length only" (false).
   - "When should the dashboard run?": "With Claude Code (recommended)": started by any session and by /analytics, one per machine (dashboard true); "Also from login": the same, plus a login item (dashboard true and autostart on); "Only when I run /dashboard" (dashboard false).
   Only if the setup output shows the dashboard port is taken by something else, also ask for another port.
3. Write ${dataDir}/config.json: the current config below with only those keys changed (profileDirs, storePrompts, dashboard, port). Keep every other key.
4. Run \`${run} autostart on\` or \`${run} autostart off\` to match the dashboard answer.
5. Unless the answer was "Only when I run /dashboard", run \`${run} serve --daemon --open\`. It imports every transcript already on disk in the background (backfill); the dashboard shows the progress.
6. Tell me in two or three lines what is set, and that /analytics setup runs this again.

Current config (${dataDir}/config.json):
${JSON.stringify(current, null, 2)}`
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
    profile = (configDir || `${home}/.claude`).replace(/\/+$/, '').split('/').pop()!.replace(/^\./, '')
    root = `${await modsHome($)}/usage-analytics`
    sid = null
    trialSid = ''
    trialProject = projectOf(e.cwd, home)
    const firstRun = await loadConfig($)
    // So `claude-usage` finds this profile's transcripts wherever its config dir is, and the login item the newest CLI.
    await $.fs.write(`${root}/profiles/${profile}.json`, JSON.stringify({ profile, configDir: configDir || `${home}/.claude` }) + '\n').catch(() => {})
    await $.fs.write(`${root}/cli-path`, `${$.plugin.root}/bin/claude-usage`).catch(() => {})
    if (firstRun) $.ui.toast('usage-analytics is recording, and importing your past sessions. /dashboard opens it; /analytics setup tailors it.')

    await $.command.register({
      name: 'analytics',
      description: 'Usage analytics across all profiles: setup · dashboard [tab] · advise (research how to use Claude cheaper/faster from your own data, A/B-trial, apply and verify) · impact (are the mods saving money?) · status · ingest · stop · or a report: overview|daily|models|projects|tools|agents|sessions|context|hours [--days N] [--profile P]',
      argumentHint: '[setup | dashboard [tab] | advise [bg|show|apply <id>|trial <id>|applied <id>|dismiss <id>|reproduce <id>] | impact | status | ingest | stop | <report>] [--days N] [--profile P]',
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

    await registerAdvisor($).catch(() => {})
    if (e.isInteractive) {
      $.clock.after(90_000, () => void notifyVerdicts($).catch(() => {}))
      if (cfg.advisorEveryDays > 0) $.clock.after(180_000, () => void adviseInBackground($, 'schedule').catch(() => {}))
    }

    $.clock.every(FLUSH_MS, () => void flush($).catch(() => {}))
    $.clock.after(1500, () => void ensureDashboard($))
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
    if (advisorBg && e.agentId && e.agentId === advisorBg.agentId) {
      const { runId } = advisorBg
      advisorBg = null
      advisorRun = ''
      if (!advisorRecorded) {
        await advise($, ['fail', runId, e.isAborted ? 'aborted' : (e.answer || 'ended without recording').slice(0, 300)]).catch(() => {})
        $.ui.toast('Advisor: the background research ended without recommendations. /analytics advise runs it here.')
      } else {
        $.ui.toast(`Advisor: ${advisorRecorded} new recommendation${advisorRecorded === 1 ? '' : 's'}. /analytics advise show, or /dashboard advisor`)
      }
    }
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
    const advisor = advisorTools.get(e.tool)
    // The advisor's own tools are answered here: no permission prompt, the mod serves them itself.
    const r = advisor ? await serveAdvisorTool($, advisor, e) : await next(e)
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
    let r = await next(e)
    // An advisor trial's instruction, in the sessions its A/B draw put in the 'on' arm.
    const extra = e.traits.includes('analysis') ? '' : await trialInstructions($).catch(() => '')
    if (extra) r = { ...r, sections: [...r.sections, { id: 'usage-analytics:advisor', text: extra, scope: 'session' as const }] }
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

  // Only the mod starts the advisor agent; the model is not offered it.
  on('agent.offer', async ($, e, next) => (advisorAgent && e.agent === advisorAgent ? { isOffered: false } : next(e)))

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
    const r = await cli($, args, timeoutMs)
    return (r.stdout || r.stderr || `claude-usage exited ${r.exitCode}`).trimEnd()
  }
  if (sub !== 'dashboard' && sub !== 'stop' && sub !== 'setup') void ensureDashboard($)
  switch (sub) {
    case 'setup': {
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      const text = setupPrompt($.plugin.root, root, cfg)
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return 'Starting the usage-analytics setup…'
    }
    // The dashboard runs detached on 127.0.0.1 and outlives the session; a second call just opens it.
    case 'dashboard': {
      const tab = rest[0] && !rest[0].startsWith('-') ? rest.shift()! : undefined
      if (tab && !TABS.includes(tab)) return `Unknown tab "${tab}". Tabs: ${TABS.join(', ')}`
      return run(['serve', '--daemon', '--open', ...(tab ? ['--tab', tab] : []), ...rest], 30_000)
    }
    case 'advise': return adviseCommand($, rest)
    case 'impact': return run(['impact', '--ingest', ...rest], 600_000)
    case 'status': return run(['status'], 30_000)
    case 'ingest': return (await run(['ingest', ...rest], 600_000)) || 'ingested'
    case 'stop': return run(['stop'], 30_000)
    default: return run(['report', '--ingest', ...(sub ? [sub] : []), ...rest], 600_000)
  }
}
