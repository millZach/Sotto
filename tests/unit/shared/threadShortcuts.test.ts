import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettings } from '../../../src/shared/settings'
import {
  DEFAULT_THREAD_SHORTCUTS, THREAD_SHORTCUT_IDS, isThreadChord, parseThreadShortcutChoices, resolveThreadShortcut,
} from '../../../src/shared/threadShortcuts'

describe('thread shortcut chords (ADR-0133)', () => {
  it('gives every shortcut a default chord it may itself use', () => {
    for (const id of THREAD_SHORTCUT_IDS) {
      expect(isThreadChord(DEFAULT_THREAD_SHORTCUTS[id]), id).toBe(true)
    }
    // No two defaults mean the same spelling.
    expect(new Set(Object.values(DEFAULT_THREAD_SHORTCUTS)).size).toBe(THREAD_SHORTCUT_IDS.length)
  })

  it('needs a primary modifier and one allowed key, so plain typing never qualifies', () => {
    expect(isThreadChord('mod+shift+n')).toBe(true)
    expect(isThreadChord('ctrl+enter')).toBe(true)
    expect(isThreadChord('mod+alt+arrowdown')).toBe(true)
    expect(isThreadChord('mod+space')).toBe(true)
    expect(isThreadChord('e')).toBe(false)
    expect(isThreadChord('shift+e')).toBe(false)
    expect(isThreadChord('alt+e')).toBe(false)
    expect(isThreadChord('mod+shift')).toBe(false)
    expect(isThreadChord('mod+tab')).toBe(false)
    expect(isThreadChord('mod+escape')).toBe(false)
    expect(isThreadChord('mod+.')).toBe(false)
    expect(isThreadChord('e+mod')).toBe(false)
    expect(isThreadChord('mod+mod+e')).toBe(false)
    expect(isThreadChord('fn')).toBe(false)
  })

  it('reads choices row by row, keeping nulls and dropping damage and retired rows', () => {
    expect(parseThreadShortcutChoices({ settle: 'mod+alt+s', 'new-thread': null })).toEqual({ settle: 'mod+alt+s', 'new-thread': null })
    expect(parseThreadShortcutChoices({ settle: 'e', restore: 42, gone: 'mod+q', changes: 'mod+shift+c' })).toEqual({ changes: 'mod+shift+c' })
    expect(parseThreadShortcutChoices('mod+d')).toEqual({})
    expect(parseThreadShortcutChoices(null)).toEqual({})
  })

  it('resolves a choice, a removal, then the default', () => {
    expect(resolveThreadShortcut({}, 'settle')).toBe('mod+shift+e')
    expect(resolveThreadShortcut({ settle: 'mod+alt+s' }, 'settle')).toBe('mod+alt+s')
    expect(resolveThreadShortcut({ settle: null }, 'settle')).toBeNull()
  })

  it('keeps saved choices whole through settings, and defaults where the file predates them', () => {
    expect(DEFAULT_SETTINGS.threadShortcuts).toEqual({})
    expect(parseSettings({ ...DEFAULT_SETTINGS, threadShortcuts: { settle: 'mod+alt+s', 'zoom-pane': null } }).threadShortcuts)
      .toEqual({ settle: 'mod+alt+s', 'zoom-pane': null })
    const before: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete before.threadShortcuts
    expect(parseSettings(before).threadShortcuts).toEqual({})
    expect(parseSettings({ ...DEFAULT_SETTINGS, threadShortcuts: { settle: 'nope', changes: 'mod+shift+c' } }).threadShortcuts)
      .toEqual({ changes: 'mod+shift+c' })
  })
})
