import { describe, expect, it } from 'vitest'
import { keepRecent, readRecent } from '../../../src/shared/recentMap'

describe('a most-recent map', () => {
  it('keeps the newest entries up to its limit, and a read makes an entry the newest', () => {
    const map = new Map<string, number>()
    expect(keepRecent(map, 'a', 1, 2)).toBe(1)
    keepRecent(map, 'b', 2, 2)
    expect(readRecent(map, 'a')).toBe(1)
    keepRecent(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['a', 'c'])
    keepRecent(map, 'a', 4, 2)
    expect([...map.entries()]).toEqual([['c', 3], ['a', 4]])
    expect(readRecent(map, 'b')).toBeUndefined()
  })
})
