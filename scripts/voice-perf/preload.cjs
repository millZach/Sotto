/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('voicePerf', {
  fixture: () => ipcRenderer.invoke('perf:fixture'),
  prepare: () => ipcRenderer.invoke('perf:prepare'),
  utterance: command => ipcRenderer.invoke('perf:utterance', command),
  transcribe: request => ipcRenderer.invoke('perf:transcribe', request),
  cancelTranscription: id => ipcRenderer.invoke('perf:cancel', id),
})



