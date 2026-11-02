// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { PopupShortcut, type PopupShortcutKeys } from '../../../../src/main/popup/popupShortcut'
import type { PopupShortcutState } from '../../../../src/shared/popup'

/** A system shortcut table: each chord one owner, and the chords other apps hold. */
function system(taken: readonly string[] = []) {
  const held = new Map<string, () => void>()
  return {
    held,
    register: vi.fn((chord: string, run: () => void) => {
      if (taken.includes(chord) || held.has(chord)) return false
      held.set(chord, run)
      return true
    }),
    unregister: vi.fn((chord: string) => { held.delete(chord) }),
  }
}

const keys = (popupShortcut: string | null): PopupShortcutKeys => ({ popupShortcut, hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: [], holdShortcuts: [] })

function setup(taken: readonly string[] = []) {
  const shortcuts = system(taken)
  const press = vi.fn()
  const states: PopupShortcutState[] = []
  const shortcut = new PopupShortcut(shortcuts, press, 'darwin', state => states.push(state))
  return { shortcuts, press, states, shortcut }
}

describe('the popup shortcut (ADR-0181)', () => {
  it('registers the saved keys, and a press shows the popup', () => {
    const { shortcuts, press, shortcut } = setup()
    shortcut.apply(keys('Alt+Shift+Space'))
    expect([...shortcuts.held.keys()]).toEqual(['Alt+Shift+Space'])
    expect(shortcut.state()).toEqual({ status: 'on', chord: 'Alt+Shift+Space' })
    shortcuts.held.get('Alt+Shift+Space')!()
    expect(press).toHaveBeenCalledOnce()
  })

  it('follows a change of setting: the old keys go, the new come, and none leaves nothing registered', () => {
    const { shortcuts, shortcut, states } = setup()
    shortcut.apply(keys('Alt+Shift+Space'))
    shortcut.apply(keys('Alt+Shift+Space'))
    expect(shortcuts.register).toHaveBeenCalledTimes(1)
    shortcut.apply(keys('Control+Alt+P'))
    expect([...shortcuts.held.keys()]).toEqual(['Control+Alt+P'])
    shortcut.apply(keys(null))
    expect(shortcuts.held.size).toBe(0)
    expect(states.map(state => state.status)).toEqual(['on', 'on', 'off'])
  })

  it('says when another app holds the saved keys, and leaves keys dictation holds to dictation', () => {
    const { shortcuts, shortcut } = setup(['Alt+Shift+Space'])
    shortcut.apply(keys('Alt+Shift+Space'))
    expect(shortcut.state()).toEqual({ status: 'taken', chord: 'Alt+Shift+Space' })
    shortcut.apply(keys('Shift+CommandOrControl+Space'))
    expect(shortcut.state()).toEqual({ status: 'dictation', chord: 'Shift+CommandOrControl+Space' })
    expect(shortcuts.held.size).toBe(0)
  })

  it('registers keys from Settings before they are saved, and keeps the old ones when they cannot be taken', () => {
    const { shortcuts, shortcut } = setup(['Control+Alt+P'])
    shortcut.apply(keys('Alt+Shift+Space'))
    expect(shortcut.replace('Control+Alt+P', keys(null))).toEqual({ ok: false, reason: 'taken' })
    expect([...shortcuts.held.keys()]).toEqual(['Alt+Shift+Space'])
    expect(shortcut.replace('CommandOrControl+Shift+Space', keys(null))).toEqual({ ok: false, reason: 'dictation' })
    expect(shortcut.replace('Shift+P', keys(null))).toEqual({ ok: false, reason: 'invalid' })
    expect(shortcut.replace('Control+Alt+K', keys(null))).toEqual({ ok: true })
    expect([...shortcuts.held.keys()]).toEqual(['Control+Alt+K'])
    expect(shortcut.replace(null, keys(null))).toEqual({ ok: true })
    expect(shortcuts.held.size).toBe(0)
  })

  it('takes the same keys in another spelling by letting the old spelling go first', () => {
    const { shortcuts, shortcut } = setup()
    shortcut.apply(keys('Alt+Shift+Space'))
    expect(shortcut.replace('Shift+Alt+Space', keys(null))).toEqual({ ok: true })
    expect([...shortcuts.held.keys()]).toEqual(['Shift+Alt+Space'])
  })

  it('stands aside while Settings records keys and comes back after, or on the change it records', () => {
    const { shortcuts, shortcut } = setup()
    shortcut.apply(keys('Alt+Shift+Space'))
    shortcut.suspend(true)
    expect(shortcuts.held.size).toBe(0)
    // A settings change while recording waits for the recording to end.
    shortcut.apply(keys('Control+Alt+P'))
    expect(shortcuts.held.size).toBe(0)
    shortcut.suspend(false)
    expect([...shortcuts.held.keys()]).toEqual(['Control+Alt+P'])
    shortcut.suspend(true)
    expect(shortcut.replace('Control+Alt+K', keys(null))).toEqual({ ok: true })
    expect([...shortcuts.held.keys()]).toEqual(['Control+Alt+K'])
  })

  it('lets its keys go when disposed, and registers nothing after', () => {
    const { shortcuts, shortcut } = setup()
    shortcut.apply(keys('Alt+Shift+Space'))
    shortcut.dispose()
    shortcut.apply(keys('Control+Alt+P'))
    expect(shortcuts.held.size).toBe(0)
  })
})
