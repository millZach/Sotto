// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { markTurnActivity } from '../../../src/main/agents/turnActivity'

describe('turn lifecycle records for providers that report none', () => {
  it('opens a turn once, keeps its start, and settles it without reopening', () => {
    const started = markTurnActivity([], { provider: 'claude', turnId: 'user-1', status: 'running', afterMessageId: 'user-1', at: 1_000 })
    expect(started).toEqual([expect.objectContaining({ id: 'claude-turn-user-1', turnId: 'user-1', kind: 'turn', status: 'running',
      title: 'Working', afterMessageId: 'user-1', startedAt: new Date(1_000).toISOString(), timingSource: 'observed' })])
    expect(started[0]!.completedAt).toBeUndefined()

    const again = markTurnActivity(started, { provider: 'claude', turnId: 'user-1', status: 'running', at: 3_000 })
    expect(again[0]!.startedAt).toBe(new Date(1_000).toISOString())

    const done = markTurnActivity(again, { provider: 'claude', turnId: 'user-1', status: 'completed', at: 5_000 })
    expect(done[0]).toMatchObject({ status: 'completed', title: 'Turn completed', startedAt: new Date(1_000).toISOString(), completedAt: new Date(5_000).toISOString() })
    // A settled turn is history: a late frame cannot put it back to work.
    expect(markTurnActivity(done, { provider: 'claude', turnId: 'user-1', status: 'running', at: 9_000 })).toEqual(done)
  })

  it('keeps each provider and turn apart, and carries a failure message', () => {
    const claude = markTurnActivity([], { provider: 'claude', turnId: 'a', status: 'running', at: 0 })
    const both = markTurnActivity(claude, { provider: 'grok', turnId: 'a', status: 'failed', error: 'Grok stopped answering.', at: 2_000 })
    expect(both.map(record => record.id)).toEqual(['claude-turn-a', 'grok-turn-a'])
    expect(both[1]).toMatchObject({ status: 'failed', title: 'Turn failed', error: 'Grok stopped answering.', completedAt: new Date(2_000).toISOString() })
    expect(markTurnActivity(both, { provider: 'grok', turnId: 'b', status: 'interrupted', at: 3_000 }).at(-1))
      .toMatchObject({ id: 'grok-turn-b', status: 'interrupted', title: 'Turn interrupted' })
  })
})
