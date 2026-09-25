import { describe, expect, it } from 'vitest'

import { approximateDetailBytes } from '../../../src/renderer/src/agents/detailCacheSize'
import type { AgentThreadDetail } from '../../../src/shared/agents'

describe('the approximate size of held histories', () => {
  it('counts two bytes a character for keys and strings across every message of every history', () => {
    const detail = (threadId: string, text: string): AgentThreadDetail =>
      ({ threadId, revision: 1, messages: [{ id: 'a', role: 'user', text, createdAt: 'x' }] })
    // id + a, role + user, text + hi, createdAt + x: (2 + 1) + (4 + 4) + (4 + 2) + (9 + 1) characters.
    expect(approximateDetailBytes([detail('one', 'hi')])).toBe(27 * 2)
    // Only the histories' records are counted, not the thread ID or revision beside them.
    expect(approximateDetailBytes([detail('one', 'hi'), detail('two', 'hello')])).toBe(27 * 2 + 30 * 2)
    expect(approximateDetailBytes([])).toBe(0)
  })

  it('counts numbers, booleans and nested records in activity', () => {
    const detail = {
      threadId: 'one', revision: 1, messages: [],
      activities: [{ id: 'b', count: 3, done: true, parts: ['cd'], missing: null }],
    } as unknown as AgentThreadDetail
    // id + b, count + 8, done + 4, parts + cd, missing + nothing.
    expect(approximateDetailBytes([detail])).toBe((2 + 1) * 2 + 5 * 2 + 8 + 4 * 2 + 4 + (5 + 2) * 2 + 7 * 2)
  })
})
