// Usage after build: mise exec node@24.21.0 -- node scripts/verify-shell-plumbing.mjs [Playwright spec ...]
// An owned nested Hyprland and systemd scopes keep all input and descendants away from the locked live session.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { assertProofInstancesPreserved, createOwnedProofProcesses, installProofCleanup, snapshotProofInstances, terminateThenCleanup } from './owned-proof-processes.mjs'

const checkout = process.cwd()
const captures = resolve(checkout, 'artifacts/linux-shell-plumbing')
mkdirSync(captures, { recursive: true })
const shellPid = execFileSync('pgrep', ['-x', 'quickshell'], { encoding: 'utf8' }).trim().split('\n')[0]
const live = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
  const i = entry.indexOf('=')
  return [entry.slice(0, i), entry.slice(i + 1)]
}))
const runtime = live.XDG_RUNTIME_DIR
assert.ok(runtime && live.HYPRLAND_INSTANCE_SIGNATURE && live.WAYLAND_DISPLAY)
const instanceRoot = join(runtime, 'hypr')
const before = snapshotProofInstances(instanceRoot)
const owned = createOwnedProofProcesses(console.log)
// mkdtemp creates a private 0700 folder. Keep Unix socket paths short even in a deep checkout.
const temporaryRoot = mkdtempSync('/tmp/sp-')
assert.equal(statSync(temporaryRoot).mode & 0o777, 0o700)
console.log(`Temporary root ${temporaryRoot}: mode 700`)
const temporaryEnvironment = {
  TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot,
  XDG_CONFIG_HOME: join(temporaryRoot, 'config'), XDG_CACHE_HOME: join(temporaryRoot, 'cache'),
  PWTEST_CACHE_DIR: join(temporaryRoot, 'playwright-cache'),
}
let compositor, signature, display, folderIdentity
const lifecycle = installProofCleanup(() => terminateThenCleanup(() => owned.stop(), [() => {
  if (signature && !before.has(signature) && signature !== live.HYPRLAND_INSTANCE_SIGNATURE) {
    const folder = join(instanceRoot, signature)
    if (existsSync(folder)) {
      const current = statSync(folder)
      assert.equal(current.ino, folderIdentity.ino)
      assert.equal(current.dev, folderIdentity.dev)
      rmSync(folder, { recursive: true, force: true })
    }
  }
  assertProofInstancesPreserved(instanceRoot, before, signature)
  console.log('cleanup: owned PIDs stopped; prior Hyprland instances preserved')
}, () => {
  rmSync(temporaryRoot, { recursive: true, force: true })
  assert.ok(!existsSync(temporaryRoot))
  console.log(`Temporary root removed: ${temporaryRoot}`)
}]), console.log)
const instances = () => JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { env: live, encoding: 'utf8' }))
try {
  const config = join(temporaryRoot, 'hyprland.lua')
  writeFileSync(config, 'hl.monitor({ output = "", mode = "1600x1000@60", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n')
  compositor = owned.start('nested Hyprland', 'Hyprland', ['-c', config], {
    env: { ...process.env, ...temporaryEnvironment, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: live.WAYLAND_DISPLAY, HYPRLAND_INSTANCE_SIGNATURE: '', HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: 'ignore',
  })
  const deadline = Date.now() + 20_000
  let instance
  while (Date.now() < deadline) {
    lifecycle.assertRunning()
    if (compositor.proofError) throw compositor.proofError
    instance = instances().find(candidate => candidate.pid === compositor.pid)
    if (instance) break
    await wait(100)
  }
  assert.ok(instance, 'The owned nested compositor must start')
  signature = instance.instance
  display = instance.wl_socket
  assert.notEqual(signature, live.HYPRLAND_INSTANCE_SIGNATURE)
  assert.notEqual(display, live.WAYLAND_DISPLAY)
  folderIdentity = statSync(join(instanceRoot, signature))
  console.log(`nested Hyprland PID ${compositor.pid}: ${signature} on ${display}; live instance untouched`)
  const env = { ...process.env, ...temporaryEnvironment, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: display, HYPRLAND_INSTANCE_SIGNATURE: signature, XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', SOTTO_PROOF_CAPTURE_DIR: captures, SOTTO_PROOF_LIVE_SIGNATURE: live.HYPRLAND_INSTANCE_SIGNATURE }
  delete env.ELECTRON_RUN_AS_NODE
  const specs = process.argv.slice(2)
  const child = owned.start('Linux Playwright proof', process.execPath, [join(checkout, 'node_modules/@playwright/test/cli.js'), 'test', ...(specs.length ? specs : ['tests/e2e/linux-shell-plumbing.spec.ts']), '--workers=1', `--output=${join(temporaryRoot, 'test-results')}`], { env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, 'Linux built-app proof must pass')
} finally { await lifecycle.cleanup() }
