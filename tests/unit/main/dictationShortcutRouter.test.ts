// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDictationShortcutRouter, type KeyListenerHandlers } from '../../../src/main/hotkeys/dictationShortcutRouter'
import type { GlobalShortcutAdapter } from '../../../src/main/hotkeys/hotkeyManager'
import type { KeyListener, KeyListenerPermissionState } from '../../../src/main/hotkeys/keyListener'
import type { SottoPlatform } from '../../../src/shared/platform'

function createHarness(options: { platform?: SottoPlatform; taken?: readonly string[]; spawns?: boolean; ready?: boolean } = {}) {
  const active = new Map<string, () => void>()
  const calls: string[] = []
  const shortcuts: GlobalShortcutAdapter = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      calls.push(`register:${accelerator}`)
      if (options.taken?.includes(accelerator)) return false
      active.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      calls.push(`unregister:${accelerator}`)
      active.delete(accelerator)
    }),
  }
  let handlers!: KeyListenerHandlers
  let running = false
  let permission: KeyListenerPermissionState = 'unknown'
  const watched: string[][] = []
  const listener = {
    watch: vi.fn((tokens: readonly string[]) => {
      watched.push([...tokens])
      running = options.spawns !== false && tokens.length > 0
    }),
    record: vi.fn((on: boolean) => {
      running = options.spawns !== false && (on || (watched.at(-1)?.length ?? 0) > 0)
    }),
    request: vi.fn(),
    running: () => running,
    ready: () => running && options.ready !== false,
    permission: () => permission,
    dispose: vi.fn(),
  } satisfies KeyListener
  let idle = true
  let focused = true
  const dispatch = vi.fn()
  const showWidget = vi.fn()
  const pushHeld = vi.fn()
  const pushPermission = vi.fn()
  const openInputMonitoring = vi.fn(async () => undefined)
  const log = vi.fn()
  const router = createDictationShortcutRouter({
    shortcuts,
    createListener: (next) => {
      handlers = next
      return listener
    },
    canStart: () => idle,
    isFocused: () => focused,
    dispatch,
    showWidget,
    pushHeld,
    pushPermission,
    openInputMonitoring,
    log,
    platform: options.platform ?? 'darwin',
  })
  return {
    router, shortcuts, active, calls, listener, watched, dispatch, showWidget, pushHeld, pushPermission, openInputMonitoring, log,
    key: (type: 'down' | 'up', token: string) => handlers.onKey(type, token),
    handlers: () => handlers,
    setIdle: (value: boolean) => { idle = value },
    setFocused: (value: boolean) => { focused = value },
    setPermission: (value: KeyListenerPermissionState) => { permission = value },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dictation shortcut router apply', () => {
  it('registers extra press accelerators, leaves press[0] to HotkeyManager and feeds the rest to the matcher', () => {
    const h = createHarness()
    expect(h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D', 'Fn+Shift+Space'], hold: ['Control+Alt'] }, 'strict')).toEqual({ ok: true })
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
    expect(h.watched.at(-1)?.sort()).toEqual(['Alt', 'Control', 'Fn', 'Shift', 'Space'])
    h.active.get('Alt+Shift+D')?.()
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'toggle' })
    expect(h.showWidget).toHaveBeenCalledOnce()
  })

  it('watches nothing when no chord needs the listener', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    expect(h.watched.at(-1)).toEqual([])
  })

  it('strict apply registers the new set before unregistering the old', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    h.calls.length = 0
    expect(h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+E'], hold: [] }, 'strict')).toEqual({ ok: true })
    expect(h.calls).toEqual(['register:Alt+Shift+E', 'unregister:Alt+Shift+D'])
  })

  it('strict apply rolls back on a conflict and keeps the old set and matcher', () => {
    const h = createHarness({ taken: ['Alt+Shift+F'] })
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: ['Fn'] }, 'strict')
    const result = h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+E', 'Alt+Shift+F'], hold: [] }, 'strict')
    expect(result).toEqual({ ok: false, reason: 'conflict', chord: 'Alt+Shift+F' })
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
    h.key('down', 'Fn')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'start' })
  })

  it('lenient apply skips a failing chord and a duplicate of press[0], logging each', () => {
    const h = createHarness({ taken: ['Alt+Shift+F'] })
    const result = h.router.apply({ press: ['ctrl+shift+space', 'Alt+Shift+F', 'Alt+Shift+G'], hold: ['Shift+Control+Space', 'Fn'] }, 'lenient')
    expect(result).toEqual({ ok: true })
    expect([...h.active.keys()]).toEqual(['Alt+Shift+G'])
    expect(h.log).toHaveBeenCalledTimes(2)
    expect(h.log).toHaveBeenCalledWith('native-extra-shortcut-unavailable')
    expect(h.watched.at(-1)).toEqual(['Fn'])
  })

  it('feeds the matcher canonical chords from legacy spellings', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['shift+fn'] }, 'strict')
    expect(h.watched.at(-1)?.sort()).toEqual(['Fn', 'Shift'])
    h.key('down', 'Shift')
    h.key('down', 'Fn')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'start' })
  })

  it('refuses a listener chord that cannot be canonicalised in strict mode', () => {
    const h = createHarness({ platform: 'win32' })
    expect(h.router.apply({ press: ['CommandOrControl+Shift+Space'], hold: ['Fn'] }, 'strict'))
      .toEqual({ ok: false, reason: 'invalid', chord: 'Fn' })
  })

  it('dispatches hold start and stop, and ignores a hold that starts while dictation is busy', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    h.key('down', 'Fn')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'start' })
    expect(h.showWidget).toHaveBeenCalledOnce()
    h.key('up', 'Fn')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'stop' })
    h.dispatch.mockClear()
    h.setIdle(false)
    h.key('down', 'Fn')
    h.key('up', 'Fn')
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('cancels an active hold when a new set is applied', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    h.key('down', 'Fn')
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn', 'Alt+Shift'] }, 'strict')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'cancel' })
  })

  it('toggles from a listener press chord and shows the widget', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Fn+Shift'], hold: [] }, 'strict')
    h.key('down', 'Fn')
    h.key('down', 'Shift')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'toggle' })
    expect(h.showWidget).toHaveBeenCalledOnce()
  })
})

