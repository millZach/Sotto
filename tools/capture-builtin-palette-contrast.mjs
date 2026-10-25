// After build: mise exec node@24.22.1 -- node tools/capture-builtin-palette-contrast.mjs <output-root> [main-entry]
// The captures land in <output-root>/builtin-palette-contrast/, through SOTTO_E2E_ARTIFACT_ROOT (docs/ci.md, E2e evidence).
// Captures the surfaces #936 fixed in every built-in half. The live session tiles an owned nested Hyprland (A) at
// whatever size its layout allows, so a second one (B) runs inside A, floated at an exact size; the app runs on B
// and grim captures B's output. B and the app share a private session bus with no service directories, so no
// portal can activate. Pass an older build's out/main/index.js as main-entry to capture the look before a change.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const SIZE = { width: 1280, height: 1000 }

if (process.argv[2] === '--inner') await inner(process.argv[3])
else await outer(process.argv[2], process.argv[3])

async function outer(output, entry) {
  if (!output) throw new Error('Usage: node tools/capture-builtin-palette-contrast.mjs <output-root> [main-entry]')
  const evidence = resolve(output)
  mkdirSync(evidence, { recursive: true })
  const temporary = mkdtempSync('/tmp/sotto-palette-')
  for (const folder of ['home', 'tmp', 'config', 'state', 'data', 'cache']) mkdirSync(join(temporary, folder))
  const busConfig = join(temporary, 'session-bus.conf')
  writeFileSync(busConfig, '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>\n')
  const child = spawn(process.execPath, [
    'scripts/with-nested-hyprland.mjs', join(temporary, 'sandbox'), 'dbus-run-session', `--config-file=${busConfig}`, '--',
    process.execPath, 'tools/capture-builtin-palette-contrast.mjs', '--inner', temporary,
  ], { stdio: 'inherit', env: {
    ...process.env, HOME: join(temporary, 'home'), TMPDIR: join(temporary, 'tmp'),
    XDG_CONFIG_HOME: join(temporary, 'config'), XDG_STATE_HOME: join(temporary, 'state'),
    XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
    SOTTO_PALETTE_CONTRAST_EVIDENCE: '1', SOTTO_E2E_ARTIFACT_ROOT: evidence,
    ...(entry ? { SOTTO_E2E_MAIN_ENTRY: resolve(entry) } : {}),
  } })
  console.log(`Owned nested capture runner PID ${child.pid}; isolated home ${temporary}`)
  const stop = () => child.kill('SIGTERM')
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
    process.exitCode = code ?? 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    removeInnerFolder(join(temporary, 'inner-display.json'))
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** A stopped run can leave B's runtime folder behind; remove it only if it is still the one B made and B is gone. */
function removeInnerFolder(record) {
  if (!existsSync(record)) return
  const { folder, pid, ino, dev } = JSON.parse(readFileSync(record, 'utf8'))
  const current = statSync(folder, { throwIfNoEntry: false })
  if (!current || current.ino !== ino || current.dev !== dev) return
  try { process.kill(pid, 0); return } catch { /* B has exited */ }
  rmSync(folder, { recursive: true, force: true })
  console.log(`Removed inner display folder ${folder}`)
}

/** Runs on A, under the private bus: starts B inside A at an exact size, then the spec on B. */
async function inner(temporary) {
  const a = { ...process.env }
  assert.ok(a.HYPRLAND_INSTANCE_SIGNATURE && a.WAYLAND_DISPLAY, 'Expected to run on the nested display A')
  const hypr = (signature, args) => execFileSync('hyprctl', args, { env: { ...a, HYPRLAND_INSTANCE_SIGNATURE: signature }, encoding: 'utf8' })
  const config = join(temporary, 'inner-hyprland.lua')
  writeFileSync(config, `hl.monitor({ output = "", mode = "${SIZE.width}x${SIZE.height}@60", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false }, ecosystem = { no_update_news = true, no_donation_nag = true } })\n`)
  const env = { ...a }
  delete env.HYPRLAND_INSTANCE_SIGNATURE
  const b = spawn('Hyprland', ['-c', config], { env: { ...env, HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: 'ignore' })
  // Listen from the start: a compositor killed by a signal keeps a null exit code, and its exit event fires only once.
  const exited = new Promise(done => b.once('exit', done))
  let instance, identity
  const directory = join(a.XDG_RUNTIME_DIR, 'hypr')
  try {
    for (const deadline = Date.now() + 20000; !instance && Date.now() < deadline; await wait(100)) {
      assert.ok(b.exitCode === null && b.signalCode === null, 'Inner compositor exited')
      instance = JSON.parse(hypr(a.HYPRLAND_INSTANCE_SIGNATURE, ['instances', '-j'])).find(item => item.pid === b.pid)
    }
    assert.ok(instance, 'Inner compositor must start')
    assert.notEqual(instance.instance, a.HYPRLAND_INSTANCE_SIGNATURE)
    identity = statSync(join(directory, instance.instance))
    writeFileSync(join(temporary, 'inner-display.json'), JSON.stringify({ folder: join(directory, instance.instance), pid: b.pid, ino: identity.ino, dev: identity.dev }))
    let client
    for (const deadline = Date.now() + 20000; !client && Date.now() < deadline; await wait(100)) {
      client = JSON.parse(hypr(a.HYPRLAND_INSTANCE_SIGNATURE, ['clients', '-j'])).find(item => item.pid === b.pid)
    }
    assert.ok(client, 'Inner compositor window must open in A')
    for (const action of [`hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`,
      `hl.dsp.window.resize({ x = ${SIZE.width}, y = ${SIZE.height}, window = "address:${client.address}" })`,
      `hl.dsp.window.move({ x = 0, y = 0, window = "address:${client.address}" })`]) hypr(a.HYPRLAND_INSTANCE_SIGNATURE, ['dispatch', action])
    for (const deadline = Date.now() + 20000; ; await wait(100)) {
      const [monitor] = JSON.parse(hypr(instance.instance, ['monitors', '-j']))
      if (monitor?.width === SIZE.width && monitor?.height === SIZE.height) break
      assert.ok(Date.now() < deadline, `Inner output must be ${SIZE.width}x${SIZE.height}`)
    }
    hypr(instance.instance, ['dismissnotify'])
    console.log(`inner display ${instance.wl_socket} at ${SIZE.width}x${SIZE.height} inside ${a.WAYLAND_DISPLAY}`)
    const spec = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/e2e/builtin-palette-contrast.spec.ts',
      '--workers=1', `--output=${join(temporary, 'test-results')}`], {
      stdio: 'inherit', env: { ...env, WAYLAND_DISPLAY: instance.wl_socket, HYPRLAND_INSTANCE_SIGNATURE: instance.instance },
    })
    const code = await new Promise((done, reject) => { spec.once('error', reject); spec.once('exit', done) })
    assert.equal(code, 0, 'The capture spec must pass')
  } finally {
    b.kill('SIGTERM')
    await exited
    if (instance && identity) {
      const folder = join(directory, instance.instance)
      const current = statSync(folder, { throwIfNoEntry: false })
      if (current && current.ino === identity.ino && current.dev === identity.dev) rmSync(folder, { recursive: true, force: true })
    }
  }
}
