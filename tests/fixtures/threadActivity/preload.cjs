// Test-only preload: copy-only output bridges so code block Copy and Copy image work as in the app.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- sandboxed preload is CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sotto', {
  openExternalLink: url => ipcRenderer.invoke('activity-fixture:open-link', url),
  deliverOutput: request => ipcRenderer.invoke('activity-fixture:deliver-output', request),
  copyImage: request => ipcRenderer.invoke('activity-fixture:copy-image', request),
})
