/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron test bootstrap. */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = process.env.SOTTO_DIAGRAM_SAFETY_DIR
if (!root || app.isPackaged) throw new Error('Isolated diagram safety fixture required.')
app.setPath('userData', join(root, 'profile'))
globalThis.diagramSafety = { requests: [], unexpected: [], navigations: [], popups: [] }
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  // Exact built fixture files only. In particular, never blanket-allow file: URLs.
  const allowed = new Set(['index.html', 'bundle.js', 'bundle.css'].map(name => pathToFileURL(join(root, name)).href))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    globalThis.diagramSafety.requests.push(details.url)
    const unexpected = !allowed.has(details.url)
    if (unexpected) globalThis.diagramSafety.unexpected.push(details.url)
    callback({ cancel: unexpected })
  })
  window.webContents.on('will-navigate', (event, url) => {
    globalThis.diagramSafety.navigations.push(url)
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(details => {
    globalThis.diagramSafety.popups.push(details.url)
    return { action: 'deny' }
  })
  void window.loadFile(join(root, 'index.html'))
})
