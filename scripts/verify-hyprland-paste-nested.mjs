// Real paste only in an owned nested Hyprland; the locked live session receives no keys.
// Usage after building, Node 24 on Omarchy: node scripts/verify-hyprland-paste-nested.mjs <out-dir>
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as wait } from 'node:timers/promises'
import { createOwnedProofProcesses } from './owned-proof-processes.mjs'
import { fetchProofJson, openProofDebugger } from './proof-debugger.mjs'

const checkout = process.cwd()
const out = resolve(process.argv[2] ?? '/tmp/nested-paste')
mkdirSync(out, { recursive: true })
const runtime = '/run/user/1000'
const shellPid = execFileSync('pgrep', ['-x', 'quickshell'], { timeout: 5000 }).toString().trim().split('\n')[0]
const live = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
  .map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))
const liveSig = live.HYPRLAND_INSTANCE_SIGNATURE
assert.ok(liveSig && live.WAYLAND_DISPLAY, 'The live instance and display must be known')
const base = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: live.DBUS_SESSION_BUS_ADDRESS }
const instances = () => JSON.parse(execFileSync('/usr/bin/hyprctl', ['instances', '-j'], { env: live, encoding: 'utf8', timeout: 5000 }))
const owned = createOwnedProofProcesses(console.log)
const debuggers = []
let sig, sock, hypr, runtimeIdentity
const results = {}

const poll = async (label, check, child, timeoutMs = 20000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (child?.proofError) throw child.proofError
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`${label}: process exited`)
    const result = await check(Math.max(1, deadline - performance.now()))
    if (result && performance.now() < deadline) return result
    await wait(Math.min(100, Math.max(1, deadline - performance.now())))
  }
  throw new Error(`${label}: deadline`)
}
const connect = async url => {
  const debuggerClient = await openProofDebugger(url)
  debuggers.push(debuggerClient)
  return debuggerClient
}
const discover = (port, child) => poll('Debugger discovery', async remaining => {
  try { return (await fetchProofJson(`http://127.0.0.1:${port}/json/list`, Math.min(2000, Math.ceil(remaining))))[0] }
  catch { return undefined }
}, child)
const assertNested = () => {
  assert.notEqual(sig, liveSig, 'Never dispatch to the live instance')
  assert.notEqual(sock, live.WAYLAND_DISPLAY, 'Never use the live display')
  assert.ok(sig && sock && instances().some(instance => instance.pid === hypr.pid && instance.instance === sig && instance.wl_socket === sock), 'The spawned compositor must own both the instance and display')
}

