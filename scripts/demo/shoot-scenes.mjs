// Docs screenshots of terminal-scenes.html (see README.md), over the Chrome DevTools protocol, no dependencies.
//   node scripts/demo/shoot-scenes.mjs <outdir> <scene id> [...]   (serve scripts/demo on :8798 first)
// Each shot is the page's body at 2x, saved as <outdir>/<scene id>.png.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const [OUT, ...IDS] = process.argv.slice(2), BASE = process.env.BASE || 'http://127.0.0.1:8798/terminal-scenes.html', PORT = 9334
mkdirSync(OUT, { recursive: true })
const PROFILE = mkdtempSync(join(tmpdir(), 'scene-shoot-'))
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
for (const s of IDS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
  await cdp('Page.navigate', { url: `${BASE}?s=${s}` }); await sleep(1200); await ev('document.fonts.ready.then(() => 1)')
  const { w, h } = await ev('({ w: Math.ceil(document.body.getBoundingClientRect().width), h: Math.ceil(document.body.getBoundingClientRect().height) })')
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }); await sleep(300)
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
  writeFileSync(join(OUT, `${s}.png`), Buffer.from(shot.result.data, 'base64')); console.log(s, `${w}×${h}`)
}
ws.close(); chrome.kill(); await sleep(300); rmSync(PROFILE, { recursive: true, force: true })
