import { describe, expect, it } from 'vitest'
import { watcherProgressFingerprint } from '../../../src/main/agents/watcherWakeUp'
import { cutActivityBodies } from '../../../src/shared/activityBodies'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread } from '../../../src/shared/agents'

const lines = (count: number): string => Array.from({ length: count }, (_, index) => `line ${index}`.padEnd(40, '.')).join('\n')
const thread = (activities: AgentActivity[]) => ({ id: 'thread', status: 'running', messages: [], requests: [], activities }) as unknown as AgentThread
const command = (output: string): AgentActivity => ({ id: 'build', turnId: 'turn', sequence: 0, kind: 'command', status: 'running', title: 'Run the build', output })

describe('Watcher progress over cut bodies (ADR-0025, October 18 amendment)', () => {
  it('counts output growing on the host as progress though the kept end is the same length', () => {
    const before = cutActivityBodies(command(lines(200) + '\n' + 'tail'.padEnd(40, '.')))
    const after = cutActivityBodies(command(lines(220) + '\n' + 'tail'.padEnd(40, '.')))
    expect(before.output!.length).toBe(after.output!.length)
    expect(watcherProgressFingerprint(thread([before]))).not.toBe(watcherProgressFingerprint(thread([after])))
  })

  it('reads a thread with no cut body as it always did', () => {
    expect(watcherProgressFingerprint(thread([command('ok')]))).toBe(watcherProgressFingerprint(thread([command('no')])))
  })
})
