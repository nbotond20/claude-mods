import { describe, expect, test } from 'claude-code/testing'
import { nodeOk, reminderText, setupPrompt } from '../hooks/register.ts'

const ENTRY = '/h/.claude-mods/timesheet/entry'

function engine(on: any, opts: { node?: string; launcher?: string; config?: object } = {}) {
  const files = new Map<string, string>()
  if (opts.config) files.set('/h/.timesheet/config.json', JSON.stringify(opts.config))
  const runs: string[][] = []
  const submitted: string[] = []
  on('clock.now', () => ({ value: 1_000_000_000 }))
  on('clock.after', () => ({ value: undefined }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => (submitted.push(e.text), { text: e.text }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : e.name === 'CLAUDE_CONFIG_DIR' ? '/h/.claude-my' : undefined }))
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
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    runs.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { stdout, stderr: '', exitCode } })
    if (argv[0] === 'node' && argv[1] === '-p') return opts.node ? out(opts.node) : out('', 127)
    if (argv[0] === 'sh' && String(argv[1]).endsWith('install-launcher.sh')) {
      files.set(ENTRY, 'x')
      return out(opts.launcher ?? 'installed')
    }
    if (argv[0] === 'curl') return out('000', 7)
    if (argv.includes('doctor')) return out('Config: ~/.timesheet/config.json\n  ✓ git')
    return out('')
  })
  return { files, runs, submitted }
}

const cmd = ($: any, args: string) => $.command.run({ command: 'timesheet', args, origin: { kind: 'user' }, presentation: 'text' })
const settle = () => new Promise(r => setTimeout(r, 0))

describe('timesheet', () => {
  test('Node 22.18 or newer', () => {
    expect(nodeOk('22.18.0')).toBe(true)
    expect(nodeOk('v24.1.0')).toBe(true)
    expect(nodeOk('22.17.9')).toBe(false)
    expect(nodeOk('20.11.0')).toBe(false)
  })

  test('a session puts the launcher in place and records itself for /mods', async ($, on) => {
    const { files, runs } = engine(on, { node: '22.20.0', config: { target: 7, calendar: { enabled: true } } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    expect(runs.some(a => String(a[1]).endsWith('install-launcher.sh') && a[2] === ENTRY)).toBe(true)
    const rec = JSON.parse(files.get('/h/.claude-mods/mods/installed/claude-my/timesheet.json')!)
    expect(rec).toMatchObject({ mod: 'timesheet', command: 'timesheet', pausable: false, pending: 'welcome' })
    expect(rec.status).toMatch(/7h\/day · calendar on/)
    const s = await cmd($, 'status')
    expect(s.text).toMatch(/node 22\.20\.0 · launcher ~\/\.local\/bin\/timesheet: installed · web app off/)
  })

  test('the first run says where the command went, in the one mods toast', async ($, on) => {
    const toasts: string[] = []
    engine(on, { node: '22.20.0' })
    on('ui.toast', ($: any, e: any) => (toasts.push(e.text), { value: undefined }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await settle()
    expect(toasts.join('\n')).toMatch(/Mods on: timesheet \(the `timesheet` command is in ~\/\.local\/bin/)
  })

  test('day/week/month and free text go to Claude with the skill; doctor runs the CLI', async ($, on) => {
    const { submitted, runs } = engine(on, { node: '22.20.0' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const r = await cmd($, 'week last')
    expect(r.text).toMatch(/Building your timesheet \(week last\)/)
    await settle()
    expect(submitted.at(-1)).toBe('Use the timesheet skill to show my timesheet: week last')
    await cmd($, 'move 2h on Tuesday to Meetings')
    await settle()
    expect(submitted.at(-1)).toMatch(/timesheet skill for this: move 2h/)
    const d = await cmd($, 'doctor')
    expect(d.text).toMatch(/✓ git/)
    expect(runs.some(a => a[0] === 'node' && String(a[3]).endsWith('/bin/timesheet.js') && a[4] === 'doctor')).toBe(true)
  })

  test('without a new enough Node, doctor and setup say so', async ($, on) => {
    engine(on, { node: '20.1.0' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    expect((await cmd($, 'doctor')).text).toMatch(/needs Node 22\.18 or newer \(found 20\.1\.0\)/)
    expect(setupPrompt(false, { version: '20.1.0', ok: false })).toMatch(/Node\.js 20\.1\.0; timesheet needs/)
  })

  test('the setup keeps secrets and submission with the person', () => {
    const p = setupPrompt(false, { version: '22.20.0', ok: true })
    expect(p).toMatch(/Never ask me for, print or store a client secret or token/)
    expect(p).toMatch(/Never run `timesheet submit week`/)
    expect(p).toMatch(/`! timesheet init`/)
  })

  test('the weekly reminder speaks only when last week needs something', () => {
    const day = (date: string, extra: object = {}) => ({ date, locked: false, flags: [], status: 'final', target: 8, total: 8, ...extra })
    const done = { week: '2026-10-05', days: [day('2026-10-05', { locked: true })], systems: [{ system: 'redmine', ok: true }] }
    expect(reminderText(done)).toBe('')
    expect(reminderText({ ...done, systems: [], days: [day('2026-10-05')] })).toBe('')
    const open = { week: '2026-10-05', missing: ['2026-10-09'], days: [day('2026-10-05', { flags: ['Only 1h'] }), day('2026-10-06')], systems: [{ system: 'redmine', ok: false }] }
    expect(reminderText(open)).toBe('timesheet: week of 2026-10-05: 1 day(s) not computed, 1 day(s) to check, 2 workday(s) not submitted. /timesheet review last week')
  })

  test('a launcher that is not ours is left alone', async ($, on) => {
    engine(on, { node: '22.20.0', launcher: 'foreign' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    expect((await cmd($, 'install')).text).toMatch(/not timesheet's launcher; left alone\. \/timesheet install --force/)
  })
})
