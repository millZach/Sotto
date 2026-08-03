import { describe, expect, it } from 'vitest'

import {
  PLATFORM_ARGUMENT_PREFIX,
  defaultHotkey,
  resolvePlatform,
} from '../../../src/shared/platform'

describe('resolvePlatform', () => {
  it('maps darwin to the macOS platform', () => {
    expect(resolvePlatform('darwin')).toBe('darwin')
  })

  it('maps win32 to the Windows platform', () => {
    expect(resolvePlatform('win32')).toBe('win32')
  })

  it.each(['linux', 'freebsd', 'aix', 'Darwin', 'darwin ', '', 'not-a-platform'])(
    'falls back to win32 for %o',
    (raw) => {
      expect(resolvePlatform(raw)).toBe('win32')
    },
  )
})

describe('defaultHotkey', () => {
  it('keeps the shipped Windows shortcut', () => {
    expect(defaultHotkey('win32')).toBe('CommandOrControl+Shift+Space')
  })

  it('binds the literal Control key on macOS', () => {
    expect(defaultHotkey('darwin')).toBe('Control+Shift+Space')
  })
})

describe('PLATFORM_ARGUMENT_PREFIX', () => {
  it('uses the renderer argument convention', () => {
    expect(PLATFORM_ARGUMENT_PREFIX).toBe('--sotto-platform=')
  })
})
