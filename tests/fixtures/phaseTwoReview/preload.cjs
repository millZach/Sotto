// Review-only preload: copy-only output and a recorded link opener, as in the thread activity fixture.
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- sandboxed preload is CommonJS. */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sotto', {
  platform: 'win32',
  openExternalLink: url => ipcRenderer.invoke('phase-two-fixture:open-link', url),
  deliverOutput: request => ipcRenderer.invoke('phase-two-fixture:deliver-output', request),
})
