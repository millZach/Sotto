import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { CodexActivityProjection, codexItemSchema } from '../../../src/main/agents/codexActivity'

// A Codex fork carries its source's own turn and item IDs, and its history names the source's agents (#1028). What
// Sotto keys by those IDs is kept per thread, so a fork never takes over its source's agents or turns.

const spawned = (kind: string, id: string) => codexItemSchema.parse({ id, type: 'subAgentActivity', kind, agentThreadId: 'native-child', agentPath: '/root/stream_perf' })
const thread = (id: string) => ({ id, messages: [], activities: [] as AgentActivity[] })
const agents = (conversation: ReturnType<typeof thread>) => conversation.activities.flatMap(record => record.agents ?? [])

describe('a fork keeps its source\'s agents its source\'s', () => {
  it('leaves the agent\'s own notifications with the thread that saw it live', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const source = thread('source'), fork = thread('fork')
    projection.item(source, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'completed' })
    // The fork reads the same items from its copied history.
    projection.item(fork, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'history' })
    now = 2_000
    expect(projection.childNotification('native-child', 'turn/completed', { turn: { id: 'child-turn', status: 'completed' } })).toBe(source)
    expect(agents(source).at(-1)).toMatchObject({ status: 'completed' })
    expect(agents(fork).at(-1)).toMatchObject({ status: 'running' })
  })

  it('finds an agent in the history of the thread asking, under the same roster identity in each', () => {
    const projection = new CodexActivityProjection(() => 1_000)
    const source = thread('source'), fork = thread('fork'), other = thread('other')
    projection.item(source, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'completed' })
    projection.item(fork, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'history' })
    const roster = agents(source)[0]!.id
    expect(agents(fork)[0]!.id).toBe(roster)
    expect(projection.agentThread(source, roster)).toBe('native-child')
    expect(projection.agentThread(fork, roster)).toBe('native-child')
    // A thread whose history does not name the agent has none to continue.
    expect(projection.agentThread(other, roster)).toBeUndefined()
    expect(projection.agentThread(source, 'codex-agent-unknown')).toBeUndefined()
  })

  it('reads each thread\'s copy of an agent from that thread alone', () => {
    let now = 1_000
    const projection = new CodexActivityProjection(() => now)
    const source = thread('source'), fork = thread('fork')
    projection.item(source, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'completed' })
    now = 2_000
    projection.item(source, spawned('completed', 'subagent-completed-1'), { turnId: 'turn-2', phase: 'completed' })
    // A fork at the first turn carries the start and not the finish: the source's later finish is not the fork's.
    projection.item(fork, spawned('started', 'call-spawn'), { turnId: 'turn-1', phase: 'history' })
    expect(agents(source)[0]).toMatchObject({ status: 'completed' })
    expect(agents(fork)).toHaveLength(1)
    expect(agents(fork)[0]).toMatchObject({ status: 'running' })
  })
})
