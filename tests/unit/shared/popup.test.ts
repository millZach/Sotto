import { describe, expect, it } from 'vitest'

import { popupShortcutRefusal } from '../../../src/shared/popup'

const dictation = { hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: ['F8'], holdShortcuts: ['Fn', 'Control+Alt+H'] }

describe('the popup shortcut check (ADR-0181)', () => {
  it('takes a chord with a key and a modifier other than Shift that no dictation shortcut holds', () => {
    expect(popupShortcutRefusal('Alt+Shift+Space', dictation, 'darwin')).toBeNull()
    expect(popupShortcutRefusal('CommandOrControl+Alt+P', dictation, 'win32')).toBeNull()
  })

  it('refuses keys dictation holds, in any spelling and order', () => {
    expect(popupShortcutRefusal('Shift+CommandOrControl+Space', dictation, 'win32')).toBe('dictation-press')
    expect(popupShortcutRefusal('Ctrl+Shift+Space', dictation, 'win32')).toBe('dictation-press')
    expect(popupShortcutRefusal('Alt+Control+H', dictation, 'darwin')).toBe('dictation-hold')
    expect(popupShortcutRefusal('Alt+F8', dictation, 'win32')).toBeNull()
  })

  it('refuses a chord a hold of modifiers alone is part of, since holding them starts dictation first', () => {
    const holdingModifiers = { ...dictation, holdShortcuts: ['Control+Alt'] }
    expect(popupShortcutRefusal('Control+Alt+Space', holdingModifiers, 'darwin')).toBe('dictation-hold')
    expect(popupShortcutRefusal('Alt+Shift+Space', holdingModifiers, 'darwin')).toBeNull()
  })

  it('refuses modifiers alone, a key with no modifier or Shift alone, and Escape', () => {
    expect(popupShortcutRefusal('Alt+Shift', dictation, 'win32')).toBe('needs-key')
    expect(popupShortcutRefusal('Space', dictation, 'win32')).toBe('plain-key')
    expect(popupShortcutRefusal('Shift+P', dictation, 'win32')).toBe('plain-key')
    expect(popupShortcutRefusal('Alt+Escape', dictation, 'win32')).toBe('escape')
  })
})
