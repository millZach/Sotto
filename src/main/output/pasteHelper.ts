import type { PasteProcessAdapter } from './outputService'
import type { PasteInvocation } from './pasteCommand'
import { buildPasteHelperInvocation } from './pasteCommand.win32'
import { deliveredAppName } from '../../shared/dictationRecord'

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
  /**
   * The display name of the app that owns the foreground window, asked of the helper ahead of any paste queued after it
   * (ADR-0100). Null when the helper cannot answer; never a window title.
   */
  readForegroundApp(): Promise<string | null>
}

const HELPER_RESPONSE_TIMEOUT_MS = 5_000
/** How long a delivery waits for the foreground app before going on without it. The paste is never held longer. */
export const HELPER_APP_TIMEOUT_MS = 1_000

/** A command the helper has been, or will be, sent, answered in the order it was sent. */
interface PendingCommand {
  readonly command: 'paste' | 'app'
  /** The helper's line for this command. */
  answer(line: string): void
  /** The helper went away before answering. */
  lost(): void
  timer: unknown
}

interface HelperSession {
  readonly process: HelperProcessLike
  readonly pending: PendingCommand[]
  buffer: string
  dead: boolean
  ready: boolean
}

/** Reads the helper's answer to `app`: `app` alone when no name could be read, else `app` and the name as base64 UTF-8. */
export function parseForegroundAppReply(line: string): string | null {
  const match = /^app(?: ([A-Za-z0-9+/=]*))?$/u.exec(line)
  if (match === null || match[1] === undefined || match[1].length === 0) return null
  return deliveredAppName(Buffer.from(match[1], 'base64').toString('utf8'))
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
      request.lost()
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
              for (const request of [...created.pending]) {
                if (created.dead) break
                dispatch(created, request.command)
              }
            }
            newlineIndex = created.buffer.indexOf('\n')
            continue
          }
          const request = created.ready ? created.pending.shift() : undefined
          if (request !== undefined) {
            clearTimer(request.timer)
            request.answer(line)
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

  const dispatch = (target: HelperSession, command: PendingCommand['command']): void => {
    try {
      // A false return means backpressure, not that the command was rejected.
      target.process.stdin!.write(`${command}\n`)
    } catch {
      destroySession(target)
    }
  }

  const pasteViaHelper = (target: HelperSession): Promise<boolean | 'unavailable'> => {
    return new Promise((resolve) => {
      const request: PendingCommand = {
        command: 'paste',
        answer: line => resolve(line === 'ok'),
        lost: () => resolve(target.ready || disposed ? false : 'unavailable'),
        timer: setTimer(() => {
          // Before ready no command is sent; after ready a paste may have happened.
          destroySession(target)
        }, responseTimeoutMs),
      }
      target.pending.push(request)
      if (target.ready) dispatch(target, 'paste')
    })
  }

  const appViaHelper = (target: HelperSession): Promise<string | null> => {
    return new Promise((resolve) => {
      const request: PendingCommand = {
        command: 'app',
        answer: line => resolve(parseForegroundAppReply(line)),
        lost: () => resolve(null),
        // A late answer is still taken off the queue, so every later answer stays with its own command.
        timer: setTimer(() => resolve(null), Math.min(HELPER_APP_TIMEOUT_MS, responseTimeoutMs)),
      }
      target.pending.push(request)
      if (target.ready) dispatch(target, 'app')
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

    readForegroundApp(): Promise<string | null> {
      const target = ensureSession()
      return target === null ? Promise.resolve(null) : appViaHelper(target)
    },

    dispose(): void {
      disposed = true
      const target = session
      if (target !== null) destroySession(target)
    },
  }
}