try {
  writeFileSync(join(out, 'hyprland.lua'), [
    'package.path = "/usr/share/omarchy/?.lua;" .. package.path',
    'require("default.hypr.helpers")',
    'hl.monitor({ output = "", mode = "1280x800@60", position = "0x0", scale = 1 })',
    'require("default.hypr.apps.terminals")',
  ].join('\n') + '\n')
  hypr = owned.start('Hyprland', 'Hyprland', ['-c', join(out, 'hyprland.lua')], {
    env: { ...base, WAYLAND_DISPLAY: live.WAYLAND_DISPLAY, HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: 'ignore',
  })
  const compositor = await poll('Nested Hyprland startup', () => instances().find(instance => instance.pid === hypr.pid), hypr)
  sig = compositor.instance
  sock = compositor.wl_socket
  assertNested()
  runtimeIdentity = statSync(join(runtime, 'hypr', sig))
  const nested = { ...base, WAYLAND_DISPLAY: sock, HYPRLAND_INSTANCE_SIGNATURE: sig, XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'wayland' }
  const hyprctl = (...args) => {
    if (args[0] === 'dispatch') assertNested()
    return execFileSync('/usr/bin/hyprctl', args, { env: nested, encoding: 'utf8', timeout: 5000 })
  }
  console.log(`nested: ${sig} on ${sock}; live: ${liveSig} on ${live.WAYLAND_DISPLAY} (untouched)`)

  const footFile = join(out, 'foot.txt')
  writeFileSync(footFile, '')
  owned.start('foot', 'foot', ['-a', 'foot', '-e', 'sh', '-c', 'stty raw -echo; exec cat > "$1"', 'proof-cat', footFile], { env: nested, stdio: 'ignore' })
  const chromium = owned.start('Chromium', 'chromium', [`--user-data-dir=${join(out, 'chromium')}`, '--ozone-platform=wayland', '--no-first-run', '--remote-debugging-port=9347',
    '--app=data:text/html,<title>pastebox</title><textarea id=t autofocus style="width:95vw;height:90vh"></textarea>'], { env: nested, stdio: 'ignore' })
  const data = join(out, `sotto-profile-${process.pid}`)
  mkdirSync(data)
  const sotto = owned.start('Sotto', join(checkout, 'node_modules/electron/dist/electron'), ['--inspect=9346', checkout], { env: { ...nested, XDG_CONFIG_HOME: data }, stdio: 'ignore' })
  const inspectorTarget = await discover(9346, sotto)
  const inspector = await connect(inspectorTarget.webSocketDebuggerUrl)
  assert.equal(await inspector.evaluate('process.pid'), sotto.pid, 'The inspector must belong to the spawned Sotto')
  assert.deepEqual(await inspector.evaluate('({ instance: process.env.HYPRLAND_INSTANCE_SIGNATURE, display: process.env.WAYLAND_DISPLAY })'), { instance: sig, display: sock })
  assertNested()
  const win = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
  await poll('Sotto preload startup', async remaining => {
    try { return await inspector.evaluate(`(() => { if (!process.mainModule) return false; const w = ${win}; return Boolean(w && !w.webContents.isLoading()) })()`, Math.min(2000, remaining)) }
    catch (error) { if (/Promise was collected|Execution context was destroyed/u.test(error.message)) return false; throw error }
  }, sotto)
  const invoke = js => inspector.evaluate(`(async () => (${win}).webContents.executeJavaScript(${JSON.stringify(js)}))()`)
  await invoke('window.sotto.updateSettings({ autoPaste: true, showWidgetWhenIdle: false, localHostEnabled: false })')
  await inspector.evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.hide())")
  await poll('Nested target startup', () => {
    const clients = JSON.parse(hyprctl('clients', '-j'))
    return clients.some(client => client.class === 'foot') && clients.some(client => client.title === 'pastebox')
  }, chromium)

  const deliver = async (label, selector, text) => {
    assertNested()
    hyprctl('dispatch', `hl.dsp.focus({ window = "${selector}" })`)
    await wait(500)
    const active = JSON.parse(hyprctl('activewindow', '-j'))
    const result = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text, autoPaste: true, pasteDelayMs: 150 })})`)
    await wait(1200)
    results[label] = { focused: active.class, tags: active.tags, result }
    console.log(`${label}: focused=${active.class} tags=${JSON.stringify(active.tags)} deliverOutput=${result}`)
  }
  await deliver('terminal', 'class:foot', 'Sotto pasted into a terminal — café 🚀')
  await deliver('app', 'title:pastebox', 'Sotto pasted into an app — naïve façade ✓')
  results.terminalText = readFileSync(footFile, 'utf8')
  console.log('foot received:', JSON.stringify(results.terminalText))
  const pages = await fetchProofJson('http://127.0.0.1:9347/json/list')
  const page = pages.find(p => p.title === 'pastebox')
  assert.ok(page, 'Chromium pastebox debugger must exist')
  const cdp = await connect(page.webSocketDebuggerUrl)
  results.appText = await cdp.evaluate('document.getElementById("t").value')
  console.log('chromium textarea:', JSON.stringify(results.appText))
  execFileSync('grim', [join(out, 'nested.png')], { env: nested, timeout: 5000 })
  console.log('screenshot:', join(out, 'nested.png'))
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
} finally {
  for (const debuggerClient of debuggers) debuggerClient.close()
  // Startup may fail before discovery completes. A lock naming our PID still
  // establishes ownership; never infer it from a newly appeared directory.
  if (hypr?.pid && !runtimeIdentity) {
    for (const candidate of readdirSync(join(runtime, 'hypr'))) {
      if (candidate === liveSig) continue
      const folder = join(runtime, 'hypr', candidate)
      try {
        const [pid, display] = readFileSync(join(folder, 'hyprland.lock'), 'utf8').split('\n')
        if (Number(pid) === hypr.pid && display !== live.WAYLAND_DISPLAY) {
          sig = candidate; sock = display; runtimeIdentity = statSync(folder)
          break
        }
      } catch { /* No owned runtime folder was created here. */ }
    }
  }
  try { await owned.stop() } finally {
    const folder = sig && join(runtime, 'hypr', sig)
    if (folder && sig !== liveSig && runtimeIdentity && existsSync(folder)) {
      const current = statSync(folder)
      assert.ok(current.ino === runtimeIdentity.ino && current.dev === runtimeIdentity.dev, 'Never remove a replaced runtime folder')
      const lock = join(folder, 'hyprland.lock')
      if (existsSync(lock)) {
        const [pid, display] = readFileSync(lock, 'utf8').split('\n')
        assert.equal(Number(pid), hypr.pid, 'Only remove the spawned compositor runtime folder')
        assert.equal(display, sock)
      }
      rmSync(folder, { recursive: true, force: true })
    }
    const remaining = readdirSync(join(runtime, 'hypr'))
    console.log('Hyprland instance folders after cleanup:', JSON.stringify(remaining))
    assert.deepEqual(remaining, [liveSig], 'Only the live session instance folder may remain')
  }
}
