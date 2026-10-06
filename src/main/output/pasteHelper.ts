import type { PasteProcessAdapter } from './outputService'
import type { PasteInvocation } from './pasteCommand'
import { buildPasteHelperInvocation } from './pasteCommand.win32'

export interface HelperProcessLike {
  readonly stdin: { write(chunk: string): boolean } | null
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

export type SpawnHelperProcess = (invocation: PasteInvocation) => HelperProcessLike

export interface WarmPasteAdapterOptions {
  readonly spawnHelper: SpawnHelperProcess
  readonly fallback: PasteProcessAdapter
  readonly responseTimeoutMs?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface WarmPasteAdapter extends PasteProcessAdapter {
  start(): void
  dispose(): void
}

const HELPER_RESPONSE_TIMEOUT_MS = 5_000

interface PendingPaste {
  resolve(result: boolean | 'unavailable'): void
  timer: unknown
}

interface HelperSession {
  readonly process: HelperProcessLike
  readonly pending: PendingPaste[]
  buffer: string
  dead: boolean
  ready: boolean
}

export function createWarmPasteAdapter(options: WarmPasteAdapterOptions): WarmPasteAdapter {
  const responseTimeoutMs = options.responseTimeoutMs ?? HELPER_RESPONSE_TIMEOUT_MS
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let session: HelperSession | null = null
  let disposed = false

  const settlePending = (session: HelperSession): void => {
    const pending = session.pending.splice(0)
    for (const request of pending) {
      clearTimer(request.timer)
      request.resolve(session.ready || disposed ? false : 'unavailable')
    }
  }

  const destroySession = (target: HelperSession): void => {
    if (session === target) session = null
    if (target.dead) return
    target.dead = true
    settlePending(target)
    try {
      target.process.kill()
    } catch {
      // The helper may already have pasted. An unconfirmed command is never retried.
    }
  }

  const ensureSession = (): HelperSession | null => {
    if (disposed) return null
    if (session !== null) return session

    let process: HelperProcessLike
    try {
      process = options.spawnHelper(buildPasteHelperInvocation())
    } catch {
      return null
    }
    const created: HelperSession = { process, pending: [], buffer: '', dead: false, ready: false }
    session = created

    try {
      process.once('error', () => destroySession(created))
      process.once('exit', () => destroySession(created))
      process.stdout?.on('data', (chunk) => {
        if (created.dead) return
        created.buffer += String(chunk)
        let newlineIndex = created.buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = created.buffer.slice(0, newlineIndex).trim()
          created.buffer = created.buffer.slice(newlineIndex + 1)
          if (line === 'ready') {
            if (!created.ready) {
              created.ready = true
              for (let index = 0, count = created.pending.length; index < count; index += 1) {
                if (created.dead) break
                dispatchPaste(created)
              }
            }
            newlineIndex = created.buffer.indexOf('\n')
            continue
          }
          const request = created.ready ? created.pending.shift() : undefined
          if (request !== undefined) {
            clearTimer(request.timer)
            request.resolve(line === 'ok')
          }
          newlineIndex = created.buffer.indexOf('\n')
        }
      })
    } catch {
      destroySession(created)
      return null
    }
    if (created.dead || process.stdin === null || process.stdout === null) {
      destroySession(created)
      return null
    }
    return created
  }

  const dispatchPaste = (target: HelperSession): void => {
    try {
      // A false return means backpressure, not that the command was rejected.
      target.process.stdin!.write('paste\n')
    } catch {
      destroySession(target)
    }
  }

  const pasteViaHelper = (target: HelperSession): Promise<boolean | 'unavailable'> => {
    return new Promise((resolve) => {
      const request: PendingPaste = {
        resolve,
        timer: setTimer(() => {
          // Before ready no command is sent; after ready a paste may have happened.
          destroySession(target)
        }, responseTimeoutMs),
      }
      target.pending.push(request)
      if (target.ready) dispatchPaste(target)
    })
  }

  return {
    start(): void {
      ensureSession()
    },

    async run(invocation): Promise<boolean> {
      const target = ensureSession()
      if (target === null) return options.fallback.run(invocation)

      const result = await pasteViaHelper(target)
      return result === 'unavailable' ? options.fallback.run(invocation) : result
    },

    dispose(): void {
      disposed = true
      const target = session
      if (target !== null) destroySession(target)
    },
  }
}
