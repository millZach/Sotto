// After build: mise exec node@24.22.1 -- node scripts/verify-linux-window-minimum.mjs
// --probe compares Electron options; --exec <command> [args] runs a spec on the same isolated desktop.
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { promisify } from 'node:util'
import { prepareSandboxBus, snapshotTree } from './omarchy-shell-sandbox.mjs'
import { assertProofInstancesPreserved, createOwnedProofProcesses, installProofCleanup, snapshotProofInstances, terminateThenCleanup } from './owned-proof-processes.mjs'

const checkout = resolve(import.meta.dirname, '..')
const destination = join(checkout, 'artifacts/linux-window-minimum')
const run = promisify(execFile)
const environmentOf = pid => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(entry => {
  const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]
}))
async function until(label, predicate) {
  const deadline = Date.now() + 20000
  do { const result = await predicate(); if (result) return result; await wait(100) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
function checkDestination() {
  for (let path = destination; path !== dirname(path); path = dirname(path)) {
    if (existsSync(path)) assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink())
  }
}
async function orchestrate() {
  assert.equal(process.platform, 'linux')
  assert.equal(process.cwd(), checkout)
  checkDestination()
  mkdirSync(destination, { recursive: true })
  const proof = join(destination, process.argv[2] === '--exec' ? 'exec-proof.txt' : process.argv[2] === '--probe' ? 'probe-proof.txt' : 'proof.txt')
  assert.ok(!existsSync(proof) || lstatSync(proof).isFile() && !lstatSync(proof).isSymbolicLink())
  writeFileSync(proof, '')
  const say = message => { console.log(message); appendFileSync(proof, `${message}\n`) }
  const shells = execFileSync('pgrep', ['-x', 'quickshell'], { encoding: 'utf8' }).trim().split('\n').map(Number)
    .map(pid => ({ pid, env: environmentOf(pid) }))
    .filter(({ env }) => env.XDG_RUNTIME_DIR === `/run/user/${process.getuid()}`)
  assert.equal(shells.length, 1)
  const live = shells[0].env
  const directory = join(live.XDG_RUNTIME_DIR, 'hypr')
  const before = snapshotProofInstances(directory)
  assert.ok(before.has(live.HYPRLAND_INSTANCE_SIGNATURE))
  const protectedPaths = ['.config/omarchy', '.config/hypr', '.local/state/omarchy', '.sotto'].map(path => join(live.HOME, path)).filter(existsSync)
  const stamps = protectedPaths.map(snapshotTree)
  const root = mkdtempSync('/tmp/slm-')
  const home = join(root, 'home'), runtime = join(root, 'rt'), temporary = join(root, 'tmp')
  for (const path of [home, runtime, temporary]) mkdirSync(path, { mode: 0o700 })
  const env = {
    HOME: home, USER: live.USER, PATH: process.env.PATH, LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: runtime, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    HYPRLAND_NO_SD_NOTIFY: '1', XDG_CURRENT_DESKTOP: 'Hyprland', XDG_SESSION_TYPE: 'wayland',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  }
  const owned = createOwnedProofProcesses(say)
  const compositors = []
  const start = (label, command, args, commandEnv = env, stdio = 'ignore') => owned.start(label, '/usr/bin/env',
    [...Object.entries(commandEnv).map(([key, value]) => `${key}=${value}`), command, ...args],
    { env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR }, stdio })
  const discover = child => JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR }, encoding: 'utf8' })).find(instance => instance.pid === child.pid)
  const lifecycle = installProofCleanup(() => terminateThenCleanup(() => owned.stop(), [() => {
    for (const record of compositors) {
      // A compositor that died during startup is absent from `hyprctl instances`.
      // Its lock still identifies the stale folder by our recorded PID.
      const signature = record.instance?.instance ?? readdirSync(directory).find(name => {
        if (before.has(name) || name === live.HYPRLAND_INSTANCE_SIGNATURE) return false
        const lock = join(directory, name, 'hyprland.lock')
        return existsSync(lock) && Number(readFileSync(lock, 'utf8').split('\n')[0]) === record.child.pid
      })
      if (!signature) continue
      assert.notEqual(signature, live.HYPRLAND_INSTANCE_SIGNATURE)
      assert.ok(!before.has(signature))
      const folder = join(directory, signature)
      if (!existsSync(folder)) continue
      const lock = join(folder, 'hyprland.lock')
      if (existsSync(lock)) assert.equal(Number(readFileSync(lock, 'utf8').split('\n')[0]), record.child.pid)
      if (record.identity) assert.equal(statSync(folder).ino, record.identity.ino)
      rmSync(folder, { recursive: true })
      say(`Removed owned instance ${signature}`)
    }
  }, () => {
    assertProofInstancesPreserved(directory, before)
  }, () => {
    protectedPaths.forEach((path, index) => { assert.deepEqual(snapshotTree(path), stamps[index]); say(`Live ${path} unchanged`) })
  }, () => {
    rmSync(root, { recursive: true })
    say(`Removed private root ${root}; prior Hyprland instances preserved`)
  }]), say, 20000)
  const compositor = async (label, parent) => {
    const path = join(root, `${label}.lua`)
    writeFileSync(path, 'hl.monitor({ output = "", mode = "1800x1200@60", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n')
    const log = openSync(join(root, `${label}.log`), 'a')
    const child = owned.start(label, 'Hyprland', ['-c', path], { env: { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: parent }, stdio: ['ignore', log, log] })
    const record = { child }; compositors.push(record)
    record.instance = await until(label, () => { lifecycle.assertRunning(); if (child.proofError) throw child.proofError; return discover(child) })
    record.identity = statSync(join(directory, record.instance.instance))
    assert.notEqual(record.instance.instance, live.HYPRLAND_INSTANCE_SIGNATURE)
    assert.notEqual(record.instance.wl_socket, live.WAYLAND_DISPLAY)
    say(`Owned ${label}: PID ${child.pid}, ${record.instance.instance}, ${record.instance.wl_socket}`)
    return record.instance
  }
  try {
    const a = await compositor('sizing', live.WAYLAND_DISPLAY)
    const b = await compositor('session', a.wl_socket)
    const aEnv = { ...env, XDG_RUNTIME_DIR: live.XDG_RUNTIME_DIR, HYPRLAND_INSTANCE_SIGNATURE: a.instance }
    const client = await until('nested output', async () => JSON.parse((await run('hyprctl', ['clients', '-j'], { env: aEnv })).stdout).find(client => client.pid === b.pid))
    for (const action of [
      `hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`,
      `hl.dsp.window.resize({ x = 1800, y = 1200, window = "address:${client.address}" })`,
    ]) await run('hyprctl', ['dispatch', action], { env: aEnv })
    Object.assign(env, { WAYLAND_DISPLAY: b.wl_socket, HYPRLAND_INSTANCE_SIGNATURE: b.instance, SOTTO_NESTED_LIVE_SIGNATURE: live.HYPRLAND_INSTANCE_SIGNATURE })
    mkdirSync(join(runtime, 'hypr'))
    symlinkSync(join(directory, b.instance), join(runtime, 'hypr', b.instance))
    symlinkSync(join(live.XDG_RUNTIME_DIR, b.wl_socket), join(runtime, b.wl_socket))
    const details = join(root, 'details.json')
    writeFileSync(details, JSON.stringify({ root, destination, home, signature: b.instance, liveSignature: live.HYPRLAND_INSTANCE_SIGNATURE }))
    const command = process.argv[2] === '--exec' ? process.argv[3] : process.execPath
    const args = process.argv[2] === '--exec' ? process.argv.slice(4) : [join(import.meta.dirname, 'verify-linux-window-minimum.mjs'), '--journey', details, ...(process.argv[2] === '--probe' ? ['--probe'] : [])]
    const busConfig = prepareSandboxBus(root)
    const child = start('isolated GUI check', 'dbus-run-session', [`--config-file=${busConfig}`, '--', command, ...args], env, 'inherit')
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    assert.equal(code, 0, 'GUI check must pass')
    say('PASS: isolated GUI check')
  } finally { await lifecycle.cleanup() }
}
async function journey() {
  const { _electron: electron } = await import('@playwright/test')
  const { root, destination, home, signature, liveSignature } = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  assert.equal(process.env.HOME, home)
  assert.equal(process.env.HYPRLAND_INSTANCE_SIGNATURE, signature)
  assert.notEqual(signature, liveSignature)
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.DBUS_SESSION_BUS_ADDRESS.includes('/run/user/'))
  const observations = []
  const hypr = async (...args) => JSON.parse((await run('hyprctl', args)).stdout)
  const resize = async (pid, width, height) => {
    const client = await until('mapped window', async () => (await hypr('clients', '-j')).find(client => client.pid === pid && client.mapped))
    await run('hyprctl', ['dispatch', `hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`])
    await run('hyprctl', ['dispatch', `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${client.address}" })`])
    await wait(400)
    return (await hypr('clients', '-j')).find(entry => entry.address === client.address)
  }
  const probe = process.argv.includes('--probe')
  if (probe) {
    const entry = join(root, 'probe.cjs')
    writeFileSync(entry, `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{const w=new BrowserWindow({width:1080,height:720,minWidth:820,minHeight:560,frame:false,...JSON.parse(process.env.SOTTO_PROBE_OPTIONS)});w.loadURL('data:text/html,minimum probe')})`)
    for (const options of [{}, { useContentSize: true }, { hasShadow: false }, { transparent: true }]) {
      const app = await electron.launch({ args: [entry, '--ozone-platform=wayland'], env: { ...process.env, SOTTO_PROBE_OPTIONS: JSON.stringify(options) } })
      try {
        const page = await app.firstWindow()
        const client = await resize(app.process().pid, 100, 100)
        const sizes = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { minimum: w.getMinimumSize(), content: w.getContentSize(), bounds: w.getBounds() } })
        observations.push({ options, clientSize: client.size, ...sizes, renderer: await page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]) })
        console.log(JSON.stringify(observations.at(-1)))
      } finally { await app.close() }
    }
  } else {
    const profile = join(root, 'profile'); mkdirSync(profile)
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true, showWidgetWhenIdle: false, reducedMotion: 'on' }))
    const app = await electron.launch({ args: [join(checkout, 'out/main/index.js'), '--ozone-platform=wayland'], env: { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile } })
    try {
      const page = await until('main page', () => app.windows().find(page => page.url().endsWith('/index.html')))
      await page.getByRole('link', { name: 'Settings', exact: true }).waitFor()
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
      for (const mode of ['light', 'dark']) {
        await page.getByRole('radio', { name: mode === 'light' ? 'Light' : 'Dark', exact: true }).click()
        await until('appearance', () => page.locator('html').getAttribute('data-theme').then(value => value === mode))
        for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560], [100, 100]]) {
          const client = await resize(app.process().pid, width, height)
          const target = [Math.max(width, 820), Math.max(height, 560)]
          await until('content size', () => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]).then(size => size.every((value, index) => value === target[index])))
          const sizes = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')); return { minimum: w.getMinimumSize(), content: w.getContentSize(), bounds: w.getBounds() } })
          const renderer = await page.evaluate(() => ({ size: [globalThis.innerWidth, globalThis.innerHeight], scroll: [globalThis.document.documentElement.scrollWidth, globalThis.document.documentElement.scrollHeight] }))
          assert.deepEqual(renderer.scroll, target)
          assert.deepEqual(sizes.minimum, [820, 560])
          assert.deepEqual(sizes.content, target)
          assert.deepEqual(client.size, target)
          observations.push({ mode, requested: [width, height], clientSize: client.size, ...sizes, renderer })
          if (width === 820) {
            const path = join(destination, `minimum-settings-${mode}.png`)
            assert.ok(!existsSync(path) || lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
            await run('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, path])
          }
        }
        await page.getByRole('tab', { name: 'Threads', exact: true }).click()
        await page.getByRole('complementary', { name: 'Thread sidebar', exact: true }).waitFor()
        assert.deepEqual(await page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]), [820, 560])
        const client = (await hypr('clients', '-j')).find(client => client.pid === app.process().pid && client.mapped)
        const path = join(destination, `minimum-${mode}.png`)
        assert.ok(!existsSync(path) || lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
        await run('grim', ['-g', `${client.at[0]},${client.at[1]} ${client.size[0]}x${client.size[1]}`, path])
        await page.getByRole('link', { name: 'Settings', exact: true }).click()
        await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
      }
    } finally { await app.close() }
  }
  const result = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), electron: JSON.parse(readFileSync(join(checkout, 'node_modules/electron/package.json'))).version,
    build: existsSync(join(checkout, 'out/main/index.js')) ? createHash('sha256').update(readFileSync(join(checkout, 'out/main/index.js'))).digest('hex') : null, observations }
  const path = join(destination, probe ? 'probe.json' : 'sizes.json')
  assert.ok(!existsSync(path) || lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
}
if (process.argv[2] === '--journey') await journey()
else await orchestrate()
