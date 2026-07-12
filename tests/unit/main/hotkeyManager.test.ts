import { describe, expect, it, vi } from 'vitest'

import { HotkeyManager, type GlobalShortcutAdapter } from '../../../src/main/hotkeys/hotkeyManager'

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

describe('HotkeyManager listening-only Escape', () => {
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
