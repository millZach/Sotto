// Live desktop proof (sends keys): npm run build && mise exec node@24.22.1 -- node scripts/verify-hyprland-paste-keyboards.mjs
// Run only while the owner has made the unlocked forge desktop available for testing.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as wait } from 'node:timers/promises'
import { createOwnedProofProcesses, installProofCleanup, terminateThenCleanup, snapshotProofInstances, assertProofInstancesPreserved, isProofProcessAlive } from './owned-proof-processes.mjs'
import { fetchProofJson, openProofDebugger } from './proof-debugger.mjs'

assert.equal(process.platform, 'linux')
const root = process.cwd()
const out = resolve(process.argv[2] ?? '.cache/paste-keyboard/live')
assert.ok(out.startsWith(`${root}/`), 'Keep proof files inside this checkout')
let scratch
const shellPid = execFileSync('pgrep', ['-x', 'quickshell'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0]
const session = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
  .map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
assert.ok(session.HYPRLAND_INSTANCE_SIGNATURE && session.WAYLAND_DISPLAY && session.XDG_RUNTIME_DIR)
const env = { ...session, YDOTOOL_SOCKET: join(session.XDG_RUNTIME_DIR, '.ydotool_socket') }
for (const key of Object.keys(env)) if (key.startsWith('SOTTO_E2E') || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
const hyprctl = (...args) => execFileSync('hyprctl', args, { env, encoding: 'utf8', timeout: 5000 }).trim()
const unlocked = () => assert.equal(JSON.parse(hyprctl('locked', '-j')).locked, false, 'Never send keys to a locked desktop')
unlocked()
const version = JSON.parse(hyprctl('version', '-j'))
const instancesDirectory = join(env.XDG_RUNTIME_DIR, 'hypr')
const instancesBefore = snapshotProofInstances(instancesDirectory)
const originalFocus = JSON.parse(hyprctl('activewindow', '-j')).address
const owned = createOwnedProofProcesses(console.log)
const debuggers = []
const results = []
const startedAt = new Date().toISOString()
let inspector, sotto, sottoStart, dictationDirectoryIdentity
const dictationDirectory = join(env.XDG_RUNTIME_DIR, 'sotto')
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
const retireDictationFiles = () => {
  if (!sotto?.pid || !dictationDirectoryIdentity || !existsSync(dictationDirectory)) return
  assert.equal(isProofProcessAlive(sotto.pid), false, 'Never retire files while that PID is live')
  assert.ok(sameFile(lstatSync(dictationDirectory), dictationDirectoryIdentity), 'Never clean a replaced dictation folder')
  const privateSocket = new RegExp(`^dictation-${sotto.pid}-[a-f0-9]{8}\\.sock$`, 'u')
  for (const name of readdirSync(dictationDirectory)) {
    const path = join(dictationDirectory, name)
    const identity = lstatSync(path)
    if (identity.uid !== process.getuid()) continue
    const ours = (privateSocket.test(name) && identity.isSocket())
      || (name === 'dictation.sock' && identity.isSymbolicLink() && privateSocket.test(readlinkSync(path)))
      || (name === 'dictation-state.json' && identity.isFile() && (() => {
        const state = JSON.parse(readFileSync(path, 'utf8'))
        return state.pid === sotto.pid && state.pidStart === sottoStart
      })())
    if (!ours) continue
    assert.ok(sameFile(lstatSync(path), identity), 'Never remove a replaced dictation file')
    unlinkSync(path)
    console.log(`Removed proof-owned dictation file: ${name}`)
  }
}
const lifecycle = installProofCleanup(() => terminateThenCleanup(async () => {
  // Let Sotto remove its own live dictation endpoint before terminating the scope.
  try { await inspector?.evaluate("process.mainModule.require('electron').app.quit()", 1000, false) } catch { /* The inspector closes on quit. */ }
  const deadline = performance.now() + 11000 // Sotto's quit drain allows ten seconds.
  while (sotto && sotto.exitCode === null && sotto.signalCode === null && performance.now() < deadline) await wait(50)
  if (!dictationDirectoryIdentity && existsSync(dictationDirectory)) dictationDirectoryIdentity = lstatSync(dictationDirectory)
  await owned.stop()
}, [
  () => { for (const debuggerClient of debuggers) debuggerClient.close() },
  retireDictationFiles,
  () => {
    if (originalFocus && JSON.parse(hyprctl('clients', '-j')).some(client => client.address === originalFocus)) {
      hyprctl('dispatch', `hl.dsp.focus({ window = "address:${originalFocus}" })`)
    }
  },
  () => { if (scratch) rmSync(scratch, { recursive: true, force: true }) },
  () => assertProofInstancesPreserved(instancesDirectory, instancesBefore),
]), console.log, 20000)

const poll = async (label, check, timeoutMs = 15000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    lifecycle.assertRunning()
    const result = await check()
    if (result) return result
    await wait(50)
  }
  throw new Error(`${label}: deadline`)
}
const connect = async url => {
  const client = await openProofDebugger(url)
  debuggers.push(client)
  return client
}
const assertTarget = (target, child) => {
  const current = JSON.parse(hyprctl('activewindow', '-j'))
  assert.equal(current.address, target.address, 'Input must go to the focused proof target')
  assert.equal(current.pid, target.pid, 'The focused target PID must be unchanged')
  assert.ok(owned.owns(current.pid, child), 'The focused target must still belong to this proof')
}
const runKeyboard = (executable, args, target, targetProcess) => new Promise((resolve, reject) => {
  unlocked()
  assertTarget(target, targetProcess)
  const child = owned.start(executable, executable, args, { env, stdio: 'ignore' })
  const timer = setTimeout(() => reject(new Error(`${executable}: deadline`)), 5000)
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('exit', code => {
    clearTimeout(timer)
    if (code === 0) resolve()
    else reject(new Error(`${executable}: exit ${code}`))
  })
})
const seed = async (text, primary = false) => {
  const child = owned.start(primary ? 'PRIMARY sentinel' : 'clipboard sentinel', 'wl-copy',
    ['--foreground', ...(primary ? ['--primary'] : []), '--type', 'text/plain;charset=utf-8'], { env, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.on('error', () => {}) // Early exit is reported by polling below.
  child.stdin.end(text)
  await poll('Selection seeded', () => {
    if (child.proofError) throw child.proofError
    try { return execFileSync('wl-paste', [...(primary ? ['--primary'] : []), '--no-newline'], { env, encoding: 'utf8', timeout: 1000 }) === text }
    catch { return false }
  })
}

try {
  mkdirSync(out, { recursive: true })
  scratch = mkdtempSync(join(out, 'run-'))
  // Isolate settings; the real desktop runtime is needed by Hyprland and wl-clipboard.
  sotto = owned.start('Sotto', '/usr/bin/env', [
    `XDG_CONFIG_HOME=${join(scratch, 'config')}`,
    join(root, 'node_modules/electron/dist/electron'), '--inspect=127.0.0.1:0', '--password-store=basic', root,
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (sotto.pid) {
    const stat = readFileSync(`/proc/${sotto.pid}/stat`, 'utf8')
    sottoStart = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
  }
  let inspectorUrl
  sotto.stderr.on('data', chunk => {
    inspectorUrl ??= /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/u.exec(chunk.toString())?.[0]
    appendFileSync(join(scratch, 'sotto-boot.log'), chunk)
  })
  await poll('Sotto inspector', () => {
    if (sotto.proofError) throw sotto.proofError
    assert.equal(sotto.exitCode, null, 'Sotto must stay running')
    return inspectorUrl
  })
  inspector = await connect(inspectorUrl)
  assert.equal(await inspector.evaluate('process.pid', 5000, false), sotto.pid, 'Drive only the owned Sotto process')
  const mainWindow = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
  await poll('Sotto preload', async () => {
    try { return await inspector.evaluate(`Boolean(process.mainModule && (${mainWindow}) && !(${mainWindow}).webContents.isLoading())`, 2000, false) }
    catch (error) { if (/Execution context was destroyed|Promise was collected/u.test(error.message)) return false; throw error }
  })
  await poll('Sotto window shown', () => inspector.evaluate(`(${mainWindow}).isVisible()`, 2000, false))
  if (existsSync(dictationDirectory)) dictationDirectoryIdentity = lstatSync(dictationDirectory)
  const invoke = expression => inspector.evaluate(`(${mainWindow}).webContents.executeJavaScript(${JSON.stringify(expression)})`)
  await invoke('window.sotto.updateSettings({ autoPaste: true, showWidgetWhenIdle: false, localHostEnabled: false })')
  await inspector.evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.hide())", 5000, false)

  const chromiumProfile = join(scratch, 'chromium')
  const chromium = owned.start('Chromium', 'chromium', [`--user-data-dir=${chromiumProfile}`, '--ozone-platform=wayland', '--no-first-run',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--app=data:text/html,<title>Sotto paste keyboard proof</title><textarea id=t autofocus style="width:95vw;height:85vh"></textarea>'], { env, stdio: 'ignore' })
  const port = await poll('Chromium debugger', () => {
    try { return Number(readFileSync(join(chromiumProfile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  })
  // The fresh profile and socket owner tie CDP discovery to this proof's browser.
  const listener = readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/u))
    .find(fields => fields[1] === `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}` && fields[3] === '0A')
  assert.ok(listener && readdirSync(`/proc/${chromium.pid}/fd`).some(fd => {
    try { return readlinkSync(`/proc/${chromium.pid}/fd/${fd}`) === `socket:[${listener[9]}]` } catch { return false }
  }), 'The owned Chromium must own the loopback debugger listener')
  const page = await poll('Chromium textarea page', async () =>
    (await fetchProofJson(`http://127.0.0.1:${port}/json/list`)).find(target => target.type === 'page' && target.title === 'Sotto paste keyboard proof'))
  const cdp = await connect(page.webSocketDebuggerUrl)
  const readChromium = () => cdp.evaluate('document.getElementById("t").value')
  const terminalFile = join(out, 'foot.txt')
  const terminalReady = join(scratch, 'foot-ready')
  writeFileSync(terminalFile, '')
  const foot = owned.start('foot', 'foot', ['-c', '/dev/null', '-a', 'foot', '-T', 'Sotto paste keyboard proof', '-e',
    'sh', '-c', 'stty raw -echo; : > "$2"; exec cat > "$1"', 'proof-cat', terminalFile, terminalReady], { env, stdio: 'ignore' })
  await poll('Terminal cat ready', () => existsSync(terminalReady))

  for (const target of ['Chromium', 'foot']) {
    const child = target === 'Chromium' ? chromium : foot
    const client = await poll(`${target} window`, () => JSON.parse(hyprctl('clients', '-j')).find(window => owned.owns(window.pid, child)))
    for (const keyboard of ['wtype', 'ydotool']) {
      unlocked()
      hyprctl('dispatch', `hl.dsp.focus({ window = "address:${client.address}" })`)
      hyprctl('dispatch', `hl.dsp.cursor.move({ x = ${Math.round(client.at[0] + client.size[0] / 2)}, y = ${Math.round(client.at[1] + client.size[1] / 2)} })`)
      await poll('Target focused', () => JSON.parse(hyprctl('activewindow', '-j')).address === client.address)
      // Keymap/focus delivery to the client follows the compositor reply asynchronously.
      await wait(150)
      if (target === 'Chromium') await cdp.evaluate('document.getElementById("t").focus(); document.getElementById("t").value = ""')
      const offset = target === 'foot' ? readFileSync(terminalFile).length : 0
      const text = `Sotto ${target} after ${keyboard} — café 🚀 ✓`
      await seed('Wrong clipboard: this must be replaced')
      if (target === 'foot') await seed('Wrong PRIMARY: this must be replaced', true)
      await runKeyboard(keyboard, keyboard === 'wtype' ? ['x'] : ['type', 'x'], client, child)
      const receive = async () => target === 'Chromium' ? readChromium() : readFileSync(terminalFile).subarray(offset).toString('utf8')
      await poll('Last keystroke arrived', async () => (await receive()) === 'x')
      unlocked()
      assertTarget(client, child)
      const delivery = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text, autoPaste: true, pasteDelayMs: 150 })})`)
      try { await poll('Exact paste received', async () => (await receive()) === `x${text}`, 2500) } catch { /* Keep all four verdicts when reproducing. */ }
      const received = await receive()
      const passed = delivery === 'pasted' && received === `x${text}` && JSON.parse(hyprctl('activewindow', '-j')).address === client.address
      results.push({ target, keyboard, delivery, expected: `x${text}`, received, passed })
      console.log(`${passed ? 'PASS' : 'FAIL'}: ${target} after ${keyboard}; deliverOutput=${delivery}; received=${JSON.stringify(received)}`)
      execFileSync('grim', [join(out, `${target.toLowerCase()}-${keyboard}.png`)], { env, timeout: 5000 })
    }
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ startedAt, hyprland: version, results }, null, 2) + '\n')
  assert.ok(results.length === 4 && results.every(result => result.passed), 'All four keyboard/target combinations must receive exact text')
  console.log('PASS: actual Sotto output reaches Chromium and stock foot after both keyboards')
} finally {
  await lifecycle.cleanup()
}
