// @vitest-environment node
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createKeyListener, type KeyListenerChild, type KeyListenerOptions } from '../../../src/main/hotkeys/keyListener'
import { spawnKeyListenerHelper } from '../../../src/main/hotkeys/keyListenerHelpers'

vi.mock('../../../src/main/hotkeys/keyListenerWin32', () => ({
  keyListenerWin32Invocation: (csPath: string, acceptSynthetic: boolean) => ({
    executable: 'powershell.exe',
    args: ['-EncodedCommand', `${csPath}|${String(acceptSynthetic)}`],
  }),
}))

class FakeChild implements KeyListenerChild {
  readonly written: string[] = []
  ended = false
  killed = false
  private data: ((chunk: unknown) => void) | null = null
  private exitListener: (() => void) | null = null
  readonly stdin = {
    write: (chunk: string) => {
      this.written.push(chunk)
      return true
    },
    end: () => {
      this.ended = true
    },
    on: () => undefined,
  }
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: unknown) => void) => {
      this.data = listener
    },
  }
  once(event: 'error' | 'exit', listener: (...args: never[]) => void): unknown {
    if (event === 'exit') this.exitListener = listener as () => void
    return this
  }
  kill(): boolean {
    this.killed = true
    return true
  }
  emit(text: string): void {
    this.data?.(Buffer.from(text))
  }
  exit(): void {
    this.exitListener?.()
  }
}

