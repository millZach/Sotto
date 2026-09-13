// Test-only preload: stands in for the real openExternalLink bridge and records what the renderer asked to open.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- sandboxed preload is CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sotto', {
  openExternalLink: url => ipcRenderer.invoke('rich-fixture:open-link', url),
})
