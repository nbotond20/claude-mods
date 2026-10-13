import { describe, expect, test } from 'claude-code/testing'

const QUICK = 'quick question, explanation, lookup, or a tiny one-file edit'
const TRIVIAL = 'trivial: a greeting, a yes/no, run or start a command or server, open a file or URL, a one-line factual answer'
const usage = { input_tokens: 10, output_tokens: 2_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 20_000 }

// What the engine answers beneath the plugin in every test.
function engine(on: any, extra: { classify?: string; agents?: any[]; holdout?: number; env?: Record<string, string>; now?: number } = {}) {
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', ($: any, e: any) => ({ value: extra.env?.[e.name] }))
  on('clock.now', () => ({ value: extra.now ?? 1_000_000 }))
  on('classic.Stop', () => ({}))
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('model.classify', () => ({ value: extra.classify }))
  on('agent.list', () => ({ value: extra.agents ?? [] }))
  // An in-memory disk and store.
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  on('session.id', () => ({ value: 's1' }))
  on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.exists', ($: any, e: any) => ({ value: [...files.keys()].some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
  on('fs.list', ($: any, e: any) => ({
    value: [...files.keys()].filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1 })),
  }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  if (extra.holdout !== undefined) files.set('/.claude-shared/budget-guard/config.json', JSON.stringify({ holdout: extra.holdout }))
  return files
}

const measure = ($: any, tokens: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }, rateLimits: [], changed: ['context'] })

async function step($: any, input: any) {
  const s = $.turn.step({ turnId: 't1', index: 0, messageCount: 1, ...input })
  for await (const _ of s) {
    // drain
  }
  return s.result
}