function setup(extra: Partial<KeyListenerOptions> = {}) {
  const children: FakeChild[] = []
  const calls: string[] = []
  const logs: string[] = []
  const timers: { callback: () => void; cleared: boolean; delayMs: number }[] = []
  let clock = 0
  const listener = createKeyListener({
    platform: 'darwin',
    spawnHelper: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
    onKey: (type, token) => calls.push(`${type} ${token}`),
    onReset: () => calls.push('reset'),
    onPermission: (permission) => calls.push(`permission ${permission}`),
    onExit: () => calls.push('exit'),
    log: (event) => logs.push(event),
    now: () => clock,
    setTimer: (callback, delayMs) => {
      const timer = { callback, cleared: false, delayMs }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    ...extra,
  })
  const fireTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback()
  }
  return {
    listener,
    children,
    calls,
    logs,
    fireTimers,
    timers,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('createKeyListener', () => {
  it('spawns lazily and stops when nothing is watched or recorded', () => {
    const { listener, children, calls } = setup()
    listener.watch([])
    listener.record(false)
    expect(children).toHaveLength(0)
    expect(listener.running()).toBe(false)

    listener.watch(['Fn', 'Space'])
    expect(children).toHaveLength(1)
    expect(children[0]!.written).toEqual(['keys Fn Space\n'])
    listener.record(true)
    listener.watch([])
    expect(listener.running()).toBe(true)
    expect(children[0]!.written).toEqual(['keys Fn Space\n', 'record on\n', 'keys\n'])

    listener.record(false)
    expect(listener.running()).toBe(false)
    expect(children[0]!.ended).toBe(true)
    expect(children[0]!.killed).toBe(true)
    expect(calls).toEqual(['reset', 'exit'])
    children[0]!.exit()
    expect(children).toHaveLength(1)
    expect(calls).toEqual(['reset', 'exit'])

    listener.record(true)
    expect(children).toHaveLength(2)
    expect(children[1]!.written).toEqual(['keys\n', 'record on\n'])
  })

  it('parses lines strictly, tolerates CRLF and split chunks, and never logs line content', () => {
    const { listener, children, calls, logs } = setup()
    listener.watch(['Fn'])
    expect(listener.permission()).toBe('unknown')
    const child = children[0]!
    child.emit('permission granted\r\ndown F')
    child.emit('n\nsecret typed text\ndown\ndown Fn extra\nup Fn\r\nreset\nup a b\npermission maybe\n')
    child.emit('down Fn;rm\n\nup Other\nup Fn')
    expect(calls).toEqual(['permission granted', 'down Fn', 'up Fn', 'reset', 'up Other'])
    expect(listener.permission()).toBe('granted')
    child.emit('\npermission denied\n')
    expect(calls.slice(-2)).toEqual(['up Fn', 'permission denied'])
    expect(listener.permission()).toBe('denied')
    expect(logs.join(' ')).not.toMatch(/secret|Fn|rm|maybe/)
  })

  it('sends request only to a running helper', () => {
    const { listener, children } = setup()
    listener.request()
    listener.watch(['Fn'])
    listener.request()
    expect(children[0]!.written).toEqual(['keys Fn\n', 'request\n'])
  })

  it('kills a helper that is not ready within 5 s and counts it as a failure', () => {
    const { listener, children, calls, logs, fireTimers } = setup()
    listener.watch(['Fn'])
    fireTimers()
    expect(children[0]!.killed).toBe(true)
    expect(logs).toEqual(['native-key-listener-not-ready', 'native-key-listener-restarting'])
    expect(calls).toEqual(['reset', 'exit'])
    expect(children).toHaveLength(2)

    children[1]!.emit('permission granted\n')
    fireTimers()
    expect(children[1]!.killed).toBe(false)
    expect(children).toHaveLength(2)
  })

  it.each([[undefined, 5_000], [30_000, 30_000]])('waits readyTimeoutMs %s for the first permission line', (readyTimeoutMs, expected) => {
    const { listener, timers } = setup(readyTimeoutMs === undefined ? {} : { readyTimeoutMs })
    listener.watch(['Fn'])
    expect(timers.map((timer) => timer.delayMs)).toEqual([expected])
  })

  it('reports unavailable when there is no helper to spawn', () => {
    const { listener, logs } = setup({ spawnHelper: () => null })
    expect(listener.permission()).toBe('unknown')
    listener.watch(['Fn'])
    expect(listener.permission()).toBe('unavailable')
    expect(listener.running()).toBe(false)
    expect(logs).toEqual(['native-key-listener-unavailable'])
  })

  it('restarts at most 3 times per 60 s, then gives up until re-armed', () => {
    const { listener, children, calls, logs, advance } = setup()
    listener.watch(['Fn'])
    for (let index = 0; index < 3; index += 1) children.at(-1)!.exit()
    expect(children).toHaveLength(4)
    children.at(-1)!.exit()
    expect(children).toHaveLength(4)
    expect(listener.running()).toBe(false)
    expect(logs.at(-1)).toBe('native-key-listener-gave-up')
    expect(calls.slice(-2)).toEqual(['reset', 'exit'])

    listener.watch(['Fn'])
    expect(children).toHaveLength(5)
    advance(60_000)
    for (let index = 0; index < 3; index += 1) {
      children.at(-1)!.exit()
      advance(30_000)
    }
    expect(children).toHaveLength(8)
    expect(listener.running()).toBe(true)
  })

  it('dispose stops the helper without restarting it', () => {
    const { listener, children, calls } = setup()
    listener.watch(['Fn'])
    listener.dispose()
    children[0]!.exit()
    listener.watch(['Fn'])
    expect(children).toHaveLength(1)
    expect(calls).toEqual(['reset', 'exit'])
  })
})

describe('spawnKeyListenerHelper', () => {
  function spawnWith(platform: 'darwin' | 'win32' | 'linux', packaged: boolean, present = true) {
    const spawned: { command: string; args: readonly string[]; options: unknown }[] = []
    const checked: string[] = []
    const logs: string[] = []
    const child = new FakeChild()
    const result = spawnKeyListenerHelper(platform, {
      resourcesPath: '/res',
      appPath: '/app',
      packaged,
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        return child
      },
      exists: (path) => {
        checked.push(path)
        return present
      },
      log: (event) => logs.push(event),
    })
    return { result, child, spawned, checked, logs }
  }

  it('runs the packaged darwin binary from resources', () => {
    const { result, child, spawned } = spawnWith('darwin', true)
    expect(result).toBe(child)
    expect(spawned).toEqual([
      {
        command: join('/res', 'native', 'sotto-key-listener'),
        args: [],
        options: { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
      },
    ])
  })

  it('runs the unpackaged darwin build and passes --accept-synthetic', () => {
    const spawned: { command: string; args: readonly string[] }[] = []
    spawnKeyListenerHelper('darwin', {
      resourcesPath: '/res',
      appPath: '/app',
      packaged: false,
      acceptSynthetic: true,
      spawn: (command, args) => {
        spawned.push({ command, args })
        return new FakeChild()
      },
      exists: () => true,
      log: () => undefined,
    })
    expect(spawned).toEqual([
      { command: join('/app', 'native', 'key-listener', 'build', 'sotto-key-listener'), args: ['--accept-synthetic'] },
    ])
  })

  it('logs a missing binary and spawns nothing', () => {
    const { result, spawned, logs } = spawnWith('darwin', true, false)
    expect(result).toBeNull()
    expect(spawned).toEqual([])
    expect(logs).toEqual(['native-key-listener-missing'])
  })

  it('builds the win32 invocation from the shipped or source C# file', () => {
    const packaged = spawnWith('win32', true)
    const csPackaged = join('/res', 'native', 'win32.cs')
    expect(packaged.checked).toEqual([csPackaged])
    expect(packaged.spawned[0]).toMatchObject({
      command: 'powershell.exe',
      args: ['-EncodedCommand', `${csPackaged}|false`],
      options: { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    })
    const unpackaged = spawnWith('win32', false)
    expect(unpackaged.checked).toEqual([join('/app', 'native', 'key-listener', 'win32.cs')])
  })

  it('returns null on linux', () => {
    const { result, spawned, checked } = spawnWith('linux', true)
    expect(result).toBeNull()
    expect(spawned).toEqual([])
    expect(checked).toEqual([])
  })
})
