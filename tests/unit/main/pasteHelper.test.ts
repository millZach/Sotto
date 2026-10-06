// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createPasteCommands } from '../../../src/main/output/pasteCommand'
import {
  createWarmPasteAdapter,
  type HelperProcessLike,
} from '../../../src/main/output/pasteHelper'
import { OutputService, PASTE_SETTLE_MS, type PasteProcessAdapter } from '../../../src/main/output/outputService'

const windowsCommands = createPasteCommands('win32')
const buildPasteInvocation = windowsCommands.oneShot
const buildPasteHelperInvocation = windowsCommands.helper!

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

describe('warm helper invocation', () => {
  it('exists only on Windows', () => {
    expect(createPasteCommands('win32').helper).not.toBeNull()
    expect(createPasteCommands('darwin').helper).toBeNull()
  })

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
    expect(script).toContain("WriteLine('ready')")
    expect(script).toContain("WriteLine('ok')")
    expect(script).toContain("WriteLine('fail')")
    expect(script).not.toContain('System.Windows.Forms')
  })
})

describe('createWarmPasteAdapter', () => {
  it.each(['exit', 'fail', 'timeout'] as const)(
    'holds a queued copy and widget restoration until an unconfirmed paste settles: %s', async failure => {
      vi.useFakeTimers()
      const helper = new FakeHelperProcess()
      const fallback = fallbackAdapter()
      const adapter = createWarmPasteAdapter({ spawnHelper: () => helper, fallback })
      try {
        adapter.start()
        helper.emit('ready\n')
        const writes: string[] = []
        const showWidget = vi.fn()
        const service = new OutputService({
          clipboard: { writeText: text => { writes.push(text) } },
          widget: { hideWidget: vi.fn(), showWidget },
          delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
          process: adapter,
          buildPasteInvocation,
        })
        const paste = service.deliver('dictation', { autoPaste: true, pasteDelayMs: 0, restoreWidget: true })
        const copy = service.deliver('history', { autoPaste: false, pasteDelayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        expect(helper.writes).toEqual(['paste\n'])
        if (failure === 'exit') helper.exit(0)
        else if (failure === 'fail') helper.emit('fail\n')
        else await vi.advanceTimersByTimeAsync(5_000)
        await vi.advanceTimersByTimeAsync(0)
        expect(writes).toEqual(['dictation'])
        expect(showWidget).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(PASTE_SETTLE_MS - 1)
        expect(writes).toEqual(['dictation'])
        expect(showWidget).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        await expect(paste).resolves.toBe('copied')
        await expect(copy).resolves.toBe('copied')
        expect(writes).toEqual(['dictation', 'history'])
        expect(showWidget).toHaveBeenCalledOnce()
        expect(fallback.calls).toBe(0)
      } finally {
        adapter.dispose()
        vi.useRealTimers()
      }
    },
  )

  it.each(['exit', 'error', 'timeout'] as const)('falls back when the helper fails before ready: %s', async failure => {
    vi.useFakeTimers()
    try {
      const helper = new FakeHelperProcess()
      const fallback = fallbackAdapter()
      const adapter = createWarmPasteAdapter({ spawnHelper: () => helper, fallback })
      const result = adapter.run(buildPasteInvocation())
      expect(helper.writes).toEqual([])
      if (failure === 'exit') helper.exit(1)
      else if (failure === 'error') helper.fail(new Error('Add-Type failed'))
      else await vi.advanceTimersByTimeAsync(5_000)
      await expect(result).resolves.toBe(true)
      expect(fallback.calls).toBe(1)
      helper.emit('ready\nok\n')
      expect(helper.writes).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })


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
    processes[0]?.emit('ready\n')
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
    processes[0]?.emit('ready\n')
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
    processes[0]?.emit('ready\n')
    processes[0]?.emit('ok\n')
    await expect(first).resolves.toBe(true)

    processes[0]?.exit(1)

    const second = adapter.run(buildPasteInvocation())
    processes[1]?.emit('ready\n')
    processes[1]?.emit('ok\n')
    await expect(second).resolves.toBe(true)
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })

  it.each(['exit', 'error'] as const)('does not repeat an unacknowledged paste after helper %s', async failure => {
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
    processes[0]?.emit('ready\n')
    if (failure === 'exit') processes[0]?.exit(1)
    else processes[0]?.fail(new Error('helper lost after paste'))

    await expect(result).resolves.toBe(false)
    expect(fallback.calls).toBe(0)
  })

  it('times out a hung helper without repeating the paste, even when its acknowledgement arrives late', async () => {
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
    processes[0]?.emit('ready\n')
    timers.at(-1)?.()
    processes[0]?.emit('ready\n')
    processes[0]?.emit('ok\n')

    await expect(result).resolves.toBe(false)
    expect(processes[0]?.killed).toBe(true)
    expect(fallback.calls).toBe(0)
  })

  it('waits for acknowledgement when stdin reports backpressure', async () => {
    const helper = new FakeHelperProcess()
    helper.stdin.write = vi.fn(() => false)
    const fallback = fallbackAdapter()
    const adapter = createWarmPasteAdapter({ spawnHelper: () => helper, fallback })

    const result = adapter.run(buildPasteInvocation())
    helper.emit('ready\n')
    helper.emit('ok\n')

    await expect(result).resolves.toBe(true)
    expect(helper.killed).toBe(false)
    expect(fallback.calls).toBe(0)
  })

  it('does not retry when writing the paste command throws after dispatch may have started', async () => {
    const helper = new FakeHelperProcess()
    helper.stdin.write = () => { throw new Error('stream lost') }
    const fallback = fallbackAdapter()
    const adapter = createWarmPasteAdapter({ spawnHelper: () => helper, fallback })

    const result = adapter.run(buildPasteInvocation())
    helper.emit('ready\n')
    await expect(result).resolves.toBe(false)
    expect(helper.killed).toBe(true)
    expect(fallback.calls).toBe(0)
  })

  it('uses the fallback when the helper has no command pipe before dispatch', async () => {
    const helper = new FakeHelperProcess()
    const fallback = fallbackAdapter()
    const adapter = createWarmPasteAdapter({ spawnHelper: () => ({
      stdin: null, stdout: helper.stdout,
      once: helper.once.bind(helper), kill: helper.kill.bind(helper),
    }), fallback })

    await expect(adapter.run(buildPasteInvocation())).resolves.toBe(true)
    expect(helper.killed).toBe(true)
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

  it('does not paste through the fallback when disposed while waiting for ready', async () => {
    const helper = new FakeHelperProcess()
    const fallback = fallbackAdapter()
    const adapter = createWarmPasteAdapter({ spawnHelper: () => helper, fallback })
    const pending = adapter.run(buildPasteInvocation())
    adapter.dispose()
    await expect(pending).resolves.toBe(false)
    expect(fallback.calls).toBe(0)
    expect(helper.writes).toEqual([])
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
