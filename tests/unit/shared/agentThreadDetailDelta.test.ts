// @vitest-environment node
/**
 * The arithmetic of the detail stream: what a delta may say, what it refuses to say, and what a window
 * holds after applying one.
 */
import { describe, expect, it } from 'vitest'
import { applyAgentThreadDetailDelta, diffAgentThreadDetail, mergeAgentThreadDetailUpdates } from '../../../src/shared/agentThreadDetail'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThreadDetail } from '../../../src/shared/agents'

const message = (id: string, text: string): AgentMessage =>
  ({ id, role: 'assistant', text, createdAt: '2026-01-01T00:00:00.000Z' })
const record = (id: string, patch: Partial<AgentActivity> = {}): AgentActivity =>
  ({ id, turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'npm test', ...patch })
const base = (messages: AgentMessage[], activities?: AgentActivity[]): AgentThreadDetail =>
  ({ threadId: 'workshop', revision: 4, messages, ...(activities === undefined ? {} : { activities }) })

describe('diffing the detail of one thread', () => {
  it('says a streaming message grew by a suffix', () => {
    const held = base([message('a', 'Pick'), message('b', 'Indigo')])
    const delta = diffAgentThreadDetail(held, { messages: [message('a', 'Pick'), message('b', 'Indigo it is.')] }, 5)
    expect(delta).toMatchObject({ baseRevision: 4, revision: 5, messageDeltas: [{ id: 'b', appendText: ' it is.' }] })
  })

  it('sends the whole message when the text was rewritten rather than extended', () => {
    const held = base([message('a', 'Indigo')])
    const delta = diffAgentThreadDetail(held, { messages: [message('a', 'Copper')] }, 5)!
    expect(delta.messageDeltas).toEqual([{ message: message('a', 'Copper') }])
  })

  it('refuses a history whose messages were removed or reordered', () => {
    const held = base([message('a', 'One'), message('b', 'Two')])
    expect(diffAgentThreadDetail(held, { messages: [message('a', 'One')] }, 5)).toBeNull()
    expect(diffAgentThreadDetail(held, { messages: [message('b', 'Two'), message('a', 'One')] }, 5)).toBeNull()
  })

  it('refuses a thread whose activity has appeared or gone away entirely', () => {
    expect(diffAgentThreadDetail(base([]), { messages: [], activities: [record('one')] }, 5)).toBeNull()
    expect(diffAgentThreadDetail(base([], []), { messages: [] }, 5)).toBeNull()
  })

  it('carries an activity record as it now stands, and the id of one that has gone', () => {
    const held = base([], [record('one'), record('two')])
    const delta = diffAgentThreadDetail(held, { messages: [], activities: [record('two', { status: 'completed' })] }, 5)!
    expect(delta.activityDeltas).toEqual([{ id: 'one', removed: true }, { record: record('two', { status: 'completed' }) }])
  })

  it('carries task classification changes without changing the historical identity or status', () => {
    const old = record('agent', { kind: 'subagent', status: 'completed' })
    const held = base([], [old])
    const next = { ...old, taskUpdatesExcluded: true }
    const delta = diffAgentThreadDetail(held, { messages: [], activities: [next] }, 5)!
    expect(delta.activityDeltas).toEqual([{ record: next }])
    expect(applyAgentThreadDetailDelta(held, delta)?.activities).toEqual([next])
  })

  it('copies what it carries, so the snapshot it builds never references the live thread', () => {
    const live = message('a', 'Indigo it is.')
    const delta = diffAgentThreadDetail(base([]), { messages: [live] }, 5)!
    expect(delta.messageDeltas[0]).toEqual({ message: live })
    expect((delta.messageDeltas[0] as { message: AgentMessage }).message).not.toBe(live)
  })
})

describe('applying a delta', () => {
  it('replaces only the message that changed', () => {
    const held = base([message('a', 'Pick'), message('b', 'Indigo')])
    const applied = applyAgentThreadDetailDelta(held, { threadId: 'workshop', baseRevision: 4, revision: 5,
      messageDeltas: [{ id: 'b', appendText: ' it is.' }], activityDeltas: [] })!
    expect(applied.messages[0]).toBe(held.messages[0])
    expect(applied.messages[1]).not.toBe(held.messages[1])
    expect(applied.messages[1]!.text).toBe('Indigo it is.')
    expect(applied.revision).toBe(5)
  })

  it('keeps an updated record in its place and puts a new one at the end', () => {
    const held = base([], [record('one'), record('two')])
    const applied = applyAgentThreadDetailDelta(held, { threadId: 'workshop', baseRevision: 4, revision: 5,
      messageDeltas: [], activityDeltas: [{ record: record('one', { status: 'completed' }) }, { record: record('three') }] })!
    expect(applied.activities!.map(item => item.id)).toEqual(['one', 'two', 'three'])
    expect(applied.activities![1]).toBe(held.activities![1])
  })

  it('refuses a delta measured from another revision or another thread', () => {
    const held = base([message('a', 'Pick')])
    const delta = { threadId: 'workshop', baseRevision: 3, revision: 5, messageDeltas: [], activityDeltas: [] }
    expect(applyAgentThreadDetailDelta(held, delta)).toBeNull()
    expect(applyAgentThreadDetailDelta(held, { ...delta, baseRevision: 4, threadId: 'docs' })).toBeNull()
  })
})

describe('merging two updates for one thread', () => {
  it('makes two appends to one message into one', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [{ id: 'a', appendText: ' one' }], activityDeltas: [] }
    const merged = mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, messageDeltas: [{ id: 'a', appendText: ' two' }] })
    expect(merged).toMatchObject({ baseRevision: 1, revision: 3, messageDeltas: [{ id: 'a', appendText: ' one two' }] })
  })

  it('keeps only the newest state of a record updated twice', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ record: record('one', { output: 'a' }) }] }
    const merged = mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, activityDeltas: [{ record: record('one', { output: 'ab' }) }] })
    expect(merged).toMatchObject({ activityDeltas: [{ record: { output: 'ab' } }] })
  })

  it('will not merge a delta that does not follow the one waiting, or one carrying a removal', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [] }
    expect(mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 7, revision: 8 })).toBeNull()
    expect(mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, activityDeltas: [{ id: 'one', removed: true }] })).toBeNull()
  })
})
