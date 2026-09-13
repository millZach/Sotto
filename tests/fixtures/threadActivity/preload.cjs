// Test-only preload: a copy-only output bridge so code block Copy works as in the app.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- sandboxed preload is CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sotto', {
  openExternalLink: url => ipcRenderer.invoke('activity-fixture:open-link', url),
  deliverOutput: request => ipcRenderer.invoke('activity-fixture:deliver-output', request),
})
