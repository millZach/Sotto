// Real paste only in an owned nested Hyprland; the locked live session receives no keys.
// Usage after building, Node 24 with foot, Alacritty, Chromium, cc and Wayland client headers: node scripts/verify-hyprland-paste-nested.mjs <out-dir>
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { URL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as wait } from 'node:timers/promises'
import { assertProofInstancesPreserved, createOwnedProofProcesses, installProofCleanup, snapshotProofInstances, terminateThenCleanup } from './owned-proof-processes.mjs'
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
const instanceDirectory = join(runtime, 'hypr')
const instancesBefore = snapshotProofInstances(instanceDirectory)
assert.ok(instancesBefore.has(liveSig), 'The live instance folder must exist before the proof')
console.log('Hyprland instance folders before proof:', JSON.stringify([...instancesBefore.keys()]))
const base = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: live.DBUS_SESSION_BUS_ADDRESS }
const instances = () => JSON.parse(execFileSync('/usr/bin/hyprctl', ['instances', '-j'], { env: live, encoding: 'utf8', timeout: 5000 }))
const owned = createOwnedProofProcesses(console.log)
const debuggers = []
let sig, sock, hypr, runtimeIdentity
const results = {}

const poll = async (label, check, child, timeoutMs = 20000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    lifecycle.assertRunning()
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
  lifecycle.assertRunning()
  assert.notEqual(sig, liveSig, 'Never dispatch to the live instance')
  assert.notEqual(sock, live.WAYLAND_DISPLAY, 'Never use the live display')
  assert.ok(sig && sock && instances().some(instance => instance.pid === hypr.pid && instance.instance === sig && instance.wl_socket === sock), 'The spawned compositor must own both the instance and display')
}
const assertDebuggerListener = (port, child) => {
  assert.equal(child.exitCode, null, 'The owned browser must still be running')
  assert.equal(child.signalCode, null, 'The owned browser must still be running')
  const sockets = readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(fields => fields[1] === `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}` && fields[3] === '0A')
  assert.equal(sockets.length, 1, 'Exactly one loopback debugger listener must exist')
  const expected = `socket:[${sockets[0][9]}]`
  assert.ok(readdirSync(`/proc/${child.pid}/fd`).some(fd => {
    try { return readlinkSync(`/proc/${child.pid}/fd/${fd}`) === expected } catch { return false }
  }), 'The browser started by this proof must own the debugger socket')
}

