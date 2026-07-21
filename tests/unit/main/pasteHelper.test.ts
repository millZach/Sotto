import { describe, expect, it, vi } from 'vitest'

import { buildPasteHelperInvocation } from '../../../src/main/output/pasteCommand'
import {
  createWarmPasteAdapter,
  type HelperProcessLike,
} from '../../../src/main/output/pasteHelper'
import type { PasteProcessAdapter } from '../../../src/main/output/outputService'
import { buildPasteInvocation } from '../../../src/main/output/pasteCommand'

class FakeHelperProcess implements HelperProcessLike {
  writes: string[] = []
  killed = false
  private dataListener: ((chunk: unknown) => void) | undefined
  private exitListener: ((code: number | null, signal: string | null) => void) | undefined
  private errorListener: ((error: Error) => void) | undefined

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk)
      return true
    },
  }

  readonly stdout = {
    on: (_event: 'data', listener: (chunk: unknown) => void): void => {
      this.dataListener = listener
    },
  }

  once(event: 'error' | 'exit', listener: unknown): this {
    if (event === 'error') this.errorListener = listener as (error: Error) => void
    if (event === 'exit') {
      this.exitListener = listener as (code: number | null, signal: string | null) => void
    }
    return this
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  emit(text: string): void {
    this.dataListener?.(Buffer.from(text))
  }

  exit(code: number | null): void {
    this.exitListener?.(code, null)
  }

  fail(error: Error): void {
    this.errorListener?.(error)
  }
}

function fallbackAdapter(result = true): PasteProcessAdapter & { calls: number } {
  const adapter = {
    calls: 0,
    run(): Promise<boolean> {
      adapter.calls += 1
      return Promise.resolve(result)
    },
  }
  return adapter
}

describe('buildPasteHelperInvocation', () => {
  it('builds a hidden PowerShell invocation that compiles once and loops on stdin', () => {
    const invocation = buildPasteHelperInvocation()

    expect(invocation.executable).toBe('powershell.exe')
    expect(invocation.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
    ])

    const script = Buffer.from(invocation.args[5] ?? '', 'base64').toString('utf16le')
    expect(script).toContain('SendInput')
    expect(script).toContain('ReadLine')
    expect(script).toContain("WriteLine('ok')")
    expect(script).toContain("WriteLine('fail')")
    expect(script).not.toContain('System.Windows.Forms')
  })
})

describe('createWarmPasteAdapter', () => {
  it('spawns the helper once and resolves pastes over its stdin protocol', async () => {
    const processes: FakeHelperProcess[] = []
    const spawnHelper = vi.fn(() => {
      const helper = new FakeHelperProcess()
      processes.push(helper)
      return helper
    })
    const fallback = fallbackAdapter()
    const adapter = createWarmPasteAdapter({ spawnHelper, fallback })

    const first = adapter.run(buildPasteInvocation())
    processes[0]?.emit('ok\r\n')
    await expect(first).resolves.toBe(true)

    const second = adapter.run(buildPasteInvocation())
    // Chunked stdout must be reassembled into one response line.
    processes[0]?.emit('o')
    processes[0]?.emit('k\n')
    await expect(second).resolves.toBe(true)

    expect(spawnHelper).toHaveBeenCalledTimes(1)
    expect(processes[0]?.writes).toEqual(['paste\n', 'paste\n'])
    expect(fallback.calls).toBe(0)
  })

  it('reports a rejected paste when the helper answers fail', async () => {
    const processes: FakeHelperProcess[] = []
    const adapter = createWarmPasteAdapter({
      spawnHelper: () => {
        const helper = new FakeHelperProcess()
        processes.push(helper)
        return helper
      },
      fallback: fallbackAdapter(),
    })

    const result = adapter.run(buildPasteInvocation())
    processes[0]?.emit('fail\n')

    await expect(result).resolves.toBe(false)
  })

  it('falls back to the one-shot invocation when the helper cannot spawn', async () => {
    const fallback = fallbackAdapter(true)
    const adapter = createWarmPasteAdapter({
      spawnHelper: () => {
        throw new Error('spawn failed')
      },
      fallback,
    })

    await expect(adapter.run(buildPasteInvocation())).resolves.toBe(true)
    expect(fallback.calls).toBe(1)
  })

  it('respawns the helper after it exits', async () => {
    const processes: FakeHelperProcess[] = []
    const spawnHelper = vi.fn(() => {
      const helper = new FakeHelperProcess()
      processes.push(helper)
      return helper
    })
    const adapter = createWarmPasteAdapter({ spawnHelper, fallback: fallbackAdapter() })

    const first = adapter.run(buildPasteInvocation())
    processes[0]?.emit('ok\n')
    await expect(first).resolves.toBe(true)

    processes[0]?.exit(1)

    const second = adapter.run(buildPasteInvocation())
    processes[1]?.emit('ok\n')
    await expect(second).resolves.toBe(true)
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })

  it('rejects the in-flight paste when the helper dies mid-request via the fallback', async () => {
    const processes: FakeHelperProcess[] = []
    const fallback = fallbackAdapter(true)
    const adapter = createWarmPasteAdapter({
      spawnHelper: () => {
        const helper = new FakeHelperProcess()
        processes.push(helper)
        return helper
      },
      fallback,
    })

    const result = adapter.run(buildPasteInvocation())
    processes[0]?.exit(1)

    await expect(result).resolves.toBe(true)
    expect(fallback.calls).toBe(1)
  })

  it('times out a hung helper, kills it, and uses the fallback', async () => {
    const timers: Array<() => void> = []
    const processes: FakeHelperProcess[] = []
    const fallback = fallbackAdapter(true)
    const adapter = createWarmPasteAdapter({
      spawnHelper: () => {
        const helper = new FakeHelperProcess()
        processes.push(helper)
        return helper
      },
      fallback,
      responseTimeoutMs: 1_000,
      setTimer: (callback) => {
        timers.push(callback)
        return timers.length
      },
      clearTimer: () => undefined,
    })

    const result = adapter.run(buildPasteInvocation())
    timers.at(-1)?.()

    await expect(result).resolves.toBe(true)
    expect(processes[0]?.killed).toBe(true)
    expect(fallback.calls).toBe(1)
  })

  it('start() pre-spawns the helper without sending a paste', () => {
    const processes: FakeHelperProcess[] = []
    const spawnHelper = vi.fn(() => {
      const helper = new FakeHelperProcess()
      processes.push(helper)
      return helper
    })
    const adapter = createWarmPasteAdapter({ spawnHelper, fallback: fallbackAdapter() })

    adapter.start()
    adapter.start()

    expect(spawnHelper).toHaveBeenCalledTimes(1)
    expect(processes[0]?.writes).toEqual([])
  })

  it('dispose() kills the helper and routes later pastes to the fallback', async () => {
    const processes: FakeHelperProcess[] = []
    const fallback = fallbackAdapter(true)
    const adapter = createWarmPasteAdapter({
      spawnHelper: () => {
        const helper = new FakeHelperProcess()
        processes.push(helper)
        return helper
      },
      fallback,
    })

    adapter.start()
    adapter.dispose()

    expect(processes[0]?.killed).toBe(true)
    await expect(adapter.run(buildPasteInvocation())).resolves.toBe(true)
    expect(fallback.calls).toBe(1)
  })
})
