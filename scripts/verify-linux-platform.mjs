// Usage: node scripts/verify-linux-platform.mjs <isolated-config-folder> [inspector-port] [screenshot-folder]; needs Hyprland.
/* global WebSocket, fetch */
import assert from 'node:assert/strict'
import { log } from 'node:console'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout, clearTimeout } from 'node:timers'
import { setTimeout as sleep } from 'node:timers/promises'

const data = process.argv[2]
assert(data, 'Pass an isolated configuration folder.')
const shellPid = execFileSync('pgrep', ['-x', 'quickshell'], { encoding: 'utf8' }).trim().split('\n')[0]
const keep = new Set(['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE',
  'ELECTRON_OZONE_PLATFORM_HINT', 'OZONE_PLATFORM', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'GDK_BACKEND',
  'QT_QPA_PLATFORM', 'DISPLAY', 'PATH', 'HOME', 'USER', 'LANG'])
const env = Object.fromEntries(readFileSync(`/proc/${shellPid}/environ`, 'utf8').split('\0')
  .map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)])
  .filter(([key]) => keep.has(key)))
env.XDG_CONFIG_HOME = resolve(data)
const port = Number(process.argv[3] ?? 9340)
assert(Number.isInteger(port) && port > 1023 && port < 65536, 'Pass an unprivileged inspector port.')
const screenshotFolder = process.argv[4] ? resolve(process.argv[4]) : null
const child = spawn(resolve('node_modules/electron/dist/electron'), [`--inspect=${port}`, process.cwd()], { env, stdio: 'ignore' })
const exited = new Promise(resolveExit => child.once('exit', resolveExit))
let socket
let nextId = 0
const replies = new Map()

async function until(check) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, 'The app quit during startup.')
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error('The app did not reach the expected state.')
}

