import { describe, expect, test } from 'claude-code/testing'

const CONFIG = '/h/.claude-shared/lsp-first/config.json'

function engine(on: any, holdout = 0) {
  const files = new Map<string, string>([[CONFIG, JSON.stringify({ holdout })]])
  on('clock.now', () => ({ value: 1_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : e.name === 'CLAUDE_CONFIG_DIR' ? '/h/.claude-my' : undefined }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.exists', ($: any, e: any) => ({ value: [...files.keys()].some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
  on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('tool.describe', ($: any, e: any) => ({ description: e.description, isDeferred: e.isDeferred }))
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' }] }))
  on('tool.call', () => ({ result: 'src/a.ts:3: export function makeThing', text: 'src/a.ts:3: export function makeThing' }) as any)
  return files
}

const events = (files: Map<string, string>) =>
  [...files.entries()]
    .filter(([p]) => p.includes('/usage-analytics/events/'))
    .flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))

describe('lsp-first', () => {
  test('LSP is listed up front, not behind ToolSearch', async ($, on) => {
    engine(on)
    const r = await $.tool.describe({ tool: 'LSP', description: 'lsp', isDeferred: true, provider: { plugin: 'engine', tier: 'core' } } as any)
    expect(r.isDeferred).toBe(false)
  })

  test('the guide joins the system prompt when the LSP tool is present', async ($, on) => {
    engine(on)
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', outputStyle: null, surfaces: ['terminal'], sections: [], tools: ['Bash', 'LSP'], traits: [] } as any)
    expect(r.sections.map(s => s.id)).toEqual(['core', 'lsp-first:guide'])
    const none = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', outputStyle: null, surfaces: ['terminal'], sections: [], tools: ['Bash'], traits: [] } as any)
    expect(none.sections.map(s => s.id)).toEqual(['core'])
  })

  test('a grep for a symbol in TS gets one nudge, a text search none', async ($, on) => {
    engine(on)
    const call = (command: string) => $.tool.call({ tool: 'Bash', tool_use_id: 'x', command } as any)
    const text = await call(`rg "connection refused" -g '*.ts'`)
    expect(text.context).toBeUndefined()
    const sym = await call(`rg -n '\\bmakeThing\\b' --type ts src`)
    expect(String(sym.context?.[0])).toMatch(/symbol "makeThing".*workspaceSymbol/)
    const again = await call(`grep -rn makeThing src/*.ts`)
    expect(again.context).toBeUndefined()
  })

  test('logs searches, the nudge and whether LSP followed', async ($, on) => {
    const files = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: `rg -n makeThing --type ts src` } as any)
    await $.tool.call({ tool: 'LSP', tool_use_id: 'b', operation: 'workspaceSymbol', query: 'makeThing' } as any)
    await $.session.end({ sessionId: 'sess-1', reason: 'exit' } as any)
    const ev = events(files)
    expect(ev.find(x => x.kind === 'arm')).toMatchObject({ mod: 'lsp-first', arm: 'on', profile: 'claude-my' })
    expect(ev.find(x => x.kind === 'symbol_search')?.symbol).toBe('makeThing')
    expect(ev.find(x => x.kind === 'nudge_outcome')).toMatchObject({ followed: 1 })
    expect(ev.find(x => x.kind === 'lsp_call')?.op).toBe('workspaceSymbol')
  })

  test('in the holdout LSP stays deferred and nothing is added', async ($, on) => {
    const files = engine(on, 1)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const d = await $.tool.describe({ tool: 'LSP', description: 'lsp', isDeferred: true, provider: { plugin: 'engine', tier: 'core' } } as any)
    expect(d.isDeferred).toBe(true)
    const sym = await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: `rg -n makeThing --type ts src` } as any)
    expect(sym.context).toBeUndefined()
    await $.session.end({ sessionId: 'sess-1', reason: 'exit' } as any)
    expect(events(files).some(x => x.kind === 'would_nudge' && x.arm === 'holdout')).toBe(true)
  })

  test('/lsp-first off session steps aside until /lsp-first on', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const compose = () => $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', outputStyle: null, surfaces: ['terminal'], sections: [], tools: ['Bash', 'LSP'], traits: [] } as any)
    const cmd = (args: string) => $.command.run({ command: 'lsp-first', args, origin: { kind: 'user' }, presentation: 'text' } as any) as any
    expect((await cmd('off session')).text).toMatch(/paused for this session/)
    expect((await compose()).sections.map(s => s.id)).toEqual(['core'])
    await cmd('on')
    expect((await compose()).sections.map(s => s.id)).toEqual(['core', 'lsp-first:guide'])
  })
})
