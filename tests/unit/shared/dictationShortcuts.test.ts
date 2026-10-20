// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  sameChord,
  canonicalChord,
  chordFromKeyboardEvent,
  chordHasKey,
  chordInline,
  chordNeedsListener,
  chordTokens,
  chordWords,
  keyTokenFromCode,
  validateChord,
  type DictationShortcutSet,
} from '../../../src/shared/dictationShortcuts'

const owl = { listener: true }
const stable = { listener: false }
const adding = (role: 'hold' | 'press') => ({ role, index: null })
const darwinSet: DictationShortcutSet = { press: ['Control+Shift+Space'], hold: ['Fn'] }
const win32Set: DictationShortcutSet = { press: ['CommandOrControl+Shift+Space'], hold: ['CommandOrControl+Super'] }

describe('chord tokens', () => {
  it('splits, trims and classifies', () => {
    expect(chordTokens(' Fn + Shift +Space ')).toEqual(['Fn', 'Shift', 'Space'])
    expect(chordHasKey('Fn+Shift')).toBe(false)
    expect(chordHasKey('ctrl+shift+space')).toBe(true)
    expect(chordHasKey('ctrl+shift')).toBe(false)
  })

  it('says which chords need the listener', () => {
    expect(chordNeedsListener('Control+Shift+Space', 'press')).toBe(false)
    expect(chordNeedsListener('Control+Shift+Space', 'hold')).toBe(true)
    expect(chordNeedsListener('Fn+Space', 'press')).toBe(true)
    expect(chordNeedsListener('CommandOrControl+Super', 'press')).toBe(true)
  })
})

describe('canonicalChord', () => {
  it('orders modifiers per platform', () => {
    expect(canonicalChord(['Space', 'CommandOrControl', 'Shift', 'Alt', 'Control', 'Fn'], 'darwin')).toBe(
      'Fn+Control+Alt+Shift+CommandOrControl+Space',
    )
    expect(canonicalChord(['Super', 'Space', 'Shift', 'Alt', 'CommandOrControl'], 'win32')).toBe(
      'CommandOrControl+Alt+Shift+Super+Space',
    )
    expect(canonicalChord(['Fn'], 'darwin')).toBe('Fn')
    expect(canonicalChord(['Shift', 'Shift', 'A'], 'linux')).toBe('Shift+A')
  })

  it.each([
    [[], 'darwin'],
    [['Shift', 'A', 'B'], 'darwin'],
    [['Shift', 'Other'], 'win32'],
    [['Shift', 'Insert'], 'win32'],
    [['Fn', 'Space'], 'win32'],
    [['Fn'], 'linux'],
    [['Super', 'A'], 'darwin'],
    [['Control', 'A'], 'win32'],
  ] as const)('refuses %o on %s', (tokens, platform) => {
    expect(canonicalChord(tokens, platform)).toBeNull()
  })
})

describe('keyTokenFromCode', () => {
  it.each([
    ['KeyA', 'A'], ['KeyZ', 'Z'], ['Digit0', '0'], ['Digit9', '9'], ['F1', 'F1'], ['F24', 'F24'],
    ['Space', 'Space'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['Delete', 'Delete'],
    ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
    ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'], ['Escape', 'Escape'],
    ['AltLeft', 'Alt'], ['AltRight', 'Alt'], ['ShiftLeft', 'Shift'], ['ShiftRight', 'Shift'],
  ])('maps %s to %s on every platform', (code, token) => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) expect(keyTokenFromCode(code, '', platform)).toBe(token)
  })

  it.each([
    ['ControlLeft', 'Control', 'CommandOrControl'],
    ['ControlRight', 'Control', 'CommandOrControl'],
    ['MetaLeft', 'CommandOrControl', 'Super'],
    ['MetaRight', 'CommandOrControl', 'Super'],
    ['OSLeft', 'CommandOrControl', 'Super'],
    ['OSRight', 'CommandOrControl', 'Super'],
  ])('maps %s per platform', (code, darwin, win32) => {
    expect(keyTokenFromCode(code, '', 'darwin')).toBe(darwin)
    expect(keyTokenFromCode(code, '', 'win32')).toBe(win32)
    expect(keyTokenFromCode(code, '', 'linux')).toBe(win32)
  })

  it.each(['F25', 'Numpad1', 'Minus', 'CapsLock', 'Fn', 'Insert', 'Keya'])('ignores %s', (code) => {
    expect(keyTokenFromCode(code, '', 'darwin')).toBeNull()
  })
})