const lifecycle = installProofCleanup(() => terminateThenCleanup(() => owned.stop(), [
  () => { for (const debuggerClient of debuggers) debuggerClient.close() },
  () => {
    // Startup may fail before discovery completes. A lock naming our PID still
    // establishes ownership; never infer it from a newly appeared directory.
    if (hypr?.pid && !runtimeIdentity) {
      for (const candidate of readdirSync(instanceDirectory)) {
        if (instancesBefore.has(candidate)) continue
        const folder = join(runtime, 'hypr', candidate)
        try {
          const [pid, display] = readFileSync(join(folder, 'hyprland.lock'), 'utf8').split('\n')
          if (Number(pid) === hypr.pid && display !== live.WAYLAND_DISPLAY) {
            sig = candidate; sock = display; runtimeIdentity = statSync(folder)
            break
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
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
  },
  () => {
    const remaining = assertProofInstancesPreserved(instanceDirectory, instancesBefore, sig)
    console.log('Hyprland instance folders after cleanup:', JSON.stringify(remaining))
  },
]), console.log)

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
    if (args[0] === 'dispatch' || args[0] === 'eval') assertNested()
    return execFileSync('/usr/bin/hyprctl', args, { env: nested, encoding: 'utf8', timeout: 5000 })
  }
  console.log(`nested: ${sig} on ${sock}; live: ${liveSig} on ${live.WAYLAND_DISPLAY} (untouched)`)

  // A locked parent supplies no mouse to nested Hyprland. PRIMARY offers need
  // pointer focus, so create a virtual pointer entirely inside the owned display.
  const pointerExecutable = join(out, 'nested-pointer')
  execFileSync('cc', [join(checkout, 'scripts/nested-proof-pointer.c'), '-o', pointerExecutable, '-lwayland-client', '-Wall', '-Wextra', '-Werror'], { timeout: 5000 })
  assertNested()
  const pointer = owned.start('nested pointer', pointerExecutable, [liveSig, sig, live.WAYLAND_DISPLAY, sock], { env: nested, stdio: ['ignore', 'pipe', 'ignore'] })
  let pointerReady = false
  pointer.stdout.on('data', chunk => { if (chunk.toString().includes('ready')) pointerReady = true })
  await poll('Nested pointer startup', () => pointerReady, pointer)

  const footFile = join(out, 'foot.txt')
  const alacrittyFile = join(out, 'alacritty.txt')
  const stockFootFile = join(out, 'stock-foot.txt')
  const stockFootReady = join(out, 'stock-foot-ready')
  const footReady = join(out, 'foot-ready')
  const alacrittyReady = join(out, 'alacritty-ready')
  for (const file of [footReady, alacrittyReady, stockFootReady]) rmSync(file, { force: true })
  writeFileSync(footFile, '')
  writeFileSync(alacrittyFile, '')
  writeFileSync(stockFootFile, '')
  const catArgs = (file, ready) => ['sh', '-c', 'stty raw -echo; : > "$2"; exec cat > "$1"', 'proof-cat', file, ready]
  const foot = owned.start('foot', 'foot', ['-a', 'foot', '-e', ...catArgs(footFile, footReady)], { env: nested, stdio: 'ignore' })
  const stockFoot = owned.start('stock foot', 'foot', ['-c', '/dev/null', '-a', 'foot', '-T', 'stock foot', '-e', ...catArgs(stockFootFile, stockFootReady)], { env: nested, stdio: 'ignore' })
  // A missing system executable can be extracted into this checkout's ignored cache.
  // Alacritty from PATH; SOTTO_ALACRITTY points at another build, such as an unpacked Arch package.
  const alacrittyExecutable = process.env.SOTTO_ALACRITTY ?? 'alacritty'
  const alacritty = owned.start('Alacritty', alacrittyExecutable, ['--class', 'Alacritty', '-e', ...catArgs(alacrittyFile, alacrittyReady)], { env: nested, stdio: 'ignore' })
  const chromiumProfile = mkdtempSync(join(out, 'chromium-'))
  const chromium = owned.start('Chromium', 'chromium', [`--user-data-dir=${chromiumProfile}`, '--ozone-platform=wayland', '--no-first-run', '--remote-debugging-port=0',
    '--app=data:text/html,<title>pastebox</title><textarea id=t autofocus style="width:95vw;height:90vh"></textarea>'], { env: nested, stdio: 'ignore' })
  const data = join(out, `sotto-profile-${process.pid}`)
  mkdirSync(data)
  const sotto = owned.start('Sotto', join(checkout, 'node_modules/electron/dist/electron'), ['--inspect=9346', checkout], { env: { ...nested, XDG_CONFIG_HOME: data }, stdio: 'ignore' })
  const inspectorTarget = await discover(9346, sotto)
  const inspector = await connect(inspectorTarget.webSocketDebuggerUrl)
  assert.equal(await inspector.evaluate('process.pid', 5000, false), sotto.pid, 'The inspector must belong to the spawned Sotto')
  assert.deepEqual(await inspector.evaluate('({ instance: process.env.HYPRLAND_INSTANCE_SIGNATURE, display: process.env.WAYLAND_DISPLAY })', 5000, false), { instance: sig, display: sock })
  assertNested()
  const win = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
  await poll('Sotto preload startup', async remaining => {
    try { return await inspector.evaluate(`(() => { if (!process.mainModule) return false; const w = ${win}; return Boolean(w && !w.webContents.isLoading()) })()`, Math.min(2000, remaining), false) }
    catch (error) { if (/Promise was collected|Execution context was destroyed/u.test(error.message)) return false; throw error }
  }, sotto)
  const invoke = js => inspector.evaluate(`(async () => (${win}).webContents.executeJavaScript(${JSON.stringify(js)}))()`)
  await invoke('window.sotto.updateSettings({ autoPaste: true, showWidgetWhenIdle: false, localHostEnabled: false })')
  await poll('Sotto initial window shown', remaining => inspector.evaluate(`Boolean((${win}).isVisible())`, Math.min(2000, remaining), false), sotto)
  await inspector.evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.hide())")
  await poll('Nested target startup', () => {
    const clients = JSON.parse(hyprctl('clients', '-j'))
    return clients.some(client => client.class === 'foot' && owned.owns(client.pid, foot))
      && clients.some(client => client.class === 'Alacritty' && owned.owns(client.pid, alacritty))
      && clients.some(client => client.title === 'pastebox' && owned.owns(client.pid, chromium))
      && clients.some(client => client.title === 'stock foot' && owned.owns(client.pid, stockFoot))
      && existsSync(footReady) && existsSync(alacrittyReady) && existsSync(stockFootReady)
  }, chromium)

  const [portText, browserPath] = await poll('Chromium debugger startup', () => {
    try { return readFileSync(join(chromiumProfile, 'DevToolsActivePort'), 'utf8').trim().split('\n') }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }, chromium)
  const chromiumPort = Number(portText)
  assert.ok(Number.isInteger(chromiumPort) && chromiumPort > 0 && chromiumPort <= 65535)
  assert.match(browserPath, /^\/devtools\/browser\/[\w-]+$/u)
  assertDebuggerListener(chromiumPort, chromium)
  const origin = `http://127.0.0.1:${chromiumPort}`
  const browser = await fetchProofJson(`${origin}/json/version`)
  assert.equal(browser.webSocketDebuggerUrl, `ws://127.0.0.1:${chromiumPort}${browserPath}`, 'Discovery must identify the browser in the fresh profile')
  const pages = await fetchProofJson(`${origin}/json/list`)
  const page = pages.find(p => p.type === 'page' && p.title === 'pastebox')
  assert.ok(page, 'Chromium pastebox debugger must exist')
  const pageSocket = new URL(page.webSocketDebuggerUrl)
  assert.equal(pageSocket.origin, `ws://127.0.0.1:${chromiumPort}`, 'The page must use the owned browser listener')
  assert.equal(pageSocket.pathname, `/devtools/page/${page.id}`, 'The debugger must address the discovered page')
  const cdp = await connect(page.webSocketDebuggerUrl)
  const readChromium = () => {
    assertDebuggerListener(chromiumPort, chromium)
    return cdp.evaluate('document.getElementById("t").value')
  }
  console.log(`Chromium debugger: owned browser PID ${chromium.pid}, assigned port ${chromiumPort}`)
  assertDebuggerListener(chromiumPort, chromium)
  assert.equal(await cdp.evaluate('document.getElementById("t").value'), '')

  const deliver = async (label, child, matches, tags, text, receive, refocus = true) => {
    assertNested()
    const target = JSON.parse(hyprctl('clients', '-j')).find(client => matches(client) && owned.owns(client.pid, child))
    assert.ok(target, `${label}: target must be a window owned by this proof`)
    const active = refocus ? await poll(`${label} focus`, async () => {
      assert.equal(hyprctl('dispatch', `hl.dsp.focus({ window = "address:${target.address}" })`).trim(), 'ok')
      // Hyprland delivers PRIMARY offers to pointer focus. Model selecting this
      // stock terminal with the pointer as well as setting keyboard focus.
      if (label === 'stock foot') {
        const x = Math.round(target.at[0] + target.size[0] / 2)
        const y = Math.round(target.at[1] + target.size[1] / 2)
        assert.equal(hyprctl('dispatch', `hl.dsp.cursor.move({ x = ${x}, y = ${y} })`).trim(), 'ok')
      }
      // Initial window activation and keyboard focus delivery are asynchronous.
      await wait(500)
      const window = JSON.parse(hyprctl('activewindow', '-j'))
      return window.address === target.address ? window : undefined
    }, child) : JSON.parse(hyprctl('activewindow', '-j'))
    assert.equal(active.address, target.address, `${label}: target stays focused without refocusing`)
    assert.equal(active.pid, target.pid, `${label}: focused PID`)
    assert.equal(active.class, target.class, `${label}: focused class`)
    assert.equal(active.title, target.title, `${label}: focused title`)
    assert.deepEqual(active.tags, tags, `${label}: expected Omarchy tags`)
    assertNested()
    const result = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text, autoPaste: true, pasteDelayMs: 150 })})`)
    assert.equal(result, 'pasted', `${label}: real deliverOutput must paste`)
    const after = JSON.parse(hyprctl('activewindow', '-j'))
    if (after.address !== target.address) {
      console.error(`${label} unexpected focus after paste:`, JSON.stringify({ class: after.class, pid: after.pid, title: after.title }))
      execFileSync('grim', [join(out, `${label}-failure.png`)], { env: nested, timeout: 5000 })
    }
    assert.equal(after.address, target.address, `${label}: focus after paste`)
    try { await poll(`${label} exact text`, async () => (await receive()) === text, child) }
    catch (error) {
      console.error(`${label} mismatched text:`, JSON.stringify(await receive()))
      execFileSync('grim', [join(out, `${label}-failure.png`)], { env: nested, timeout: 5000 })
      throw error
    }
    const receivedText = await receive()
    assert.equal(receivedText, text, `${label}: exact received transcript`)
    results[label] = { focused: active.class, pid: active.pid, address: active.address, tags: active.tags, result, receivedText }
    console.log(`${label}: focused=${active.class} tags=${JSON.stringify(active.tags)} deliverOutput=${result}`)
    console.log(`${label} received:`, JSON.stringify(receivedText))
  }
  await deliver('foot', foot, client => client.class === 'foot', ['terminal*'], 'Sotto pasted into foot — café 🚀', () => readFileSync(footFile, 'utf8'))
  const stalePrimary = 'Different PRIMARY selection: never paste this'
  await new Promise((resolve, reject) => {
    const child = owned.start('Primary sentinel', 'wl-copy', ['--primary', '--type', 'text/plain;charset=utf-8'], { env: nested, stdio: ['pipe', 'ignore', 'ignore'] })
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Primary seed deadline')) }, 5000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.stdin.once('error', error => { clearTimeout(timeout); child.kill('SIGTERM'); reject(error) })
    child.once('exit', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error('Primary seed failed'))
    })
    child.stdin.end(stalePrimary, 'utf8')
  })
  assert.equal(execFileSync('wl-paste', ['--primary', '--no-newline'], { env: nested, encoding: 'utf8', timeout: 5000 }), stalePrimary)
  console.log('stock foot PRIMARY before:', JSON.stringify(stalePrimary))
  await deliver('stock foot', stockFoot, client => client.title === 'stock foot', ['terminal*'], 'Sotto pasted into stock foot — café 🚀', () => readFileSync(stockFootFile, 'utf8'))
  assert.equal(execFileSync('wl-paste', ['--primary', '--no-newline'], { env: nested, encoding: 'utf8', timeout: 5000 }), 'Sotto pasted into stock foot — café 🚀')
  await deliver('Alacritty', alacritty, client => client.class === 'Alacritty', ['terminal*'], 'Sotto pasted into Alacritty — café 🚀', () => readFileSync(alacrittyFile, 'utf8'))
  await deliver('Chromium', chromium, client => client.title === 'pastebox', [], 'Sotto pasted into Chromium — naïve façade ✓', readChromium)
  await invoke('window.sotto.updateSettings({ showWidgetWhenIdle: true, onboardingComplete: true })')
  const widget = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html'))"
  await poll('Idle widget shown', remaining => inspector.evaluate(`Boolean((${widget}).isVisible())`, Math.min(2000, remaining), false), sotto)
  await cdp.evaluate('document.getElementById("t").value = ""')
  const widgetFirst = 'Widget on: first dictation — café 🚀'
  const widgetSecond = ' + second dictation to the same target ✓'
  await deliver('widget on first', chromium, client => client.title === 'pastebox', [], widgetFirst, readChromium)
  assert.equal(await inspector.evaluate(`(${widget}).isVisible()`, 5000, false), true, 'Idle widget stays visible after paste')
  await deliver('widget on second', chromium, client => client.title === 'pastebox', [], widgetSecond, async () => {
    const received = await readChromium()
    return received.startsWith(widgetFirst) ? received.slice(widgetFirst.length) : received
  }, false)
  assert.equal(await readChromium(), widgetFirst + widgetSecond, 'Both dictations reach the same textarea without refocusing')
  console.log('widget on: target focus retained; second dictation reached the same target without refocusing')
  execFileSync('grim', [join(out, 'nested.png')], { env: nested, timeout: 5000 })
  console.log('screenshot:', join(out, 'nested.png'))
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  console.log('PASS: exact paste into foot, stock foot with seeded PRIMARY, Alacritty and Chromium; widget-on focus and second dictation')
} finally {
  await lifecycle.cleanup()
}
