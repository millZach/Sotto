// After build: node scripts/with-nested-hyprland.mjs .cache/omarchy-setup/outer node scripts/verify-omarchy-setup.mjs [--package]
// Only a private HOME, a nested sizing display, and an explicitly owned shell may be changed.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { prepareSandboxBus, prepareSandboxHome, rewriteSandboxConfig } from './omarchy-shell-sandbox.mjs'
import { createOwnedProofProcesses, installProofCleanup, terminateThenCleanup } from './owned-proof-processes.mjs'

const checkout = resolve(import.meta.dirname, '..')
const findings = process.argv.includes('--findings')
assert.equal(process.platform, 'linux')
assert.ok(process.env.SOTTO_PACKAGE_NESTED_PID, 'Use with-nested-hyprland.mjs')
assert.notEqual(process.env.HOME, '', 'A parent HOME is required')
const parent = { ...process.env }
const root = mkdtempSync(join(checkout, '.cache/su-'))
const home = join(root, 'h'), temporary = join(root, 't')
// Quickshell appends 38 characters for its socket; its Qt socket limit is shorter than Node's.
let runtime
for (let index = 0; !runtime; index++) {
  const candidate = join(checkout, '.cache', `r${index}`)
  try { mkdirSync(candidate, { mode: 0o700 }); runtime = candidate }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
for (const folder of [home, temporary]) mkdirSync(folder, { mode: 0o700 })
const bin = join(home, 'bin'); mkdirSync(bin)
const systemBin = join(home, 'system-bin'); mkdirSync(systemBin)
mkdirSync(join(home, '.local/bin'), { recursive: true })
const owned = createOwnedProofProcesses(console.log)
let compositor, instance, shell
const lifecycle = installProofCleanup(() => terminateThenCleanup(() => owned.stop(), []), console.log)
const omarchy = '/usr/share/omarchy'
const env = { ...parent, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
  XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: runtime,
  TMPDIR: temporary, TMP: temporary, TEMP: temporary, PATH: `${bin}:${join(home, '.local/bin')}:${omarchy}/bin:${systemBin}`, OMARCHY_PATH: omarchy,
  QS_DISABLE_FILE_WATCHER: '1', QS_NO_RELOAD_POPUP: '1', QT_QPA_PLATFORM: 'wayland', SOTTO_OMARCHY_SETUP_PROOF: '1',
  SOTTO_E2E_EVIDENCE: 'publish',
  SOTTO_SETUP_PROOF_HOME: home, SOTTO_SETUP_PROOF_ROOT: root, SOTTO_SETUP_PROOF_PACKAGE: process.argv.includes('--package') ? '1' : '0' }
delete env.ELECTRON_RUN_AS_NODE
if (findings) {
  // Keep Node/Git fixture sockets in the normal short temporary directory.
  delete env.TMPDIR; delete env.TMP; delete env.TEMP
  env.SOTTO_LINUX_FINDINGS_PROOF = '1'
}
delete env.DISPLAY; delete env.XAUTHORITY
const log = name => ['ignore', openSync(join(root, `${name}.log`), 'a'), openSync(join(root, `${name}.log`), 'a')]
const run = (command, args = [], environment = env) => execFileSync(command, args, { env: environment, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })
const until = async (name, predicate) => {
  const end = Date.now() + 30000
  while (Date.now() < end) { lifecycle.assertRunning(); const value = await predicate(); if (value) return value; await wait(100) }
  throw new Error(`Timed out: ${name}`)
}
const startIsolated = (name, command, args, stdio = log(name)) => owned.start(name, '/usr/bin/env',
  [...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args], { env: parent, stdio })

try {
  prepareSandboxHome(home, omarchy); rewriteSandboxConfig(home, omarchy)
  // Links are only executable lookups, outside every checked configuration tree.
  for (const command of readdirSync('/usr/bin')) if (command !== 'sotto') symlinkSync(join('/usr/bin', command), join(systemBin, command))
  mkdirSync(join(home, '.config/hypr'), { recursive: true })
  writeFileSync(join(home, '.config/hypr/bindings.lua'), '-- My bindings\n')
  writeFileSync(join(bin, 'voxtype'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'luac'), `#!/bin/bash\nwhile [[ -e '${join(root, 'hold-keys')}' ]]; do sleep 0.1; done\nexec /usr/bin/luac "$@"\n`, { mode: 0o755 })
  const launcher = process.argv.includes('--package') ? join(checkout, 'release/linux-unpacked/sotto') : join(checkout, 'apps/omarchy/sotto')
  writeFileSync(join(bin, 'sotto'), `#!/bin/sh\nexec '${launcher}' "$@"\n`, { mode: 0o755 })
  const configPath = join(root, 'hyprland.lua')
  const lua = `dofile("${omarchy}/default/hypr/bootstrap.lua")\nrequire("default.hypr.helpers")\nrequire("default.hypr.looknfeel")\nrequire("default.hypr.input")\nrequire("default.hypr.apps.omarchy-shell")\nrequire("default.hypr.bindings.voxtype")\nrequire("hypr.bindings")\nhl.monitor({ output = "", mode = "1600x1000@60", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n`
  writeFileSync(configPath, lua)
  // Only the compositor needs its parent's runtime to open the Wayland socket.
  compositor = owned.start('setup display', 'Hyprland', ['-c', configPath], { env: { ...env, XDG_RUNTIME_DIR: parent.XDG_RUNTIME_DIR,
    WAYLAND_DISPLAY: parent.WAYLAND_DISPLAY, HYPRLAND_INSTANCE_SIGNATURE: '', HYPRLAND_NO_SD_NOTIFY: '1' }, stdio: log('hyprland') })
  instance = await until('private compositor', () => JSON.parse(run('hyprctl', ['instances', '-j'], parent)).find(item => item.pid === compositor.pid))
  assert.notEqual(instance.instance, parent.HYPRLAND_INSTANCE_SIGNATURE)
  // Short aliases keep Unix socket paths inside this worktree under 108 bytes.
  mkdirSync(join(runtime, 'hypr'))
  symlinkSync(join(parent.XDG_RUNTIME_DIR, 'hypr', instance.instance), join(runtime, 'hypr/s'))
  symlinkSync(join(parent.XDG_RUNTIME_DIR, instance.wl_socket), join(runtime, 'w'))
  Object.assign(env, { WAYLAND_DISPLAY: 'w', HYPRLAND_INSTANCE_SIGNATURE: 's', SOTTO_SETUP_PROOF_HYPR_CONFIG: configPath })
  const client = await until('sizing window', () => JSON.parse(run('hyprctl', ['clients', '-j'], parent)).find(item => item.pid === compositor.pid))
  for (const action of [`hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`,
    `hl.dsp.window.resize({ x = 1600, y = 1000, window = "address:${client.address}" })`]) run('hyprctl', ['dispatch', action], parent)
  assert.equal(run('hyprctl', ['configerrors']).trim(), '')
  cpSync(join(omarchy, 'themes/tokyo-night'), join(home, '.local/state/omarchy/current/theme'), { recursive: true })
  writeFileSync(join(home, '.local/state/omarchy/current/theme.name'), 'tokyo-night\n')
  const bus = prepareSandboxBus(root)
  // A private bus activates no portals, clipboard daemons or live desktop services.
  shell = startIsolated('shell', 'dbus-run-session', [`--config-file=${bus}`, '--', 'quickshell', '-n', '-p', join(omarchy, 'shell')])
  await until('private shell', () => { try { run('omarchy-shell', ['shell', 'ping']); return true } catch { return false } })
  writeFileSync(join(root, 'shell-pid'), String(shell.pid))
  // Route restart to an explicitly owned nested process. Never call Omarchy's any-display restart in a proof.
  writeFileSync(join(bin, 'omarchy'), `#!/bin/bash\nif [[ $1 == restart && $2 == shell ]]; then\n  exec '${process.execPath}' '${join(checkout, 'scripts/verify-omarchy-setup-restart.mjs')}' >>'${join(root, 'restart.log')}' 2>&1\nfi\nexec '${omarchy}/bin/omarchy' "$@"\n`, { mode: 0o755 })
  const proof = startIsolated('journeys', process.execPath, [join(checkout, 'node_modules/@playwright/test/cli.js'), 'test', findings ? 'tests/e2e/linux-test-findings.spec.ts' : 'tests/e2e/omarchy-setup.spec.ts'], 'inherit')
  const code = await new Promise((resolveExit, reject) => { proof.once('error', reject); proof.once('exit', resolveExit) })
  assert.equal(code, 0, 'Omarchy setup journeys must pass')
  if (findings && process.argv.includes('--package')) {
    const verifier = startIsolated('package resources', process.execPath, [join(checkout, 'scripts/verify-packaged-resources.mjs'),
      join(checkout, 'release/linux-unpacked'), '--installer', join(checkout, 'release', `Sotto-${JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version}-linux-x64.tar.gz`)], 'inherit')
    const verified = await new Promise((resolveExit, reject) => { verifier.once('error', reject); verifier.once('exit', resolveExit) })
    assert.equal(verified, 0, 'Packaged resources and external dependency inventory must pass')
  }
  const shellLog = readFileSync(join(root, 'shell.log'), 'utf8')
  assert.ok(!/Type .* unavailable|ReferenceError|SyntaxError|Cannot assign to non-existent property|is not a type/.test(shellLog), 'No QML loading error')
  console.log(`Verified only private HOME ${home}; shell and compositor belong to this proof.`)
} finally {
  await lifecycle.cleanup()
  // Hyprland removes its own sockets on normal exit. Preserve logs and private HOME for inspection.
  console.log(`Proof files kept in ${root}`)
}
