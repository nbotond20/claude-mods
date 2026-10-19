// Docs screenshots of the demo timesheet web app (see README.md), over the Chrome DevTools protocol, no dependencies.
//   node scripts/demo/shoot-timesheet.mjs <outdir> [name ...]
// Prints what each shot shows (heading, open dialog) so a wrong page shows without opening the images.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const OUT = process.argv[2], BASE = process.env.BASE || 'http://127.0.0.1:4391/', PORT = 9334
mkdirSync(OUT, { recursive: true })
const PROFILE = mkdtempSync(join(tmpdir(), 'ts-shoot-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let tgt
for (let i = 0; i < 50 && !tgt; i++) { await sleep(200); try { tgt = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page') } catch {} }
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r)
let id = 0; const pending = {}
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id] } }
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })) })
const ev = expr => cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result?.exceptionDetails ? `error: ${r.result.exceptionDetails.exception?.description?.split('\n')[0]}` : r.result?.result?.value)
await cdp('Page.enable')
// Every shot starts from the default views, not the one the previous shot left behind.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'try { localStorage.clear() } catch {}' })

// In-page helpers: click by accessible name or text, wait a little after each step.
const HELPERS = `
  window.__find = (name, root = document) => [...root.querySelectorAll('button,[role=radio],[role=tab],[role=option],a,[role=button]')]
    .find(e => (e.getAttribute('aria-label') || e.textContent || '').trim() === name)
  window.__click = async (name, ms = 900) => { const e = __find(name); if (!e) throw new Error('no ' + name); e.click(); await new Promise(r => setTimeout(r, ms)) }
`
// Weeks from the current week back to the demo's fullest week (Oct 5, 2026).
const monday = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
const WEEKS_BACK = Math.round((monday(new Date()) - monday(new Date('2026-10-05T12:00:00'))) / (7 * 86400_000))
const toWeek = `for (let i = 0; i < ${WEEKS_BACK}; i++) await __click('Previous week', 500); await new Promise(r => setTimeout(r, 1500))`
// The calendar tab has its own view buttons; its mini month jumps to a date.
const calendar = view => `const p = [...document.querySelectorAll('[role=tabpanel]')].find(e => e.offsetParent);
  [...p.querySelectorAll('button')].find(e => e.textContent.trim() === '${view}').click(); await new Promise(r => setTimeout(r, 1200));
  p.querySelector('[aria-label="October 8, 2026"]').click(); await new Promise(r => setTimeout(r, 1500))`
const open = label => `document.querySelector('[aria-label^="${label}"]').click(); await new Promise(r => setTimeout(r, 1500))`
const SHOTS = [
  ['week-view', `${toWeek}`],
  ['week-view-dark', `${toWeek}`, { dark: true, w: 1100 }],
  ['month-view', `${toWeek}; await __click('Month', 1500); await __click('Previous month', 2500)`],
  ['day-block-details', `${toWeek}; const day = [...document.querySelectorAll('h3,h4')].find(e => e.textContent.trim() === 'Monday, Oct 5').closest('section,article,li,div[class*=card]');
    [...day.querySelectorAll('button')].find(e => /time blocks/.test(e.textContent)).click(); await new Promise(r => setTimeout(r, 1200));
    [...document.querySelectorAll('button')].find(e => /^09:45.*MOB-377/.test(e.textContent.trim())).click(); await new Promise(r => setTimeout(r, 1500))`, { w: 1000, h: 625 }],
  ['submit-preview', `${toWeek}; const b = [...document.querySelectorAll('button')].find(e => e.textContent.trim().startsWith('Submission')); b.click(); await new Promise(r => setTimeout(r, 1500));
    b.scrollIntoView({ block: 'start' }); scrollBy(0, -16); await new Promise(r => setTimeout(r, 800))`],
  ['calendar-week', `${calendar('Week')}`, { hash: 'calendar' }],
  ['calendar-month', `${calendar('Month')}`, { hash: 'calendar' }],
  ['calendar-resources', `${calendar('Resources')}`, { hash: 'calendar' }],
  ['calendar-block-details', `${calendar('Week')}; ${open('MOB-377')}`, { hash: 'calendar' }],
  ['settings-general', `location.hash = 'settings/general'; await new Promise(r => setTimeout(r, 1500))`, { hash: 'settings/general' }],
  ['settings-activity-sources', '', { hash: 'settings/sources' }],
  ['settings-work-scope', '', { hash: 'settings/scope' }],
  ['settings-task-categories', '', { hash: 'settings/categories' }],
]
const only = process.argv.slice(3)
for (const [name, js, o = {}] of SHOTS) {
  if (only.length && !only.includes(name)) continue
  await cdp('Emulation.setDeviceMetricsOverride', { width: o.w || 1440, height: o.h || 900, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] })
  await cdp('Page.navigate', { url: BASE + '?shot=' + name + '#' + (o.hash || '') }); await sleep(3000)
  await ev(HELPERS)
  if (js) { const r = await ev(`(async () => { ${js} })()`); if (r) console.log(name, r) }
  console.log(name, JSON.stringify(await ev(`({ h: [...document.querySelectorAll('main h1, main h3, [role=dialog] h2')].map(e => e.textContent.trim().slice(0, 50)).slice(0, 3), dialog: !!document.querySelector('[role=dialog]'), y: scrollY })`)))
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
}
ws.close(); chrome.kill(); await sleep(500); rmSync(PROFILE, { recursive: true, force: true })
