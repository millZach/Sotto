// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { agentThreadSchema, type AgentThread } from '../../../src/shared/agents'
import { MAX_ACTIVITY_TEXT, MAX_AGENT_ACTIVITIES, mergeAgentActivities } from '../../../src/shared/agentActivity'
import { activityItems } from '../../fixtures/codexActivityFixture'

const thread = (): AgentThread => ({ id: 'sotto-thread', projectId: 'project', title: 'Fixture', modelId: 'fixture', status: 'running', requests: [], messages: [{ id: 'original-message', role: 'user', text: 'Do the work', createdAt: '2026-09-12T00:00:00.000Z' }] })
const context = { turnId: 'turn-1', phase: 'started' as const, afterMessageId: 'original-message', startedAtMs: 1_000 }

describe('Codex activity projection', () => {
  it('ignores unsupported native item payloads without interpreting shared field names as tool output', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    const item = { id: 'future', type: 'futureNativeItem', result: ['opaque'], error: 'opaque', content: 'private', summary: 'opaque' }
    const parsed = codexItemSchema.parse(item)
    expect(parsed).toEqual({ id: item.id, type: item.type })
    projection.item(t, parsed, { ...context, phase: 'completed' })
    expect(t.activities).toBeUndefined()
    expect(t.messages).toHaveLength(1)
  })
  it('shows a generated image as an image step, never reading its result as tool output or keeping it (ADR-0170)', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    const parsed = codexItemSchema.parse({ id: 'image', type: 'imageGeneration', status: 'completed', result: 'SYNTHETIC_IMAGE_RESULT', revisedPrompt: null })
    expect(parsed.result).toBeUndefined()
    projection.item(t, parsed, { ...context, phase: 'completed' })
    expect(t.activities).toEqual([expect.objectContaining({ kind: 'tool', title: 'Image', status: 'completed', generates: 'image' })])
    expect(t.activities?.[0]?.output).toBeUndefined()
    expect(JSON.stringify(t.activities)).not.toContain('SYNTHETIC_IMAGE_RESULT')
  })
  it('upserts lifecycle replay in order, uses authoritative output, and never rewrites messages', () => {
    const t = thread(); const messages = structuredClone(t.messages); const projection = new CodexActivityProjection(() => 2_000)
    projection.item(t, codexItemSchema.parse(activityItems.command), context)
    projection.delta(t, 'item/commandExecution/outputDelta', { turnId: context.turnId, itemId: activityItems.command.id, delta: '2 ' })
    projection.item(t, codexItemSchema.parse(activityItems.change), { ...context, phase: 'completed', completedAtMs: 1_500 })
    projection.item(t, codexItemSchema.parse(activityItems.commandDone), { ...context, phase: 'completed', completedAtMs: 1_800 })
    const expected = structuredClone(t.activities)
    projection.item(t, codexItemSchema.parse(activityItems.command), context)
    projection.delta(t, 'item/commandExecution/outputDelta', { turnId: context.turnId, itemId: activityItems.command.id, delta: 'late replay' })
    projection.item(t, codexItemSchema.parse(activityItems.commandDone), { ...context, phase: 'completed', completedAtMs: 9_000 })
    expect(t.activities).toEqual(expected)
    expect(t.activities?.map(record => record.kind)).toEqual(['command', 'file-change'])
    expect(t.activities?.[0]).toMatchObject({ status: 'completed', output: '2 tests passed\n', durationMs: 800, timingSource: 'provider', afterMessageId: 'original-message' })
    expect(t.messages).toEqual(messages)
    expect(agentThreadSchema.parse(t)).toEqual(t)
  })

  it('streams ordered visible summary parts and replaces them with the native summary without raw reasoning', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.item(t, codexItemSchema.parse({ ...activityItems.reasoning, summary: [] }), context)
    projection.delta(t, 'item/reasoning/summaryTextDelta', { turnId: context.turnId, itemId: activityItems.reasoning.id, summaryIndex: 1, delta: 'Second' })
    projection.delta(t, 'item/reasoning/summaryTextDelta', { turnId: context.turnId, itemId: activityItems.reasoning.id, summaryIndex: 0, delta: 'First' })
    expect(t.activities?.[0]?.text).toBe('First\n\nSecond')
    projection.item(t, codexItemSchema.parse(activityItems.reasoning), { ...context, phase: 'completed' })
    expect(t.activities?.[0]?.text).toBe('Checking the public interface.')
    expect(JSON.stringify(t)).not.toContain('PRIVATE_REASONING')
  })

  it('shows no row for reasoning that came without a summary, and drops one an earlier read kept', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    const wordless = { ...activityItems.reasoning, id: 'wordless', summary: [] }
    projection.item(t, codexItemSchema.parse(wordless), context)
    projection.item(t, codexItemSchema.parse(wordless), { ...context, phase: 'completed' })
    projection.item(t, codexItemSchema.parse(activityItems.command), context)
    expect(t.activities?.map(record => record.kind)).toEqual(['command'])

    // A row streamed summary words keeps them when the finished item carries none.
    projection.delta(t, 'item/reasoning/summaryTextDelta', { turnId: context.turnId, itemId: activityItems.reasoning.id, summaryIndex: 0, delta: 'Streamed' })
    projection.item(t, codexItemSchema.parse({ ...activityItems.reasoning, summary: [] }), { ...context, phase: 'completed' })
    expect(t.activities?.find(record => record.kind === 'reasoning')).toMatchObject({ status: 'completed', text: 'Streamed' })

    // A wordless row an earlier Sotto saved goes when native history is read again.
    const saved = thread(); const reread = new CodexActivityProjection()
    const id = `codex-activity-${createHash('sha256').update(JSON.stringify(['old', 'wordless'])).digest('hex')}`
    // An earlier Sotto kept an empty summary's parts as blank text.
    saved.activities = [{ id, turnId: 'old', sequence: 0, kind: 'reasoning', title: 'Reasoning summary', status: 'completed', text: '\n\n' }]
    reread.item(saved, codexItemSchema.parse(wordless), { turnId: 'old', phase: 'history', terminal: true })
    expect(saved.activities).toEqual([])
  })

  it('retains repeated output chunks, bounds detail, and marks truncation', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.item(t, codexItemSchema.parse(activityItems.command), context)
    for (let i = 0; i < 2; i++) projection.delta(t, 'item/commandExecution/outputDelta', { turnId: context.turnId, itemId: activityItems.command.id, delta: 'repeat\n' })
    expect(t.activities?.[0]?.output).toBe('repeat\nrepeat\n')
    projection.delta(t, 'item/commandExecution/outputDelta', { turnId: context.turnId, itemId: activityItems.command.id, delta: 'x'.repeat(MAX_ACTIVITY_TEXT + 1) })
    expect(t.activities?.[0]?.output!.length).toBeLessThan(MAX_ACTIVITY_TEXT)
    expect(t.activities?.[0]?.truncated).toBe(true)
  })

  it('restores untimed historical work without inventing elapsed time and scopes reused item IDs to turns', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.item(t, codexItemSchema.parse(activityItems.change), { turnId: 'old', phase: 'history' })
    projection.item(t, codexItemSchema.parse(activityItems.change), { turnId: 'new', phase: 'history' })
    expect(new Set(t.activities?.map(record => record.id)).size).toBe(2)
    expect(t.activities?.[0]).not.toHaveProperty('startedAt')
    expect(t.activities?.[0]).not.toHaveProperty('completedAt')
    expect(t.activities?.[0]).not.toHaveProperty('durationMs')
    expect(mergeAgentActivities(t.activities, t.activities)).toEqual(t.activities)
  })

  it('reports subagent lifecycle without leaking routable native thread IDs or creating child messages', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.item(t, codexItemSchema.parse(activityItems.spawn), { ...context, phase: 'completed' })
    expect(t.activities?.[0]?.agents?.[0]?.status).toBe('running')
    expect(projection.childNotification('unrelated', 'turn/completed', { turn: { status: 'completed' } })).toBeUndefined()
    expect(projection.childNotification('native-child', 'turn/completed', { turn: { status: 'failed', error: { message: 'Review failed' } } })).toBe(t)
    expect(t.activities?.[0]?.agents?.[0]).toMatchObject({ status: 'failed', message: 'Review failed' })
    expect(JSON.stringify(t)).not.toContain('native-child')
    expect(t.messages).toHaveLength(1)
  })

  it('keeps provider tool errors and interruption distinct from successful completion', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.item(t, codexItemSchema.parse(activityItems.tool), { ...context, phase: 'completed' })
    projection.item(t, codexItemSchema.parse(activityItems.command), context)
    projection.turn(t, { id: context.turnId, status: 'interrupted' }, true)
    expect(t.activities?.find(record => record.kind === 'tool')).toMatchObject({ status: 'failed', error: 'Fixture resource unavailable' })
    expect(t.activities?.find(record => record.kind === 'command')?.status).toBe('interrupted')
    const unfinished = thread()
    projection.item(unfinished, codexItemSchema.parse(activityItems.command), context)
    projection.turn(unfinished, { id: context.turnId, status: 'completed' }, true)
    expect(unfinished.activities?.find(record => record.kind === 'command')?.status).toBe('unknown')
    projection.delta(unfinished, 'item/commandExecution/outputDelta', { turnId: context.turnId, itemId: activityItems.command.id, delta: 'late' })
    expect(unfinished.activities?.find(record => record.kind === 'command')?.status).toBe('unknown')
  })

  it('does not append an evicted historical prefix after recent activity when native history is reread', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    for (let index = 0; index < MAX_AGENT_ACTIVITIES + 1; index++) projection.item(t, codexItemSchema.parse({ ...activityItems.change, id: `change-${index}` }), { turnId: 'turn', phase: 'history' })
    const before = structuredClone(t.activities)
    projection.item(t, codexItemSchema.parse({ ...activityItems.change, id: 'change-0' }), { turnId: 'turn', phase: 'history' })
    expect(t.activities).toEqual(before)
    expect(t.activities).toHaveLength(MAX_AGENT_ACTIVITIES)
    expect(t.activities?.[0]?.truncated).toBe(true)
  })

  it('places each record where the full merge would, past the bound as well (#352)', () => {
    // The same events on two threads. The second's array is replaced by a copy after every call, so the
    // projection never recognises it and merges every record into the whole list, as it did before #352.
    const placed = thread(), merged = thread()
    const projections = [new CodexActivityProjection(() => 5_000), new CodexActivityProjection(() => 5_000)] as const
    const both = (call: (projection: CodexActivityProjection, t: AgentThread) => void): void => {
      call(projections[0], placed); call(projections[1], merged)
      merged.activities = merged.activities && [...merged.activities]
    }
    // Three records a turn, so the last few turns evict the oldest.
    for (let index = 0; index < 680; index++) {
      const turnId = `turn-${index}`, at = 1_000 + index
      both((projection, t) => projection.turn(t, { id: turnId, status: 'inProgress', startedAt: at }, true))
      both((projection, t) => projection.item(t, codexItemSchema.parse({ ...activityItems.command, id: `command-${index}` }), { turnId, phase: 'started' }))
      both((projection, t) => projection.delta(t, 'item/commandExecution/outputDelta', { turnId, itemId: `command-${index}`, delta: 'ok ' }))
      both((projection, t) => projection.item(t, codexItemSchema.parse({ ...activityItems.reasoning, id: `reasoning-${index}` }), { turnId, phase: 'completed' }))
      both((projection, t) => projection.anchor(t, turnId, `message-${index}`))
      both((projection, t) => projection.item(t, codexItemSchema.parse({ ...activityItems.commandDone, id: `command-${index}` }), { turnId, phase: 'completed', completedAtMs: at * 1000 + 800 }))
      // A late replay of a finished item must not reopen it.
      both((projection, t) => projection.item(t, codexItemSchema.parse({ ...activityItems.command, id: `command-${index}` }), { turnId, phase: 'history' }))
      both((projection, t) => projection.turn(t, { id: turnId, status: 'completed', startedAt: at, completedAt: at + 1 }, true))
      expect(placed.activities).toEqual(merged.activities)
      // An activity snapshot installs a frozen copy on the first thread from time to time, as the adapter does on an
      // emit; its next record takes the full merge, and the ones after it are placed again.
      if (index % 7 === 3) placed.activities = immutableActivities(placed.activities!)
    }
    expect(placed.activities).toHaveLength(MAX_AGENT_ACTIVITIES)
    expect(placed.activities?.[0]?.truncated).toBe(true)
  })

  it('anchors a new turn only to its own first user message, not the previous prompt', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.turn(t, { id: 'new-turn', status: 'inProgress' }, true)
    expect(t.activities?.[0]).not.toHaveProperty('afterMessageId')
    projection.anchor(t, 'new-turn', 'new-message')
    projection.anchor(t, 'new-turn', 'steered-message')
    projection.turn(t, { id: 'new-turn', status: 'completed' }, true)
    expect(t.activities?.[0]?.afterMessageId).toBe('new-message')
  })

  it("reads a sub-agent's own notifications against their shapes, refusing what does not parse and changing nothing", () => {
    let now = 5_000
    const t = thread(); const projection = new CodexActivityProjection(() => now)
    projection.item(t, codexItemSchema.parse(activityItems.spawn), { ...context, phase: 'completed' })
    const before = JSON.stringify(t)
    const nested = { id: 'nested-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['native-grandchild'], agentsStates: { 'native-grandchild': { status: 'running' } } }
    for (const [method, params] of [
      ['item/completed', { item: nested }],
      ['item/completed', { turnId: 'child-turn', item: { ...nested, id: 7 } }],
      ['item/started', { turnId: 'child-turn', item: { id: 'reply', type: 'agentMessage', text: 'Done' } }],
      ['item/completed', { turnId: 'child-turn', item: nested, startedAtMs: 'soon' }],
      ['turn/completed', { turn: { status: 3 } }],
      ['turn/completed', { turn: { status: 'completed', durationMs: -1 } }],
      ['turn/completed', { turn: { status: 'failed', error: { code: 1 } } }],
      ['turn/completed', { status: { type: 1 } }],
      ['thread/status/changed', { status: { type: 'unheardOf' } }],
      ['turn/aborted', { turn: { status: 'completed' } }],
    ] as const) expect(projection.childNotification('native-child', method, params), `${method} ${JSON.stringify(params)}`).toBeUndefined()
    expect(JSON.stringify(t)).toBe(before)

    expect(projection.childNotification('native-child', 'item/completed', { turnId: 'child-turn', item: nested, startedAtMs: 4_000, completedAtMs: null })).toBe(t)
    expect(t.activities?.some(record => record.agents?.some(agent => agent.status === 'running' && agent.id !== t.activities?.[0]?.agents?.[0]?.id))).toBe(true)
    expect(JSON.stringify(t)).not.toContain('native-grandchild')

    now = 6_000
    expect(projection.childNotification('native-child', 'thread/status/changed', { status: { type: 'active' } })).toBe(t)
    expect(t.activities?.[0]?.agents?.[0]?.status).toBe('running')
    expect(projection.childNotification('native-child', 'turn/completed', { turn: { id: 'child-turn', status: 'completed', startedAt: 4, completedAt: 6, durationMs: 1_500 } })).toBe(t)
    expect(t.activities?.[0]?.agents?.[0]).toMatchObject({ status: 'completed', durationMs: 1_500, startedAt: new Date(4_000).toISOString(), completedAt: new Date(6_000).toISOString() })
  })
})
