/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('bench', {
  status: () => ipcRenderer.invoke('bench:status'),
  synthesize: (provider, text, fixtureId) => ipcRenderer.invoke('bench:synthesize', provider, text, fixtureId),
  cancel: () => ipcRenderer.invoke('bench:cancel'),
})
