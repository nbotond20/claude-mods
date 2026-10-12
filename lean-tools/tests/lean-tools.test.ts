import { describe, expect, test } from 'claude-code/testing'

const CONFIG = '/h/.claude-shared/lean-tools/config.json'

function engine(on: any, seen: { command?: string }, holdout = 0) {
  const files = new Map<string, string>([['/w/big.ts', 'x'], [CONFIG, JSON.stringify({ holdout })]])
  let now = 1_000_000_000
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : e.name === 'CLAUDE_CONFIG_DIR' ? '/h/.claude-db' : undefined }))
  on('clock.now', () => ({ value: (now += 1000) }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: [...files.keys()].some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
  on('fs.list', ($: any, e: any) => {
    const kids = new Map<string, string>()
    for (const f of files.keys()) if (f.startsWith(`${e.path}/`)) {
      const [name, ...rest] = f.slice(e.path.length + 1).split('/')
      kids.set(name!, rest.length ? 'dir' : 'file')
    }
    return { value: [...kids].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: Date.now(), isLink: false })) }
  })
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'Bash') seen.command = e.command
    const text = e.tool === 'Read' ? 'y'.repeat(e.limit ? 100 : 50_000) : 'ok'
    return { result: text, text }
  })
  return files
}

/** Every logged mod event, from the event files written so far. */
const events = (files: Map<string, string>) =>
  [...files.entries()]
    .filter(([p]) => p.includes('/usage-analytics/events/'))
    .flatMap(([, t]) => t.trim().split('\n').map(l => JSON.parse(l)))

describe('lean-tools', () => {
  test('caps shell output, leaves bounded commands, bounds git log', async ($, on) => {
    const seen: { command?: string } = {}
    engine(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: 'find . -name "*.ts"' } as any)
    expect(seen.command).toMatch(/lean-tools: output was/)
    await $.tool.call({ tool: 'Bash', tool_use_id: '2', command: 'sed -n 1,40p src/a.ts' } as any)
    expect(seen.command).toBe('sed -n 1,40p src/a.ts')
    await $.tool.call({ tool: 'Bash', tool_use_id: '3', command: 'git log --oneline' } as any)
    expect(seen.command).toMatch(/git log -n 30 --oneline/)
  })

  test('nudges a big whole-file read once, then a re-read, not a ranged read', async ($, on) => {
    engine(on, {})
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const first = await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/w/a.ts' } as any)
    expect(String(first.context?.[0])).toMatch(/offset\/limit/)
    const again = await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/w/a.ts' } as any)
    expect(String(again.context?.[0])).toMatch(/already read whole/)
    const ranged = await $.tool.call({ tool: 'Read', tool_use_id: 'r3', file_path: '/w/b.ts', offset: 10, limit: 20 } as any)
    expect(ranged.context).toBeUndefined()
  })

  test('a Write over an existing file points at Edit', async ($, on) => {
    engine(on, {})
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const r = await $.tool.call({ tool: 'Write', tool_use_id: 'w1', file_path: '/w/big.ts', content: 'z'.repeat(5000) } as any)
    expect(String(r.context?.[0])).toMatch(/use Edit/)
    const fresh = await $.tool.call({ tool: 'Write', tool_use_id: 'w2', file_path: '/w/new.ts', content: 'z'.repeat(5000) } as any)
    expect(fresh.context).toBeUndefined()
  })

  test('logs its arm, nudges and outcomes to the analytics store', async ($, on) => {
    const files = engine(on, {})
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/w/a.ts' } as any)
    for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', tool_use_id: `q${i}`, file_path: `/w/q${i}.ts`, offset: 1, limit: 5 } as any)
    await $.session.end({ sessionId: 'sess-1', reason: 'exit' } as any)
    const ev = events(files)
    expect(ev.every(x => x.ev === 'mod' && x.mod === 'lean-tools' && x.profile === 'claude-db' && x.sid === 'sess-1')).toBe(true)
    expect(ev.find(x => x.kind === 'arm')?.arm).toBe('on')
    expect(ev.find(x => x.kind === 'nudge')?.nudge).toBe('bigread')
    const out = ev.find(x => x.kind === 'nudge_outcome' && x.nudge === 'bigread')
    expect(out).toMatchObject({ followed: 10, total: 10 })
  })

  test('in the holdout it changes nothing and logs what it would have done', async ($, on) => {
    const seen: { command?: string } = {}
    const files = engine(on, seen, 1)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Bash', tool_use_id: '3', command: 'git log --oneline' } as any)
    expect(seen.command).toBe('git log --oneline')
    const r = await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/w/a.ts' } as any)
    expect(r.context).toBeUndefined()
    await $.session.end({ sessionId: 'sess-1', reason: 'exit' } as any)
    const ev = events(files)
    expect(ev.find(x => x.kind === 'arm')?.arm).toBe('holdout')
    expect(ev.some(x => x.kind === 'would_nudge' && x.nudge === 'bigread')).toBe(true)
    expect(ev.some(x => x.kind === 'would_gitlog_bound')).toBe(true)
  })

  test('records itself for /mods, pauses for a while, and resumes', async ($, on) => {
    const seen: { command?: string } = {}
    const files = engine(on, seen)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const entry = JSON.parse(files.get('/h/.claude-shared/mods/installed/claude-db/lean-tools.json')!)
    expect(entry).toMatchObject({ mod: 'lean-tools', profile: 'claude-db', session: 'sess-1', command: 'lean', pausable: true })
    expect(entry.setup).toMatch(/Set up the lean-tools mod/)
    const cmd = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'user' }, presentation: 'text' } as any) as any

    const status = await cmd('mods', 'status')
    expect(status.text).toMatch(/lean-tools .*caps on/)
    expect(status.text).toMatch(/not installed here: budget-guard/)

    expect((await cmd('lean', 'off 1h')).text).toMatch(/paused until/)
    expect(JSON.parse(files.get('/h/.claude-shared/mods/pause.json')!).mods['lean-tools']).toBeGreaterThan(Date.now())
    await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: 'find . -name "*.ts"' } as any)
    expect(seen.command).toBe('find . -name "*.ts"')

    await cmd('lean', 'on')
    await $.tool.call({ tool: 'Bash', tool_use_id: '2', command: 'find . -name "*.ts"' } as any)
    expect(seen.command).toMatch(/lean-tools: output was/)

    expect((await cmd('mods', 'pause 2h')).text).toMatch(/paused until/)
    await $.tool.call({ tool: 'Bash', tool_use_id: '3', command: 'find . -name "*.js"' } as any)
    expect(seen.command).toBe('find . -name "*.js"')
    await cmd('mods', 'resume')
    await $.tool.call({ tool: 'Bash', tool_use_id: '4', command: 'find . -name "*.js"' } as any)
    expect(seen.command).toMatch(/lean-tools: output was/)
  })

  test('one toast for a first run, none the next session', async ($, on) => {
    const toasts: string[] = []
    const files = engine(on, {})
    files.delete(CONFIG)
    on('clock.after', () => ({ value: undefined }))
    on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await new Promise(r => setTimeout(r, 0))
    expect(toasts.join('\n')).toMatch(/Mods on: lean-tools\. \/mods status/)
    toasts.length = 0
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await new Promise(r => setTimeout(r, 0))
    expect(toasts).toEqual([])
  })
})
