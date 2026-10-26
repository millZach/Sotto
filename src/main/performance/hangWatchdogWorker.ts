import { Session } from 'node:inspector'
import { parentPort, workerData } from 'node:worker_threads'

import { saveHangRecording, updateHangRecording } from './hangRecording'
import { MainHangWatch, type MainDebugger } from './mainHangWatch'
import { HEARTBEAT_SLOT, QUIT_SLOT, WATCH_TICK_MS, type HangWatchdogWorkerData } from './hangWatchdogShared'

/**
 * The hang watch's own thread (#1581): built beside main's index.js and started by `hangWatchdog.ts`. It reads main's
 * heartbeat from shared memory, so it needs nothing from main to notice main has stopped, and reaches main's debugger
 * through `connectToMainThread`, which opens no port.
 */
const data = workerData as HangWatchdogWorkerData
const shared = new BigInt64Array(data.shared)

interface PausedFrame { readonly functionName?: unknown; readonly url?: string; readonly location?: { readonly scriptId?: string; readonly lineNumber?: unknown; readonly columnNumber?: unknown } }

function mainDebugger(): MainDebugger {
  const session = new Session()
  session.connectToMainThread()
  // A paused frame's own `url` is deprecated and comes empty; its script's address comes from the scripts the debugger
  // announces as it is enabled.
  const scripts = new Map<string, string>()
  session.on('Debugger.scriptParsed', message => { scripts.set(message.params.scriptId, message.params.url) })
  return {
    post: (method, params) => new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => { if (error) reject(error); else resolve(result) })
    }),
    nextPause: withinMs => new Promise(resolve => {
      const timer = setTimeout(() => { session.off('Debugger.paused', paused); resolve(null) }, withinMs)
      const paused = (message: { params: { callFrames?: unknown[] } }): void => {
        clearTimeout(timer)
        // Only a frame's name and place are taken; its `this`, scopes and values are never read (ADR-0098).
        resolve((message.params.callFrames ?? []).map(frame => {
          const { functionName, url, location } = frame as PausedFrame
          return { functionName, url: url || scripts.get(location?.scriptId ?? '') || '',
            location: { lineNumber: location?.lineNumber, columnNumber: location?.columnNumber } }
        }))
      }
      session.once('Debugger.paused', paused)
    }),
    close: () => session.disconnect(),
  }
}

const watch = new MainHangWatch({
  lastAnswered: () => Number(Atomics.load(shared, HEARTBEAT_SLOT)),
  quitReceivedAt: () => Number(Atomics.load(shared, QUIT_SLOT)),
  now: () => Date.now(),
  connect: mainDebugger,
  save: record => saveHangRecording(data.directory, record),
  update: (name, record) => updateHangRecording(data.directory, name, record),
  // From a worker this ends the whole process: TerminateProcess on Windows, SIGKILL elsewhere.
  kill: () => { process.kill(process.pid, 'SIGKILL') },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  // Stable names only; main logs them when it can.
  log: event => parentPort?.postMessage(event),
  appRoots: data.appRoots,
  devOrigins: data.devOrigins,
  sottoVersion: data.sottoVersion,
  platform: data.platform,
  ...(data.hangMs ? { hangMs: data.hangMs } : {}),
  ...(data.quitForceMs ? { quitForceMs: data.quitForceMs } : {}),
})

let looking = false
setInterval(() => {
  if (looking) return
  looking = true
  void watch.tick().catch(() => undefined).finally(() => { looking = false })
}, WATCH_TICK_MS)
