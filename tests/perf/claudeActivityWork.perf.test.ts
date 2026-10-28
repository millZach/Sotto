// @vitest-environment node
/**
 * What one Claude subagent's launch, start and result cost the activity projector, counted rather than timed, against
 * how many subagents the thread has run before it.
 *
 * Every Claude event runs `ClaudeActivity.apply` on Electron main. A thread keeps up to `MAX_AGENT_ACTIVITIES` records,
 * and each subagent adds two, so the window fills after a thousand subagents. The projector used to look records up
 * with a scan of the window and merge by rebuilding, reducing and sorting it, so every event read every record: about
 * a millisecond per subagent once the window was full, and the 5,000-subagent retention test in
 * `tests/unit/main/subagentRetention.test.ts` came within a second of its deadline on Windows CI. This counts how many
 * times the next subagent's three events read a held record's `id` or `sequence`, for threads that held 100, 1,000 and
 * 3,000 subagents before it. Once the window is full the count must not grow with them, and it stays within a budget sized
 * for the records those events name and the oldest ones they push out. The budget only tightens.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../src/main/agents/claudeActivity'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'

const timestamp = '2026-09-20T12:00:00.000Z'
/** Reads of held records' `id` and `sequence` the next subagent's three events may make. */
const BUDGET = 8

function assign(projection: ClaudeActivity, rows: AgentActivity[], index: number): AgentActivity[] {
  const tool = `launch-${index}`
  rows = projection.apply(rows, { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { prompt: `Task ${index}` } }] } }, 'turn', 'message', '/p')
  rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: `task-${index}`, tool_use_id: tool, timestamp }, 'turn', 'message', '/p')
  return projection.apply(rows, { type: 'user', timestamp, tool_use_result: { agentId: `native-${index}`, content: [{ type: 'text', text: 'Done' }] },
    message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'Done' }] } }, 'turn', 'message', '/p')
}

/** Reads of the held records' `id` and `sequence` while the next subagent is launched, started and finished. */
function readsForNextSubagent(held: number): { records: number; reads: number } {
  const projection = new ClaudeActivity()
  let rows: AgentActivity[] = []
  for (let index = 0; index < held; index++) rows = assign(projection, rows, index)
  let reads = 0
  // Count in place, so the list keeps its identity and the projector sees the same list it returned.
  for (const record of rows) for (const key of ['id', 'sequence'] as const) {
    const value = record[key]
    Object.defineProperty(record, key, { enumerable: true, configurable: true, get: () => { reads++; return value } })
  }
  const records = rows.length
  rows = assign(projection, rows, held)
  expect(rows.at(-1)).toMatchObject({ id: 'claude-task-task-' + held, status: 'running' })
  expect(rows.at(-2)).toMatchObject({ id: `claude-tool-launch-${held}`, status: 'completed' })
  return { records, reads }
}

describe('Claude activity work per subagent', () => {
  it('reads the same few held records however many subagents the thread has run', () => {
    const counts = [100, 1_000, 3_000].map(readsForNextSubagent)
    expect(counts.map(count => count.records)).toEqual([200, MAX_AGENT_ACTIVITIES, MAX_AGENT_ACTIVITIES])
    const reads = counts.map(count => count.reads)
    const report = `reads at 100, 1,000 and 3,000 earlier subagents: ${reads.join(', ')}`
    // A full window drops its oldest records as the new ones arrive, which reads those it drops; that is the same at any history.
    expect(reads[2], report).toBe(reads[1])
    for (const count of reads) expect(count, report).toBeLessThanOrEqual(BUDGET)
  })
})