describe('dictation shortcut router suspend', () => {
  it('stands every extra down, then restores, and auto-restores after 60 s', () => {
    vi.useFakeTimers()
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: ['Fn'] }, 'strict')
    h.router.suspend(true)
    expect(h.active.size).toBe(0)
    expect(h.watched.at(-1)).toEqual([])
    h.key('down', 'Fn')
    h.router.suspend(false)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
    expect(h.watched.at(-1)).toEqual(['Fn'])

    h.router.suspend(true)
    vi.advanceTimersByTime(59_999)
    expect(h.active.size).toBe(0)
    vi.advanceTimersByTime(1)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
  })
})

describe('dictation shortcut router record', () => {
  it('records the keys held at the first release and pushes each change', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    const recorded = h.router.record()
    expect(h.listener.record).toHaveBeenLastCalledWith(true)
    expect(h.active.size).toBe(0)
    h.key('down', 'Shift')
    h.key('down', 'Fn')
    h.key('down', 'Space')
    h.key('up', 'Space')
    await expect(recorded).resolves.toEqual({ kind: 'recorded', chord: 'Fn+Shift+Space' })
    expect(h.pushHeld.mock.calls).toEqual([[['Shift']], [['Shift', 'Fn']], [['Shift', 'Fn', 'Space']]])
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('cancels on Escape alone', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.key('down', 'Escape')
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
  })

  it('cancels after 30 s', async () => {
    vi.useFakeTimers()
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    vi.advanceTimersByTime(30_000)
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
  })

  it('cancels on cancelRecord', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.router.cancelRecord()
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
  })

  it('is unavailable when the helper cannot run', async () => {
    const h = createHarness({ spawns: false })
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    await expect(h.router.record()).resolves.toEqual({ kind: 'unavailable' })
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
  })

  it('finishes unsupported-key when a key outside the shortcut table goes down, and resumes the shortcuts', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.key('down', 'Control')
    h.key('down', 'Other')
    await expect(recorded).resolves.toEqual({ kind: 'unsupported-key' })
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
  })

  it('refuses to record while the main window is not focused: record mode never turns on', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    h.setFocused(false)
    await expect(h.router.record()).resolves.toEqual({ kind: 'cancelled' })
    h.key('down', 'K')
    expect(h.listener.record).not.toHaveBeenCalledWith(true)
    expect(h.pushHeld).not.toHaveBeenCalled()
  })

  it('cancels with nothing pushed when a key arrives after the window lost focus', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.setFocused(false)
    h.key('down', 'K')
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
    expect(h.pushHeld).not.toHaveBeenCalled()
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
  })

  it('caps recordings that reach record mode at 10 a minute, then lets the page record instead', async () => {
    vi.useFakeTimers()
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    for (let started = 0; started < 10; started += 1) {
      void h.router.record()
      h.router.cancelRecord()
      vi.advanceTimersByTime(100)
    }
    expect(h.listener.record.mock.calls.filter(([on]) => on)).toHaveLength(10)
    await expect(h.router.record()).resolves.toEqual({ kind: 'unavailable' })
    expect(h.listener.record.mock.calls.filter(([on]) => on)).toHaveLength(10)
    vi.advanceTimersByTime(60_000)
    void h.router.record()
    expect(h.listener.record.mock.calls.filter(([on]) => on)).toHaveLength(11)
  })

  it('caps record() attempts that never arm, so a renderer cannot churn the helper', async () => {
    vi.useFakeTimers()
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    for (let tried = 0; tried < 40; tried += 1) {
      void h.router.record()
      h.router.cancelRecord()
    }
    expect(h.listener.record.mock.calls.filter(([on]) => on)).toHaveLength(30)
    await expect(h.router.record()).resolves.toEqual({ kind: 'unavailable' })
    vi.advanceTimersByTime(60_000)
    void h.router.record()
    expect(h.listener.record.mock.calls.filter(([on]) => on)).toHaveLength(31)
  })

  it('starts the next recording at once when the user switches rows, without a cooldown', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const first = h.router.record()
    h.router.cancelRecord()
    await expect(first).resolves.toEqual({ kind: 'cancelled' })
    const second = h.router.record()
    h.key('down', 'Alt')
    h.key('down', 'K')
    h.key('up', 'K')
    await expect(second).resolves.toEqual({ kind: 'recorded', chord: 'Alt+K' })
  })

  it('does not count a recording that never reached record mode against the cap', async () => {
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    for (let tried = 0; tried < 12; tried += 1) {
      const recorded = h.router.record()
      h.setPermission('denied')
      h.handlers().onPermission('denied')
      await expect(recorded).resolves.toEqual({ kind: 'unavailable' })
    }
    h.setPermission('granted')
    const recorded = h.router.record()
    h.handlers().onPermission('granted')
    h.key('down', 'Alt')
    h.key('down', 'K')
    h.key('up', 'K')
    await expect(recorded).resolves.toEqual({ kind: 'recorded', chord: 'Alt+K' })
  })

  it('cancels a recording that becomes ready after the window lost the focus', async () => {
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.setFocused(false)
    h.setPermission('granted')
    h.handlers().onPermission('granted')
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
    expect(h.pushHeld).not.toHaveBeenCalled()
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
  })

  it('ends a recording when the screen locks or the computer sleeps', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.router.interrupt()
    await expect(recorded).resolves.toEqual({ kind: 'cancelled' })
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
  })

  it('is unavailable without Input Monitoring, at once or when the helper reports it', async () => {
    const denied = createHarness()
    denied.setPermission('denied')
    denied.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    await expect(denied.router.record()).resolves.toEqual({ kind: 'unavailable' })

    const fresh = createHarness()
    fresh.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = fresh.router.record()
    fresh.handlers().onPermission('denied')
    await expect(recorded).resolves.toEqual({ kind: 'unavailable' })
    expect(fresh.listener.record).toHaveBeenLastCalledWith(false)
  })
})

