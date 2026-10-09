// @vitest-environment node
import type { Stats } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateDictationRuntime } from '../../../src/main/hotkeys/dictationRuntime'

const { lstat } = vi.hoisted(() => ({ lstat: vi.fn() }))
vi.mock('node:fs', () => ({ lstatSync: lstat }))

describe('dictation runtime ancestry', () => {
  const entries = new Map<string, Stats>()
  const originalGetuid = process.getuid
  const directory = (uid: number, mode: number): Stats => ({ uid, mode, isDirectory: () => true }) as Stats
  beforeEach(() => {
    process.getuid = vi.fn(() => 1000)
    entries.clear()
    entries.set('/', directory(0, 0o755))
    entries.set('/run', directory(0, 0o755))
    entries.set('/run/user', directory(0, 0o755))
    entries.set('/run/user/1000', directory(1000, 0o700))
    lstat.mockImplementation(path => entries.get(path))
  })
  afterEach(() => {
    if (originalGetuid === undefined) Reflect.deleteProperty(process, 'getuid')
    else process.getuid = originalGetuid
    lstat.mockReset()
  })

  it('accepts root-owned 0755 ancestors as in /run/user/<uid>', () => {
    expect(validateDictationRuntime('/run/user/1000').map(entry => entry.path))
      .toEqual(['/', '/run', '/run/user', '/run/user/1000'])
  })
  it.each([0o755, 0o777, 0o1777])('refuses a foreign-owned parent with permissions %s', mode => {
    entries.set('/run/user', directory(2000, mode))
    expect(() => validateDictationRuntime('/run/user/1000')).toThrow('only you or the system can change')
  })
  it.each([0, 1000])('refuses non-sticky writable parents owned by UID %s', uid => {
    entries.set('/run/user', directory(uid, 0o775))
    expect(() => validateDictationRuntime('/run/user/1000')).toThrow('only you or the system can change')
  })
  it.each([0, 1000])('accepts a sticky writable parent owned by UID %s', uid => {
    entries.set('/run/user', directory(uid, 0o1777))
    expect(validateDictationRuntime('/run/user/1000')).toHaveLength(4)
  })
})
