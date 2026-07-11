import { contextBridge } from 'electron'

const talkTypeBridge = Object.freeze({})

contextBridge.exposeInMainWorld('talkType', talkTypeBridge)
