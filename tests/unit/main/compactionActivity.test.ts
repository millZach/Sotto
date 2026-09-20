// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bracketCompaction, markCompactionActivity } from '../../../src/main/agents/compactionActivity'
import type { AgentActivity } from '../../../src/shared/agentActivity'

const work = (id: string): AgentActivity => ({ id, turnId: 't1', sequence: 0, kind: 'command', status: 'completed', title: 'Command' })

describe('recording a compaction', () => {
  it('records the boundary once, with the sizes the provider reported', () => {
    const first = markCompactionActivity([work('cmd')], { provider: 'claude', key: 'uuid-1', turnId: 't1', afterMessageId: 'a1', before: 120_000, after: 30_000, at: 1_000 })
    expect(first.at(-1)).toMatchObject({ id: 'claude-compaction-uuid-1', kind: 'compaction', status: 'completed', title: 'Context compacted',
      turnId: 't1', afterMessageId: 'a1', context: { before: 120_000, after: 30_000 } })
    // Seeing the same boundary again is the same boundary, not a second one.
    const twice = markCompactionActivity(first, { provider: 'claude', key: 'uuid-1', turnId: 't1', before: 120_000, after: 30_000 })
    expect(twice.filter(record => record.kind === 'compaction')).toHaveLength(1)
    expect(twice.at(-1)!.completedAt).toBe(first.at(-1)!.completedAt)
  })

  it('keeps a side the provider did not report out of the record', () => {
    const only = markCompactionActivity([], { provider: 'codex', key: 'item', turnId: 't1' })
    expect(only[0]!.context).toBeUndefined()
    expect(markCompactionActivity([], { provider: 'codex', key: 'item', turnId: 't1', after: 4_000 })[0]!.context).toEqual({ after: 4_000 })
  })
})

describe('bracketing a compaction the provider did not measure', () => {
  const opened = (): AgentActivity[] => bracketCompaction(markCompactionActivity([work('cmd')], { provider: 'codex', key: 'item', turnId: 't1' }), { before: 90_000 })

  it('opens with the latest reading and closes with the first smaller one', () => {
    expect(opened().at(-1)!.context).toEqual({ before: 90_000 })
    expect(bracketCompaction(opened(), { after: 12_000 }).at(-1)!.context).toEqual({ before: 90_000, after: 12_000 })
  })

  it('leaves a reading that did not shrink alone, since it is later growth rather than this result', () => {
    expect(bracketCompaction(opened(), { after: 95_000 }).at(-1)!.context).toEqual({ before: 90_000 })
  })

  it('never invents a bracket where no compaction was recorded, and closes only an open one', () => {
    expect(bracketCompaction([work('cmd')], { before: 90_000 })).toEqual([work('cmd')])
    const closed = bracketCompaction(opened(), { after: 12_000 })
    expect(bracketCompaction(closed, { after: 9_000 }).at(-1)!.context).toEqual({ before: 90_000, after: 12_000 })
  })

  it('brackets the newest boundary when a thread has compacted more than once', () => {
    const second = markCompactionActivity(bracketCompaction(opened(), { after: 12_000 }), { provider: 'codex', key: 'item-2', turnId: 't2' })
    const bracketed = bracketCompaction(bracketCompaction(second, { before: 80_000 }), { after: 10_000 })
    expect(bracketed.filter(record => record.kind === 'compaction').map(record => record.context))
      .toEqual([{ before: 90_000, after: 12_000 }, { before: 80_000, after: 10_000 }])
  })
})