async function evaluate(expression) {
  const id = ++nextId
  const result = new Promise((done, fail) => {
    const timeout = setTimeout(() => { replies.delete(id); fail(new Error('Main process inspection timed out.')) }, 20_000)
    replies.set(id, message => { clearTimeout(timeout); done(message) })
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const message = await result
  assert(!message.error && !message.result.exceptionDetails, 'Main process inspection failed.')
  return message.result.result.value
}

const mainWindow = "process.mainModule?.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html'))"
const page = expression => evaluate(`${mainWindow}.webContents.executeJavaScript(${JSON.stringify(expression)})`)
const click = label => page(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const heading = expected => until(async () => await page("document.getElementById('onboarding-heading')?.textContent") === expected)

try {
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0] } catch { return null }
  })
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const done = replies.get(message.id)
    if (done) { replies.delete(message.id); done(message) }
  })
  const inspectedPid = await until(async () => {
    try { return await evaluate("typeof process === 'undefined' ? null : process.pid") } catch { return null }
  })
  assert.equal(inspectedPid, child.pid, 'The inspector belongs to another app process.')
  await until(() => evaluate(`!!${mainWindow} && ${mainWindow}.webContents.isLoading() === false`))
  await heading('Dictation, ready when you are')
  assert.equal(await page('window.sotto.platform'), 'linux')
  await click('Continue')
  await heading('Check your microphone')
  await click('Skip for now')
  await until(() => page("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Continue' && !b.disabled)"))
  await click('Continue')
  await heading('Connect your OpenRouter key')
  // Drive the renderer's input and blur handlers while the desktop cannot grant native focus.
  // Synthetic local input only. Do not press Verify key or make a provider request.
  await page(`(() => {
    const field = document.querySelector('input[type=password]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'sotto-linux-storage-check');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await until(() => page("document.querySelector('input[type=password]').value === 'sotto-linux-storage-check'"))
  await page("document.querySelector('input[type=password]').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))")
  await until(() => page("document.querySelector('input[type=password]').placeholder === 'Key saved'"))
  const state = await evaluate(`(() => {
    const { app, safeStorage } = process.mainModule.require('electron');
    const { readFileSync } = process.mainModule.require('node:fs');
    const { join } = process.mainModule.require('node:path');
    const sealed = JSON.parse(readFileSync(join(app.getPath('userData'), 'credentials.json'), 'utf8')).formatting;
    const settings = readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8');
    return { pid: process.pid, ready: app.isReady(), passwordStore: app.commandLine.getSwitchValue('password-store'),
      available: safeStorage.isEncryptionAvailable(), backend: safeStorage.getSelectedStorageBackend(),
      keySaved: !!sealed, keyRoundTrip: safeStorage.decryptString(Buffer.from(sealed, 'base64')) === 'sotto-linux-storage-check',
      keyAbsentFromSettings: !settings.includes('sotto-linux-storage-check') };
  })()`)
  assert.equal(state.pid, child.pid)
  assert.equal(state.backend, 'gnome_libsecret')
  assert(state.ready && state.available && state.keySaved && state.keyRoundTrip && state.keyAbsentFromSettings)
  const items = execFileSync('busctl', ['--user', 'get-property', 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
    'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems'], { env, encoding: 'utf8' }).trim()
  const ownedItem = [...items.matchAll(/"([^"]+)"/gu)].find(([, item]) => {
    const bus = item.split('/')[0]
    const pid = execFileSync('busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus', 'GetConnectionUnixProcessID', 's', bus], { env, encoding: 'utf8' }).trim()
    return pid === `u ${child.pid}`
  })
  assert(ownedItem, 'The tray item does not belong to the app process.')
  assert(child.exitCode === null && child.signalCode === null, 'The app quit before its tray was checked.')
  log(JSON.stringify({ ...state, onboarding: true, trayOwnedByProcess: true }))
  log(items)

  const [bus, ...pathParts] = ownedItem[1].split('/')
  const itemPath = `/${pathParts.join('/')}`
  const trayProperty = name => JSON.parse(execFileSync('busctl', ['--user', '--json=short', 'get-property', bus,
    itemPath, 'org.kde.StatusNotifierItem', name], { env, encoding: 'utf8' })).data
  const pixmaps = await until(() => {
    const current = trayProperty('IconPixmap')
    return current.length > 0 ? current : null
  })
  const colourPixels = pixmaps.reduce((total, [, , pixels]) => total + pixels.reduce((count, _byte, i) =>
    count + (i % 4 === 0 && pixels[i] > 0 && (pixels[i + 1] !== pixels[i + 2] || pixels[i + 2] !== pixels[i + 3]) ? 1 : 0), 0), 0)
  assert(pixmaps.some(([width, height]) => width >= 44 && height === width), 'The tray must keep at least 44 pixels for a 2x bar.')
  assert(colourPixels > 0, 'The tray image must have colour pixels.')
  const chunks = resolve('out/main/chunks')
  const icons = readdirSync(chunks).filter(name => /^icon-.*\.png$/u.test(name))
  assert.equal(icons.length, 1, 'The build must emit the app icon once.')
  const iconFile = join(chunks, icons[0])
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  assert.equal(hash(iconFile), hash(resolve('build/icon.png')))
  log(JSON.stringify({ trayBus: bus, trayPid: child.pid,
    iconPixmapSizes: pixmaps.map(([width, height]) => [width, height]), colourPixels, iconFile,
    sourceFile: resolve('build/icon.png'), sameSourceHash: true }))

  if (screenshotFolder !== null) {
    mkdirSync(screenshotFolder, { recursive: true })
    await click('Continue')
    await heading('Copy your words, then paste')
    await click('Finish setup')
    await until(() => page("!!document.querySelector('a[title=Settings]')"))
    await page("document.querySelector('a[title=Settings]').click()")
    await until(() => page("Array.from(document.querySelectorAll('[role=tab]')).some(b => b.textContent.trim() === 'Application')"))
    await page("Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'Application').click()")
    const startup = () => page(`(() => {
      const row = document.querySelector('[role=switch][aria-label="Launch when you sign in"]');
      if (!row) return null;
      row.click();
      return { disabled: row.disabled, label: row.getAttribute('aria-label'), explanation: row.querySelector('.tt-field__description')?.textContent,
        errorNotice: document.body.textContent.includes('Launch at sign-in could not be updated.') };
    })()`)
    const startupState = await until(startup)
    assert.equal(startupState.disabled, true)
    assert.equal(startupState.explanation, 'Starting at sign-in comes with the installed package.')
    assert.equal(startupState.errorNotice, false)
    // Native decorations can add to the minimum on Wayland. Free this isolated
    // window's constraint while checking the renderer at the exact documented sizes.
    const minimumSize = await evaluate(`${mainWindow}.getMinimumSize()`)
    await evaluate(`${mainWindow}.setMinimumSize(0, 0)`)
    const screenshots = []
    for (const appearance of ['dark', 'light']) {
      await page(`window.sotto.updateSettings({ appearance: ${JSON.stringify(appearance)}, reducedMotion: 'on' })`)
      await until(() => page(`document.documentElement.dataset.theme === ${JSON.stringify(appearance)} && document.documentElement.dataset.reducedMotion === 'on'`))
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await evaluate(`${mainWindow}.setSize(${width}, ${height})`)
        await until(() => page(`Math.abs(innerWidth - ${width}) <= 2 && Math.abs(innerHeight - ${height}) <= 2`))
        await until(() => page(`(() => {
          const row = document.querySelector('[role=switch][aria-label="Launch when you sign in"]');
          row.scrollIntoView({ behavior: 'instant', block: 'center' });
          const rect = row.getBoundingClientRect();
          return rect.top >= 32 && rect.bottom <= innerHeight - 20;
        })()`))
        await page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const shot = join(screenshotFolder, `startup-${appearance}-${width}x${height}.png`)
        await evaluate(`(async () => { const png = (await ${mainWindow}.webContents.capturePage()).toPNG();
          process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(shot)}, png); })()`)
        const fits = await page('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight')
        assert(fits, 'The page must fit the window.')
        screenshots.push(shot)
      }
    }
    log(JSON.stringify({ startup: startupState, screenshots, reducedMotion: 'on', pageFitsAllSizes: true }))
    await page("document.querySelector('a[title=Help]').click()")
    await until(() => page("document.querySelector('.help-view h1')?.textContent === 'Help'"))
    const helpState = await page(`({ about: document.querySelector('.help-about').textContent.trim(),
      usesButton: document.body.textContent.includes('Use the dictation button to begin, then press Stop to finish.'),
      waylandLimit: document.body.textContent.includes('Wayland does not deliver this shortcut yet. Use the dictation button.'),
      copyOnly: document.body.textContent.includes('Sotto copies transcripts to the clipboard on Linux.') })`)
    assert(helpState.about.includes('Linux') && helpState.usesButton && helpState.waylandLimit && helpState.copyOnly)
    const helpShot = join(screenshotFolder, 'help-light-820x560.png')
    await evaluate(`(async () => { const png = (await ${mainWindow}.webContents.capturePage()).toPNG();
      process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(helpShot)}, png); })()`)
    log(JSON.stringify({ help: helpState, screenshot: helpShot }))
    await page("document.querySelector('.help-about').scrollIntoView({ behavior: 'instant', block: 'center' })")
    await page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const aboutShot = join(screenshotFolder, 'help-about-light-820x560.png')
    await evaluate(`(async () => { const png = (await ${mainWindow}.webContents.capturePage()).toPNG();
      process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(aboutShot)}, png); })()`)
    log(JSON.stringify({ helpAboutScreenshot: aboutShot }))
    await evaluate(`${mainWindow}.setMinimumSize(${minimumSize[0]}, ${minimumSize[1]})`)
  }
} finally {
  socket?.close()
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(child.pid, 'SIGTERM')
    const killTimeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, 'SIGKILL') }, 5_000)
    await exited
    clearTimeout(killTimeout)
  }
  log(`Stopped Electron PID ${child.pid}`)
}
