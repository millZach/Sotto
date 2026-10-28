// @vitest-environment node
/**
 * What one Claude subagent's launch, start and result cost the activity projector, counted rather than timed, against
 * how many subagents the thread has run before it.
 *
 * Every Claude event runs `ClaudeActivity.apply` on Electron main against the thread's activity window, which holds up to
 * `MAX_AGENT_ACTIVITIES` records and fills after a thousand subagents, two records each. The projector used to read the
 * window about sixteen times per subagent: a map, a reduce and a sort of the whole window in every merge, and a lookup
 * that rebuilt its id for every record it compared. The 5,000-subagent retention test in
 * `tests/unit/main/subagentRetention.test.ts` came within a second of its deadline on Windows CI.
 *
 * This counts the reads of a held record's `id` and `sequence`, and the sorts of more than a handful of records, while
 * the next subagent's three events run, for threads that had run 100, 1,000 and 3,000 subagents before it. It proves
 * three things. Once the window is full the reads do not grow with history (1,000 and 3,000 read the same). They stay
 * within a few passes of the window per subagent, which a merge that maps, reduces and sorts every time does not. And a
 * merge that only updates and appends sorts nothing. It does not prove the work is independent of the window: each merge
 * still reads every held record once, by design, since it keeps no state between calls. The budgets only tighten.
 */
import { describe, expect, it } from 'vitest'
import { ClaudeActivity } from '../../src/main/agents/claudeActivity'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../src/shared/agentActivity'

const timestamp = '2026-09-20T12:00:00.000Z'
/** Reads of a held record's `id` or `sequence`, per held record, the next subagent's three events may make. */
const READS_PER_RECORD = 10
/** A sort of more records than this is a sort of the window rather than of a record's own few agents or steps. */
const SMALL_SORT = 16

function assign(projection: ClaudeActivity, rows: AgentActivity[], index: number): AgentActivity[] {
  const tool = `launch-${index}`
  rows = projection.apply(rows, { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { prompt: `Task ${index}` } }] } }, 'turn', 'message', '/p')
  rows = projection.apply(rows, { type: 'system', subtype: 'task_started', task_id: `task-${index}`, tool_use_id: tool, timestamp }, 'turn', 'message', '/p')
  return projection.apply(rows, { type: 'user', timestamp, tool_use_result: { agentId: `native-${index}`, content: [{ type: 'text', text: 'Done' }] },
    message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'Done' }] } }, 'turn', 'message', '/p')
}

/** What the next subagent's launch, start and result read of the held records, and how many window-sized sorts they make. */
function workForNextSubagent(held: number): { records: number; reads: number; sorts: number } {
  const projection = new ClaudeActivity()
  let rows: AgentActivity[] = []
  for (let index = 0; index < held; index++) rows = assign(projection, rows, index)
  let reads = 0, sorts = 0
  // Count in place, so the projector is given the same list it returned.
  for (const record of rows) for (const key of ['id', 'sequence'] as const) {
    const value = record[key]
    Object.defineProperty(record, key, { enumerable: true, configurable: true, get: () => { reads++; return value } })
  }
  const records = rows.length
  const sort = Array.prototype.sort
  Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    if (this.length > SMALL_SORT) sorts++
    return sort.call(this, compare) as T[]
  }
  try { rows = assign(projection, rows, held) } finally { Array.prototype.sort = sort }
  expect(rows.at(-1)).toMatchObject({ id: 'claude-task-task-' + held, status: 'running' })
  expect(rows.at(-2)).toMatchObject({ id: `claude-tool-launch-${held}`, status: 'completed' })
  return { records, reads, sorts }
}

describe('Claude activity work per subagent', () => {
  it('reads the window a few times per subagent, sorts none of it, and does no more at 3,000 subagents than at 1,000', () => {
    const work = [100, 1_000, 3_000].map(workForNextSubagent)
    expect(work.map(count => count.records)).toEqual([200, MAX_AGENT_ACTIVITIES, MAX_AGENT_ACTIVITIES])
    const report = `reads at 100, 1,000 and 3,000 earlier subagents: ${work.map(count => count.reads).join(', ')}; window sorts: ${work.map(count => count.sorts).join(', ')}`
    expect(work[2]!.reads, report).toBe(work[1]!.reads)
    for (const count of work) {
      expect(count.reads, report).toBeLessThanOrEqual(READS_PER_RECORD * count.records)
      expect(count.sorts, report).toBe(0)
    }
  })
})
