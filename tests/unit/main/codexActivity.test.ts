// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'
import { agentThreadSchema, type AgentThread } from '../../../src/shared/agents'
import { MAX_ACTIVITY_TEXT, MAX_AGENT_ACTIVITIES, mergeAgentActivities } from '../../../src/shared/agentActivity'
import { activityItems } from '../../fixtures/codexActivityFixture'

const thread = (): AgentThread => ({ id: 'sotto-thread', projectId: 'project', title: 'Fixture', modelId: 'fixture', status: 'running', requests: [], messages: [{ id: 'original-message', role: 'user', text: 'Do the work', createdAt: '2026-09-12T00:00:00.000Z' }] })
const context = { turnId: 'turn-1', phase: 'started' as const, afterMessageId: 'original-message', startedAtMs: 1_000 }

describe('Codex activity projection', () => {
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

  it('anchors a new turn only to its own first user message, not the previous prompt', () => {
    const t = thread(); const projection = new CodexActivityProjection()
    projection.turn(t, { id: 'new-turn', status: 'inProgress' }, true)
    expect(t.activities?.[0]).not.toHaveProperty('afterMessageId')
    projection.anchor(t, 'new-turn', 'new-message')
    projection.anchor(t, 'new-turn', 'steered-message')
    projection.turn(t, { id: 'new-turn', status: 'completed' }, true)
    expect(t.activities?.[0]?.afterMessageId).toBe('new-message')
  })
})
