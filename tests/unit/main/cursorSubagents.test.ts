// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CursorSubagents } from '../../../src/main/agents/cursorSubagents'

const spawned = (session: string, toolCallId: string, task = 'Draw the car\nIn detail.') =>
  ({ sessionUpdate: 'subagent_spawned', subagentSessionId: session, name: 'generalPurpose', task, capabilities: {}, _meta: { cursor: { toolCallId, agentId: session } } })
const ended = (session: string, state: string) => ({ sessionUpdate: 'subagent_state_update', subagentSessionId: session, state })

describe('CursorSubagents (#2631)', () => {
  it('counts a subagent as background work only once its Task returned while it runs, until its own ending', () => {
    const subagents = new CursorSubagents()
    expect(subagents.apply(spawned('child', 'call_1'), true)).toBe(true)
    expect(subagents.working).toEqual([])
    expect(subagents.running('call_1')).toBe(true)
    subagents.describe('call_1', 'GT3 RS dimensioned drawing')
    expect(subagents.backgrounded('call_1')).toBe(true)
    expect(subagents.working).toMatchObject([{ label: 'GT3 RS dimensioned drawing', type: 'subagent' }])
    expect(subagents.apply(ended('child', 'completed'), true)).toEqual({ toolCallId: 'call_1', ended: 'completed' })
    expect(subagents.working).toEqual([])
    expect(subagents.running('call_1')).toBe(false)
  })

  it('reads a stop as interrupted and a disconnect as an outcome nobody saw, and ignores a state it does not know', () => {
    const subagents = new CursorSubagents()
    subagents.apply(spawned('a', 'call_a'), true); subagents.apply(spawned('b', 'call_b'), true)
    expect(subagents.apply(ended('a', 'running'), true)).toBe(false)
    expect(subagents.apply(ended('a', 'cancelled'), true)).toMatchObject({ ended: 'interrupted' })
    expect(subagents.apply(ended('b', 'disconnected'), true)).toMatchObject({ ended: 'unknown' })
  })

  it('keeps a subagent’s own subagents for their requests, never as the thread’s work', () => {
    const subagents = new CursorSubagents()
    subagents.apply(spawned('child', 'call_1'), true)
    expect(subagents.apply(spawned('grandchild', 'call_inner'), false)).toBe(true)
    expect(subagents.owns('grandchild')).toBe(true)
    expect(subagents.backgrounded('call_inner')).toBe(false)
    expect(subagents.working).toEqual([])
    expect(subagents.apply(ended('grandchild', 'completed'), false)).toBe(true)
    expect(subagents.owns('grandchild')).toBe(false)
    expect(subagents.clear()).toBe(true)
    expect(subagents.owns('child')).toBe(false)
  })
})
