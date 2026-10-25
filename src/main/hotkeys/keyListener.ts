import type { SottoPlatform } from '../../shared/platform'

export interface KeyListenerChild {
  readonly stdin: {
    write(chunk: string): boolean
    end(): void
    on(event: 'error', listener: (error: Error) => void): unknown
  } | null
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

/** 'unavailable': there is no helper to spawn here. */
export type KeyListenerPermissionState = 'granted' | 'denied' | 'unknown' | 'unavailable'

export interface KeyListenerOptions {
  readonly platform: SottoPlatform
  readonly spawnHelper: () => KeyListenerChild | null
  onKey(type: 'down' | 'up', token: string): void
  onReset(): void
  onPermission(permission: 'granted' | 'denied'): void
  onExit(): void
  log(event: string): void
  /** How long a fresh helper may take to print its first permission line (default 5 s). */
  readonly readyTimeoutMs?: number
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface KeyListener {
  watch(tokens: readonly string[]): void
  record(on: boolean): void
  request(): void
  running(): boolean
  /** The running helper has printed its first permission line, so it acts on commands. */
  ready(): boolean
  permission(): KeyListenerPermissionState
  dispose(): void
}

const READY_TIMEOUT_MS = 5_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 3
const MAX_BUFFERED_CHARS = 4_096
const TOKEN_PATTERN = /^[A-Za-z0-9]+$/

interface Session {
  readonly child: KeyListenerChild
  readonly readyTimer: unknown
  buffer: string
  ready: boolean
  dead: boolean
}

export function createKeyListener(options: KeyListenerOptions): KeyListener {
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let session: Session | null = null
  let tokens: string[] = []
  let recording = false
  let permission: KeyListenerPermissionState = 'unknown'
  let restarts: number[] = []
  let gaveUp = false
  let disposed = false

  const wanted = (): boolean => tokens.length > 0 || recording

  const send = (target: Session, line: string): void => {
    if (target.dead) return
    try {
      target.child.stdin?.write(`${line}\n`)
    } catch {
      fail(target)
    }
  }

  const finish = (target: Session, unexpected: boolean): void => {
    if (target.dead) return
    target.dead = true
    clearTimer(target.readyTimer)
    if (session === target) session = null
    try {
      target.child.stdin?.end()
    } catch {
      // The child is already gone.
    }
    try {
      target.child.kill()
    } catch {
      // The child is already gone.
    }
    options.onReset()
    options.onExit()
    if (!unexpected || disposed) return
    const at = now()
    restarts = restarts.filter((time) => at - time < RESTART_WINDOW_MS)
    if (restarts.length >= MAX_RESTARTS) {
      gaveUp = true
      options.log('native-key-listener-gave-up')
      return
    }
    restarts.push(at)
    options.log('native-key-listener-restarting')
    sync()
  }

  const fail = (target: Session): void => finish(target, true)

  const handleLine = (target: Session, line: string): void => {
    const parts = line.split(' ')
    if (parts.length === 1 && parts[0] === 'reset') {
      options.onReset()
      return
    }
    if (parts.length !== 2) return
    const [kind, value] = parts as [string, string]
    if (kind === 'permission' && (value === 'granted' || value === 'denied')) {
      if (!target.ready) {
        target.ready = true
        clearTimer(target.readyTimer)
      }
      permission = value
      options.onPermission(value)
    } else if ((kind === 'down' || kind === 'up') && TOKEN_PATTERN.test(value)) {
      options.onKey(kind, value)
    }
  }

  const start = (): void => {
    let child: KeyListenerChild | null
    try {
      child = options.spawnHelper()
    } catch {
      child = null
    }
    if (child === null) {
      permission = 'unavailable'
      options.log('native-key-listener-unavailable')
      return
    }
    const target: Session = {
      child,
      buffer: '',
      ready: false,
      dead: false,
      readyTimer: setTimer(() => {
        if (target.ready) return
        options.log('native-key-listener-not-ready')
        fail(target)
      }, options.readyTimeoutMs ?? READY_TIMEOUT_MS),
    }
    session = target
    try {
      child.once('error', () => fail(target))
      child.once('exit', () => fail(target))
      child.stdin?.on('error', () => fail(target))
      child.stdout?.on('data', (chunk) => {
        if (target.dead) return
        target.buffer += String(chunk)
        let newline = target.buffer.indexOf('\n')
        while (newline >= 0 && !target.dead) {
          const line = target.buffer.slice(0, newline)
          target.buffer = target.buffer.slice(newline + 1)
          handleLine(target, line.endsWith('\r') ? line.slice(0, -1) : line)
          newline = target.buffer.indexOf('\n')
        }
        // A helper that never ends a line must not grow this buffer without bound.
        if (target.buffer.length > MAX_BUFFERED_CHARS) target.buffer = ''
      })
    } catch {
      fail(target)
      return
    }
    if (child.stdin === null || child.stdout === null) {
      fail(target)
      return
    }
    send(target, `keys ${tokens.join(' ')}`.trimEnd())
    if (recording) send(target, 'record on')
  }

  const sync = (): void => {
    if (disposed) return
    if (wanted() && session === null && !gaveUp) start()
    else if (!wanted() && session !== null) finish(session, false)
  }

  const rearm = (): void => {
    if (!gaveUp) return
    gaveUp = false
    restarts = []
  }

  return {
    watch(next) {
      if (disposed) return
      tokens = next.filter((token) => TOKEN_PATTERN.test(token))
      rearm()
      if (session !== null && wanted()) send(session, `keys ${tokens.join(' ')}`.trimEnd())
      sync()
    },

    record(on) {
      if (disposed) return
      recording = on
      rearm()
      if (session !== null && wanted()) send(session, on ? 'record on' : 'record off')
      sync()
    },

    request() {
      if (session !== null) send(session, 'request')
    },

    running() {
      return session !== null
    },

    ready() {
      return session?.ready ?? false
    },

    permission() {
      return permission
    },

    dispose() {
      disposed = true
      if (session !== null) finish(session, false)
    },
  }
}
