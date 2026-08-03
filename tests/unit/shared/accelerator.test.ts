import { describe, expect, it } from 'vitest'

import {
  formatAccelerator,
  parseAccelerator,
  type AcceleratorStyle,
} from '../../../src/shared/accelerator'

const styles: readonly AcceleratorStyle[] = ['display', 'editing']

const win32Canonical = [
  'CommandOrControl+Shift+Space',
  'CommandOrControl+Alt+9',
  'Super+Shift+Space',
  'Alt+Shift+A',
  'Shift+Alt+F5',
  'CommandOrControl+Shift+PageUp',
] as const

const darwinCanonical = [
  'Control+Shift+Space',
  'CommandOrControl+Shift+Space',
  'CommandOrControl+Alt+Shift+K',
  'CommandOrControl+Control+Shift+Space',
  'Control+Alt+Space',
  'Alt+Shift+F5',
  'Shift+Alt+PageDown',
] as const

describe('formatAccelerator on win32', () => {
  it.each(styles)('renders the command modifier as Ctrl in the %s style', (style) => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', 'win32', style)).toBe('Ctrl+Shift+Space')
    expect(formatAccelerator('CmdOrCtrl+Alt+M', 'win32', style)).toBe('Ctrl+Alt+M')
    expect(formatAccelerator('Control+Shift+Space', 'win32', style)).toBe('Ctrl+Shift+Space')
  })

  it.each(styles)('leaves every other canonical token untouched in the %s style', (style) => {
    expect(formatAccelerator('Super+Shift+Space', 'win32', style)).toBe('Super+Shift+Space')
    expect(formatAccelerator('Alt+Shift+A', 'win32', style)).toBe('Alt+Shift+A')
    expect(formatAccelerator('Shift+Alt+F5', 'win32', style)).toBe('Shift+Alt+F5')
  })

  it.each(styles)('trims segments and drops empty ones in the %s style', (style) => {
    expect(formatAccelerator(' CommandOrControl + Shift + Space ', 'win32', style)).toBe('Ctrl+Shift+Space')
    expect(formatAccelerator('CommandOrControl++Shift+Space', 'win32', style)).toBe('Ctrl+Shift+Space')
    expect(formatAccelerator('', 'win32', style)).toBe('')
  })

  it.each(styles)('passes lowercase spellings through verbatim in the %s style', (style) => {
    expect(formatAccelerator('ctrl+shift+space', 'win32', style)).toBe('ctrl+shift+space')
    expect(formatAccelerator('option+shift+m', 'win32', style)).toBe('option+shift+m')
  })
})

describe('parseAccelerator on win32', () => {
  it.each([
    ['ctrl+shift+space', 'CommandOrControl+Shift+Space'],
    ['Ctrl+Shift+Space', 'CommandOrControl+Shift+Space'],
    ['control+alt+9', 'CommandOrControl+Alt+9'],
    ['CmdOrCtrl+Shift+Space', 'CommandOrControl+Shift+Space'],
    ['commandorcontrol+shift+space', 'CommandOrControl+Shift+Space'],
    ['win+shift+p', 'Super+Shift+P'],
    ['windows+shift+p', 'Super+Shift+P'],
    ['meta+shift+p', 'Super+Shift+P'],
    ['super+shift+p', 'Super+Shift+P'],
    ['option+shift+p', 'Alt+Shift+P'],
    ['alt+shift+p', 'Alt+Shift+P'],
  ])('canonicalizes %o', (value, expected) => {
    expect(parseAccelerator(value, 'win32')).toBe(expected)
  })

  it.each([
    ['ctrl+return', 'CommandOrControl+Enter'],
    ['ctrl+enter', 'CommandOrControl+Enter'],
    ['ctrl+shift+pageup', 'CommandOrControl+Shift+PageUp'],
    ['ctrl+shift+pagedown', 'CommandOrControl+Shift+PageDown'],
    ['ctrl+backspace', 'CommandOrControl+Backspace'],
    ['ctrl+up', 'CommandOrControl+Up'],
  ])('names well-known keys for %o', (value, expected) => {
    expect(parseAccelerator(value, 'win32')).toBe(expected)
  })

  it.each([
    ['ctrl+f5', 'CommandOrControl+F5'],
    ['ctrl+f24', 'CommandOrControl+F24'],
    ['ctrl+a', 'CommandOrControl+A'],
    ['ctrl+f25', 'CommandOrControl+f25'],
    ['ctrl+numpad0', 'CommandOrControl+numpad0'],
  ])('normalizes the key of %o', (value, expected) => {
    expect(parseAccelerator(value, 'win32')).toBe(expected)
  })

  it('keeps modifiers in the order they were typed', () => {
    expect(parseAccelerator('shift+ctrl+space', 'win32')).toBe('Shift+CommandOrControl+Space')
  })

  it.each([
    '',
    'ctrl',
    'space',
    'ctrl+shift',
    'a+b',
    'ctrl+a+b',
    'ctrl+ctrl+a',
    'ctrl+control+a',
    'ctrl+a b',
  ])('rejects %o', (value) => {
    expect(parseAccelerator(value, 'win32')).toBeNull()
  })

  it.each(win32Canonical)('round-trips %o through both styles', (accelerator) => {
    for (const style of styles) {
      expect(parseAccelerator(formatAccelerator(accelerator, 'win32', style), 'win32')).toBe(accelerator)
    }
  })
})

