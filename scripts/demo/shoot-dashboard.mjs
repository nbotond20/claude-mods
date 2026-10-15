// Docs screenshots of the demo dashboard (see README.md), over the Chrome DevTools protocol, no dependencies.
//   SID=<session with subagents> node scripts/demo/shoot-dashboard.mjs <outdir> [name ...]
// Prints what each page rendered (KPIs, errors, charts) so a broken panel shows without opening the images.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const OUT = process.argv[2], BASE = process.env.BASE || 'http://127.0.0.1:8799/', PORT = 9333
mkdirSync(OUT, { recursive: true })
const PROFILE = mkdtempSync(join(tmpdir(), 'ua-shoot-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let tgt
for (let i = 0; i < 50 && !tgt; i++) { await sleep(200); try { tgt = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page') } catch {} }
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r)
let id = 0; const pending = {}
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id] } }
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })) })
const ev = expr => cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(r => r.result?.result?.value)
await cdp('Page.enable')
const SHOTS = [
  ['live', 'live'], ['overview', 'overview'], ['overview-dark', 'overview', { dark: true, h: 736 }], ['cost', 'cost'], ['context', 'context'],
  ['background', 'background'], ['tools', 'tools'], ['agents', 'agents'], ['projects', 'projects'], ['prompts', 'prompts'],
  ['frustration', 'mood'], ['engine', 'engine'], ['recurring', 'recurring', { w: 1440, h: 1000 }], ['impact', 'impact'], ['savings', 'savings'],
  ['session-drilldown', 'projects', { js: `openSession(${JSON.stringify(process.env.SID || '')} || document.querySelector('[data-sid]')?.dataset.sid || '')`, wait: 3500 }],
  ['command-palette-dark', 'overview', { dark: true, h: 736, js: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))", wait: 800 }],
]
const only = process.argv.slice(3)
for (const [name, tab, o = {}] of SHOTS) {
  if (only.length && !only.includes(name)) continue
  await cdp('Emulation.setDeviceMetricsOverride', { width: o.w || 900, height: o.h || 625, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] })
  await cdp('Page.navigate', { url: BASE + '?shot=' + name + '#' + tab }); await sleep(4500)
  if (o.js) { console.log(name, 'js:', await ev(o.js)); await sleep(o.wait || 1000) }
  console.log(name, JSON.stringify(await ev(`({ h: document.querySelector('h1,h2,.tabtitle')?.textContent?.trim().slice(0, 60), kpis: document.querySelector('#kpis')?.innerText.replace(/\\s+/g, ' ').slice(0, 260),
    errs: [...document.querySelectorAll('.err')].map(e => e.textContent.slice(0, 120)), charts: document.querySelectorAll('canvas').length, empty: [...document.querySelectorAll('.empty,.nodata')].length,
    page: document.body.scrollHeight, dark: matchMedia('(prefers-color-scheme: dark)').matches, modal: document.querySelector('.open,[open]')?.className })`)))
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name)
}
ws.close(); chrome.kill(); await sleep(500); rmSync(PROFILE, { recursive: true, force: true })
