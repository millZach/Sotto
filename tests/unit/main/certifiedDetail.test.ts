// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread, AgentThreadDetailUpdate } from '../../../src/shared/agents'
import { createAgentControl } from '../../fixtures/agentControlFixture'

const record = (id: string, output = 'first'): AgentActivity => ({ id, turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Synthetic', output, steps: [{ text: 'first', status: 'running' }] })
const thread = (): AgentThread => ({ id: 'thread', projectId: 'project', title: 'Synthetic', modelId: 'fake', status: 'running', messages: [], requests: [], activities: immutableActivities([record('one'), record('two')]) })
function fixture(enabled: boolean) {
  const control = createAgentControl({ directory: '', host: new E2EAgentHost(), credentials: { has: () => false, available: () => false } as never, streamingPublishCost: enabled })
  const detail = control as unknown as { detailRevision(thread: AgentThread): number; detailUpdate(thread: AgentThread, revision: number): AgentThreadDetailUpdate; detailSnapshots: Map<string, { activities?: AgentActivity[] }> }
  return { control, detail, publish(value: AgentThread) { const revision = detail.detailRevision(value); return { revision, update: detail.detailUpdate(value, revision) } } }
}

describe('certified activity detail under the streaming cost gate', () => {
  it('matches stable revisions and payloads through replacements, reorders, trims, resets and certification changes', () => {
    const stable = fixture(false), owl = fixture(true), value = thread()
    const check = () => expect(owl.publish(value)).toEqual(stable.publish(value))
    try {
      check(); check()
      value.activities = immutableActivities([...value.activities!.slice(0, 1), { ...value.activities![1]!, output: 'longer output' }]); check()
      // A same-length text replacement keeps the existing signature trade exactly.
      value.activities = immutableActivities(value.activities!.map(item => ({ ...item, output: item.output!.replace(/./g, 'z') }))); check()
      value.activities = immutableActivities([...value.activities!].reverse()); check()
      value.activities = immutableActivities(value.activities!.slice(0, 1)); check()
      value.activities = structuredClone(value.activities); check()
      value.activities![0]!.steps![0]!.status = 'completed'; check()
      value.activities = immutableActivities(value.activities!); check()
      value.activities = undefined; check()
      value.historyEpoch = 'reset'; value.activities = immutableActivities([]); check()
      value.messages = [{ id: 'reply', role: 'assistant', text: 'First', createdAt: '2026-10-13' }]; check()
      value.messages[0]!.text += ' more'; check()
    } finally { stable.control.dispose(); owl.control.dispose() }
  })

  it('keeps a public whole detail and delta writable without granting either authority over its baseline', () => {
    const f = fixture(true), value = thread()
    try {
      const whole = f.publish(value).update
      if ('messageDeltas' in whole) throw new Error('Expected whole detail')
      whole.activities![0]!.output = 'caller edits'
      expect(f.detail.detailSnapshots.get(value.id)?.activities?.[0]?.output).toBe('first')
      value.activities = immutableActivities([{ ...value.activities![0]!, output: 'longer' }, value.activities![1]!])
      const delta = f.publish(value).update
      if (!('activityDeltas' in delta) || !('record' in delta.activityDeltas[0]!)) throw new Error('Expected record delta')
      delta.activityDeltas[0].record.output = 'caller edits again'
      expect(f.detail.detailSnapshots.get(value.id)?.activities?.[0]?.output).toBe('longer')
    } finally { f.control.dispose() }
  })

  it('does not trust an externally frozen array with mutable nested records', () => {
    const stable = fixture(false), owl = fixture(true), value = thread()
    value.activities = Object.freeze([record('one')]) as unknown as AgentActivity[]
    try {
      expect(owl.publish(value)).toEqual(stable.publish(value))
      value.activities[0]!.steps![0]!.text = 'changed nested words'
      expect(owl.publish(value)).toEqual(stable.publish(value))
    } finally { stable.control.dispose(); owl.control.dispose() }
  })
})
