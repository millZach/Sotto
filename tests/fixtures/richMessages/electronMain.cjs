// Test-only Electron entry: loads the built rich message fixture with the production window security posture.
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron bootstrap is CommonJS. */
const { app, BrowserWindow, ipcMain } = require('electron')
const { resolve, join } = require('node:path')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

if (app.isPackaged || process.env.SOTTO_RICH_FIXTURE !== '1') throw new Error('The rich message fixture requires an unpackaged opt-in launch.')
const profile = mkdtempSync(join(tmpdir(), 'sotto-rich-fixture-'))
app.setPath('userData', profile)
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chromium may still hold files; the OS temp cleaner removes them. */ } })
if (process.env.SOTTO_RICH_FIXTURE_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.SOTTO_RICH_FIXTURE_SCALE)

globalThis.richFixture = { opened: [], navigations: [], popups: [] }

ipcMain.handle('rich-fixture:open-link', (_event, url) => {
  globalThis.richFixture.opened.push(url)
  return String(url).includes('fail') ? { ok: false, reason: 'unavailable' } : { ok: true }
})

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: Number(process.env.SOTTO_RICH_FIXTURE_WIDTH || 1080),
    height: Number(process.env.SOTTO_RICH_FIXTURE_HEIGHT || 720),
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, 'preload.cjs') },
  })
  window.webContents.setWindowOpenHandler(details => { globalThis.richFixture.popups.push(details.url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { globalThis.richFixture.navigations.push(url); event.preventDefault() })
  void window.loadFile(resolve(__dirname, '../../../test-results/rich-messages-fixture/index.html'))
})
