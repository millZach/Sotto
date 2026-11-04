import type { SottoPlatform } from '../../shared/platform'

export interface KeyListenerChild {
  readonly stdin: {
    write(chunk: string): boolean
    end(): void
    on(event: 'error', listener: (error: Error) => void): unknown
    on(event: 'drain', listener: () => void): unknown
  } | null
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

/** 'unavailable': there is no helper to spawn here. */
export type KeyListenerPermissionState = 'granted' | 'denied' | 'unknown' | 'unavailable'

/** Dispatched means both events were submitted, not that the app consumed them. */
export type KeyListenerPasteResult = 'not-sent' | 'dispatched' | 'uncertain'

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
  /** The keys to report, and the shortcuts whose key is kept from the app in front (macOS, with Accessibility). */
  watch(tokens: readonly string[], chords?: readonly string[]): void
  record(on: boolean): void
  request(): void
  running(): boolean
  /** The running helper has printed its first permission line, so it acts on commands. */
  ready(): boolean
  permission(): KeyListenerPermissionState
  /** Uses only the already-running, ready macOS helper. Never starts or retains it. */
  paste(): Promise<KeyListenerPasteResult>
  dispose(): void
}

const READY_TIMEOUT_MS = 5_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 3
const MAX_BUFFERED_CHARS = 4_096
const TOKEN_PATTERN = /^[A-Za-z0-9]+$/
const CHORD_PATTERN = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/
const PASTE_ACK_TIMEOUT_MS = 5_000

interface Session {
  readonly child: KeyListenerChild
  readonly readyTimer: unknown
  buffer: string
  ready: boolean
  dead: boolean
  pasteCapable: boolean
  backpressure: boolean
  paste: { id: string; timer: unknown; resolve(result: KeyListenerPasteResult): void } | null
}

export function createKeyListener(options: KeyListenerOptions): KeyListener {
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let session: Session | null = null
  let tokens: string[] = []
  let chords: string[] = []
  let recording = false
  let permission: KeyListenerPermissionState = 'unknown'
  let restarts: number[] = []
  let gaveUp = false
  let disposed = false
  let pasteId = 0

  const wanted = (): boolean => tokens.length > 0 || recording

  const send = (target: Session, line: string): void => {
    if (target.dead) return
    try {
      // false means accepted with backpressure, never permission to resend.
      if (target.child.stdin?.write(`${line}\n`) === false) target.backpressure = true
    } catch {
      fail(target)
    }
  }

  const finishPaste = (target: Session, result: KeyListenerPasteResult): void => {
    const pending = target.paste
    if (pending === null) return
    target.paste = null
    clearTimer(pending.timer)
    pending.resolve(result)
  }

  const finish = (target: Session, unexpected: boolean): void => {
    if (target.dead) return
    target.dead = true
    finishPaste(target, 'uncertain')
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
    if (parts.length === 3 && parts[0] === 'paste' && parts[1] === target.paste?.id
      && (parts[2] === 'dispatched' || parts[2] === 'not-sent')) {
      finishPaste(target, parts[2])
      return
    }
    if (parts.length === 1 && parts[0] === 'reset') {
      options.onReset()
      return
    }
    if (parts.length !== 2) return
    const [kind, value] = parts as [string, string]
    if (kind === 'capability' && value === 'paste-v1') {
      target.pasteCapable = true
    } else if (kind === 'permission' && (value === 'granted' || value === 'denied')) {
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
      pasteCapable: false,
      backpressure: false,
      paste: null,
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
      child.stdin?.on('drain', () => { target.backpressure = false })
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
    send(target, `swallow ${chords.join(' ')}`.trimEnd())
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
    watch(next, nextChords = []) {
      if (disposed) return
      tokens = next.filter((token) => TOKEN_PATTERN.test(token))
      chords = nextChords.filter((chord) => CHORD_PATTERN.test(chord))
      rearm()
      if (session !== null && wanted()) {
        send(session, `keys ${tokens.join(' ')}`.trimEnd())
        send(session, `swallow ${chords.join(' ')}`.trimEnd())
      }
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

    paste() {
      const target = session
      // An overlapping delivery must not paste via a second transport either.
      if (target?.paste) return Promise.resolve('uncertain')
      if (options.platform !== 'darwin' || disposed || target === null || !target.ready
        || !target.pasteCapable || target.backpressure || target.child.stdin === null) {
        return Promise.resolve('not-sent')
      }
      return new Promise(resolve => {
        const id = String(++pasteId)
        // Stop queued paste work before recovery can replace the clipboard.
        const timer = setTimer(() => fail(target), PASTE_ACK_TIMEOUT_MS)
        target.paste = { id, timer, resolve }
        // Once write is attempted, any failure is uncertain, even a synchronous throw.
        send(target, `paste ${id}`)
      })
    },

    dispose() {
      disposed = true
      if (session !== null) finish(session, false)
    },
  }
}
