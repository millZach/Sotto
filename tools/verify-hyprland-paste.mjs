// Locked-screen proof: mise exec node@24.21.0 -- node tools/verify-hyprland-paste.mjs
// Uses the built app's real preload/output path. All key dispatch goes to a recording stub.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const scratch = join(root, '.cache/hyprland-paste-proof')
const evidence = join(root, 'artifacts/linux-hyprland-paste')
await mkdir(scratch, { recursive: true })
await mkdir(evidence, { recursive: true })
const shellPid = execFileSync('pgrep', ['-x', 'quickshell']).toString().trim().split('\n')[0]
const session = Object.fromEntries((await readFile(`/proc/${shellPid}/environ`, 'utf8')).split('\0')
  .filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
const env = { ...process.env, ...session, XDG_CONFIG_HOME: join(scratch, `profile-${Date.now()}`) }
await mkdir(env.XDG_CONFIG_HOME, { recursive: true })
for (const key of Object.keys(env)) if (key.startsWith('SOTTO_E2E') || key === 'ELECTRON_RUN_AS_NODE') delete env[key]
const clipboard = () => execFileSync('wl-paste', ['--no-newline'], { env, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
const owners = () => new Set(execFileSync('pgrep', ['-x', 'wl-copy'], { encoding: 'utf8' }).trim().split('\n').map(Number))
let existingOwners
try { existingOwners = owners() } catch { existingOwners = new Set() }
const writeClipboard = text => execFileSync('wl-copy', ['--type', 'text/plain;charset=utf-8'], { env, input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 })
const locked = execFileSync('/usr/bin/hyprctl', ['locked', '-j'], { env, encoding: 'utf8' }).trim()
assert.equal(JSON.parse(locked).locked, true, 'This proof is for the locked forge session')
const stub = join(scratch, 'bin')
await mkdir(stub, { recursive: true })
await writeFile(join(stub, 'hyprctl'), '#!/bin/sh\nexec "$SOTTO_HYPRCTL_NODE" "$SOTTO_HYPRCTL_STUB" "$@"\n', { mode: 0o700 })
Object.assign(env, {
  PATH: `${stub}:${env.PATH}`, SOTTO_HYPRCTL_NODE: process.execPath,
  SOTTO_HYPRCTL_STUB: join(root, 'tests/fixtures/hyprctl.mjs'),
  SOTTO_HYPRCTL_LOG: join(evidence, 'hyprctl-arguments.jsonl'), SOTTO_HYPRCTL_TAGS: 'app',
})
await writeFile(env.SOTTO_HYPRCTL_LOG, '')
const bootLog = await open(join(scratch, 'electron-boot.log'), 'w')
const child = spawn(join(root, 'node_modules/electron/dist/electron'), ['--inspect=9345', root], { env, stdio: ['ignore', bootLog.fd, bootLog.fd] })
let socket
let id = 0
const lines = []
const report = (name, value) => { const line = `${name}: ${JSON.stringify(value)}`; lines.push(line); console.log(line) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let childExited = false
child.once('exit', () => { childExited = true })
try {
  let target
  const deadline = Date.now() + 20000
  while (!target && Date.now() < deadline && !childExited) {
    try { target = (await (await fetch('http://127.0.0.1:9345/json/list')).json())[0] } catch { await wait(100) }
  }
  assert.ok(target, 'Main inspector did not start')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const evaluate = expression => new Promise((resolve, reject) => {
    const mine = ++id
    const timeout = setTimeout(() => { socket.removeEventListener('message', onMessage); reject(new Error('Inspector deadline')) }, 15000)
    const onMessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== mine) return
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message ?? message.result?.exceptionDetails?.exception?.description ?? 'Inspector evaluation failed'))
      else resolve(message.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  const windowExpression = "process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
  let ready = false
  while (!ready && Date.now() < deadline) {
    try {
      ready = await evaluate(`(() => { if (!process.mainModule) return false; const w = ${windowExpression}; return Boolean(w && !w.webContents.isLoading()); })()`)
    } catch (error) {
      if (!/Promise was collected|Execution context was destroyed/u.test(error.message)) throw error
    }
    if (!ready) await wait(100)
  }
  assert.ok(ready, 'Main preload did not start')
  const invoke = expression => evaluate(`(async () => { const w = ${windowExpression}; return w.webContents.executeJavaScript(${JSON.stringify(expression)}) })()`)
  await invoke('window.sotto.updateSettings({ autoPaste: true, showWidgetWhenIdle: false, localHostEnabled: false })')
  await evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.hide())")
  report('session locked (read-only query)', JSON.parse(locked).locked)
  writeClipboard('before-hyprland-paste-proof')
  report('wl-paste before', clipboard())
  const focused = await evaluate("Boolean(process.mainModule.require('electron').BrowserWindow.getFocusedWindow())")
  assert.equal(focused, false)
  report('Sotto focused', focused)
  const transcript = 'Sotto Wayland output while unfocused — café 🚀\nSecond line.'
  const delivery = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text: transcript, autoPaste: false, pasteDelayMs: 50 })})`)
  report('real output result', delivery)
  const actual = clipboard()
  assert.equal(actual, transcript)
  report('wl-paste after real output', actual)
  await wait(300)
  assert.equal(clipboard(), transcript)
  report('wl-paste after settle (no automatic restore)', clipboard())
  for (const target of ['app', 'terminal']) {
    await evaluate(`process.env.SOTTO_HYPRCTL_TAGS = ${JSON.stringify(target)}`)
    const result = await invoke(`window.sotto.deliverOutput(${JSON.stringify({ text: transcript, autoPaste: true, pasteDelayMs: 50 })})`)
    assert.equal(result, 'pasted')
    report(`stubbed ${target} output result`, result)
    assert.equal(clipboard(), transcript)
  }
  report('real key dispatch', 'NOT VERIFIED — screen locked; every dispatch used a recording stub')
  await writeFile(join(evidence, 'clipboard-proof.txt'), `${lines.join('\n')}\n`)
} finally {
  socket?.close()
  // Electron tears its own subprocesses down on SIGTERM. Stop only this owned main PID.
  if (!childExited) child.kill('SIGTERM')
  for (let tries = 0; tries < 30 && !childExited; tries++) await wait(100)
  if (!childExited) child.kill('SIGKILL')
  await bootLog.close()
  console.log(`Stopped Electron PID ${child.pid}`)
  // Windows does not restore the old selection, so Linux does not either. Retire
  // the synthetic test selection by stopping its owned wl-copy process by PID.
  let remaining
  try { remaining = owners() } catch { remaining = new Set() }
  for (const pid of remaining) {
    if (!existingOwners.has(pid)) {
      try { process.kill(pid, 'SIGTERM'); console.log(`Stopped wl-copy PID ${pid}`) } catch { /* Already retired. */ }
    }
  }
  await rm(env.XDG_CONFIG_HOME, { recursive: true, force: true })
}
