// Test-only Electron entry: loads the built thread activity fixture with the production window security posture.
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron bootstrap is CommonJS. */
const { app, BrowserWindow, ipcMain, clipboard } = require('electron')
const { resolve, join } = require('node:path')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

if (app.isPackaged || process.env.SOTTO_ACTIVITY_FIXTURE !== '1') throw new Error('The thread activity fixture requires an unpackaged opt-in launch.')
const profile = mkdtempSync(join(tmpdir(), 'sotto-activity-fixture-'))
app.setPath('userData', profile)
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chromium may still hold files. */ } })
if (process.env.SOTTO_ACTIVITY_FIXTURE_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', process.env.SOTTO_ACTIVITY_FIXTURE_SCALE)

globalThis.activityFixture = { opened: [], copied: [], navigations: [] }
ipcMain.handle('activity-fixture:open-link', (_event, url) => { globalThis.activityFixture.opened.push(url); return 'copied' })
ipcMain.handle('activity-fixture:deliver-output', (_event, request) => { globalThis.activityFixture.copied.push(request.text); clipboard.writeText(String(request.text)); return 'copied' })

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: Number(process.env.SOTTO_ACTIVITY_FIXTURE_WIDTH || 1280),
    height: Number(process.env.SOTTO_ACTIVITY_FIXTURE_HEIGHT || 860),
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, 'preload.cjs') },
  })
  window.setMinimumSize(760, 600)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { globalThis.activityFixture.navigations.push(url); event.preventDefault() })
  void window.loadFile(resolve(__dirname, '../../../test-results/thread-activity-fixture/index.html'))
})
