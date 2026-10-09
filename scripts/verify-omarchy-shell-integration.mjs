// After build: mise exec node@24.21.0 -- node scripts/verify-omarchy-shell-integration.mjs
// Real Electron + the installed plugin, in one isolated Omarchy session. No live input or config writes.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import { assertProofInstancesPreserved, createOwnedProofProcesses, installProofCleanup, isProofProcessAlive, snapshotProofInstances, terminateThenCleanup } from './owned-proof-processes.mjs'

const run = promisify(execFile)
const checkout = resolve(import.meta.dirname, '..')
const destination = join(checkout, 'artifacts/omarchy-shell-integration')
const omarchy = '/usr/share/omarchy'
const script = join(import.meta.dirname, 'verify-omarchy-shell-integration.mjs')
const stateKeys = ['version', 'pid', 'pidStart', 'dictation', 'state', 'since', 'updatedAt', 'detail', 'kept', 'edge'].sort()
const transcript = 'A deterministic local transcript.'

async function until(label, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout
  do {
    const result = await predicate()
    if (result) return result
    await wait(100)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
function environmentOf(pid) {
  return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
    const index = entry.indexOf('=')
    return [entry.slice(0, index), entry.slice(index + 1)]
  }))
}
function startOf(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return Number(raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/u)[19])
}
function longRunningShellProcesses(shellPid) {
  const processes = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,etimes='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
  const parents = new Map(processes.map(([pid, parent]) => [pid, parent]))
  return processes.filter(([pid, , age]) => {
    if (age < 60) return false
    for (let ancestor = pid; ancestor && ancestor !== 1; ancestor = parents.get(ancestor)) {
      if (ancestor === shellPid) return true
    }
    return false
  }).map(([pid]) => ({ pid, start: startOf(pid) }))
}
function hashFile(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function treeStamp(root) {
  if (!existsSync(root)) return []
  const entries = []
  const visit = path => {
    const stat = lstatSync(path)
    entries.push([path, stat.ino, stat.size, stat.mtimeMs])
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
  }
  visit(root)
  return entries
}
// Evidence always stays in this checkout; refuse links before writing and again at delivery.
function checkDestination() {
  for (let path = destination; path !== dirname(path); path = dirname(path)) {
    if (existsSync(path)) assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `Unsafe evidence folder: ${path}`)
  }
  const visit = path => {
    const stat = lstatSync(path)
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()) && stat.uid === process.getuid(), `Unsafe evidence entry: ${path}`)
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
  }
  if (existsSync(destination)) visit(destination)
}

async function curate(evidence) {
  const raw = name => join(evidence, 'raw', `${name}.png`)
  const output = name => join(evidence, `${name}.png`)
  const top = name => ['(', raw(name), '-crop', '1000x100+300+0', '+repage', ')']
  for (const name of ['a-idle', 'b-listening']) await run('magick', [...top(name), output(name)])
  await run('magick', [...top('c-copied'), ...top('c-expired'), '-append', output('c-copied-expired')])
  await run('magick', ['d-failed-kept', 'd-retry-copied', 'd-before-discard', 'd-discarded'].flatMap(top).concat(['-append', output('d-retry-discard')]))
  await run('magick', ['(', raw('e-dragging'), '-crop', '560x420+0+290', '+repage', ')',
    '(', raw('e-snapped-left'), '-crop', '120x420+0+290', '+repage', ')',
    '(', raw('e-restarted-left'), '-crop', '120x420+0+290', '+repage', ')', '+append', output('e-drag-restart')])
  await run('magick', [raw('f-sotto-quit'), '-crop', '180x560+0+240', '+repage', output('f-sotto-quit')])
  const rows = []
  for (const [first, second] of [['g-output1-start', 'g-output2-start'], ['g-output1-moved', 'g-output2-stays']]) {
    const row = join(evidence, 'raw', `.${first}-row.png`)
    await run('magick', [raw(first), raw(second), '-background', 'black', '-gravity', 'north', '+append', '-resize', '50%', row])
    rows.push(row)
  }
  await run('magick', [...rows, '-append', output('g-two-outputs')])
  rows.forEach(path => rmSync(path))
  cpSync(raw('h-widget-returned'), output('h-widget-returned'))
}

