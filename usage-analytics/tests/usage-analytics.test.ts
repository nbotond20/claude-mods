import { describe, expect, test } from 'claude-code/testing'
import { setupPrompt } from '../hooks/register'

function engine(on: any, env: Record<string, string>, runs: string[][] = [], toasts: string[] = []) {
  const files = new Map<string, string>()
  let now = 1_760_000_000_000
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', ($: any, e: any) => ({ value: env[e.name] }))
  on('clock.now', () => ({ value: (now += 10) }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: '2.1.296' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 1 } }))
  on('settings.read', () => ({ value: { model: 'claude-opus-5-5', enabledPlugins: { 'a@b': true, 'c@d': false } } }))
  on('process.run', ($: any, e: any) => (runs.push([...e.argv, `env:${JSON.stringify(e.init?.env ?? {})}`]), { value: { exitCode: 0, stdout: 'ok', stderr: '' } }))
  on('fs.exists', ($: any, e: any) => ({ value: [...files.keys()].some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
  on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('agent.list', () => ({ value: [] }))
  on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('tool.call', () => ({ result: 'a\nb\nc', text: 'a\nb\nc' }) as any)
  return files
}

const ENV = {
  HOME: '/h',
  CLAUDE_CONFIG_DIR: '/h/.claude-infi',
  ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1',
  ANTHROPIC_AUTH_TOKEN: 'sk-secret-value',
}

describe('usage-analytics', () => {
  test('records the session and tool calls per profile, never a secret', async ($, on) => {
    const toasts: string[] = []
    const files = engine(on, ENV, [], toasts)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/work/src/a.ts' } as any)
    await $.session.end({ reason: 'exit', sessionId: 'sess-1' } as any)

    const chunks = [...files.entries()].filter(([p]) => p.includes('/events/')).sort(([a], [b]) => (a < b ? -1 : 1))
    expect(chunks.length).toBeGreaterThan(0)
    const text = chunks.map(([, t]) => t).join('')
    for (const [path] of chunks) expect(path).toMatch(/^\/h\/\.claude-mods\/usage-analytics\/events\/claude-infi\/\d{4}-\d\d-\d\d\/sess-1\./)
    const evs = text.trim().split('\n').map(l => JSON.parse(l))
    expect(evs.map(e => e.ev)).toEqual(['session_start', 'tool', 'session_end'])
    expect(evs[0].gatewayHost).toBe('gateway.example.com')
    expect(evs[0].hasAuthToken).toBe(true)
    expect(evs[0].settings.plugins).toEqual(['a@b'])
    expect(evs[1]).toMatchObject({ tool: 'Read', file: '/work/src/a.ts', ext: 'ts', resultChars: 5, resultLines: 3, profile: 'claude-infi' })
    expect(text.includes('sk-secret-value')).toBe(false)
    // A fresh machine: the generic data folder, the config written with defaults, one first-run notice.
    expect(JSON.parse(files.get('/h/.claude-mods/usage-analytics/config.json')!)).toMatchObject({ dashboard: true, port: 8787, profileDirs: [] })
    expect(toasts.filter(t => /analytics setup/.test(t)).length).toBe(1)
    // The profile's config dir is registered so the CLI finds its transcripts wherever it lives.
    expect(JSON.parse(files.get('/h/.claude-mods/usage-analytics/profiles/claude-infi.json')!)).toEqual({ profile: 'claude-infi', configDir: '/h/.claude-infi' })
    // The live pulse the dashboard server watches.
    expect(JSON.parse(files.get('/h/.claude-mods/usage-analytics/live/claude-infi.json')!)).toMatchObject({ profile: 'claude-infi', sid: 'sess-1' })
  })

  test('uses an existing ~/.claude-shared, or CLAUDE_MODS_HOME, and passes the folder to the CLI', async ($, on) => {
    const runs: string[][] = []
    const toasts: string[] = []
    const files = engine(on, { ...ENV, CLAUDE_CONFIG_DIR: '', HOME: '/h' }, runs, toasts)
    files.set('/h/.claude-shared/usage-analytics/config.json', JSON.stringify({ storePrompts: false }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    expect(toasts.length).toBe(0)
    // Old configs gain the new keys, keeping their own values.
    expect(JSON.parse(files.get('/h/.claude-shared/usage-analytics/config.json')!)).toMatchObject({ storePrompts: false, port: 8787 })
    expect(files.has('/h/.claude-shared/usage-analytics/profiles/claude.json')).toBe(true)
    await $.command.run({ command: 'analytics', args: 'status', origin: { kind: 'user' }, presentation: 'text' } as any)
    expect(runs.find(r => r[2] === 'status')!.at(-1)).toBe('env:{"CLAUDE_USAGE_DIR":"/h/.claude-shared/usage-analytics"}')
  })

  test('/analytics setup hands the wizard to the model with the detect command and the config path', async ($, on) => {
    engine(on, { ...ENV, CLAUDE_MODS_HOME: '/data/mods/' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const r: any = await $.command.run({ command: 'analytics', args: 'setup', origin: { kind: 'user' }, presentation: 'text' } as any)
    expect(r.text).toMatch(/setup/)
    const text = setupPrompt('/p', '/data/mods/usage-analytics', { dashboard: true } as any)
    expect(text).toContain('CLAUDE_USAGE_DIR="/data/mods/usage-analytics" python3 "/p/bin/claude-usage" setup --json')
    expect(text).toContain('/data/mods/usage-analytics/config.json')
    expect(text).toContain('AskUserQuestion')
  })

  test('/dashboard and /analytics run the right claude-usage commands', async ($, on) => {
    const runs: string[][] = []
    engine(on, ENV, runs)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const cmd = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'user' }, presentation: 'text' } as any)
    const tail = () => runs[runs.length - 1].slice(2, -1)
    await cmd('dashboard', 'impact')
    expect(tail()).toEqual(['serve', '--daemon', '--open', '--tab', 'impact'])
    const bad = await cmd('dashboard', 'nope')
    expect(String((bad as any).text)).toMatch(/Unknown tab/)
    await cmd('analytics', 'impact --days 7')
    expect(tail()).toEqual(['impact', '--ingest', '--days', '7'])
    // Any other /analytics command also makes sure the one dashboard server is running.
    expect(runs.some(r => r.slice(2, -1).join(' ') === 'serve --daemon --quiet')).toBe(true)
    await cmd('analytics', 'stop')
    expect(tail()).toEqual(['stop'])
    await cmd('analytics', 'tools --days 3')
    expect(tail()).toEqual(['report', '--ingest', 'tools', '--days', '3'])
  })

  test('blanks secrets in commands and output before writing them', async ($, on) => {
    const files = engine(on, ENV)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const secrets = ['sk-ant-api03-abcdefghijklmnopqrstuvwx', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'hunter2-very-secret', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz', 'cfsecret0123456789']
    const command = `curl -H "Authorization: Bearer ${secrets[0]}" -H "CF-Access-Client-Secret: ${secrets[4]}" https://x && GH_TOKEN=${secrets[1]} gh api && mysql --password=${secrets[2]} && echo ${secrets[3]}`
    await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command } as any)
    await $.session.end({ sessionId: 'sess-1', reason: 'exit' } as any)
    const text = [...files.entries()].filter(([p]) => p.includes('/events/')).map(([, t]) => t).join('')
    for (const s of secrets) expect(text.includes(s)).toBe(false)
    expect(text).toContain('[REDACTED]')
    expect(text).toContain('curl -H')
    for (const line of text.trim().split('\n')) JSON.parse(line)
  })
})
