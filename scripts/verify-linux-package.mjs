// Usage: node scripts/with-nested-hyprland.mjs artifacts/linux-package/nested node scripts/verify-linux-package.mjs <executable-or-launcher> <profile-dir> [--dictation]
// Uses main inspector 9348, real libsecret, normal onboarding, Settings and the extracted package's client; no compositor key events.
/* global window, document, innerWidth, innerHeight, requestAnimationFrame */
import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import console from 'node:console'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { fetchProofJson, openProofDebugger } from './proof-debugger.mjs'

const [input, profileInput, dictationFlag] = process.argv.slice(2)
assert.ok(input && profileInput)
const shellPid = execFileSync('pgrep', ['-x', 'quickshell']).toString().trim().split('\n')[0]
const liveSignature = readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith('HYPRLAND_INSTANCE_SIGNATURE=')).split('=')[1]
assert.notEqual(process.env.HYPRLAND_INSTANCE_SIGNATURE, liveSignature, 'Never drive the live compositor')
const compositor = JSON.parse(execFileSync('hyprctl', ['instances', '-j'], { encoding: 'utf8' })).find(item => item.instance === process.env.HYPRLAND_INSTANCE_SIGNATURE)
assert.equal(compositor?.pid, Number(process.env.SOTTO_PACKAGE_NESTED_PID), 'The wrapper must own the nested compositor')
const executable = resolve(input)
const profile = resolve(profileInput)
mkdirSync(profile, { recursive: true, mode: 0o700 })
mkdirSync('.cache', { recursive: true })
// Keep AF_UNIX paths below 108 bytes even though the worktree and evidence paths are long.
const runtime = mkdtempSync(resolve('.cache/lp-'))
const env = { ...process.env, HOME: join(profile, 'home'), XDG_CONFIG_HOME: join(profile, 'config'), XDG_RUNTIME_DIR: runtime }
mkdirSync(env.HOME, { recursive: true })
delete env.ELECTRON_RUN_AS_NODE
// The runtime is isolated for the command socket; Wayland still lives in the desktop runtime.
env.WAYLAND_DISPLAY = join(process.env.XDG_RUNTIME_DIR, process.env.WAYLAND_DISPLAY)
// A rootless extraction cannot preserve root ownership of the setuid helper. Keep the user namespace sandbox.
const child = spawn(executable, ['--inspect=9348', '--remote-debugging-port=9349', '--ozone-platform=wayland', `--user-data-dir=${join(profile, 'chromium')}`, ...(dictationFlag === '--dictation' ? ['--disable-setuid-sandbox'] : [])], { env, stdio: 'ignore' })
console.log(`packaged app PID: ${child.pid}`)
let inspector, browser
try {
  let target
  const deadline = Date.now() + 30000
  while (!target && Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'Packaged app exited')
    try { target = (await fetchProofJson('http://127.0.0.1:9348/json/list'))[0] } catch { await wait(100) }
  }
  assert.ok(target, 'Main inspector must start on port 9348')
  inspector = await openProofDebugger(target.webSocketDebuggerUrl)
  let storage
  while (Date.now() < deadline) {
    storage = await inspector.evaluate(`(() => { const { app, safeStorage } = process.mainModule.require('electron'); return { ready: app.isReady(), packaged: app.isPackaged, version: app.getVersion(), executable: process.execPath, passwordStore: app.commandLine.getSwitchValue('password-store'), available: app.isReady() && safeStorage.isEncryptionAvailable(), backend: app.isReady() ? safeStorage.getSelectedStorageBackend() : null }; })()`, 15000, false)
    if (storage.ready) break
    await wait(100)
  }
  assert.equal(storage.ready, true)
  assert.equal(storage.packaged, true)
  assert.equal(storage.backend, 'gnome_libsecret')
  assert.equal(storage.available, true)
  console.log(JSON.stringify(storage))
  browser = await chromium.connectOverCDP('http://127.0.0.1:9349')
  let page
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => /\/index.html$/u.test(candidate.url()))
    if (!page) await wait(100)
  }
  assert.ok(page, 'Main renderer must open')
  const rendererSession = await page.context().newCDPSession(page)
  await rendererSession.send('Emulation.clearDeviceMetricsOverride')
  await page.getByRole('button', { name: 'Get started', exact: true }).waitFor({ state: 'visible' })
  let mainClient
  const windowDeadline = Date.now() + 20000
  while (!mainClient && Date.now() < windowDeadline) {
    const clients = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }))
    mainClient = clients.find(client => client.pid === child.pid && client.title === 'Sotto')
    if (!mainClient) await wait(100)
  }
  assert.ok(mainClient, 'Packaged window must belong to the nested compositor')
  if (!mainClient.floating) execFileSync('hyprctl', ['dispatch', `hl.dsp.window.float({ window = "address:${mainClient.address}", action = "toggle" })`])
  await page.getByRole('button', { name: 'Get started', exact: true }).click()
  for (let step = 0; step < 7; step++) await page.locator('.onboarding-actions').getByRole('button', { name: /^(Continue|Skip for now)$/u }).click()
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
  await page.getByRole('button', { name: 'Skip tour', exact: true }).click()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Application', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Launch when you sign in', exact: true })
  await toggle.waitFor()
  assert.equal(await toggle.isEnabled(), true)
  const file = join(env.XDG_CONFIG_HOME, 'autostart/sotto.desktop')
  assert.equal(existsSync(file), false)
  await toggle.focus()
  await toggle.press('Space')
  await page.waitForFunction(() => document.querySelector('[role=switch][aria-label="Launch when you sign in"]')?.getAttribute('aria-checked') === 'true')
  const autostart = readFileSync(file, 'utf8')
  assert.ok(autostart.includes(`Exec="${storage.executable}"`))
  execFileSync('desktop-file-validate', [file])
  const generated = join(profile, 'generated-autostart')
  mkdirSync(generated, { recursive: true })
  execFileSync('/usr/lib/systemd/user-generators/systemd-xdg-autostart-generator', [generated, generated, generated], { env })
  const autostartService = readFileSync(join(generated, 'app-sotto@autostart.service'), 'utf8')
  assert.ok(autostartService.includes(storage.executable), 'The XDG generator must resolve the packaged executable')
  assert.deepEqual(await page.evaluate(() => window.sotto.getStartup()), { enabled: true, supported: true })
  await toggle.click()
  await page.waitForFunction(() => document.querySelector('[role=switch][aria-label="Launch when you sign in"]')?.getAttribute('aria-checked') === 'false')
  assert.equal(existsSync(file), false)
  console.log('Settings startup toggle: wrote, generated and removed the autostart entry')

  // Electron's Wayland minimum includes a 20-pixel frame inset. Lower only this test window's
  // constraint so the renderer can be exercised at the documented 820x560 size.
  await inspector.evaluate(`(() => { const { BrowserWindow } = process.mainModule.require('electron'); BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setMinimumSize(800, 540); })()`, 15000, false)
  const captures = []
  for (const appearance of dictationFlag ? [] : ['dark', 'light']) {
    await page.evaluate(appearance => window.sotto.updateSettings({ appearance, reducedMotion: 'on' }), appearance)
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
      await inspector.evaluate(`(() => { const { BrowserWindow } = process.mainModule.require('electron'); BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).setSize(${width}, ${height}); })()`, 15000, false)
      execFileSync('hyprctl', ['dispatch', `hl.dsp.window.resize({ window = "address:${mainClient.address}", x = ${width}, y = ${height} })`])
      try { await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height }) }
      catch (error) {
        console.log('Requested size', width, height, 'actual viewport', await page.evaluate(() => ({ width: innerWidth, height: window.innerHeight })))
        console.log('Nested window sizes', JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' })).filter(client => client.pid === child.pid).map(client => ({ title: client.title, size: client.size, floating: client.floating })))
        throw error
      }
      await toggle.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      const rect = await toggle.boundingBox()
      assert.ok(rect && rect.y >= 0 && rect.y + rect.height <= height, 'Startup control must fit in the viewport')
      assert.equal(await toggle.isVisible(), true)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      if (width === 820 && !dictationFlag) {
        const image = await inspector.evaluate(`(async () => { const { BrowserWindow } = process.mainModule.require('electron'); const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')); return (await window.webContents.capturePage()).toPNG().toString('base64'); })()`)
        writeFileSync(join('artifacts/linux-package', `settings-${appearance}.png`), Buffer.from(image, 'base64'))
      }
      captures.push({ appearance, width, height, fits: true })
    }
  }
  const items = execFileSync('busctl', ['--user', 'get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'], { encoding: 'utf8' }).trim()
  const tray = [...items.matchAll(/"([^"]+)"/gu)].find(([, item]) => {
    const bus = item.split('/')[0]
    return execFileSync('busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', bus], { encoding: 'utf8' }).trim() === `u ${child.pid}`
  })
  assert.ok(tray, 'Tray must register for this packaged PID')
  let command
  if (dictationFlag === '--dictation') {
    assert.ok(existsSync(join(runtime, 'sotto/dictation.sock')), 'Packaged command socket must be published')
    const result = execFileSync(executable, ['dictation', 'toggle'], { env, encoding: 'utf8' }).trim()
    command = { verb: 'toggle', exitCode: 0, result }
  }
  const evidence = { storage, trayRegistered: true, autostartWritten: autostart, autostartGenerated: true, autostartRemoved: true, captures, ...(command ? { command } : {}) }
  writeFileSync(join(profile, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
  console.log(`packaged launch: ready=${storage.ready}; backend=${storage.backend}; tray=registered`)
  console.log('packaged autostart: wrote sotto.desktop; XDG generator accepted it; removed sotto.desktop')
  if (command) console.log(`extracted launcher: sotto dictation toggle; exit=${command.exitCode}`)
  await inspector.evaluate("setTimeout(() => process.mainModule.require('electron').app.quit(), 100); true", 15000, false)
} finally {
  inspector?.close()
  await browser?.close().catch(() => undefined)
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([new Promise(resolveExit => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit)), wait(5000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(runtime, { recursive: true, force: true })
}
