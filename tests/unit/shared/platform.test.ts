// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { defaultHotkey, resolvePlatform } from '../../../src/shared/platform'

describe('resolvePlatform', () => {
  it.each(['freebsd', 'aix', 'Darwin', 'darwin ', 'Linux', 'linux ', '', 'not-a-platform'])(
    'falls back to win32 for %o',
    (raw) => {
      expect(resolvePlatform(raw)).toBe('win32')
    },
  )
})

describe('defaultHotkey', () => {
  it('binds the literal Control key on macOS', () => {
    expect(defaultHotkey('darwin')).toBe('Control+Shift+Space')
  })

  it('uses Super+Ctrl+X on Linux, the key its Hyprland binding has always had', () => {
    expect(defaultHotkey('linux')).toBe('Super+CommandOrControl+X')
  })
})
