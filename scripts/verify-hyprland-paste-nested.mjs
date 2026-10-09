// Real paste proof inside a nested Hyprland, so the live (locked) session never receives a key event.
// Usage (from a built checkout, Node 24, on Omarchy with foot and chromium): node scripts/verify-hyprland-paste-nested.mjs <out-dir>
// Runs a nested Hyprland so a locked live session never receives a key event.
/* global WebSocket, fetch */
import console from 'node:console'
import process from 'node:process'
import { setTimeout } from 'node:timers'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const checkout = process.cwd()
const out = process.argv[2] ?? '/tmp/nested-paste'
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
const wait = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const runtime = '/run/user/1000'

const shellPid = execFileSync('pgrep', ['-x', 'quickshell']).toString().trim().split('\n')[0]
const live = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
  .map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
const liveSig = live.HYPRLAND_INSTANCE_SIGNATURE
const base = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: live.DBUS_SESSION_BUS_ADDRESS }

writeFileSync(join(out, 'hyprland.lua'), [
  'package.path = "/usr/share/omarchy/?.lua;" .. package.path',
  'require("default.hypr.helpers")',
  'hl.monitor({ output = "", mode = "1280x800@60", position = "0x0", scale = 1 })',
  'require("default.hypr.apps.terminals")',
].join('\n') + '\n')

const sigsBefore = new Set(readdirSync(join(runtime, 'hypr')))
const socksBefore = new Set(readdirSync(runtime).filter(n => /^wayland-\d+$/.test(n)))
const started = []
const hypr = spawn('Hyprland', ['-c', join(out, 'hyprland.lua')], { env: { ...base, WAYLAND_DISPLAY: live.WAYLAND_DISPLAY, HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: ['ignore', 'ignore', 'ignore'] })
started.push(['Hyprland', hypr.pid])
let sig, sock
for (let i = 0; i < 60 && !(sig && sock); i++) {
  await wait(250)
  sig = readdirSync(join(runtime, 'hypr')).find(s => !sigsBefore.has(s) && s !== liveSig)
  sock = readdirSync(runtime).find(n => /^wayland-\d+$/.test(n) && !socksBefore.has(n))
}
if (!sig || !sock) throw new Error('nested Hyprland did not start')
const nested = { ...base, WAYLAND_DISPLAY: sock, HYPRLAND_INSTANCE_SIGNATURE: sig, XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }
const hyprctl = (...args) => execFileSync('hyprctl', args, { env: nested, encoding: 'utf8', timeout: 5000 })
log(`nested: ${sig} on ${sock}; live: ${liveSig} (untouched)`)

const results = {}
try {
  // Targets: a terminal whose cat writes raw bytes to a file, and a Chromium text box.
  const footFile = join(out, 'foot.txt')
  const foot = spawn('foot', ['-a', 'foot', '-e', 'sh', '-c', `stty -icanon -echo; cat > ${footFile}`], { env: nested, stdio: 'ignore' })
  started.push(['foot', foot.pid])
  const chromium = spawn('chromium', [`--user-data-dir=${join(out, 'chromium')}`, '--ozone-platform=wayland', '--no-first-run', '--remote-debugging-port=9347',
    '--app=data:text/html,<title>pastebox</title><textarea id=t autofocus style="width:95vw;height:90vh"></textarea>'], { env: nested, stdio: 'ignore' })
  started.push(['chromium', chromium.pid])
  const data = join(out, 'sotto-profile'); mkdirSync(data)
  const sotto = spawn(join(checkout, 'node_modules/electron/dist/electron'), ['--inspect=9346', checkout], { env: { ...nested, XDG_CONFIG_HOME: data }, stdio: 'ignore' })
  started.push(['sotto', sotto.pid])

  let target
  for (let i = 0; i < 80 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:9346/json/list')).json())[0] } catch { await wait(250) } }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => socket.addEventListener('open', r, { once: true }))
  let id = 0
  const evaluate = expression => new Promise((resolve, reject) => {
    const mine = ++id
    const onMessage = e => {
      const m = JSON.parse(e.data)
      if (m.id !== mine) return
      socket.removeEventListener('message', onMessage)
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description))
      else resolve(m.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  const win = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
  for (let i = 0; i < 80; i++) { try { if (await evaluate(`(() => { const w = ${win}; return Boolean(w && !w.webContents.isLoading()) })()`)) break } catch { /* main is still starting */ } await wait(250) }
  const invoke = js => evaluate(`(async () => (${win}).webContents.executeJavaScript(${JSON.stringify(js)}))()`)
  await invoke('window.sotto.updateSettings({ autoPaste: true, showWidgetWhenIdle: false, localHostEnabled: false })')
  await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.hide())")
  await wait(1500)
  log('nested clients:', hyprctl('clients', '-j').match(/"class": "[^"]+"/g)?.join(' '))

  const deliver = async (label, selector, text) => {
    hyprctl('dispatch', `hl.dsp.focus({ window = "${selector}" })`)
    await wait(500)
    const active = JSON.parse(hyprctl('activewindow', '-j'))
    const result = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text, autoPaste: true, pasteDelayMs: 150 })})`)
    await wait(1200)
    results[label] = { focused: active.class, tags: active.tags, result }
    log(`${label}: focused=${active.class} tags=${JSON.stringify(active.tags)} deliverOutput=${result}`)
  }
  await deliver('terminal', 'class:foot', 'Sotto pasted into a terminal — café 🚀')
  await deliver('app', 'title:pastebox', 'Sotto pasted into an app — naïve façade ✓')

  results.terminalText = existsSync(footFile) ? readFileSync(footFile, 'utf8') : '(no file)'
  log('foot received:', JSON.stringify(results.terminalText))
  const pages = await (await fetch('http://127.0.0.1:9347/json/list')).json()
  const page = pages.find(p => p.title === 'pastebox')
  const cdp = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(r => cdp.addEventListener('open', r, { once: true }))
  results.appText = await new Promise(resolve => { cdp.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m.result?.result?.value) }); cdp.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("t").value' } })) })
  log('chromium textarea:', JSON.stringify(results.appText))
  cdp.close(); socket.close()
  execFileSync('grim', [join(out, 'nested.png')], { env: nested })
  log('screenshot:', join(out, 'nested.png'))
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
} finally {
  for (const [name, pid] of started.reverse()) { try { process.kill(pid, 'SIGTERM'); log(`stopped ${name} ${pid}`) } catch { /* already gone */ } }
  await wait(2000)
  for (const [name, pid] of started) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); log(`killed ${name} ${pid}`) } catch { /* exited after SIGTERM */ } }
  if (sig && sig !== liveSig) rmSync(join(runtime, 'hypr', sig), { recursive: true, force: true })
  log('live session signature still present:', existsSync(join(runtime, 'hypr', liveSig)))
}
