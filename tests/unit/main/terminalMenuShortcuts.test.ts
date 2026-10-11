// @vitest-environment node
import { expect, it } from 'vitest'
import { terminalTakesMenuShortcut } from '../../../src/main/terminals/menuShortcuts'

it.each(['win32', 'darwin', 'linux'] as const)('yields native zoom only in a focused terminal on %s, keeping other menu chords', platform => {
  const input = { key: '=', control: platform !== 'darwin', meta: platform === 'darwin', alt: false, shift: false }
  for (const key of ['=', '-', '0']) {
    expect(terminalTakesMenuShortcut({ ...input, key }, true, platform)).toBe(true)
    expect(terminalTakesMenuShortcut({ ...input, key }, false, platform)).toBe(false)
    expect(terminalTakesMenuShortcut({ ...input, key, alt: true }, true, platform)).toBe(false)
    expect(terminalTakesMenuShortcut({ ...input, key, shift: true }, true, platform)).toBe(false)
  }
  for (const key of ['c', 'v', 'a', 'f', 'j', 'k', 'Tab']) expect(terminalTakesMenuShortcut({ ...input, key }, true, platform)).toBe(false)
})
