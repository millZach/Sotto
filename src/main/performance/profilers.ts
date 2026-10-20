import { Session } from 'node:inspector'

import type { ProfilerTarget, RawCpuProfile } from './activityRecorder'

/** One microsecond sample interval in Chrome's terms: a sample every millisecond, the DevTools default. */
const SAMPLING_INTERVAL_US = 1_000

/** Sends one DevTools protocol command to whatever is being profiled. */
export type ProtocolSend = (method: string, params?: object) => Promise<unknown>

/**
 * The Profiler domain's lifecycle over one connection, the same for main's inspector session and the window's
 * debugger: `open` connects, then enable, the sampling interval and start; stop hands back the profile; cancel stops
 * keeping nothing. `close` runs once, after a stop or a cancel, and never throws.
 */
export function protocolProfiler(connection: { readonly open: () => void; readonly send: ProtocolSend; readonly close: () => void }): ProfilerTarget {
  let connected = false
  const close = (): void => { if (connected) { connected = false; try { connection.close() } catch { /* already gone */ } } }
  return {
    async start() {
      connection.open()
      connected = true
      await connection.send('Profiler.enable')
      await connection.send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
      await connection.send('Profiler.start')
    },
    async stop() {
      try {
        const { profile } = await connection.send('Profiler.stop') as { profile: RawCpuProfile }
        return profile
      } finally { close() }
    },
    async cancel() {
      if (!connected) return
      await connection.send('Profiler.stop').catch(() => undefined)
      close()
    },
  }
}

/**
 * Main's own CPU profile through an in-process inspector session (ADR-0098). `Session.connect` talks to this process's
 * own inspector without opening a port or a listener, so nothing outside Sotto can reach it.
 */
export function mainProcessProfiler(): ProfilerTarget {
  const session = new Session()
  return protocolProfiler({
    open: () => session.connect(),
    send: (method, params) => new Promise((resolve, reject) => {
      session.post(method, params ?? {}, (error, result) => { if (error) reject(error); else resolve(result) })
    }),
    close: () => session.disconnect(),
  })
}

/** The part of Electron's `webContents.debugger` a window profile needs. */
export interface DebuggerLike {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: object): Promise<unknown>
}

/**
 * The main window's CPU profile through its own debugger, which Electron gives main without a port. When DevTools or
 * anything else already holds that debugger, attaching fails and the recording keeps main's profile alone.
 */
export function windowProfiler(target: DebuggerLike): ProfilerTarget {
  return protocolProfiler({
    open: () => target.attach('1.3'),
    send: (method, params) => target.sendCommand(method, params),
    close: () => target.detach(),
  })
}