describe('chordFromKeyboardEvent', () => {
  it('adds modifiers, keeps one key and ignores unknown keys', () => {
    expect(chordFromKeyboardEvent({ code: 'ShiftLeft', key: 'Shift' }, ['Control'], 'darwin')).toEqual(['Control', 'Shift'])
    expect(chordFromKeyboardEvent({ code: 'KeyB', key: 'b' }, ['Control', 'A'], 'darwin')).toEqual(['Control', 'B'])
    expect(chordFromKeyboardEvent({ code: 'ShiftRight', key: 'Shift' }, ['Shift'], 'win32')).toEqual(['Shift'])
    expect(chordFromKeyboardEvent({ code: 'Numpad1', key: '1' }, ['Shift'], 'win32')).toEqual(['Shift'])
    expect(chordFromKeyboardEvent({ code: 'MetaLeft', key: 'Meta' }, [], 'win32')).toEqual(['Super'])
  })
})

describe('chordWords and chordInline', () => {
  it('names chords on darwin', () => {
    expect(chordWords('Control+Shift+Space', 'darwin')).toBe('Control Shift Space')
    expect(chordWords('Fn+Alt+CommandOrControl+K', 'darwin')).toBe('Fn Option Command K')
    expect(chordInline('Control+Shift+Space', 'darwin')).toBe('⌃ Control + ⇧ Shift + Space')
    expect(chordInline('Fn', 'darwin')).toBe('Fn')
    expect(chordInline('Fn+CommandOrControl+Space', 'darwin')).toBe('Fn + ⌘ Command + Space')
  })

  it('names chords on win32 with Win', () => {
    expect(chordWords('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl Shift Space')
    expect(chordWords('CommandOrControl+Super', 'win32')).toBe('Ctrl Win')
    expect(chordInline('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl + Shift + Space')
    expect(chordInline('Alt+Super+F5', 'win32')).toBe('Alt + Win + F5')
  })
})

describe('validateChord', () => {
  it('accepts a fresh chord', () => {
    expect(validateChord('Alt+Shift+D', adding('press'), darwinSet, 'darwin', owl)).toEqual({ ok: true })
    expect(validateChord('Fn+Shift', adding('hold'), { press: ['Control+Shift+Space'], hold: [] }, 'darwin', owl)).toEqual({ ok: true })
    expect(validateChord('F9', adding('press'), win32Set, 'win32', owl)).toEqual({ ok: true })
    expect(validateChord('CommandOrControl+Shift+Space', { role: 'press', index: 0 }, win32Set, 'win32', stable)).toEqual({ ok: true })
  })

  it.each([
    ['darwin', 'Escape'],
    ['win32', 'CommandOrControl+Escape'],
  ] as const)('refuses Escape on %s', (platform, chord) => {
    expect(validateChord(chord, adding('press'), { press: [], hold: [] }, platform, owl)).toEqual({
      ok: false, code: 'escape', message: 'Esc cancels a recording, so it can’t start one. Pick other keys.',
    })
  })

  it('refuses a plain key on both platforms and allows Fn alone', () => {
    expect(validateChord('A', adding('press'), darwinSet, 'darwin', owl)).toEqual({
      ok: false, code: 'plain-key', message: 'A on its own would start dictation while you type. Add a modifier such as ⌃ Control.',
    })
    expect(validateChord('Space', adding('press'), win32Set, 'win32', owl)).toEqual({
      ok: false, code: 'plain-key', message: 'Space on its own would start dictation while you type. Add a modifier such as Ctrl.',
    })
    expect(validateChord('Fn', adding('hold'), { press: ['Control+Shift+Space'], hold: [] }, 'darwin', owl)).toEqual({ ok: true })
  })

  it.each([
    ['CommandOrControl+Space', 'macOS uses ⌘ Command + Space for Spotlight. Pick other keys.'],
    ['CommandOrControl+Tab', 'macOS uses ⌘ Command + Tab for switching apps. Pick other keys.'],
    ['CommandOrControl+Q', 'macOS uses ⌘ Command + Q for quitting apps. Pick other keys.'],
    ['Shift+CommandOrControl+3', 'macOS uses ⇧ Shift + ⌘ Command + 3 for taking screenshots. Pick other keys.'],
    ['CommandOrControl+Shift+4', 'macOS uses ⌘ Command + ⇧ Shift + 4 for taking screenshots. Pick other keys.'],
    ['cmd+shift+5', 'macOS uses ⌘ Command + ⇧ Shift + 5 for taking screenshots. Pick other keys.'],
  ])('refuses the reserved darwin chord %s', (chord, message) => {
    expect(validateChord(chord, adding('press'), darwinSet, 'darwin', owl)).toEqual({ ok: false, code: 'reserved', message })
  })

  it.each([
    ['Super+L', 'Windows uses Win + L for locking Windows. Pick other keys.'],
    ['Alt+Tab', 'Windows uses Alt + Tab for switching windows. Pick other keys.'],
    ['Alt+F4', 'Windows uses Alt + F4 for closing windows. Pick other keys.'],
    ['Super', 'Windows uses Win for opening Start. Pick other keys.'],
    ['Alt+CommandOrControl+Delete', 'Windows uses Alt + Ctrl + Delete for the security screen. Pick other keys.'],
  ])('refuses the reserved win32 chord %s', (chord, message) => {
    expect(validateChord(chord, adding('hold'), win32Set, 'win32', owl)).toEqual({ ok: false, code: 'reserved', message })
  })

  it('refuses a duplicate across rows in another modifier order', () => {
    expect(validateChord('Shift+Control+Space', adding('hold'), darwinSet, 'darwin', owl)).toEqual({
      ok: false, code: 'duplicate', message: 'Press to start and stop already uses ⇧ Shift + ⌃ Control + Space.',
    })
    expect(validateChord('Super+CommandOrControl', adding('press'), win32Set, 'win32', owl)).toEqual({
      ok: false, code: 'duplicate', message: 'Hold to dictate already uses Win + Ctrl.',
    })
  })

  it('compares legacy strings by token set', () => {
    const legacy = { press: ['shift+ctrl+space'], hold: [] }
    expect(validateChord('CommandOrControl+Shift+Space', adding('hold'), legacy, 'win32', owl)).toMatchObject({ code: 'duplicate' })
    expect(validateChord('CommandOrControl+Shift+Space', { role: 'press', index: 0 }, legacy, 'win32', owl)).toEqual({ ok: true })
  })

  it('refuses overlap in both directions', () => {
    expect(validateChord('Control+Shift', adding('hold'), darwinSet, 'darwin', owl)).toEqual({
      ok: false,
      code: 'overlap',
      message: 'Holding ⌃ Control + ⇧ Shift would start dictation every time you press ⌃ Control + ⇧ Shift + Space. Pick keys that don’t overlap.',
    })
    expect(validateChord('CommandOrControl+Super+A', adding('press'), win32Set, 'win32', owl)).toEqual({
      ok: false,
      code: 'overlap',
      message: 'Holding Ctrl + Win would start dictation every time you press Ctrl + Win + A. Pick keys that don’t overlap.',
    })
  })

  it('ignores the slot being replaced', () => {
    expect(validateChord('Fn', { role: 'hold', index: 0 }, darwinSet, 'darwin', owl)).toEqual({ ok: true })
    expect(validateChord('Fn+Shift', { role: 'hold', index: 0 }, darwinSet, 'darwin', owl)).toEqual({ ok: true })
  })

  it('refuses a fifth shortcut in a row', () => {
    const full = { press: ['Control+Shift+Space', 'Alt+F1', 'Alt+F2', 'Alt+F3'], hold: [] }
    expect(validateChord('Alt+F6', adding('press'), full, 'darwin', owl)).toEqual({
      ok: false, code: 'too-many', message: 'Each row holds up to 4 shortcuts.',
    })
    expect(validateChord('Alt+F6', { role: 'press', index: 3 }, full, 'darwin', owl)).toEqual({ ok: true })
  })

  describe('needs-key', () => {
    const base = 'Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere.'

    it.each([
      ['darwin', 'Fn+Space', darwinSet],
      ['darwin', 'Control+Shift', darwinSet],
      ['win32', 'Alt+Shift', win32Set],
    ] as const)('refuses %s %s in press slot 0 and points to + Add', (platform, chord, set) => {
      expect(validateChord(chord, { role: 'press', index: 0 }, set, platform, owl)).toEqual({
        ok: false, code: 'needs-key', message: `${base} Add this one with + Add instead.`,
      })
    })

    it('treats adding to an empty press row as slot 0', () => {
      expect(validateChord('Fn+Space', adding('press'), { press: [], hold: [] }, 'darwin', owl)).toMatchObject({ code: 'needs-key' })
    })

    it('allows listener chords as extra press shortcuts with the listener', () => {
      expect(validateChord('Fn+Space', adding('press'), { press: ['Control+Shift+Space'], hold: ['Fn+Shift'] }, 'darwin', owl)).toEqual({ ok: true })
    })

    it.each([
      ['darwin', 'Fn+Space', adding('press'), darwinSet],
      ['win32', 'Alt+Shift', adding('press'), win32Set],
      ['darwin', 'Alt+Shift+D', adding('hold'), darwinSet],
      ['win32', 'Alt+Shift+D', { role: 'hold', index: 0 }, win32Set],
    ] as const)('refuses every listener chord on %s without the listener (%s)', (platform, chord, target, set) => {
      expect(validateChord(chord, target, set, platform, stable)).toEqual({ ok: false, code: 'needs-key', message: base })
    })
  })

  describe('lone-modifier', () => {
    it.each([['darwin', 'Shift+Shift'], ['win32', 'Control+Ctrl']] as const)('counts a repeated modifier once on %s (%s)', (platform, chord) => {
      expect(validateChord(chord, adding('hold'), { press: [], hold: [] }, platform, owl)).toMatchObject({ ok: false, code: 'lone-modifier' })
    })

    it.each([
      ['darwin', 'Shift', '⇧ Shift on its own is part of too many shortcuts. Use Fn, or two modifiers together.'],
      ['darwin', 'CommandOrControl', '⌘ Command on its own is part of too many shortcuts. Use Fn, or two modifiers together.'],
      ['win32', 'Alt', 'Alt on its own is part of too many shortcuts. Use two modifiers together.'],
    ] as const)('refuses a single modifier on %s (%s)', (platform, chord, message) => {
      expect(validateChord(chord, adding('hold'), { press: [], hold: [] }, platform, owl)).toEqual({ ok: false, code: 'lone-modifier', message })
    })

    it('allows Fn alone and two modifiers together, and refuses needs-key first in the main slot', () => {
      expect(validateChord('Fn', adding('hold'), { press: [], hold: [] }, 'darwin', owl)).toEqual({ ok: true })
      expect(validateChord('CommandOrControl+Super', adding('hold'), { press: [], hold: [] }, 'win32', owl)).toEqual({ ok: true })
      expect(validateChord('Shift', { role: 'press', index: 0 }, { press: ['Alt+K'], hold: [] }, 'win32', owl)).toMatchObject({ code: 'needs-key' })
    })
  })

  it('compares chords by key set, not spelling or order', () => {
    expect(sameChord('Shift+Ctrl+Space', 'CommandOrControl+Shift+Space', 'win32')).toBe(true)
    expect(sameChord('Control+Shift+Space', 'Control+Alt+Space', 'darwin')).toBe(false)
  })
})

describe('validateChord, bug bot round', () => {
  it.each([
    ['darwin', darwinSet, '⇧ Shift + A on its own would start dictation while you type. Add a modifier such as ⌃ Control.'],
    ['win32', win32Set, 'Shift + A on its own would start dictation while you type. Add a modifier such as Ctrl.'],
  ] as const)('refuses Shift with a plain key as plain-key on %s and allows Shift+F5', (platform, set, message) => {
    expect(validateChord('Shift+A', adding('press'), set, platform, owl)).toEqual({ ok: false, code: 'plain-key', message })
    expect(validateChord('Shift+A', adding('hold'), set, platform, owl)).toEqual({ ok: false, code: 'plain-key', message })
    expect(validateChord('Shift+F5', adding('press'), set, platform, owl)).toEqual({ ok: true })
  })

  it('refuses an empty chord as needs-key', () => {
    const needsKey = { ok: false, code: 'needs-key', message: 'Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere.' }
    expect(validateChord('', adding('hold'), darwinSet, 'darwin', owl)).toEqual(needsKey)
    expect(validateChord(' + ', { role: 'press', index: 1 }, { press: ['F9', ''], hold: [] }, 'win32', owl)).toEqual(needsKey)
  })
})

describe('Linux chords', () => {
  const linuxSet: DictationShortcutSet = { press: ['Super+CommandOrControl+X'], hold: ['F9'] }

  it('orders and names keys the way Omarchy writes them, with Super rather than Win or Command', () => {
    expect(canonicalChord(['CommandOrControl', 'Super', 'X'], 'linux')).toBe('Super+CommandOrControl+X')
    expect(chordInline('Super+CommandOrControl+X', 'linux')).toBe('Super + Ctrl + X')
    expect(chordWords('Super+CommandOrControl+X', 'linux')).toBe('Super Ctrl X')
    expect(keyTokenFromCode('MetaLeft', 'Meta', 'linux')).toBe('Super')
    expect(keyTokenFromCode('ControlRight', 'Control', 'linux')).toBe('CommandOrControl')
    // Windows and macOS keep their own words.
    expect(chordInline('CommandOrControl+Super', 'win32')).toBe('Ctrl + Win')
    expect(canonicalChord(['Super', 'CommandOrControl', 'X'], 'win32')).toBe('CommandOrControl+Super+X')
  })

  it('lets Hyprland hold any chord with a key, without a key listener', () => {
    expect(validateChord('F10', adding('hold'), linuxSet, 'linux', stable)).toEqual({ ok: true })
    expect(validateChord('Super+Alt+D', { role: 'press', index: 0 }, linuxSet, 'linux', stable)).toEqual({ ok: true })
  })

  it('refuses a chord without a key, saying Hyprland may have kept it', () => {
    const refusal = validateChord('Super+CommandOrControl', { role: 'press', index: 0 }, linuxSet, 'linux', stable)
    expect(refusal).toMatchObject({ ok: false, code: 'needs-key' })
    expect(refusal.ok ? '' : refusal.message).toContain('Hyprland already uses it')
    expect(validateChord('Super', adding('hold'), linuxSet, 'linux', owl)).toMatchObject({ ok: false, code: 'needs-key' })
    expect(validateChord('Fn', adding('hold'), linuxSet, 'linux', owl)).toMatchObject({ ok: false, code: 'needs-key' })
  })

  it('suggests Super for a plain key, and finds duplicates across rows', () => {
    expect(validateChord('D', { role: 'press', index: 0 }, linuxSet, 'linux', stable)).toMatchObject({ ok: false, code: 'plain-key', message: 'D on its own would start dictation while you type. Add a modifier such as Super.' })
    expect(validateChord('F9', { role: 'press', index: 0 }, linuxSet, 'linux', stable)).toEqual({ ok: false, code: 'duplicate', message: 'Hold to dictate already uses F9.' })
  })
})