describe('dictation shortcut router permission', () => {
  it('is not-needed on Windows unless the helper is missing, and unsupported on Linux', () => {
    const h = createHarness({ platform: 'win32' })
    h.router.apply({ press: ['CommandOrControl+Shift+Space'], hold: ['CommandOrControl+Super'] }, 'strict')
    expect(h.router.permission()).toBe('not-needed')
    h.setPermission('granted')
    expect(h.router.permission()).toBe('not-needed')
    h.setPermission('unavailable')
    expect(h.router.permission()).toBe('unsupported')
    expect(createHarness({ platform: 'linux' }).router.permission()).toBe('unsupported')
  })

  it('is unsupported on macOS once the helper is missing, even with nothing watched', () => {
    const h = createHarness()
    expect(h.router.permission()).toBe('not-needed')
    h.setPermission('unavailable')
    expect(h.router.permission()).toBe('unsupported')
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    expect(h.router.permission()).toBe('unsupported')
  })

  it('maps the listener state on macOS', () => {
    const h = createHarness()
    h.setPermission('denied')
    expect(h.router.permission()).toBe('not-needed')
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    expect(h.router.permission()).toBe('denied')
    h.setPermission('granted')
    expect(h.router.permission()).toBe('granted')
    h.setPermission('unknown')
    expect(h.router.permission()).toBe('not-needed')
    h.setPermission('granted')
    h.handlers().onPermission('granted')
    expect(h.pushPermission).toHaveBeenLastCalledWith('granted')
  })

  it('requests access and opens Input Monitoring', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    h.setPermission('denied')
    await expect(h.router.requestPermission()).resolves.toBe('denied')
    expect(h.listener.request).toHaveBeenCalledOnce()
    expect(h.openInputMonitoring).toHaveBeenCalledOnce()
  })

  it('disposes the listener and its accelerators', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: ['Fn'] }, 'strict')
    h.key('down', 'Fn')
    h.dispatch.mockClear()
    h.router.dispose()
    expect(h.active.size).toBe(0)
    expect(h.listener.dispose).toHaveBeenCalledOnce()
    expect(h.dispatch).not.toHaveBeenCalled()
  })
})

