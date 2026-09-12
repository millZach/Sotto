/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('voicePerfSpeech', {
  synthesize: (provider, text) => ipcRenderer.invoke('perf:speech', provider, text),
  cancel: () => ipcRenderer.invoke('perf:speech-stop'),
})
