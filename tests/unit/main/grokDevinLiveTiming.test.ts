import { describe, expect, it } from 'vitest'
import { mergeAgentActivities } from '../../../src/shared/agentActivity'
import { grokActivities } from '../../../src/main/agents/grokActivity'
import { devinActivities } from '../../../src/main/agents/devinActivity'

/**
 * Neither a Grok nor a Devin tool update carries a time of its own, so without an observed start a running
 * command has no time at all and nothing downstream can say how long it has run. A replayed update must
 * still be given no clock it never had.
 */
const context = { turnId: 'turn-1', cwd: 'C:/repo' }
const grokRunning = { sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', title: 'Run', status: 'in_progress', rawInput: { command: 'npm test' } }
const devinRunning = { sessionUpdate: 'tool_call', toolCallId: 'exec', kind: 'execute', title: 'Run', status: 'in_progress', rawInput: { command: 'npm test' } }

describe('timing a live Grok Build command', () => {
  it('starts a running row at the moment Sotto received the update, and says Sotto timed it', () => {
    const before = Date.now()
    const row = grokActivities(grokRunning, context, [], true)[0]!
    expect(row.status).toBe('running')
    expect(row.timingSource).toBe('observed')
    expect(Date.parse(row.startedAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(row.startedAt!)).toBeLessThanOrEqual(Date.now())
  })

  it('leaves a replayed update without a start rather than inventing one', () => {
    const row = grokActivities(grokRunning, context, [], false)[0]!
    expect(row.startedAt).toBeUndefined()
    expect(row.timingSource).toBeUndefined()
  })

  it('keeps the first start across later updates for the same tool', () => {
    const first = grokActivities(grokRunning, context, [], true)
    const again = mergeAgentActivities(first, grokActivities(grokRunning, context, first, true))
    // The row already carries a start, and the activity merge keeps the first one it saw, so a redelivered
    // update cannot restart the clock.
    expect(again[0]!.id).toBe(first[0]!.id)
    expect(again[0]!.startedAt).toBe(first[0]!.startedAt)
  })

  it('gives no start to a row that never ran under Sotto', () => {
    const row = grokActivities({ ...grokRunning, status: 'completed', rawOutput: { exitCode: 0 } }, context, [], true)[0]!
    expect(row.status).toBe('completed')
    expect(row.startedAt).toBeUndefined()
  })
})

describe('timing a live Devin command', () => {
  it('starts a running row at the moment Sotto received the update, and says Sotto timed it', () => {
    const before = Date.now()
    const row = devinActivities(devinRunning, context, [], true)[0]!
    expect(row.status).toBe('running')
    expect(row.timingSource).toBe('observed')
    expect(Date.parse(row.startedAt!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(row.startedAt!)).toBeLessThanOrEqual(Date.now())
  })

  it('leaves a replayed update without a start rather than inventing one', () => {
    const row = devinActivities(devinRunning, context, [], false)[0]!
    expect(row.startedAt).toBeUndefined()
    expect(row.timingSource).toBeUndefined()
  })

  it('keeps the first start across later updates for the same tool', () => {
    const first = devinActivities(devinRunning, context, [], true)
    const again = mergeAgentActivities(first, devinActivities(devinRunning, context, first, true))
    expect(again[0]!.id).toBe(first[0]!.id)
    expect(again[0]!.startedAt).toBe(first[0]!.startedAt)
  })

  it('gives no start to a row that never ran under Sotto', () => {
    const row = devinActivities({ ...devinRunning, status: 'completed', rawOutput: { exit_code: 0 } }, context, [], true)[0]!
    expect(row.status).toBe('completed')
    expect(row.startedAt).toBeUndefined()
  })
})