describe('dictation shortcut router fix round', () => {
  it('retries an extra whose restore failed every 5 s, up to 12 times', () => {
    vi.useFakeTimers()
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    h.router.suspend(true)
    vi.mocked(h.shortcuts.register).mockReturnValue(false)
    h.router.suspend(false)
    expect(h.active.size).toBe(0)
    expect(h.log).toHaveBeenCalledWith('native-extra-shortcut-unavailable')
    vi.advanceTimersByTime(5_000 * 3)
    expect(h.shortcuts.register).toHaveBeenCalledTimes(1 + 1 + 3)
    vi.mocked(h.shortcuts.register).mockImplementation((accelerator: string, callback: () => void) => {
      h.active.set(accelerator, callback)
      return true
    })
    vi.advanceTimersByTime(5_000)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
    const calls = vi.mocked(h.shortcuts.register).mock.calls.length
    vi.advanceTimersByTime(5_000 * 20)
    expect(vi.mocked(h.shortcuts.register).mock.calls.length).toBe(calls)
  })

  it('gives up retrying after 12 attempts', () => {
    vi.useFakeTimers()
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    h.router.suspend(true)
    vi.mocked(h.shortcuts.register).mockClear().mockReturnValue(false)
    h.router.suspend(false)
    vi.advanceTimersByTime(5_000 * 30)
    expect(h.shortcuts.register).toHaveBeenCalledTimes(13)
    expect(h.log).toHaveBeenCalledTimes(1)
  })

  it('ends a started hold silently when a press shortcut toggles', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: ['Fn'] }, 'strict')
    h.key('down', 'Fn')
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'start' })
    h.router.pressToggled()
    h.key('up', 'Fn')
    expect(h.dispatch).toHaveBeenCalledTimes(1)

    h.key('down', 'Fn')
    h.active.get('Alt+Shift+D')?.()
    h.key('up', 'Fn')
    expect(h.dispatch.mock.calls.map(([command]) => command.type)).toEqual(['start', 'start', 'toggle'])
  })

  it('ends a started hold silently when a listener press chord toggles', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'Fn+J'], hold: ['Fn+K'] }, 'strict')
    h.key('down', 'Fn')
    h.key('down', 'K')
    h.key('down', 'J')
    h.key('up', 'K')
    h.key('up', 'J')
    h.key('up', 'Fn')
    expect(h.dispatch.mock.calls.map(([command]) => command.type)).toEqual(['start', 'toggle'])
  })

  it('interrupt cancels a hold it started and forgets held keys', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: ['Fn'] }, 'strict')
    h.key('down', 'Fn')
    h.router.interrupt()
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'cancel' })
    h.key('up', 'Fn')
    h.key('down', 'Fn')
    expect(h.dispatch.mock.calls.map(([command]) => command.type)).toEqual(['start', 'cancel', 'start'])
  })

  it('resolves a recording unavailable when the helper exits', async () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.handlers().onExit()
    await expect(recorded).resolves.toEqual({ kind: 'unavailable' })
  })

  it.each([
    [{ press: ['Control+Shift+Space', 'Escape'], hold: [] }, 'Escape'],
    [{ press: ['Control+Shift+Space', 'A'], hold: [] }, 'A'],
  ])('strict apply re-validates new chords: %j', (set, chord) => {
    const h = createHarness()
    expect(h.router.apply(set, 'strict')).toEqual({ ok: false, reason: 'invalid', chord })
    expect(h.active.size).toBe(0)
  })

  it('strict apply does not re-validate a chord already applied', () => {
    const h = createHarness()
    h.router.apply({ press: ['Control+Shift+Space', 'A'], hold: [] }, 'lenient')
    expect(h.router.apply({ press: ['Control+Shift+Space', 'a'], hold: [] }, 'strict')).toEqual({ ok: true })
  })
})

