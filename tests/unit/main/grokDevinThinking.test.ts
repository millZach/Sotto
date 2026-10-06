// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEVIN_THINKING_ID_PREFIX, devinActivities } from '../../../src/main/agents/devinActivity'
import { grokActivities, keepStreamedThinking } from '../../../src/main/agents/grokActivity'
import { settledThinking, thinkingSettledAs } from '../../../src/main/agents/thinkingActivity'
import { agentActivitySchema, MAX_ACTIVITY_TEXT, mergeAgentActivities, type AgentActivity } from '../../../src/shared/agentActivity'

/**
 * ACP `agent_thought_chunk` updates in the shape Grok Build's own session history keeps them (read from a history
 * written by 1.0.44; the 1.0.46 binary names the same update and `_meta` fields), and as Devin 3000.10.31's protocol
 * schema names them. No live Grok run was made. Every word here is invented for the test.
 */
const context = { turnId: 'user-1', afterMessageId: 'user-1', cwd: '/project' }
const thought = (text: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, ...extra })
const reply = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const reasoning = (rows: readonly AgentActivity[]) => rows.filter(row => row.kind === 'reasoning')

type Project = (update: Record<string, unknown>, rows: AgentActivity[]) => AgentActivity[]
const feed = (project: Project, updates: readonly Record<string, unknown>[], rows: AgentActivity[] = []): AgentActivity[] => {
  for (const update of updates) rows = mergeAgentActivities(rows, project(update, rows))
  return rows
}

