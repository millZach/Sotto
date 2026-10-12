// In a nested display: node scripts/verify-linux-shutdown-drain.mjs .cache/shutdown-proof
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import ts from 'typescript'
import { installProofCleanup } from './owned-proof-processes.mjs'

assert.equal(process.platform, 'linux')
assert.ok(process.env.SOTTO_PACKAGE_NESTED_PID, 'Use scripts/with-nested-hyprland.mjs')
const output = resolve(process.argv[2] ?? '.cache/shutdown-proof')
assert.ok(output.startsWith(`${resolve('.cache')}/`), 'Keep proof output in the worktree cache')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'run-'))
const children = []
const lifecycle = installProofCleanup(async () => {
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGTERM')
    const exited = new Promise(resolveExit => child.once('exit', resolveExit))
    await Promise.race([exited, wait(2000)])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    console.log(`Stopped proof PID ${child.pid}`)
  }
}, console.log)
function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  child.once('error', error => { child.proofError = error })
  child.proofOutput = () => output
  children.push(child)
  console.log(`Started proof PID ${child.pid}: ${command}`)
  return child
}
async function events(directory, file) {
  try { return (await readFile(join(directory, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function until(check, description) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    lifecycle.assertRunning()
    if (await check()) return
    await wait(20)
  }
  throw new Error(`Proof did not reach: ${description}\n${children.map(child => child.proofOutput()).join('\n')}`)
}
const require = createRequire(import.meta.url)
const electron = require('electron')
const results = []
try {
  await mkdir(root, { recursive: true })
  for (const module of ['quitDrain', 'hostQuitDrain']) {
    const source = await readFile(`src/main/app/${module}.ts`, 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    await writeFile(join(root, `${module}.js`), compiled)
  }
  const entry = join(root, 'electron-proof.cjs')
  await writeFile(entry, `const { app, powerMonitor } = require('electron')
const { appendFileSync, existsSync, watch } = require('node:fs')
const { join } = require('node:path')
const { registerHostQuitDrain } = require('./hostQuitDrain.js')
const root = process.env.SOTTO_SHUTDOWN_PROOF_ROOT
const mode = process.env.SOTTO_SHUTDOWN_PROOF_MODE
app.setPath('userData', join(root, 'profile'))
app.commandLine.appendSwitch('password-store', 'basic')
const record = event => appendFileSync(join(root, 'app-events.jsonl'), JSON.stringify({event, at: Date.now()}) + '\\n')
app.whenReady().then(() => {
  record('ready')
  if (mode === 'control') {
    const shutdown = () => record('unprevented')
    powerMonitor.on('shutdown', shutdown)
    powerMonitor.removeListener('shutdown', shutdown)
    powerMonitor.on('shutdown', shutdown)
    return
  }
  registerHostQuitDrain(app, {
    localRuntime: { close: async () => {
      record('drain-started')
      const pending = new Promise(resolve => {
        const watcher = watch(root, () => {
          if (existsSync(join(root, 'release'))) { watcher.close(); resolve() }
        })
      })
      await pending
      record('writes-drained')
    } },
    phoneAccess: { close: async () => { record('phone-cleanup-started'); if (mode !== 'settled') await new Promise(() => {}) } },
  }, () => record('drain-failed'), () => record('phone-failed'), 'linux', powerMonitor)
  // Phone cleanup is deliberately held; local persistence must start without waiting for it.
  app.on('quit', () => record('quit'))
  if (mode === 'during-quit') app.quit()
})
`)
  for (const mode of ['control', 'timeout', 'held-write', 'settled', 'during-quit']) {
    const directory = join(root, mode)
    await mkdir(directory, { recursive: true })
    const address = `unix:abstract=sotto-shutdown-${randomUUID()}`
    const config = join(directory, 'dbus.conf')
    await writeFile(config, `<busconfig><type>session</type><listen>${address}</listen><auth>EXTERNAL</auth><policy context="default"><allow user="${process.getuid()}"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`)
    const env = { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: address, DBUS_SESSION_BUS_ADDRESS: address }
    delete env.ELECTRON_RUN_AS_NODE
    const bus = start('dbus-daemon', ['--nofork', '--print-address', `--config-file=${config}`], env)
    await until(() => bus.proofOutput().includes(address), 'private bus listening')
    const service = start('/usr/bin/python', ['tests/fixtures/fakeLogind.py', directory], env)
    await until(async () => (await events(directory, 'bus-events.jsonl')).some(event => event.event === 'service-ready'), 'inert login1 ready')
    const app = start(electron, [entry, '--ozone-platform=wayland'], {
      ...env, SOTTO_SHUTDOWN_PROOF_ROOT: directory, SOTTO_SHUTDOWN_PROOF_MODE: mode,
    })
    await until(async () => (await events(directory, 'bus-events.jsonl')).some(event => event.event === 'inhibit' && event.what === 'shutdown'), 'shutdown inhibitor acquired with shutdown as first listener')
    await writeFile(join(directory, 'notice'), 'first')
    if (mode === 'control') {
      await until(async () => (await events(directory, 'app-events.jsonl')).some(event => event.event === 'unprevented'), 'native unprevented shutdown delivered')
      await until(async () => (await events(directory, 'bus-events.jsonl')).some(event => event.event === 'released' && event.what === 'shutdown'), 'unprevented inhibitor released')
      assert.equal(app.exitCode, null, 'Electron Linux does not quit by itself')
      results.push({ mode, nativeSignal: true, inhibitorReleased: true, noAutomaticQuit: true })
      app.kill('SIGTERM')
      await until(() => app.exitCode !== null || app.signalCode !== null, 'control Electron stopped')
    } else {
      await until(async () => (await events(directory, 'app-events.jsonl')).some(event => event.event === 'drain-started'), 'production local drain started')
      assert.ok(!(await events(directory, 'bus-events.jsonl')).some(event => event.event === 'released' && event.what === 'shutdown'), 'Inhibitor retained while drain is pending')
      await writeFile(join(directory, 'notice'), 'second')
      if (mode === 'held-write' || mode === 'settled' || mode === 'during-quit') {
        await writeFile(join(directory, 'release'), '')
        await until(async () => (await events(directory, 'app-events.jsonl')).some(event => event.event === 'writes-drained'), 'accepted local write drained despite held phone cleanup')
      }
      await until(() => app.exitCode !== null || app.signalCode !== null, 'bounded production exit')
      assert.equal(app.exitCode, 0, app.proofOutput())
      await until(async () => (await events(directory, 'bus-events.jsonl')).some(event => event.event === 'released' && event.what === 'shutdown'), 'exit released native inhibitor')
      const observed = await events(directory, 'app-events.jsonl')
      assert.equal(observed.filter(event => event.event === 'drain-started').length, 1)
      assert.equal(observed.some(event => event.event === 'writes-drained'), mode === 'held-write' || mode === 'settled' || mode === 'during-quit')
      results.push({ mode, nativeSignal: true, inhibitorRetainedDuringDrain: true, inhibitorReleasedAtExit: true, exitCode: app.exitCode, events: observed })
    }
    service.kill('SIGTERM'); bus.kill('SIGTERM')
    await until(() => (service.signalCode !== null || service.exitCode !== null) && (bus.signalCode !== null || bus.exitCode !== null), 'private service and bus stopped')
  }
  await writeFile(join(root, 'result.json'), JSON.stringify({ electron: require('electron/package.json').version, results }, null, 2))
  console.log(JSON.stringify({ root, results }))
} finally { await lifecycle.cleanup() }
