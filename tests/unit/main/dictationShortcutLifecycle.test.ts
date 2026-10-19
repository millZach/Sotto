// @vitest-environment node
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDictationShortcutLifecycle, interruptOnLockAndSleep, type LockAndSleepSource } from '../../../src/main/hotkeys/dictationShortcutLifecycle'
import type { KeyRecordResult } from '../../../src/shared/contracts'

function setup(state = { focused: true }) {
  const resolvers: Array<(result: KeyRecordResult) => void> = []
  const suspend = vi.fn<(suspended: boolean) => void>()
  const router = {
    record: vi.fn(() => new Promise<KeyRecordResult>(resolve => { resolvers.push(resolve) })),
    cancelRecord: vi.fn(() => { resolvers.forEach(resolve => resolve({ kind: 'cancelled' })) }),
  }
  return { resolvers, suspend, router, state, lifecycle: createDictationShortcutLifecycle({ suspend, router, isFocused: () => state.focused }) }
}

afterEach(() => { vi.useRealTimers() })

describe('dictation shortcut lifecycle', () => {
  it('refuses a recording while the window is unfocused without standing any shortcut down', async () => {
    const { suspend, router, lifecycle } = setup({ focused: false })
    await expect(lifecycle.record()).resolves.toEqual({ kind: 'cancelled' })
    expect(router.record).not.toHaveBeenCalled()
    expect(suspend).not.toHaveBeenCalled()
  })

  it('lets a later recording win: the earlier one ending never resumes the shortcuts', async () => {
    const { resolvers, suspend, lifecycle } = setup()
    const first = lifecycle.record()
    const second = lifecycle.record()
    resolvers[0]!({ kind: 'cancelled' })
    await expect(first).resolves.toEqual({ kind: 'cancelled' })
    expect(suspend).not.toHaveBeenCalledWith(false)
    resolvers[1]!({ kind: 'recorded', chord: 'Alt+Shift+D' })
    await second
    expect(suspend.mock.calls).toEqual([[true], [true], [false]])
  })

  it('cancels a recording and resumes the shortcuts once when the renderer goes', async () => {
    const { suspend, router, lifecycle } = setup()
    const recording = lifecycle.record()
    lifecycle.rendererGone()
    await expect(recording).resolves.toEqual({ kind: 'cancelled' })
    expect(router.cancelRecord).toHaveBeenCalledOnce()
    expect(suspend.mock.calls).toEqual([[true], [false]])
  })

  it('cancels a recording and resumes the shortcuts when the main window loses the focus', async () => {
    const { suspend, router, lifecycle } = setup()
    const recording = lifecycle.record()
    lifecycle.windowLostFocus()
    await expect(recording).resolves.toEqual({ kind: 'cancelled' })
    expect(router.cancelRecord).toHaveBeenCalledOnce()
    expect(suspend.mock.calls).toEqual([[true], [false]])
  })

  it('ignores a suspension asked while the main window is not focused, but always resumes', () => {
    const { suspend, state, lifecycle } = setup({ focused: false })
    lifecycle.suspend(true)
    expect(suspend).not.toHaveBeenCalled()
    lifecycle.suspend(false)
    expect(suspend.mock.calls).toEqual([[false]])
    state.focused = true
    lifecycle.suspend(true)
    expect(suspend.mock.calls).toEqual([[false], [true]])
  })

  it('resumes a suspension on its own after the limit, and records nothing without a router', async () => {
    vi.useFakeTimers()
    const suspend = vi.fn<(suspended: boolean) => void>()
    const lifecycle = createDictationShortcutLifecycle({ suspend, router: null, isFocused: () => true, limitMs: 1_000 })
    lifecycle.suspend(true)
    vi.advanceTimersByTime(1_000)
    expect(suspend.mock.calls).toEqual([[true], [false]])
    await expect(lifecycle.record()).resolves.toEqual({ kind: 'unavailable' })
  })

  it('interrupts the router when the screen locks or the computer sleeps', () => {
    const monitor = new EventEmitter()
    const interrupt = vi.fn()
    interruptOnLockAndSleep(monitor as unknown as LockAndSleepSource, interrupt)
    monitor.emit('lock-screen')
    monitor.emit('suspend')
    monitor.emit('resume')
    expect(interrupt).toHaveBeenCalledTimes(2)
  })
})