describe('Grok thinking as it streams', () => {
  const stream = { promptId: 'prompt-1', streamStartMs: 1_000 }
  const live: Project = (update, rows) => grokActivities(update, context, rows, true, stream)

  it('starts a Thinking row with the first thought chunk and grows it until the reply begins', () => {
    let rows = feed(live, [thought('Look at ')])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ id: 'grok-thinking-prompt-1-1000', kind: 'reasoning', title: 'Thinking', status: 'running', text: 'Look at ', afterMessageId: 'user-1', timingSource: 'observed' })])
    expect(reasoning(rows)[0]!.cwd).toBeUndefined()
    rows = feed(live, [thought('the tests.')], rows)
    expect(reasoning(rows)).toEqual([expect.objectContaining({ status: 'running', text: 'Look at the tests.' })])
    rows = feed(live, [reply('Done.')], rows)
    expect(reasoning(rows)).toEqual([expect.objectContaining({ status: 'completed', text: 'Look at the tests.', completedAt: expect.any(String) })])
    for (const row of rows) expect(agentActivitySchema.safeParse(row).success).toBe(true)
  })

  it('comes before the tool the thought led to, and a new stream thinks on a row of its own', () => {
    let rows = feed(live, [thought('Run it.'), { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Run', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } }])
    rows = feed((update, previous) => grokActivities(update, context, previous, true, { ...stream, streamStartMs: 2_000 }), [thought('Read the output.')], rows)
    expect(rows.map(row => [row.kind, row.status])).toEqual([['reasoning', 'completed'], ['command', 'running'], ['reasoning', 'running']])
  })

  it('reads the same row back from history, where Grok has joined the chunks into one', () => {
    const shown = feed(live, [thought('Look at '), thought('the tests.'), reply('Done.')])
    const history = feed((update, rows) => grokActivities(update, context, rows, false, stream), [thought('Look at the tests.'), reply('Done.')])
    expect(reasoning(history)).toEqual([expect.objectContaining({ id: reasoning(shown)[0]!.id, status: 'completed', text: 'Look at the tests.' })])
    expect(reasoning(history)[0]!.startedAt).toBeUndefined()
  })

  it('keeps the words the stream showed when a history read trails it', () => {
    const shown = feed(live, [thought('Look at '), thought('the tests.')])
    const lagging = feed((update, rows) => grokActivities(update, context, rows, false, stream), [thought('Look at ')])
    const merged = mergeAgentActivities(shown, keepStreamedThinking(lagging, shown))
    expect(reasoning(merged)[0]!.text).toBe('Look at the tests.')
    // A further chunk goes on after what was shown, not after what history had.
    expect(reasoning(feed(live, [thought(' Then fix.')], merged))[0]!.text).toBe('Look at the tests. Then fix.')
  })

  it('settles a thought the turn ended on: completed when the turn finished, interrupted when it was stopped or failed', () => {
    const ended = (stop_reason: string) => reasoning(feed(live, [thought('Half'), { sessionUpdate: 'turn_completed', stop_reason }]))[0]!.status
    expect(ended('end_turn')).toBe('completed')
    expect(ended('cancelled')).toBe('interrupted')
    expect(ended('max_tokens')).toBe('interrupted')
  })

  it('falls back to one row per run of thought chunks when Grok names no stream', () => {
    const bare: Project = (update, rows) => grokActivities(update, context, rows, true)
    const rows = feed(bare, [thought('One. '), thought('Still one.'), reply('Reply.'), thought('Two.')])
    expect(reasoning(rows).map(row => [row.text, row.status])).toEqual([['One. Still one.', 'completed'], ['Two.', 'running']])
  })

  it('cuts long thinking at the record’s detail budget and says so', () => {
    const half = 'x'.repeat(MAX_ACTIVITY_TEXT / 2 + 10)
    const rows = feed(live, [thought(half), thought(half)])
    expect(reasoning(rows)[0]!.text).toHaveLength(MAX_ACTIVITY_TEXT)
    expect(reasoning(rows)[0]!.truncated).toBe(true)
  })
})

describe('Devin thinking as it streams', () => {
  const live: Project = (update, rows) => devinActivities(update, context, rows, true)

  it('starts a Thinking row with the first thought chunk and settles it when the reply begins', () => {
    let rows = feed(live, [thought('Check '), thought('the plan.')])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ kind: 'reasoning', title: 'Thinking', status: 'running', text: 'Check the plan.', afterMessageId: 'user-1' })])
    expect(reasoning(rows)[0]!.cwd).toBeUndefined()
    rows = feed(live, [reply('Done.')], rows)
    expect(reasoning(rows)[0]).toMatchObject({ status: 'completed', completedAt: expect.any(String) })
    for (const row of rows) expect(agentActivitySchema.safeParse(row).success).toBe(true)
  })

  it('keeps a thought apart from the tool it led to and from the next thought', () => {
    const rows = feed(live, [thought('Run it.'), { sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', title: 'Run', status: 'in_progress', rawInput: { command: 'ls' } }, thought('Read it.')])
    expect(rows.map(row => [row.kind, row.status])).toEqual([['reasoning', 'completed'], ['command', 'running'], ['reasoning', 'running']])
    expect(new Set(rows.map(row => row.id)).size).toBe(3)
  })

  it('uses the message ACP names, when it names one', () => {
    const rows = feed(live, [thought('A', { messageId: 'm-1' }), thought('B', { messageId: 'm-1' }), thought('C', { messageId: 'm-2' })])
    expect(reasoning(rows).map(row => [row.id, row.text, row.status])).toEqual([['devin-thinking-user-1-m-1', 'AB', 'completed'], ['devin-thinking-user-1-m-2', 'C', 'running']])
  })

  it('settles a thought the turn ended on the way Grok and Claude do', () => {
    const rows = feed(live, [thought('Last words')])
    const ended = (turn: AgentActivity['status']) => reasoning(mergeAgentActivities(rows, settledThinking(DEVIN_THINKING_ID_PREFIX, rows, thinkingSettledAs(turn), true)))[0]!.status
    expect(ended('completed')).toBe('completed')
    expect(ended('interrupted')).toBe('interrupted')
    expect(ended('failed')).toBe('interrupted')
  })

  it('shows a thought with no words as the row without text', () => {
    const rows = feed(live, [thought('')])
    expect(reasoning(rows)).toEqual([expect.objectContaining({ title: 'Thinking', status: 'running' })])
    expect(reasoning(rows)[0]!.text).toBeUndefined()
  })
})
