import { describe, expect, test } from 'claude-code/testing'
import { DEFAULTS, MARK, planEnv, telemetryEnv } from '../hooks/register'

describe('observability', () => {
  test('the telemetry env points every signal at the local collector, tagged with the profile', () => {
    const env = telemetryEnv(DEFAULTS, 'claude-work')
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:4318')
    expect(env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE).toBe('cumulative')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('claude.profile=claude-work')
    expect(env.BETA_TRACING_ENDPOINT).toBe('http://127.0.0.1:4318')
    expect(env.OTEL_LOG_USER_PROMPTS).toBe('1')
    expect(env.OTEL_LOG_TOOL_CONTENT).toBeUndefined()
    const lean = telemetryEnv({ ...DEFAULTS, content: false, detailedTracing: false, otlpHttpPort: 5318 }, 'claude')
    expect(lean.OTEL_LOG_USER_PROMPTS).toBeUndefined()
    expect(lean.ENABLE_BETA_TRACING_DETAILED).toBeUndefined()
    expect(lean.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:5318')
  })

  test('adds the env next to existing keys, and is a no-op once in place', () => {
    const want = telemetryEnv(DEFAULTS, 'claude')
    const plan = planEnv({ FOO: 'bar' }, want)
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.added).toBe(true)
    expect(plan.env.FOO).toBe('bar')
    expect(plan.env[MARK]).toBe('1')
    expect(planEnv(plan.env, want).action).toBe('none')
  })

  test('turning content off drops only the content keys it wrote', () => {
    const on = planEnv({}, telemetryEnv(DEFAULTS, 'claude'))
    if (on.action !== 'write') throw new Error('expected write')
    const off = planEnv(on.env, telemetryEnv({ ...DEFAULTS, content: false }, 'claude'))
    expect(off.action).toBe('write')
    if (off.action !== 'write') return
    expect(off.env.OTEL_LOG_USER_PROMPTS).toBeUndefined()
    expect(off.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  })

  test('never touches an OpenTelemetry setup it did not write', () => {
    const theirs = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com', OTEL_METRICS_EXPORTER: 'otlp' }
    expect(planEnv(theirs, telemetryEnv(DEFAULTS, 'claude')).action).toBe('foreign')
    expect(planEnv(theirs, null).action).toBe('none')
  })

  test('removing takes out exactly its own keys', () => {
    const on = planEnv({ KEEP: '1' }, telemetryEnv(DEFAULTS, 'claude'))
    if (on.action !== 'write') throw new Error('expected write')
    const off = planEnv(on.env, null)
    expect(off.action).toBe('remove')
    if (off.action !== 'remove') return
    expect(off.env).toEqual({ KEEP: '1' })
  })

  test('session start writes the env into this profile, leaves a foreign one alone, and /obs telemetry off all removes it', async ($, on) => {
    const files = new Map<string, string>([
      ['/h/.claude-shared/.keep', ''],
      ['/h/.claude-my/settings.json', JSON.stringify({ model: 'opus', env: { FOO: '1' } })],
      ['/h/.claude-work/settings.json', JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp', OTEL_LOGS_EXPORTER: 'otlp' } })],
    ])
    const commands: string[] = []
    const toasts: string[] = []
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
    on('env.get', ($: any, e: any) => ({ value: ({ HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude-my' } as Record<string, string>)[e.name] }))
    on('fs.read', ($: any, e: any) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
    on('fs.write', ($: any, e: any) => (files.set(e.path, e.text), { value: undefined }))
    on('fs.exists', ($: any, e: any) => ({ value: [...files.keys()].some(f => f === e.path || f.startsWith(`${e.path}/`)) }))
    on('fs.list', ($: any, e: any) => {
      const kids = new Set<string>()
      for (const f of files.keys()) if (f.startsWith(`${e.path}/`)) kids.add(f.slice(e.path.length + 1).split('/')[0])
      return { value: [...kids].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
    })
    on('session.id', () => ({ value: 's1' }))
    on('clock.after', () => ({ value: undefined }))
    on('command.register', ($: any, e: any) => (commands.push(e.name), { value: undefined }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '{"docker":false}\n', stderr: '' } }))
    on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    expect(commands).toContain('obs')
    expect(commands).toContain('mods')
    const mine = JSON.parse(files.get('/h/.claude-my/settings.json')!)
    expect(mine.model).toBe('opus')
    expect(mine.env.FOO).toBe('1')
    expect(mine.env.OTEL_RESOURCE_ATTRIBUTES).toBe('claude.profile=claude-my')
    expect(toasts.some(t => t.includes('from the next session'))).toBe(true)
    expect(files.get('/h/.claude-shared/observability/config.json')).toBeDefined()

    const r: any = await $.command.run({ command: 'obs', args: 'telemetry off all' } as any)
    expect(r.text).toContain('claude-my: off')
    expect(r.text).toContain('claude-work: already off')
    expect(JSON.parse(files.get('/h/.claude-my/settings.json')!).env).toEqual({ FOO: '1' })
    expect(JSON.parse(files.get('/h/.claude-work/settings.json')!).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.corp')

    const on2: any = await $.command.run({ command: 'obs', args: 'telemetry on all' } as any)
    expect(on2.text).toContain('claude-work: left alone')
    expect(on2.text).toContain('claude-my: on')
  })
})