async function orchestrate() {
  assert.equal(process.platform, 'linux')
  assert.equal(process.cwd(), checkout, 'Run from this checkout')
  checkDestination()
  const shells = execFileSync('pgrep', ['-x', 'quickshell'], { encoding: 'utf8' }).trim().split('\n')
    .map(Number).filter(pid => !readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes('proof'))
    .map(pid => ({ pid, env: environmentOf(pid) }))
    .filter(({ env }) => env.XDG_RUNTIME_DIR === `/run/user/${process.getuid()}`)
  assert.equal(shells.length, 1, 'Identify exactly one live Omarchy shell from its own environment')
  const live = shells[0].env
  const liveProcesses = longRunningShellProcesses(shells[0].pid)
  assert.ok(liveProcesses.length, 'Record the live shell and its long-running processes')
  assert.ok(live.HYPRLAND_INSTANCE_SIGNATURE && live.WAYLAND_DISPLAY)
  const instanceRoot = join(live.XDG_RUNTIME_DIR, 'hypr')
  const before = snapshotProofInstances(instanceRoot)
  const liveDirectories = ['.config/omarchy', '.config/hypr', '.local/state/omarchy'].map(path => join(live.HOME, path))
  const liveStamps = liveDirectories.map(treeStamp)
  const root = mkdtempSync('/tmp/ssi-')
  const home = join(root, 'home'), runtime = join(root, 'rt'), evidence = join(root, 'evidence')
  for (const folder of [home, runtime, evidence, join(evidence, 'raw')]) mkdirSync(folder, { mode: 0o700 })
  const proof = join(evidence, 'proof.txt')
  const say = message => { console.log(message); appendFileSync(proof, `${message}\n`) }
  say(`Temporary root ${root}: mode ${(statSync(root).mode & 0o777).toString(8)}`)
  say(`Live ${live.HYPRLAND_INSTANCE_SIGNATURE} on ${live.WAYLAND_DISPLAY}: no input or config writes`)
  say(`Live shell PID ${shells[0].pid}: ${liveProcesses.length} long-running process identities recorded`)
  say(`Checkout ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}; Electron ${JSON.parse(readFileSync(join(checkout, 'node_modules/electron/package.json'))).version}`)
  for (const path of ['out/main/index.js', 'out/main/dictationClient.js', 'out/preload/index.js', 'out/renderer/index.html']) say(`Built ${path}: sha256 ${hashFile(join(checkout, path))}`)
  const owned = createOwnedProofProcesses(say)
  const compositors = []
  const env = {
    HOME: home, USER: live.USER || process.env.USER, LANG: 'en_US.UTF-8', PATH: `${omarchy}/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: runtime, TMPDIR: root, TMP: root, TEMP: root,
    OMARCHY_PATH: omarchy, HYPRLAND_NO_SD_NOTIFY: '1', XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland',
    QT_QPA_PLATFORM: 'wayland', XCURSOR_SIZE: '24', ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  }
  // Scope creation talks to the user manager, while every started GUI process has an isolated bus.
  delete process.env.ELECTRON_RUN_AS_NODE
  const logOptions = name => ({ env, stdio: ['ignore', openSync(join(root, `${name}.log`), 'a'), openSync(join(root, `${name}.log`), 'a')] })
  // systemd-run resolves the user bus from XDG_RUNTIME_DIR, regardless of DBUS_SESSION_BUS_ADDRESS.
  // Give the runner the real runtime, then switch its command to the isolated one after scope entry.
  const startIsolated = (name, executable, args, options) => owned.start(name, '/usr/bin/env',
    [...Object.entries(env).map(([key, value]) => `${key}=${value}`), executable, ...args],
    { ...options, env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR } })
  const discover = record => {
    for (const name of readdirSync(instanceRoot)) {
      if (before.has(name) || name === live.HYPRLAND_INSTANCE_SIGNATURE) continue
      const folder = join(instanceRoot, name)
      if (existsSync(join(folder, 'hyprland.lock')) && Number(readFileSync(join(folder, 'hyprland.lock'), 'utf8').split('\n')[0]) === record.child.pid) {
        record.signature = name
        record.identity ??= statSync(folder)
      }
    }
  }
  const lifecycle = installProofCleanup(() => terminateThenCleanup(async () => {
    compositors.forEach(discover)
    await owned.stop()
  }, [() => {
    for (const record of compositors) {
      if (!record.signature) continue
      assert.ok(!isProofProcessAlive(record.child.pid))
      const folder = join(instanceRoot, record.signature)
      if (existsSync(folder)) {
        assert.equal(statSync(folder).ino, record.identity.ino)
        assert.equal(statSync(folder).dev, record.identity.dev)
        const lock = join(folder, 'hyprland.lock')
        if (existsSync(lock)) assert.equal(Number(readFileSync(lock, 'utf8').split('\n')[0]), record.child.pid)
        rmSync(folder, { recursive: true })
      }
      say(`Removed owned Hyprland folder ${record.signature}`)
    }
    assertProofInstancesPreserved(instanceRoot, before)
    say(`Prior Hyprland instances preserved: ${JSON.stringify([...before.keys()])}`)
    liveDirectories.forEach((path, index) => { assert.deepEqual(treeStamp(path), liveStamps[index]); say(`Live ${path} unchanged`) })
    for (const record of liveProcesses) {
      assert.ok(isProofProcessAlive(record.pid), `Preserve live shell process ${record.pid}`)
      assert.equal(startOf(record.pid), record.start, `Preserve live shell process identity ${record.pid}`)
    }
    say(`Live shell long-running process identities unchanged: ${liveProcesses.length}`)
  }, () => {
    checkDestination()
    mkdirSync(destination, { recursive: true })
    checkDestination()
    for (const name of readdirSync(evidence)) {
      rmSync(join(destination, name), { recursive: true, force: true })
      cpSync(join(evidence, name), join(destination, name), { recursive: true })
    }
    rmSync(root, { recursive: true })
    assert.ok(!existsSync(root))
    const removed = `Temporary root removed: ${root}`
    console.log(removed)
    appendFileSync(join(destination, 'proof.txt'), `${removed}\n`)
    console.log(`Evidence copied to ${destination}; temporary root absent`)
  }]), say, 20000)
  const instances = () => JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { env: live, encoding: 'utf8' }))
  const startCompositor = async (name, parent, config) => {
    const path = join(root, `${name}.lua`)
    writeFileSync(path, config)
    const child = owned.start(name, 'Hyprland', ['-c', path], { ...logOptions(name), env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: parent, HYPRLAND_INSTANCE_SIGNATURE: '' } })
    const record = { child }
    compositors.push(record)
    const instance = await until(`${name} starts`, () => { lifecycle.assertRunning(); if (child.proofError) throw child.proofError; return instances().find(entry => entry.pid === child.pid) }, 20000)
    discover(record)
    assert.equal(record.signature, instance.instance)
    assert.notEqual(instance.instance, live.HYPRLAND_INSTANCE_SIGNATURE)
    assert.notEqual(instance.wl_socket, live.WAYLAND_DISPLAY)
    assert.ok(owned.owns(child.pid, child))
    say(`${name} PID ${child.pid}: ${instance.instance} on ${instance.wl_socket}`)
    return instance
  }
  const hypr = (instance, args) => {
    assert.ok(compositors.some(record => record.signature === instance.instance))
    assert.notEqual(instance.instance, live.HYPRLAND_INSTANCE_SIGNATURE)
    return run('hyprctl', args, { env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR, HYPRLAND_INSTANCE_SIGNATURE: instance.instance } })
  }
  try {
    // A is a sizing host only. All shell/app/input scenes run together in B, with one HOME.
    // The locked parent tiles A; B's Wayland outputs are floated at exact sizes inside A.
    const preamble = `package.path = "${omarchy}/?.lua;" .. package.path\nrequire("default.hypr.helpers")\n`
    const a = await startCompositor('sizing Hyprland A', live.WAYLAND_DISPLAY, `${preamble}hl.monitor({ output = "", mode = "1280x800@60", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n`)
    const b = await startCompositor('session Hyprland B', a.wl_socket, `${preamble}require("default.hypr.looknfeel")\nrequire("default.hypr.input")\nrequire("default.hypr.apps.omarchy-shell")\nhl.monitor({ output = "WAYLAND-1", mode = "1600x1000@60", position = "0x0", scale = 1 })\nhl.monitor({ output = "WAYLAND-2", mode = "1280x800@60", position = "1600x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n`)
    await hypr(b, ['output', 'create', 'wayland'])
    for (const [name, width, height, x, y] of [['WAYLAND-1', 1600, 1000, 0, 0], ['WAYLAND-2', 1280, 800, 300, 120]]) {
      const client = await until(`${name} opens in A`, async () => JSON.parse((await hypr(a, ['clients', '-j'])).stdout).find(entry => entry.pid === b.pid && entry.title === `aquamarine - ${name}`))
      for (const action of [`hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`, `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${client.address}" })`, `hl.dsp.window.move({ x = ${x}, y = ${y}, window = "address:${client.address}" })`]) await hypr(a, ['dispatch', action])
    }
    await until('two exact output sizes', async () => {
      const monitors = JSON.parse((await hypr(b, ['monitors', '-j'])).stdout).sort((x, y) => x.x - y.x)
      return monitors.length === 2 && monitors[0].width === 1600 && monitors[0].height === 1000 && monitors[1].width === 1280 && monitors[1].height === 800 && monitors[1].x === 1600
    })
    for (const instance of [a, b]) {
      await hypr(instance, ['reload'])
      assert.equal((await hypr(instance, ['configerrors'])).stdout.trim(), '')
      await hypr(instance, ['dismissnotify'])
    }
    say('Nested configerrors: empty; B outputs WAYLAND-1=1600x1000 and WAYLAND-2=1280x800')
    Object.assign(env, { WAYLAND_DISPLAY: b.wl_socket, HYPRLAND_INSTANCE_SIGNATURE: b.instance })
    mkdirSync(join(runtime, 'hypr'))
    symlinkSync(join(instanceRoot, b.instance), join(runtime, 'hypr', b.instance))
    symlinkSync(join(live.XDG_RUNTIME_DIR, b.wl_socket), join(runtime, b.wl_socket))
    assert.ok(Buffer.byteLength(join(runtime, 'hypr', b.instance, '.socket.sock')) < 108)
    for (const path of [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, join(home, '.config/omarchy'), join(home, '.local/state/omarchy/current')]) mkdirSync(path, { recursive: true })
    const config = JSON.parse(readFileSync(join(omarchy, 'config/omarchy/shell.json'), 'utf8'))
    // Clipboard.qml starts by pkill-ing watchers globally, including the live shell's.
    // It must never load in this sandbox; its cache writes would also reach beyond our session.
    // Battery can change the machine's power profile when its power source changes.
    config.disabledPlugins = ['omarchy.polkit', 'omarchy.lock', 'omarchy.idle', 'omarchy.nightlight', 'omarchy.weather', 'omarchy.system-update', 'omarchy.clipboard', 'omarchy.battery']
    // A deterministic bar: the glyph is the centre anchor; clock on the right.
    config.bar.centerAnchor = 'sotto.dictation'
    config.bar.layout = { left: [{ id: 'omarchy.workspaces' }], center: [{ id: 'omarchy.indicators' }], right: [{ id: 'omarchy.clock', format: 'HH:mm' }] }
    writeFileSync(join(home, '.config/omarchy/shell.json'), JSON.stringify(config))
    say(`Nested disabled plugins: ${config.disabledPlugins.join(', ')}`)
    const theme = join(home, '.local/state/omarchy/current/next-theme')
    cpSync(join(omarchy, 'themes/tokyo-night'), theme, { recursive: true })
    await run('omarchy-theme-set-templates', [], { env })
    cpSync(theme, join(home, '.local/state/omarchy/current/theme'), { recursive: true })
    writeFileSync(join(home, '.local/state/omarchy/current/theme.name'), 'tokyo-night\n')
    const backgrounds = readdirSync(join(theme, 'backgrounds')).sort()
    symlinkSync(join(home, '.local/state/omarchy/current/theme/backgrounds', backgrounds[0]), join(home, '.local/state/omarchy/current/background'))
    startIsolated('nested Omarchy shell', 'dbus-run-session', ['--', 'quickshell', '-p', join(omarchy, 'shell')], logOptions('shell'))
    await until('isolated shell answers', async () => { try { await run('omarchy-shell', ['shell', 'ping'], { env }); return true } catch { return false } }, 30000)
    const installed = await run('bash', [join(checkout, 'apps/omarchy/install-shell-plugin.sh'), '--command', join(checkout, 'apps/omarchy/sotto')], { env })
    say(`Install: ${installed.stdout.trim()}`)
    const plugin = join(home, '.config/omarchy/plugins/sotto.dictation')
    assert.ok(existsSync(join(plugin, 'manifest.json')))
    const layout = JSON.parse(readFileSync(join(home, '.config/omarchy/shell.json'), 'utf8')).bar.layout.center
    assert.equal(layout.find(entry => entry.id === 'sotto.dictation').command, join(checkout, 'apps/omarchy/sotto'))
    await run('cc', [join(import.meta.dirname, 'omarchy-nested-pointer.c'), '-o', join(root, 'pointer'), '-lwayland-client', '-Wall', '-Wextra', '-Werror'])
    const details = { root, home, runtime, evidence, proof, liveSignature: live.HYPRLAND_INSTANCE_SIGNATURE, liveDisplay: live.WAYLAND_DISPLAY, signature: b.instance, display: b.wl_socket }
    const configPath = join(root, 'journey.json')
    writeFileSync(configPath, JSON.stringify(details))
    const worker = startIsolated('real app integration journey', process.execPath, [script, '--journey', configPath], { stdio: 'inherit' })
    const code = await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve) })
    assert.equal(code, 0, 'The real app integration journey must pass')
    await curate(evidence)
    say('Curated eight captures from the real nested-output frames')
    say('PASS: all eight integrated steps')
  } finally { await lifecycle.cleanup() }
}

async function journey(configPath) {
  const { _electron: electron } = await import('@playwright/test')
  const details = JSON.parse(readFileSync(configPath, 'utf8'))
  const { root, home, runtime, evidence, proof, signature, display, liveSignature, liveDisplay } = details
  assert.equal(process.env.HOME, home)
  assert.equal(process.env.XDG_RUNTIME_DIR, runtime)
  assert.equal(process.env.HYPRLAND_INSTANCE_SIGNATURE, signature)
  assert.notEqual(signature, liveSignature)
  assert.equal(process.env.WAYLAND_DISPLAY, display)
  assert.notEqual(display, liveDisplay)
  assert.ok(root.startsWith('/tmp/ssi-') && home === join(root, 'home') && runtime === join(root, 'rt'))
  const say = message => { console.log(message); appendFileSync(proof, `${message}\n`) }
  const hypr = async (...args) => JSON.parse((await run('hyprctl', args)).stdout)
  const statePath = join(runtime, 'sotto/dictation-state.json')
  // Sotto's existing e2e boundary uses userDataPath as the command/state runtime.
  // Share that exact private folder with the shell so the actual launcher reaches its socket.
  const profile = runtime
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, startMinimized: true, autoPaste: false, successDisplayMs: 5000, showWidgetWhenIdle: true }))
  const pointer = spawn(join(root, 'pointer'), [liveSignature, signature, liveDisplay, display], { stdio: ['pipe', 'pipe', 'pipe'] })
  const replies = []
  let pointerError = '', buffer = ''
  pointer.stderr.on('data', data => { pointerError += data })
  pointer.stdout.on('data', data => {
    buffer += data
    const lines = buffer.split('\n')
    buffer = lines.pop()
    replies.push(...lines)
  })
  await until('nested pointer ready', () => replies.shift() === 'ready')
  const mouse = async command => {
    assert.ok(pointer.exitCode === null, pointerError)
    pointer.stdin.write(`${command}\n`)
    await until(`pointer ${command}`, () => replies.shift() === 'ok', 3000)
  }
  const move = (x, y) => mouse(`move ${Math.round(x)} ${Math.round(y)} 2880 1000`)
  const click = async (x, y, label) => {
    say(`Pointer click: ${label} at ${Math.round(x)},${Math.round(y)}`)
    await move(x, y); await wait(100); await mouse('down'); await wait(60); await mouse('up')
  }
  const pillOn = async (output = 'WAYLAND-1') => (await hypr('layers', '-j'))[output]?.levels?.['3']?.some(layer => layer.namespace === 'sotto-dictation') ?? false
  const focused = async output => { await until(`focused ${output}`, async () => (await hypr('monitors', '-j')).find(monitor => monitor.focused)?.name === output) }
  const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return {}; throw error } }
  let app, pid, pidStart, currentDictation = null
  const seen = new Set()
  const state = async (label, expected, extra = {}, stale = false) => {
    await until(`${label} publishes ${expected}`, () => { const value = read(); return value.state === expected && Object.entries(extra).every(([key, wanted]) => value[key] === wanted) })
    const value = read()
    assert.deepEqual(Object.keys(value).sort(), stateKeys)
    assert.equal(value.version, 1)
    assert.equal(value.pid, pid)
    assert.equal(value.pidStart, pidStart)
    if (!stale) assert.equal(startOf(pid), pidStart)
    if (expected === 'idle') { assert.equal(value.dictation, null); currentDictation = null }
    else {
      assert.equal(typeof value.dictation, 'string')
      assert.ok(value.dictation.length)
      if (currentDictation !== null) assert.equal(value.dictation, currentDictation)
      else { assert.ok(!seen.has(value.dictation)); seen.add(value.dictation); currentDictation = value.dictation }
    }
    assert.ok(value.detail === null || (typeof value.detail === 'string' && value.detail.length < 60))
    if (value.kept) assert.ok(value.detail.includes('Recording kept.'))
    assert.ok(!JSON.stringify(value).includes(transcript))
    assert.equal(statSync(dirname(statePath)).mode & 0o777, 0o700)
    assert.equal(statSync(statePath).mode & 0o777, 0o600)
    say(`STATE ${label}: ${JSON.stringify(value)}`)
    return value
  }
  const capture = async (name, output = 'WAYLAND-1') => {
    const path = join(evidence, 'raw', `${name}.png`)
    await run('grim', ['-o', output, path], { timeout: 15000 })
    say(`CAPTURE ${name}: raw/${name}.png (${output})`)
    return path
  }
  const bounds = async (name, output = 'WAYLAND-1') => {
    const base = join(evidence, 'raw', `base-${output}.png`)
    const image = join(evidence, 'raw', `${name}.png`)
    const { stdout } = await run('magick', [base, image, '-compose', 'difference', '-composite', '-crop', '+0+27', '+repage', '-colorspace', 'gray', '-threshold', '6%', '-format', '%@', 'info:'])
    const match = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/u.exec(stdout.trim())
    assert.ok(match, `Measure pill: ${stdout}`)
    const [w, h, x, y] = match.slice(1).map(Number)
    assert.ok(w > 30 && h > 30, `${name} has visible pill bounds`)
    say(`BOUNDS ${name}: ${w}x${h} at ${x},${y + 27}`)
    return { w, h, x, y: y + 27 }
  }
  const hiddenWidget = async () => {
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/widget.html'))?.isVisible() ?? false), false)
    assert.ok(!(await hypr('clients', '-j')).some(client => client.pid === pid && client.title === 'Sotto Widget' && client.mapped))
  }
  const launch = async scenario => {
    currentDictation = null
    app = await electron.launch({ args: [join(checkout, 'out/main/index.js'), '--ozone-platform=wayland'], env: { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: scenario, SOTTO_E2E_USER_DATA: profile } })
    pid = app.process().pid
    pidStart = startOf(pid)
    say(`Built Sotto PID ${pid}; pidStart ${pidStart}; scenario ${scenario}; one HOME and runtime`)
    await state(`launch-${scenario}`, 'idle')
    await hiddenWidget()
    await until('no prior pill', async () => !await pillOn() && !await pillOn('WAYLAND-2'))
  }
  const quit = async () => {
    const old = pid
    await app.evaluate(({ app }) => { app.quit() }).catch(() => undefined)
    await until('quit removes state', () => !existsSync(statePath))
    await app.close().catch(() => undefined)
    await until('main stopped', () => !isProofProcessAlive(old))
    say(`Graceful quit PID ${old}: state file absent; process stopped`)
    app = undefined
  }
  const begin = async label => {
    currentDictation = null
    // The bar is anchored on this plugin; while idle its glyph is at x=800.
    await move(1400, 700); await focused('WAYLAND-1')
    await click(800, 13, `${label}: bar glyph (real toggle)`)
    await state(label, 'listening')
    await until('pill on focused output', () => pillOn())
    await hiddenWidget()
    await move(1599, 999)
    await wait(350)
  }
  const button = async (name, verb, offset, output = 'WAYLAND-1') => {
    const box = await bounds(name, output)
    const origin = output === 'WAYLAND-1' ? 0 : 1600
    if (box.w > box.h) await click(origin + box.x + box.w - offset, box.y + box.h / 2, `${name}: ${verb}`)
    else await click(origin + box.x + box.w / 2, box.y + box.h - offset, `${name}: upright ${verb}`)
  }
  try {
    await launch('success')
    await move(1599, 999); await focused('WAYLAND-1'); await wait(1500)
    await capture('base-WAYLAND-1')
    await capture('base-WAYLAND-2', 'WAYLAND-2')
    await state('a-plugin-present-widget-unmapped', 'idle', { edge: 'top' })
    await capture('a-idle')
    await begin('b-toggle')
    await capture('b-listening')
    const top = await bounds('b-listening')
    assert.ok(Math.abs(top.y - 31) <= 2 && Math.abs(top.x - (1600 - top.w) / 2) <= 2 && top.w > top.h)
    await button('b-listening', 'Stop (real stop)', 103)
    await state('c-stop-copied', 'copied', { detail: 'Copied — paste with Super+V', kept: false })
    const page = app.windows().find(window => window.url().endsWith('/index.html'))
    const output = await page.evaluate(() => globalThis.sottoE2E.snapshot())
    assert.equal(output.clipboardText, transcript)
    assert.equal(output.pasteAttempts, 0)
    say('Scripted output observed: clipboard equals the fixture; pasteAttempts=0 (text omitted)')
    await wait(200); await move(1599, 999); await capture('c-copied')
    await until('copied pill expires', async () => !await pillOn())
    await state('c-pill-expired', 'copied')
    await capture('c-expired')
    await quit()

    await launch('transcription-turned-away-once')
    await begin('d-start-for-retry')
    await capture('d-listening')
    await button('d-listening', 'Stop', 103)
    await state('d-failed-kept', 'failed', { kept: true, detail: 'The transcription service is busy. Recording kept.' })
    await wait(350); await move(1599, 999); await capture('d-failed-kept')
    await button('d-failed-kept', 'Try again (real retry)', 126)
    await state('d-retry-copied', 'copied', { kept: false })
    await wait(200); await move(1599, 999); await capture('d-retry-copied')
    await quit()
    await launch('transcription-turned-away-once')
    await begin('d-start-for-discard')
    await capture('d-discard-listening')
    await button('d-discard-listening', 'Stop', 103)
    await state('d-failed-before-discard', 'failed', { kept: true })
    await wait(350); await move(1599, 999); await capture('d-before-discard')
    await button('d-before-discard', 'Discard (real discard)', 47)
    await state('d-discard-idle', 'idle', { kept: false })
    await until('discard removes pill', async () => !await pillOn())
    await capture('d-discarded')

    await begin('e-start-for-drag')
    await capture('e-before-drag')
    const box = await bounds('e-before-drag')
    await move(box.x + 24, box.y + box.h / 2); await mouse('down')
    for (let i = 1; i <= 10; i++) {
      await move(box.x + 24 + (160 - box.x - 24) * i / 10, box.y + box.h / 2 + (520 - box.y - box.h / 2) * i / 10)
      await wait(30)
    }
    await capture('e-dragging')
    await mouse('up')
    await state('e-place-left', 'listening', { edge: 'left' })
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'widget-placement.json'), 'utf8')), { version: 3, placement: { edge: 'left' } })
    await move(1599, 999); await wait(350); await capture('e-snapped-left')
    const left = await bounds('e-snapped-left')
    assert.ok(Math.abs(left.x - 5) <= 2 && Math.abs(left.y - (26 + (974 - left.h) / 2)) <= 2 && left.h > left.w)
    await quit()
    await launch('success')
    await state('e-relaunch-saved-left', 'idle', { edge: 'left' })
    await begin('e-restart-dictation')
    await state('e-restarted-left', 'listening', { edge: 'left' })
    await capture('e-restarted-left')
    const restarted = await bounds('e-restarted-left')
    assert.ok(Math.abs(restarted.x - 5) <= 2 && restarted.h > restarted.w)
    await button('e-restarted-left', 'Cancel', 44)
    await state('e-cancel-after-restart', 'idle')
    await until('cancel removes pill', async () => !await pillOn())

    await begin('f-before-kill')
    await capture('f-before-kill')
    assert.equal(startOf(pid), pidStart)
    process.kill(pid, 'SIGKILL')
    await until('SIGKILL stops real main', () => !isProofProcessAlive(pid))
    await state('f-killed-stale-listening', 'listening', {}, true)
    say(`SIGKILL real main PID ${pid}; pidStart ${pidStart}; stale file retained`)
    app = undefined
    // The plugin's process probe runs every three seconds. Capture the resulting notice, never seed it.
    await wait(3600)
    await capture('f-sotto-quit')
    const lost = await bounds('f-sotto-quit')
    assert.ok(lost.h > restarted.h, 'Lost-dictation notice replaces the recording controls')
    // App startup overwrites the stale file and clears the notice.
    await launch('success')

    await move(2240, 420); await focused('WAYLAND-2'); await wait(300)
    currentDictation = null
    await click(2240, 13, 'g: output 2 glyph (real toggle)')
    await state('g-output2-listening', 'listening', { edge: 'left' })
    await until('pill only on output 2', async () => !await pillOn() && await pillOn('WAYLAND-2'))
    await move(2879, 799); await focused('WAYLAND-2'); await wait(350)
    await capture('g-output1-start')
    await capture('g-output2-start', 'WAYLAND-2')
    await move(1300, 600); await focused('WAYLAND-1'); await wait(350)
    assert.ok(!await pillOn() && await pillOn('WAYLAND-2'))
    await state('g-pointer-moved-pill-stays', 'listening', { edge: 'left' })
    await capture('g-output1-moved')
    await capture('g-output2-stays', 'WAYLAND-2')
    say('Rule A: focused output changed to WAYLAND-1; only WAYLAND-2 has sotto-dictation overlay')

    const removed = await run('bash', [join(checkout, 'apps/omarchy/install-shell-plugin.sh'), '--uninstall'])
    say(`Uninstall: ${removed.stdout.trim()}`)
    assert.ok(!existsSync(join(home, '.config/omarchy/plugins/sotto.dictation')))
    await until('Electron widget mapped again', async () => {
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/widget.html'))?.isVisible() ?? false)
      return visible && (await hypr('clients', '-j')).some(client => client.pid === pid && client.title === 'Sotto Widget' && client.mapped)
    })
    await until('shell pill removed on uninstall', async () => !await pillOn() && !await pillOn('WAYLAND-2'))
    await state('h-plugin-removed-widget-mapped', 'listening', { edge: 'left' })
    // Rescanning rebuilds the background too. Wait for its actual pixels, not a fixed delay.
    const backgroundPixel = async path => (await run('magick', [path, '-format', '%[pixel:p{1200,700}]', 'info:'])).stdout
    const expectedPixel = await backgroundPixel(join(evidence, 'raw/base-WAYLAND-1.png'))
    await until('wallpaper repaint after rescan', async () => {
      const frame = join(root, 'background-repaint.png')
      await run('grim', ['-o', 'WAYLAND-1', frame], { timeout: 15000 })
      return await backgroundPixel(frame) === expectedPixel
    })
    await capture('h-widget-returned')
    await capture('h-output2-no-pill', 'WAYLAND-2')
    say('Electron widget visible=true and compositor mapped=true; plugin absent; no shell pill on either output')
    await quit()
  } finally {
    if (app) await app.close().catch(() => undefined)
    pointer.stdin.end()
    if (pointer.exitCode === null) pointer.kill('SIGTERM')
  }
}

if (process.argv[2] === '--journey') await journey(process.argv[3])
else if (process.argv[2] === '--curate') { checkDestination(); await curate(destination) }
else await orchestrate()
