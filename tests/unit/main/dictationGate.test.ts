// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { createDictationGate } from '../../../src/main/hotkeys/dictationGate'
import type { GlobalShortcutAdapter } from '../../../src/main/hotkeys/hotkeyManager'
import { HotkeyManager } from '../../../src/main/hotkeys/hotkeyManager'
import type { KeyListener } from '../../../src/main/hotkeys/keyListener'

function os(refuse: string[] = []) {
  const live = new Map<string, () => void>()
  const adapter: GlobalShortcutAdapter = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (refuse.includes(accelerator) || live.has(accelerator)) return false
      live.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => { live.delete(accelerator) }),
    isRegistered: (accelerator: string) => live.has(accelerator),
  }
  return { adapter, live }
}

function listener(): KeyListener & { watched: () => readonly string[] } {
  let watched: readonly string[] = []
  return {
    watch: vi.fn((tokens: readonly string[]) => { watched = tokens }),
    record: vi.fn(), request: vi.fn(), running: () => watched.length > 0, ready: () => true,
    permission: () => 'granted', dispose: vi.fn(),
    watched: () => watched,
  } as KeyListener & { watched: () => readonly string[] }
}

describe('dictation gate', () => {
  it('registers nothing with the OS while off, and hands the hotkey back when turned on', () => {
    const { adapter, live } = os()
    const gate = createDictationGate(adapter, false)
    const hotkeys = new HotkeyManager(gate.shortcuts, vi.fn(), vi.fn(), 'darwin')

    expect(hotkeys.replace('Control+Space')).toEqual({ ok: true })
    expect(live.size).toBe(0)
    expect(hotkeys.current()).toBe('Control+Space')

    expect(gate.set(true)).toEqual([])
    expect([...live.keys()]).toEqual(['Control+Space'])

    gate.set(false)
    expect(live.size).toBe(0)
    expect(hotkeys.current()).toBe('Control+Space')
  })

  it('reports and lets go of a hotkey another app took while dictation was off', () => {
    const { adapter, live } = os()
    const gate = createDictationGate(adapter, true)
    const hotkeys = new HotkeyManager(gate.shortcuts, vi.fn(), vi.fn(), 'darwin')
    hotkeys.replace('Control+Space')
    gate.set(false)
    live.set('Control+Space', vi.fn())

    expect(gate.set(true)).toEqual(['Control+Space'])
    // Turning dictation off again does not release the other app's key.
    gate.set(false)
    expect(adapter.unregister).toHaveBeenCalledTimes(1)
  })

  it('stops the key listener while off and watches the same keys again when on', () => {
    const inner = listener()
    const gate = createDictationGate(os().adapter, true)
    const gated = gate.listener(inner)
    gated.watch(['Fn'])
    expect(inner.watched()).toEqual(['Fn'])

    gate.set(false)
    expect(inner.watched()).toEqual([])
    gated.watch(['Fn', 'RightCommand'])
    expect(inner.watched()).toEqual([])

    gate.set(true)
    expect(inner.watched()).toEqual(['Fn', 'RightCommand'])
  })

  it('starts no key listener recording while off', () => {
    const inner = listener()
    const gate = createDictationGate(os().adapter, false)
    gate.listener(inner).record(true)
    expect(inner.record).toHaveBeenLastCalledWith(false)
  })
})
