// @vitest-environment node
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MAX_AGENT_ACTIVITIES, findAgentActivity, mergeAgentActivities, type AgentActivity } from '../../../src/shared/agentActivity'

// A list `mergeAgentActivities` returned is merged into by reading only the records named; a copy of it is merged the
// long way. Both must give the same records, so these drive one through many upserts and check each against the other.
let seed = 7
const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
const statuses: AgentActivity['status'][] = ['running', 'unknown', 'completed', 'failed', 'interrupted']
const row = (id: string, extra: Partial<AgentActivity> = {}): AgentActivity => ({ id, turnId: 'turn', sequence: 0, kind: 'tool', title: id, status: pick(statuses),
  ...(random() < 0.3 ? { startedAt: '2026-10-01T00:00:00.000Z', timingSource: 'provider' as const } : {}),
  ...(random() < 0.3 ? { agents: [{ id: `agent-${Math.floor(random() * 4)}`, status: pick(['running', 'completed']), assignmentId: `a-${Math.floor(random() * 2)}` }] } : {}), ...extra })

describe('mergeAgentActivities on a list it returned', () => {
  it('gives the records a full merge gives, through updates, repeats, new records and the bound', () => {
    let fast = mergeAgentActivities([], Array.from({ length: MAX_AGENT_ACTIVITIES - 40 }, (_, index) => row(`r-${index}`)))
    let next = MAX_AGENT_ACTIVITIES - 40
    for (let step = 0; step < 300; step++) {
      const incoming = Array.from({ length: 1 + Math.floor(random() * 4) }, () => random() < 0.4 ? row(`r-${next++}`)
        : row(fast[Math.floor(random() * fast.length)]!.id, random() < 0.5 ? { text: `step ${step}` } : {}))
      if (random() < 0.2) incoming.push({ ...incoming[0]!, status: pick(statuses), output: 'repeated' })
      const same = random() < 0.5 ? isDeepStrictEqual : undefined
      const slow = mergeAgentActivities([...fast], incoming, same)
      const merged = mergeAgentActivities(fast, incoming, same)
      expect(merged).toEqual(slow)
      // With `same`, both keep the list they were given exactly when nothing changed.
      expect(merged === fast).toBe(same !== undefined && isDeepStrictEqual(slow, fast))
      for (const record of incoming) expect(findAgentActivity(merged, record.id)).toBe(merged.find(candidate => candidate.id === record.id))
      fast = merged
    }
    expect(fast).toHaveLength(MAX_AGENT_ACTIVITIES)
    expect(fast[0]!.truncated).toBe(true)
  })

  it('merges a list changed in place the long way', () => {
    const merged = mergeAgentActivities([], [row('a', { status: 'running' }), row('b', { status: 'running' })])
    merged.reverse()
    expect(mergeAgentActivities(merged, [row('a', { status: 'completed' })]).map(record => [record.id, record.status])).toEqual([['a', 'completed'], ['b', 'running']])
    expect(findAgentActivity(merged, 'b')).toBe(merged[0])
  })
})