describe('budget-guard', () => {
  test('caps subagents and blocks image and generated-file reads', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: 'ran', text: 'ran' }) as any)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)

    const agent = () => $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x' } as any)
    for (let i = 0; i < 3; i++) expect((await agent()).deny).toBeUndefined()
    const fourth = await agent()
    expect(String(fourth.deny ?? fourth.text)).toMatch(/subagent budget used \(3\/3\)/)

    const png = await $.tool.call({ tool: 'Read', file_path: '/work/shot.png' } as any)
    expect(String(png.deny ?? png.text)).toMatch(/reading images is off/)
    const lock = await $.tool.call({ tool: 'Read', file_path: '/work/package-lock.json' } as any)
    expect(String(lock.deny ?? lock.text)).toMatch(/generated/)
    const src = await $.tool.call({ tool: 'Read', file_path: '/work/src/app.ts' } as any)
    expect(src.deny).toBeUndefined()
  })

  test('holds prompts once the context passes the hold limit', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await measure($, 320_000)
    const held = await $.prompt.submit({ text: 'do more', wait: false, origin: { kind: 'composer' } } as any)
    expect((held as any).drop).toMatch(/context is 320k/)
    const forced = await $.prompt.submit({ text: 'force: do more', wait: false, origin: { kind: 'composer' } } as any)
    expect((forced as any).text).toBe('do more')
  })

  test('a quick first prompt routes the session to Sonnet 5.5 at low effort and counts the saving', async ($, on) => {
    engine(on, { classify: QUICK })
    let sent: any
    on('turn.step', async function* ($: any, e: any) {
      sent = e
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'what does the --frozen-lockfile flag do?', wait: false, origin: { kind: 'composer' } } as any)
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-sonnet-5-5')
    expect(sent.effort).toBe('low')

    await measure($, 50_000)
    const out = await $.command.run({ command: 'budget', args: '' } as any)
    expect(String(out.text)).toMatch(/route quick → sonnet 5\.5 · low/)
    expect(String(out.text)).toMatch(/saved this session ~\$0\.0[1-9]/)
  })

  test('a trivial first prompt runs on Haiku 5.5; a real follow-up moves it up, /budget route haiku pins it', async ($, on) => {
    engine(on, { classify: TRIVIAL })
    let sent: any
    on('turn.step', async function* ($: any, e: any) {
      sent = e
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
    await say('start docs and storybook')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-haiku-5-5')
    expect(sent.effort).toBe('low')
    await measure($, 20_000)

    await say('open the tree stories')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-haiku-5-5')

    await say('fix the tree indentation')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-opus-5-5')

    await $.command.run({ command: 'budget', args: 'route haiku' } as any)
    await say('now do the same for the list')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-haiku-5-5')
  })

  test('a quick session that turns to implementation moves to Opus without a classifier call; questions and pins stay', async ($, on) => {
    const files = engine(on, { classify: QUICK, holdout: 0 })
    on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
    let sent: any
    on('turn.step', async function* ($: any, e: any) {
      sent = e
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const say = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as any)
    await say('why does the login page flash on load?')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-sonnet-5-5')
    await measure($, 30_000)

    await say('how would you fix it?')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-sonnet-5-5')

    await say('ok, implement that')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-opus-5-5')
    expect(sent.effort).toBe('medium')

    await $.command.run({ command: 'budget', args: 'route sonnet' } as any)
    await say('now add a test for it')
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.model).toBe('claude-sonnet-5-5')

    await $.session.end({ sessionId: 's1', reason: 'exit' } as any)
    const ev = [...files.entries()].filter(([f]) => f.includes('/usage-analytics/events/')).flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))
    expect(ev.filter(x => x.kind === 'classify')).toHaveLength(1)
    expect(ev.find(x => x.kind === 'reroute')).toMatchObject({ from: 'claude-sonnet-5-5', model: 'claude-opus-5-5' })
  })

  test('Opus never runs above medium effort, on the main loop or in subagents', async ($, on) => {
    engine(on, { agents: [{ id: 'a2', type: 'fork', description: 'x', status: 'running' }] })
    const sent: any[] = []
    on('turn.step', async function* ($: any, e: any) {
      sent.push({ model: e.model, effort: e.effort, agentId: e.agentId })
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.command.run({ command: 'budget', args: 'route off' } as any)
    await step($, { model: 'claude-opus-5-5', effort: 'max' })
    await step($, { model: 'claude-opus-5-5', effort: 'low' })
    await step($, { model: 'claude-opus-5-5' })
    await step($, { model: 'claude-sonnet-5-5', effort: 'high' })
    await step($, { model: 'claude-opus-5-5', effort: 'xhigh', agentId: 'a2' })
    expect(sent.map(s => s.effort)).toEqual(['medium', 'low', 'medium', 'high', 'medium'])

    await $.command.run({ command: 'budget', args: 'route opus' } as any)
    const out = await $.command.run({ command: 'budget', args: '' } as any)
    expect(String(out.text)).toMatch(/route hard → opus 5\.5 · medium/)
  })

  test('Explore subagents run on Haiku 5.5, forks keep their model', async ($, on) => {
    engine(on, {
      agents: [
        { id: 'a1', type: 'Explore', description: 'x', status: 'running' },
        { id: 'a2', type: 'fork', description: 'x', status: 'running' },
        { id: 'a3', type: 'general-purpose', description: 'x', status: 'running' },
      ],
    })
    const seen: Record<string, string> = {}
    on('turn.step', async function* ($: any, e: any) {
      seen[e.agentId] = e.model
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await step($, { model: 'claude-sonnet-5-5', agentId: 'a1' })
    await step($, { model: 'claude-opus-5-5', agentId: 'a2' })
    await step($, { model: 'claude-opus-5-5', agentId: 'a3' })
    expect(seen).toEqual({ a1: 'claude-haiku-5-5', a2: 'claude-opus-5-5', a3: 'claude-sonnet-5-5' })
  })

  test('noisy commands keep only their tail; others run untouched', async ($, on) => {
    engine(on)
    const commands: string[] = []
    on('tool.call', ($: any, e: any) => {
      commands.push(e.command)
      return { result: { stdout: '[budget-guard: kept 9000 of 409000 bytes (last 300 lines); full log: /tmp/x]' } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)
    await $.tool.call({ tool: 'Bash', command: 'npm test | grep FAIL' } as any)
    await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
    expect(commands[0]).toMatch(/tail -n 300/)
    expect(commands[0]).toMatch(/\{ npm test\n\}/)
    expect(commands[1]).toBe('npm test | grep FAIL')
    expect(commands[2]).toBe('git status')
  })

  test('a turn that ends over compactAt is compacted, and auto-compact is kept on', async ($, on) => {
    engine(on, { holdout: 1 })
    const set: any[] = []
    on('config.list', () => ({ value: [{ key: 'autoCompact', label: 'Auto-compact', kind: 'toggle', value: false, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }))
    on('config.set', ($: any, e: any) => (set.push(e), { value: e.value }))
    let tokens = 150_000
    on('session.usage', () => ({ value: { context: { tokens, window: 1_000_000 } } }))
    on('turn.complete', () => ({ text: '' }))
    let compactions = 0
    on('session.compact', () => (compactions++, (tokens = 30_000), { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 210_000, tokensAfter: 30_000 }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    expect(set).toMatchObject([{ key: 'autoCompact', value: true }])

    const done = () => $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as any)
    await done()
    expect(compactions).toBe(0)
    tokens = 210_000
    await done()
    expect(compactions).toBe(1)

    await $.command.run({ command: 'budget', args: 'compact off' } as any)
    tokens = 210_000
    await done()
    expect(compactions).toBe(1)
  })

  test('a new task over a big context is held with clear / compact / keep', async ($, on) => {
    engine(on, { classify: 'an unrelated new task' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await measure($, 10_000)
    await $.prompt.submit({ text: 'add validation to the signup form fields', wait: false, origin: { kind: 'composer' } } as any)
    await measure($, 120_000)
    const held = await $.prompt.submit({ text: 'write a migration script for the billing tables', wait: false, origin: { kind: 'composer' } } as any)
    expect((held as any).drop).toMatch(/looks like a new task with 120k/)

    const ui = await $.ui.mount({
      plugin: 'budget-guard',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    } as any)
    expect(await ui.find({ type: 'Button', key: 'clear' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'keep' })).toBeDefined()
    await ui.unmount()
  })

  test('the band shows model, cost, context, plan limits and running agents', async ($, on) => {
    engine(on, { agents: [{ id: 'a1', type: 'Explore', description: 'find the auth code', status: 'running' }] })
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('turn.step', async function* ($: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.session.measure({
      context: { tokens: 160_000, window: 1_000_000, percent: 16 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 41 }, { kind: 'seven_day', percentUsed: 12 }],
      cost: { usd: 3.2 },
      changed: ['context', 'cost', 'rateLimits'],
    } as any)
    await step($, { model: 'claude-sonnet-5-5', agentId: 'a1' })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' }] } as any)

    const ui = await $.ui.mount({
      plugin: 'budget-guard',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 },
    } as any)
    expect(await ui.find({ type: 'Text', text: /◆ opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /≈\$3\.20/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h 41%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /160k ctx/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /haiku 5\.5 find the auth code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm run dev/ })).toBeDefined()
    await ui.unmount()
  })

  test('daily and monthly limits show as gauges and never block', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.session.measure({ context: { tokens: 40_000, window: 1_000_000, percent: 4 }, rateLimits: [], cost: { usd: 8.5 }, changed: ['context', 'cost'] } as any)
    await $.command.run({ command: 'budget', args: 'daily 10' } as any)
    const out = await $.command.run({ command: 'budget', args: 'monthly $200' } as any)
    expect(String(out.text)).toMatch(/limits today \$8\.50 of \$10 \(85%\)\s+month \$8\.50 of \$200 \(4%\)/)

    const ui = await $.ui.mount({
      plugin: 'budget-guard',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 },
    } as any)
    expect(await ui.find({ type: 'Text', text: /day \$8\.50\/\$10 85%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /month \$8\.50\/\$200 4%/ })).toBeDefined()
    await ui.unmount()

    const sent = await $.prompt.submit({ text: 'keep going', wait: false, origin: { kind: 'composer' } } as any)
    expect((sent as any).drop).toBeUndefined()
  })

  test('on a LiteLLM gateway the band shows the last 24 hours and 7 days', async ($, on) => {
    const now = Date.parse('2026-10-13T12:00:00')
    const files = engine(on, { now, env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com', ANTHROPIC_AUTH_TOKEN: 'test-token' } })
    const byDay: Record<string, number> = { '2026-10-13': 2, '2026-10-12': 4, '2026-10-08': 10, '2026-10-05': 100 }
    on('http.fetch', ($: any, e: any) => ({
      value: String(e.url).includes('/key/info')
        ? { ok: true, status: 200, text: JSON.stringify({ info: { spend: 57.5 } }) }
        : { ok: true, status: 200, text: JSON.stringify({ results: Object.entries(byDay).map(([date, spend]) => ({ date, metrics: { spend } })) }) },
    }))
    const band = async () => {
      const ui = await $.ui.mount({
        plugin: 'budget-guard',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 },
      } as any)
      const text = String((await ui.find({ type: 'Text', text: /LiteLLM/ }))?.text ?? '')
      await ui.unmount()
      return text
    }
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.session.measure({ context: { tokens: 40_000, window: 1_000_000, percent: 4 }, rateLimits: [], cost: { usd: 1 }, changed: ['context', 'cost'] } as any)
    await $.command.run({ command: 'budget', args: 'refresh' } as any)
    // As LiteLLM's UI counts them: 24h is yesterday, 7d the six days before today; today (not synced yet) and 10-05 are out.
    expect(await band()).toMatch(/24h \$4\.00 · 7d \$14\b/)

    // The figures a real LiteLLM UI showed for these days: $46.50 last 24 hours, $122.46 last 7 days.
    Object.assign(byDay, { '2026-10-06': 92.75, '2026-10-07': 19.01, '2026-10-08': 46.84, '2026-10-09': 10.07, '2026-10-10': 0.03, '2026-10-11': 0.01, '2026-10-12': 46.5, '2026-10-13': 1.16 })
    delete byDay['2026-10-05']
    await $.command.run({ command: 'budget', args: 'refresh' } as any)
    expect(await band()).toMatch(/24h \$47 · 7d \$122\b/)
    expect([...files.keys()].some(k => k.includes('key-history'))).toBe(false)
  })

  test('in the holdout the cost levers are off (the effort cap stays) and every action is logged for comparison', async ($, on) => {
    const files = engine(on, { holdout: 1, classify: QUICK })
    on('tool.call', () => ({ result: 'ran', text: 'ran' }) as any)
    on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
    const sent: any[] = []
    on('turn.step', async function* ($: any, e: any) {
      sent.push(e)
      return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'what does this function do?', origin: { kind: 'composer' } } as any)
    await step($, { model: 'claude-opus-5-5', effort: 'high' })
    expect(sent.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
    const lock = await $.tool.call({ tool: 'Read', file_path: '/work/package-lock.json' } as any)
    expect(lock.deny).toBeUndefined()
    await $.session.end({ sessionId: 's1', reason: 'exit' } as any)
    const ev = [...files.entries()].filter(([p]) => p.includes('/usage-analytics/events/')).flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))
    expect(ev.find(x => x.kind === 'arm')).toMatchObject({ mod: 'budget-guard', arm: 'holdout' })
    expect(ev.some(x => x.kind === 'would_deny' && x.what === 'generated')).toBe(true)
    expect(ev.some(x => x.kind === 'route')).toBe(false)
  })

  test('the active arm logs routing, its classifier call and denials', async ($, on) => {
    const files = engine(on, { holdout: 0, classify: QUICK })
    on('tool.call', () => ({ result: 'ran', text: 'ran' }) as any)
    on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.prompt.submit({ text: 'what does this function do?', origin: { kind: 'composer' } } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/shot.png' } as any)
    await $.session.end({ sessionId: 's1', reason: 'exit' } as any)
    const ev = [...files.entries()].filter(([p]) => p.includes('/usage-analytics/events/')).flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))
    expect(ev.find(x => x.kind === 'route')).toMatchObject({ tier: 'quick', model: 'claude-sonnet-5-5', arm: 'on' })
    expect(ev.find(x => x.kind === 'classify')).toMatchObject({ purpose: 'route' })
    expect(ev.find(x => x.kind === 'deny')?.what).toBe('image')
    expect(ev.some(x => x.kind === 'session_summary')).toBe(true)
  })

  test('/budget pause lets Opus effort through and turns routing off; resume puts the limits back', async ($, on) => {
    engine(on)
    const sent: any[] = []
    on('turn.step', async function* ($: any, e: any) {
      sent.push(e.effort)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const before = String((await $.command.run({ command: 'budget', args: '' } as any)).text)
    expect(before).toMatch(/route (decides|off|quick|normal|hard)/)
    expect(String((await $.command.run({ command: 'budget', args: 'pause 1h' } as any)).text)).toMatch(/paused until/)
    await step($, { model: 'claude-opus-5-5', effort: 'max' })
    const paused = String((await $.command.run({ command: 'budget', args: '' } as any)).text)
    expect(paused).toMatch(/PAUSED until/)
    expect(paused).toMatch(/route off/)
    await $.command.run({ command: 'budget', args: 'resume' } as any)
    await step($, { model: 'claude-opus-5-5', effort: 'max' })
    expect(sent).toEqual(['max', 'medium'])
    const after = String((await $.command.run({ command: 'budget', args: '' } as any)).text)
    expect(after).not.toMatch(/PAUSED/)
    expect(after.split('\n')[2]).toBe(before.split('\n')[2])
  })
})
