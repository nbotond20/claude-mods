// Docs screenshots of the observability demo stack (see README.md), over the Chrome DevTools protocol, no dependencies.
//   node scripts/demo/shoot-grafana.mjs <outdir> [name ...]
// Prints each page's panels with no data so an empty one shows without opening the images.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const OUT = process.argv[2], BASE = process.env.BASE || 'http://127.0.0.1:3311', PORT = 9334
mkdirSync(OUT, { recursive: true })
const PROFILE = mkdtempSync(join(tmpdir(), 'obs-shoot-'))
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
// The newest trace with subagents, for the waterfall.
const q = encodeURIComponent('{ span.span.type = "tool" && span.tool_name = "Agent" }')
const traces = await (await fetch(`${BASE}/api/datasources/proxy/uid/tempo/api/search?q=${q}&limit=20&start=${Math.floor(Date.now() / 1000) - 30 * 86400}&end=${Math.floor(Date.now() / 1000)}`)).json()
const trace = (traces.traces || []).sort((a, b) => b.durationMs - a.durationMs)[3]?.traceID || ''
const range = 'from=now-21d&to=now&orgId=1'
const cmp = 'var-a_profile=claude-work&var-a_profile=claude-personal&var-b_profile=claude-gateway'
const SHOTS = [
  ['overview', `/d/claude-overview?${range}`, { h: 800 }],
  ['compare', `/d/claude-compare?${range}&${cmp}`, { h: 1240 }],
  ['compare-breakdown', `/d/claude-compare?${range}&${cmp}`, { h: 1100, scroll: 'Breakdown' }],
  ['breakdown', `/d/claude-breakdown?${range}`, { h: 1240 }],
  ['time', `/d/claude-time?${range}`, { h: 860 }],
  ['errors', `/d/claude-errors?${range}`, { h: 1100 }],
  ['waterfall', `/explore?orgId=1&left=${encodeURIComponent(JSON.stringify({ datasource: 'tempo', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: trace }], range: { from: 'now-30d', to: 'now' } }))}`, { h: 1000 }],
]
// until no panel shows a loading bar for 3 s in a row (at most 60 s)
const settle = async () => { await sleep(3000); for (let i = 0, calm = 0; i < 120 && calm < 6; i++) { await sleep(500)
  calm = (await ev(`document.querySelectorAll('[aria-label="Panel loading bar"], [data-testid*="loading"]').length`)) ? 0 : calm + 1 } }
const only = process.argv.slice(3)
for (const [name, path, o = {}] of SHOTS) {
  if (only.length && !only.includes(name)) continue
  await cdp('Emulation.setDeviceMetricsOverride', { width: o.w || 1440, height: o.h || 1000, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] })
  await cdp('Page.navigate', { url: BASE + path + (path.includes('?') ? '&' : '?') + `theme=${o.dark ? 'dark' : 'light'}` }); await settle()
  if (o.scroll) {
    console.log(name, 'scroll:', await ev(`(() => { const t = [...document.querySelectorAll('[data-testid*="dashboard-row-title"], h2, button')].find(e => e.textContent.trim().startsWith(${JSON.stringify(o.scroll)}));
      if (!t) return 'not found'; t.scrollIntoView({ block: 'start' }); return 'ok' })()`))
    await settle()
  }
  console.log(name, JSON.stringify(await ev(`({ title: document.title, noData: [...document.querySelectorAll('[data-viz-panel-key], .react-grid-item')]
    .filter(p => /No data/.test(p.innerText) && p.getBoundingClientRect().top < innerHeight).map(p => p.querySelector('h2')?.textContent).filter(Boolean), errors: [...document.querySelectorAll('[data-testid*="Panel status error"], [data-testid*="error-indicator"]')].map(e => e.getAttribute('aria-label') || e.textContent).slice(0, 5) })`)))
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', name)
}
ws.close(); chrome.kill(); await sleep(500); rmSync(PROFILE, { recursive: true, force: true })
