import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { DEFAULT_THREAD_SHORTCUTS, THREAD_SHORTCUT_IDS } from '../../../src/shared/threadShortcuts'
import {
  acceleratorForChord, chordFromAccelerator, chosenThreadChord, claimedThreadChord, menuOwnedChord, openBesidePressed,
  sameThreadKeys, threadChordLabel, threadChordPressed,
} from '../../../src/renderer/src/agents/threadShortcuts'

const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...patch })
const chordEvent = (patch: Partial<{ key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; defaultPrevented: boolean; repeat: boolean; target: EventTarget | null }> = {}) =>
  ({ key: 'n', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, defaultPrevented: false, repeat: false, target: document.body, ...patch })

describe('thread shortcut choices (ADR-0133)', () => {
  it('reads every default until the user chooses, and nothing where the user removed one', () => {
    expect(chosenThreadChord(settings(), 'new-thread')).toBe('mod+shift+n')
    expect(chosenThreadChord(settings(), 'settle')).toBe('mod+shift+e')
    expect(chosenThreadChord(undefined, 'changes')).toBe('mod+d')
    expect(chosenThreadChord(settings({ threadShortcuts: { settle: 'mod+alt+s' } }), 'settle')).toBe('mod+alt+s')
    expect(chosenThreadChord(settings({ threadShortcuts: { settle: null } }), 'settle')).toBeNull()
  })

  it('keeps every default clear of the application menu’s own accelerators, which fire before the window', () => {
    // Windows and Linux keep Electron's default menu; its Force Reload is why Restore is not mod+shift+r.
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const id of THREAD_SHORTCUT_IDS) {
        expect(menuOwnedChord(DEFAULT_THREAD_SHORTCUTS[id], platform), `${id} on ${platform}`).toBeNull()
      }
    }
    expect(chosenThreadChord(settings(), 'restore')).toBe('mod+alt+r')
    expect(menuOwnedChord('mod+shift+r', 'win32')).toBe('ctrl+shift+r')
    expect(menuOwnedChord('ctrl+shift+r', 'linux')).toBe('ctrl+shift+r')
    expect(menuOwnedChord('mod+r', 'win32')).toBe('ctrl+r')
    expect(menuOwnedChord('mod+w', 'darwin')).toBe('mod+w')
    // Close pane's shifted W is not the menu's Close, on any platform.
    expect(menuOwnedChord('mod+shift+w', 'win32')).toBeNull()
    expect(menuOwnedChord('mod+shift+r', 'darwin')).toBeNull()
  })

  it('claims a chord unless the dictation hotkey already means it, on the platform it runs on', () => {
    expect(claimedThreadChord(settings(), 'new-thread', 'win32')).toBe('mod+shift+n')
    expect(claimedThreadChord(settings({ hotkey: 'Control+Shift+N' }), 'new-thread', 'win32')).toBeNull()
    expect(claimedThreadChord(settings({ hotkey: 'Command+Shift+N' }), 'new-thread', 'darwin')).toBeNull()
    // The same accelerator spelled for the other platform's modifier does not collide.
    expect(claimedThreadChord(settings({ hotkey: 'Command+Shift+N' }), 'new-thread', 'win32')).toBe('mod+shift+n')
    expect(claimedThreadChord(settings({ threadShortcuts: { settle: null } }), 'settle', 'win32')).toBeNull()
    // An extra press or hold shortcut takes the keys just as the hotkey does, defaults included.
    expect(claimedThreadChord(settings({ holdShortcuts: ['CommandOrControl+Shift+S'] }), 'stop-turn', 'win32')).toBeNull()
    expect(claimedThreadChord(settings({ pressShortcuts: ['CommandOrControl+Shift+E'] }), 'settle', 'win32')).toBeNull()
  })

  it('labels a chord in each platform’s own words, from the chord itself', () => {
    expect(threadChordLabel('mod+shift+n', 'win32')).toEqual({ suffix: '(Ctrl+Shift+N)', plain: 'Ctrl+Shift+N', keys: 'Control+Shift+N' })
    expect(threadChordLabel('mod+shift+n', 'darwin')).toEqual({ suffix: '(Cmd+Shift+N)', plain: 'Cmd+Shift+N', keys: 'Meta+Shift+N' })
    expect(threadChordLabel('ctrl+enter', 'darwin').keys).toBe('Control+Enter')
    expect(threadChordLabel('mod+alt+arrowdown', 'win32')).toEqual({ suffix: '(Ctrl+Alt+Down)', plain: 'Ctrl+Alt+Down', keys: 'Control+Alt+ArrowDown' })
    expect(threadChordLabel('mod+space', 'win32').plain).toBe('Ctrl+Space')
  })

  it('turns a recorded accelerator into a chord and back, and refuses keys no thread shortcut may use', () => {
    expect(chordFromAccelerator('CommandOrControl+Shift+E', 'win32')).toBe('mod+shift+e')
    expect(chordFromAccelerator('Control+Shift+Space', 'darwin')).toBe('ctrl+shift+space')
    expect(chordFromAccelerator('CommandOrControl+Alt+Down', 'darwin')).toBe('mod+alt+arrowdown')
    expect(chordFromAccelerator('Shift+E', 'win32')).toBeNull()
    expect(chordFromAccelerator('CommandOrControl+Tab', 'win32')).toBeNull()
    expect(acceleratorForChord('mod+shift+e', 'win32')).toBe('CommandOrControl+Shift+E')
    expect(acceleratorForChord('mod+alt+arrowdown', 'darwin')).toBe('CommandOrControl+Alt+Down')
    expect(acceleratorForChord('ctrl+enter', 'win32')).toBe('CommandOrControl+Enter')
    expect(sameThreadKeys('shift+mod+n', 'mod+shift+n', 'win32')).toBe(true)
    expect(sameThreadKeys('ctrl+enter', 'mod+enter', 'darwin')).toBe(false)
  })
})

