// Run a Linux GUI check only on an owned nested display. Usage: node scripts/with-nested-hyprland.mjs <evidence-dir> <command> [args...]
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { assertProofInstancesPreserved, createOwnedProofProcesses, installProofCleanup, snapshotProofInstances, terminateThenCleanup } from './owned-proof-processes.mjs'
import { nestedCommandEnvironment } from './nested-hyprland-environment.mjs'

const [output, command, ...args] = process.argv.slice(2)
assert.ok(output && command, 'Expected an evidence directory and command')
const out = resolve(output)
mkdirSync(out, { recursive: true })
const shellPid = execFileSync('pgrep', ['-x', 'quickshell']).toString().trim().split('\n')[0]
const live = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').filter(Boolean)
  .map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]))
const directory = join(live.XDG_RUNTIME_DIR, 'hypr')
const before = snapshotProofInstances(directory)
assert.ok(live.HYPRLAND_INSTANCE_SIGNATURE && before.has(live.HYPRLAND_INSTANCE_SIGNATURE))
const owned = createOwnedProofProcesses(console.log)
let hypr, instance, identity
const lifecycle = installProofCleanup(() => terminateThenCleanup(() => owned.stop(), [
  () => {
    if (!instance) return
    const folder = join(directory, instance.instance)
    if (identity && statSync(folder, { throwIfNoEntry: false })) {
      const current = statSync(folder)
      assert.equal(current.ino, identity.ino)
      assert.equal(current.dev, identity.dev)
      rmSync(folder, { recursive: true, force: true })
    }
  },
  // Other agents own other nested displays and may stop them during this run.
  () => assertProofInstancesPreserved(directory, new Map([[live.HYPRLAND_INSTANCE_SIGNATURE, before.get(live.HYPRLAND_INSTANCE_SIGNATURE)]]), instance?.instance),
]), console.log)

try {
  writeFileSync(join(out, 'hyprland.lua'), 'hl.monitor({ output = "", mode = "1800x1200@60", position = "0x0", scale = 1 })\n')
  const base = { ...process.env, ...Object.fromEntries(['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE'].map(key => [key, live[key]])) }
  delete base.HYPRLAND_INSTANCE_SIGNATURE
  delete base.ELECTRON_RUN_AS_NODE
  hypr = owned.start('nested Hyprland', 'Hyprland', ['-c', join(out, 'hyprland.lua')], {
    env: { ...base, HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: 'ignore',
  })
  const deadline = Date.now() + 20000
  while (!instance && Date.now() < deadline) {
    lifecycle.assertRunning()
    assert.equal(hypr.exitCode, null, 'Nested compositor exited')
    instance = JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { env: base, encoding: 'utf8' })).find(item => item.pid === hypr.pid)
    if (!instance) await wait(100)
  }
  assert.ok(instance, 'Nested compositor must start')
  assert.notEqual(instance.instance, live.HYPRLAND_INSTANCE_SIGNATURE)
  assert.notEqual(instance.wl_socket, live.WAYLAND_DISPLAY)
  identity = statSync(join(directory, instance.instance))
  console.log(`nested display: ${instance.wl_socket}; live display: ${live.WAYLAND_DISPLAY} (untouched)`)
  const nested = nestedCommandEnvironment(base, instance, hypr.pid)
  // Restore the real session bus after the scope wrapper: this check needs Secret Service and the tray.
  const child = owned.start(command, '/usr/bin/env', [`DBUS_SESSION_BUS_ADDRESS=${live.DBUS_SESSION_BUS_ADDRESS}`, command, ...args], { env: nested, stdio: 'inherit' })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  assert.equal(code, 0, 'Nested command must pass')
} finally { await lifecycle.cleanup() }
