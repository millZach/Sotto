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

export const HELPER_RESPONSE_TIMEOUT_MS = 5_000

interface PendingPaste {
  resolve(successful: boolean | 'helper-lost'): void
  timer: unknown
}

interface HelperSession {
  readonly process: HelperProcessLike
  readonly pending: PendingPaste[]
  buffer: string
  dead: boolean
}

export function createWarmPasteAdapter(options: WarmPasteAdapterOptions): WarmPasteAdapter {
  const responseTimeoutMs = options.responseTimeoutMs ?? HELPER_RESPONSE_TIMEOUT_MS
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let session: HelperSession | null = null
  let disposed = false

  const settlePending = (session: HelperSession, outcome: boolean | 'helper-lost'): void => {
    const pending = session.pending.splice(0)
    for (const request of pending) {
      clearTimer(request.timer)
      request.resolve(outcome)
    }
  }

  const destroySession = (target: HelperSession, outcome: boolean | 'helper-lost'): void => {
    if (session === target) session = null
    if (target.dead) return
    target.dead = true
    settlePending(target, outcome)
    try {
      target.process.kill()
    } catch {
      // The helper is already unusable; the fallback path covers delivery.
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
    const created: HelperSession = { process, pending: [], buffer: '', dead: false }
    session = created

    try {
      process.once('error', () => destroySession(created, 'helper-lost'))
      process.once('exit', () => destroySession(created, 'helper-lost'))
      process.stdout?.on('data', (chunk) => {
        created.buffer += String(chunk)
        let newlineIndex = created.buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = created.buffer.slice(0, newlineIndex).trim()
          created.buffer = created.buffer.slice(newlineIndex + 1)
          const request = created.pending.shift()
          if (request !== undefined) {
            clearTimer(request.timer)
            request.resolve(line === 'ok')
          }
          newlineIndex = created.buffer.indexOf('\n')
        }
      })
    } catch {
      destroySession(created, 'helper-lost')
      return null
    }
    return created
  }

  const pasteViaHelper = (target: HelperSession): Promise<boolean | 'helper-lost'> => {
    return new Promise((resolve) => {
      const request: PendingPaste = {
        resolve,
        timer: setTimer(() => {
          // A hung helper cannot be trusted for future pastes either.
          destroySession(target, 'helper-lost')
        }, responseTimeoutMs),
      }
      target.pending.push(request)
      let written: boolean
      try {
        written = target.process.stdin?.write('paste\n') ?? false
      } catch {
        written = false
      }
      if (!written) destroySession(target, 'helper-lost')
    })
  }

  return {
    start(): void {
      ensureSession()
    },

    async run(invocation): Promise<boolean> {
      const target = ensureSession()
      if (target === null) return options.fallback.run(invocation)

      const outcome = await pasteViaHelper(target)
      if (outcome === 'helper-lost') return options.fallback.run(invocation)
      return outcome
    },

    dispose(): void {
      disposed = true
      const target = session
      if (target !== null) destroySession(target, false)
    },
  }
}