describe('dictation shortcut router recording readiness', () => {
  it('records in the page when a running helper is not ready within 3 s, ignoring early keys', async () => {
    vi.useFakeTimers()
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space', 'Alt+Shift+D'], hold: [] }, 'strict')
    let result: unknown
    void h.router.record().then((value) => { result = value })
    h.key('down', 'Control')
    h.key('down', 'K')
    h.key('up', 'K')
    await vi.advanceTimersByTimeAsync(2_999)
    expect(result).toBeUndefined()
    expect(h.pushHeld).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ kind: 'unavailable' })
    expect(h.listener.record).toHaveBeenLastCalledWith(false)
    expect([...h.active.keys()]).toEqual(['Alt+Shift+D'])
  })

  it('starts the 30 s limit only once the helper is ready', async () => {
    vi.useFakeTimers()
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    let result: unknown
    void h.router.record().then((value) => { result = value })
    await vi.advanceTimersByTimeAsync(2_000)
    h.setPermission('granted')
    h.handlers().onPermission('granted')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ kind: 'cancelled' })
  })

  it('records in the page when the helper becomes ready without Input Monitoring', async () => {
    const h = createHarness({ ready: false })
    h.router.apply({ press: ['Control+Shift+Space'], hold: [] }, 'strict')
    const recorded = h.router.record()
    h.setPermission('denied')
    h.handlers().onPermission('denied')
    await expect(recorded).resolves.toEqual({ kind: 'unavailable' })
  })
})

describe('dictation shortcut router strict duplicates', () => {
  it.each([['Fn+Shift'], ['Alt+Shift+D']])('refuses %s repeated in both roles even when already applied', (chord) => {
    const h = createHarness()
    expect(h.router.apply({ press: ['Control+Shift+Space', chord], hold: ['Control+Alt'] }, 'lenient')).toEqual({ ok: true })
    expect(h.router.apply({ press: ['Control+Shift+Space', chord], hold: [chord] }, 'strict'))
      .toEqual({ ok: false, reason: 'invalid', chord })
    expect(h.router.apply({ press: ['Control+Shift+Space', chord], hold: [chord] }, 'lenient')).toEqual({ ok: true })
    expect(h.log).toHaveBeenCalledWith('native-extra-shortcut-unavailable')
  })
})
