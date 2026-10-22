// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  HotkeyManager,
  syncEscapeForWidgetSnapshot,
  type GlobalShortcutAdapter,
} from '../../../src/main/hotkeys/hotkeyManager'
import { chordTokenSet } from '../../../src/main/hotkeys/dictationShortcutRouter'

function createAdapter(registerResult: (accelerator: string) => boolean = () => true) {
  const active = new Map<string, () => void>()
  const calls: string[] = []
  const adapter: GlobalShortcutAdapter = {
    register: vi.fn((accelerator, callback) => {
      calls.push(`register:${accelerator}`)
      if (!registerResult(accelerator)) {
        return false
      }
      active.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator) => {
      calls.push(`unregister:${accelerator}`)
      active.delete(accelerator)
    }),
    isRegistered: vi.fn((accelerator) => active.has(accelerator)),
  }

  return { active, adapter, calls }
}

describe('HotkeyManager primary shortcut', () => {
  it.each(['win32', 'darwin'] as const)('keeps the %s global toggle and Escape registration', platform => {
    const { active, adapter } = createAdapter()
    const toggle = vi.fn()
    const cancel = vi.fn()
    const manager = new HotkeyManager(adapter, toggle, cancel, platform)
    expect(manager.replace('Control+Shift+Space')).toEqual({ ok: true })
    active.get('Control+Shift+Space')?.()
    expect(toggle).toHaveBeenCalledOnce()
    manager.beginListening()
    active.get('Escape')?.()
    expect(cancel).toHaveBeenCalledOnce()
    manager.dispose()
    expect(active.size).toBe(0)
  })

  it('keeps Linux settings without claiming a global shortcut or Escape', () => {
    const { adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'linux')
    expect(manager.replace('Control+Shift+Space')).toEqual({ ok: true })
    expect(manager.current()).toBe('Control+Shift+Space')
    syncEscapeForWidgetSnapshot(manager, { status: 'listening', cancellable: true })
    expect(manager.beginListening()).toBe(false)
    manager.dispose()
    expect(adapter.register).not.toHaveBeenCalled()
    expect(adapter.unregister).not.toHaveBeenCalled()
  })
  it('keeps the prior shortcut when replacement registration conflicts', () => {
    const { active, adapter } = createAdapter((accelerator) => accelerator !== 'Taken')
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())

    expect(manager.replace('Old')).toEqual({ ok: true })
    expect(manager.replace('Taken')).toEqual({ ok: false, reason: 'conflict' })
    expect(manager.current()).toBe('Old')
    expect(active.has('Old')).toBe(true)
  })

  it('registers a candidate before unregistering the prior accelerator', () => {
    const { active, adapter, calls } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Old')
    calls.splice(0)

    expect(manager.replace('New')).toEqual({ ok: true })

    expect(calls).toEqual(['register:New', 'unregister:Old'])
    expect(active.has('New')).toBe(true)
    expect(active.has('Old')).toBe(false)
    expect(manager.current()).toBe('New')
  })

  it('restores the prior accelerator if completing a replacement throws', () => {
    const { active, adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Old')
    vi.mocked(adapter.unregister).mockImplementationOnce((accelerator) => {
      active.delete(accelerator)
      throw new Error('native failure')
    })

    expect(manager.replace('New')).toEqual({ ok: false, reason: 'unavailable' })
    expect(manager.current()).toBe('Old')
    expect(active.has('Old')).toBe(true)
    expect(active.has('New')).toBe(false)
  })

  it('rejects blank accelerators and bare Escape without changing active state', () => {
    const { adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Old')

    expect(manager.replace('   ')).toEqual({ ok: false, reason: 'invalid' })
    expect(manager.replace('Escape')).toEqual({ ok: false, reason: 'invalid' })
    expect(manager.current()).toBe('Old')
  })

  it('invokes the toggle callback from the registered primary accelerator', () => {
    const { active, adapter } = createAdapter()
    const toggle = vi.fn()
    const manager = new HotkeyManager(adapter, toggle, vi.fn())
    manager.replace('Primary')

    active.get('Primary')?.()

    expect(toggle).toHaveBeenCalledOnce()
  })
})

describe('HotkeyManager cancellable-session Escape', () => {
  it('tracks snapshot cancellability during permission, listening, and processing', () => {
    const { active, adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())

    for (const status of ['requesting-permission', 'listening', 'processing'] as const) {
      syncEscapeForWidgetSnapshot(manager, { status, cancellable: true })
      expect(active.has('Escape')).toBe(true)
      syncEscapeForWidgetSnapshot(manager, { status, cancellable: false })
      expect(active.has('Escape')).toBe(false)
    }
  })

  it('registers Escape only after listening begins and invokes cancellation', () => {
    const { active, adapter } = createAdapter()
    const cancel = vi.fn()
    const manager = new HotkeyManager(adapter, vi.fn(), cancel)
    manager.replace('Primary')

    expect(active.has('Escape')).toBe(false)
    expect(manager.beginListening()).toBe(true)
    expect(active.has('Escape')).toBe(true)

    active.get('Escape')?.()

    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['stop', (manager: HotkeyManager) => manager.stopListening()],
    ['cancel', (manager: HotkeyManager) => manager.cancelListening()],
    ['error', (manager: HotkeyManager) => manager.failListening()],
  ] as const)('unregisters Escape on the %s path without disturbing the primary', (_name, finish) => {
    const { active, adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Primary')
    manager.beginListening()

    finish(manager)

    expect(active.has('Escape')).toBe(false)
    expect(active.has('Primary')).toBe(true)
    expect(manager.current()).toBe('Primary')
  })

  it('unregisters Escape and the primary shortcut during idempotent quit cleanup', () => {
    const { active, adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Primary')
    manager.beginListening()

    manager.dispose()
    manager.dispose()

    expect(active.size).toBe(0)
    expect(manager.current()).toBeNull()
    expect(adapter.unregister).toHaveBeenCalledTimes(2)
  })

  it('does not claim listening when Escape registration fails', () => {
    const { active, adapter } = createAdapter((accelerator) => accelerator !== 'Escape')
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn())
    manager.replace('Primary')

    expect(manager.beginListening()).toBe(false)
    expect(manager.isListening()).toBe(false)
    expect(active.has('Primary')).toBe(true)
  })
})

describe('HotkeyManager suspend', () => {
  it('stands the primary down and back up without changing current()', () => {
    const { active, adapter } = createAdapter()
    const toggle = vi.fn()
    const manager = new HotkeyManager(adapter, toggle, vi.fn(), 'darwin')
    manager.replace('Control+Shift+Space')
    manager.suspend(true)
    expect(active.has('Control+Shift+Space')).toBe(false)
    expect(manager.current()).toBe('Control+Shift+Space')
    manager.suspend(false)
    active.get('Control+Shift+Space')?.()
    expect(toggle).toHaveBeenCalledOnce()
    expect(manager.current()).toBe('Control+Shift+Space')
  })

  it('ends a suspension on replace and never touches Linux shortcuts', () => {
    const { active, adapter } = createAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'win32')
    manager.replace('Control+Shift+Space')
    manager.suspend(true)
    expect(manager.replace('Alt+Shift+D')).toEqual({ ok: true })
    expect([...active.keys()]).toEqual(['Alt+Shift+D'])
    manager.suspend(false)
    expect([...active.keys()]).toEqual(['Alt+Shift+D'])

    const linux = createAdapter()
    const onLinux = new HotkeyManager(linux.adapter, vi.fn(), vi.fn(), 'linux')
    onLinux.replace('Control+Shift+Space')
    onLinux.suspend(true)
    onLinux.suspend(false)
    expect(linux.adapter.register).not.toHaveBeenCalled()
    expect(linux.adapter.unregister).not.toHaveBeenCalled()
  })
})

describe('HotkeyManager fix round', () => {
  // Electron refuses an accelerator already registered, in any spelling.
  function refusingAdapter(platform: 'darwin' | 'win32' = 'darwin') {
    const active = new Map<string, () => void>()
    const calls: string[] = []
    let refuseAll = false
    const key = (accelerator: string) => chordTokenSet(accelerator, platform)
    const adapter: GlobalShortcutAdapter = {
      register: vi.fn((accelerator: string, callback: () => void) => {
        calls.push(`register:${accelerator}`)
        if (refuseAll || active.has(key(accelerator))) return false
        active.set(key(accelerator), callback)
        return true
      }),
      unregister: vi.fn((accelerator: string) => {
        calls.push(`unregister:${accelerator}`)
        active.delete(key(accelerator))
      }),
      isRegistered: (accelerator) => active.has(key(accelerator)),
    }
    return { active, adapter, calls, refuse: (on: boolean) => { refuseAll = on } }
  }

  it('re-registers the same chord under a new spelling', () => {
    const { active, adapter, calls } = refusingAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'darwin')
    manager.replace('Shift+Control+Space')
    calls.splice(0)
    expect(manager.replace('Control+Shift+Space')).toEqual({ ok: true })
    expect(calls).toEqual(['unregister:Shift+Control+Space', 'register:Control+Shift+Space'])
    expect(manager.current()).toBe('Control+Shift+Space')
    expect(active.size).toBe(1)
  })

  it('restores the old spelling when the new one is refused', () => {
    const { adapter } = refusingAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'darwin')
    manager.replace('Shift+Control+Space')
    vi.mocked(adapter.register).mockImplementationOnce(() => false)
    expect(manager.replace('Control+Shift+Space')).toEqual({ ok: false, reason: 'conflict' })
    expect(manager.current()).toBe('Shift+Control+Space')
    expect(adapter.isRegistered?.('Shift+Control+Space')).toBe(true)
  })

  it('registers a candidate after a release and restores the prior one on refusal', () => {
    const { adapter, refuse } = refusingAdapter()
    const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'darwin')
    manager.replace('Control+Shift+Space')
    manager.suspend(true)
    refuse(true)
    expect(manager.replace('Alt+Shift+D')).toEqual({ ok: false, reason: 'conflict' })
    refuse(false)
    manager.suspend(true)
    expect(manager.replace('Control+Shift+Space')).toEqual({ ok: true })
    expect(adapter.isRegistered?.('Control+Shift+Space')).toBe(true)
  })

  it('logs a failed restore, reports no shortcut, and retries every 5 s up to 12 times', () => {
    vi.useFakeTimers()
    try {
      const { adapter, refuse } = refusingAdapter()
      const log = vi.fn()
      const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'darwin', log)
      manager.replace('Control+Shift+Space')
      manager.suspend(true)
      refuse(true)
      manager.suspend(false)
      expect(log).toHaveBeenCalledExactlyOnceWith('native-hotkey-registration-failed')
      expect(manager.current()).toBeNull()
      vi.advanceTimersByTime(5_000 * 2)
      expect(manager.current()).toBeNull()
      refuse(false)
      vi.advanceTimersByTime(5_000)
      expect(manager.current()).toBe('Control+Shift+Space')
      expect(adapter.isRegistered?.('Control+Shift+Space')).toBe(true)

      manager.suspend(true)
      refuse(true)
      vi.mocked(adapter.register).mockClear()
      manager.suspend(false)
      vi.advanceTimersByTime(5_000 * 30)
      expect(adapter.register).toHaveBeenCalledTimes(13)
      expect(manager.current()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('HotkeyManager never forgets the primary', () => {
  it('keeps a refused prior, reports no shortcut, logs, and retries it', () => {
    vi.useFakeTimers()
    try {
      const taken = new Set<string>()
      const active = new Map<string, () => void>()
      const adapter: GlobalShortcutAdapter = {
        register: vi.fn((accelerator: string, callback: () => void) => {
          if (taken.has(accelerator) || active.has(accelerator)) return false
          active.set(accelerator, callback)
          return true
        }),
        unregister: vi.fn((accelerator: string) => { active.delete(accelerator) }),
        isRegistered: (accelerator) => active.has(accelerator),
      }
      const log = vi.fn()
      const manager = new HotkeyManager(adapter, vi.fn(), vi.fn(), 'darwin', log)
      manager.replace('Control+Shift+Space')
      manager.suspend(true)
      taken.add('Control+Shift+Space').add('Alt+Shift+D')
      expect(manager.replace('Alt+Shift+D')).toEqual({ ok: false, reason: 'conflict' })
      expect(manager.current()).toBeNull()
      expect(log).toHaveBeenCalledExactlyOnceWith('native-hotkey-registration-failed')
      taken.clear()
      vi.advanceTimersByTime(5_000)
      expect(manager.current()).toBe('Control+Shift+Space')
      expect(active.has('Control+Shift+Space')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
