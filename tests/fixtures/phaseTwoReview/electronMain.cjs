// Review-only Electron entry: loads the built Phase 2 workspace fixture with the production window security posture.
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron bootstrap is CommonJS. */
const { app, BrowserWindow, ipcMain } = require('electron')
const { resolve, join } = require('node:path')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

if (app.isPackaged || process.env.SOTTO_PHASE_TWO_FIXTURE !== '1') throw new Error('The Phase 2 review fixture requires an unpackaged opt-in launch.')
const profile = mkdtempSync(join(tmpdir(), 'sotto-phase-two-fixture-'))
app.setPath('userData', profile)
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chromium may still hold files. */ } })

globalThis.phaseTwoFixture = { opened: [], copied: [], navigations: [] }
ipcMain.handle('phase-two-fixture:open-link', (_event, url) => { globalThis.phaseTwoFixture.opened.push(url); return 'copied' })
// Copy is recorded, never written to the user's clipboard.
ipcMain.handle('phase-two-fixture:deliver-output', (_event, request) => { globalThis.phaseTwoFixture.copied.push(String(request.text)); return 'copied' })

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: Number(process.env.SOTTO_PHASE_TWO_FIXTURE_WIDTH || 1280),
    height: Number(process.env.SOTTO_PHASE_TWO_FIXTURE_HEIGHT || 800),
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: resolve(__dirname, 'preload.cjs') },
  })
  window.setMinimumSize(700, 500)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { globalThis.phaseTwoFixture.navigations.push(url); event.preventDefault() })
  void window.loadFile(resolve(__dirname, '../../../.cache/phase-two-review-fixture/index.html'))
})