describe('whether a keydown presses a thread chord', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('matches the chord on its own platform', () => {
    expect(threadChordPressed(chordEvent(), 'mod+shift+n', 'win32')).toBe(true)
    expect(threadChordPressed(chordEvent({ ctrlKey: false, metaKey: true }), 'mod+shift+n', 'darwin')).toBe(true)
    expect(threadChordPressed(chordEvent({ key: ' ' }), 'mod+shift+space', 'win32')).toBe(true)
  })
  it('ignores a different key or an already-handled or repeating keydown', () => {
    expect(threadChordPressed(chordEvent({ key: 'm' }), 'mod+shift+n', 'win32')).toBe(false)
    expect(threadChordPressed(chordEvent({ defaultPrevented: true }), 'mod+shift+n', 'win32')).toBe(false)
    expect(threadChordPressed(chordEvent({ repeat: true }), 'mod+shift+n', 'win32')).toBe(false)
  })
  it('ignores the chord typed into a terminal', () => {
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    document.body.appendChild(terminal)
    expect(threadChordPressed(chordEvent({ target: terminal }), 'mod+shift+n', 'win32')).toBe(false)
  })
  it('ignores the chord while a dialog is already open, which answers Escape instead', () => {
    const openDialog = document.createElement('dialog')
    openDialog.setAttribute('open', '')
    document.body.appendChild(openDialog)
    expect(threadChordPressed(chordEvent(), 'mod+shift+n', 'win32')).toBe(false)
  })
  it('keeps either primary modifier for Open beside at its default, and only the chosen keys after', () => {
    const enter = (patch: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
      ({ key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...patch })
    expect(openBesidePressed(enter({ ctrlKey: true }), 'ctrl+enter', 'darwin')).toBe(true)
    expect(openBesidePressed(enter({ metaKey: true }), 'ctrl+enter', 'darwin')).toBe(true)
    expect(openBesidePressed(enter({ metaKey: true }), 'mod+enter', 'darwin')).toBe(true)
    expect(openBesidePressed(enter({ ctrlKey: true }), 'mod+enter', 'darwin')).toBe(false)
    expect(openBesidePressed(enter({}), 'ctrl+enter', 'win32')).toBe(false)
  })
})