describe('parseAccelerator on darwin', () => {
  it.each(['Control+Shift+Space', 'control+shift+space', 'ctrl+shift+space', '⌃+⇧+Space'])(
    'keeps the literal Control key of %o as its own token',
    (value) => {
      expect(parseAccelerator(value, 'darwin')).toBe('Control+Shift+Space')
    },
  )

  it.each([
    'command+shift+space',
    'cmd+shift+space',
    '⌘+⇧+Space',
    'commandorcontrol+shift+space',
    'cmdorctrl+shift+space',
    'super+shift+space',
    'meta+shift+space',
  ])('canonicalizes %o to the command modifier', (value) => {
    expect(parseAccelerator(value, 'darwin')).toBe('CommandOrControl+Shift+Space')
  })

  it.each(['option+shift+m', 'alt+shift+m', '⌥+⇧+M'])('canonicalizes %o to Alt', (value) => {
    expect(parseAccelerator(value, 'darwin')).toBe('Alt+Shift+M')
  })

  it('treats Command and Control as distinct modifiers', () => {
    expect(parseAccelerator('cmd+ctrl+shift+space', 'darwin')).toBe(
      'CommandOrControl+Control+Shift+Space',
    )
  })

  it.each(['cmd+super+space', 'cmd+⌘+space', 'ctrl+control+space', 'alt+⌥+space'])(
    'rejects the duplicate modifier in %o',
    (value) => {
      expect(parseAccelerator(value, 'darwin')).toBeNull()
    },
  )
})

describe('formatAccelerator on darwin', () => {
  it.each([
    ['CommandOrControl+Shift+Space', '⌘+⇧+Space'],
    ['Control+Shift+Space', '⌃+⇧+Space'],
    ['CommandOrControl+Alt+Shift+K', '⌘+⌥+⇧+K'],
    ['CmdOrCtrl+Shift+Space', '⌘+⇧+Space'],
    ['Super+Shift+Space', '⌘+⇧+Space'],
  ])('renders %o as glyphs in the display style', (accelerator, expected) => {
    expect(formatAccelerator(accelerator, 'darwin', 'display')).toBe(expected)
  })

  it.each([
    ['CommandOrControl+Shift+Space', 'Command+Shift+Space'],
    ['Control+Shift+Space', 'Control+Shift+Space'],
    ['CommandOrControl+Alt+Shift+K', 'Command+Option+Shift+K'],
    ['⌘+⇧+Space', 'Command+Shift+Space'],
  ])('renders %o as typeable words in the editing style', (accelerator, expected) => {
    expect(formatAccelerator(accelerator, 'darwin', 'editing')).toBe(expected)
  })

  it.each(styles)('trims segments and leaves unknown tokens alone in the %s style', (style) => {
    expect(formatAccelerator(' Control + Shift + F5 ', 'darwin', style)).toBe(
      style === 'display' ? '⌃+⇧+F5' : 'Control+Shift+F5',
    )
    expect(formatAccelerator('', 'darwin', style)).toBe('')
  })

  it.each(darwinCanonical)('round-trips %o through both styles', (accelerator) => {
    for (const style of styles) {
      expect(parseAccelerator(formatAccelerator(accelerator, 'darwin', style), 'darwin')).toBe(accelerator)
    }
  })
})

describe('platform isolation', () => {
  it('does not leak the darwin Control token onto win32', () => {
    expect(parseAccelerator('control+shift+space', 'win32')).toBe('CommandOrControl+Shift+Space')
    expect(parseAccelerator('control+shift+space', 'darwin')).toBe('Control+Shift+Space')
  })

  it('does not accept macOS glyphs as modifiers on win32', () => {
    expect(parseAccelerator('⌘+⇧+Space', 'win32')).toBeNull()
  })
})
