import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThreadDetail } from '../../../src/shared/agents'
import { deltaInStepWindow, detailInStepWindow, stepWindowAfterDelta, stepWindowStart } from '../../../src/shared/stepWindow'

const at = (second: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, second)).toISOString()
/** Turns of a question, a run of `runs[i]` steps and an answer, each step a second apart. */
function thread(runs: number[]): AgentThreadDetail {
  const messages: AgentThreadDetail['messages'] = []
  const activities: AgentActivity[] = []
  let clock = 0, sequence = 0
  runs.forEach((steps, turn) => {
    messages.push({ id: `ask-${turn}`, role: 'user', text: 'Go on', createdAt: at(clock++) })
    activities.push({ id: `turn-${turn}`, turnId: `ask-${turn}`, sequence: ++sequence, kind: 'turn', status: 'completed', title: 'Turn' } as AgentActivity)
    for (let step = 0; step < steps; step++) {
      activities.push({ id: `step-${turn}-${step}`, sequence: ++sequence, kind: 'command', status: 'completed', title: 'Ran', startedAt: at(clock++) } as AgentActivity)
    }
    messages.push({ id: `answer-${turn}`, role: 'assistant', text: 'Done', createdAt: at(clock++) })
  })
  return { threadId: 't', revision: 1, messages, activities }
}
const stepIds = (detail: AgentThreadDetail) => detail.activities?.filter(record => record.kind !== 'turn').map(record => record.id)

describe('a phone\'s step window (ADR-0194)', () => {
  it('opens the whole thread when it holds no more steps than the window', () => {
    const detail = thread([2, 3])
    expect(stepWindowStart(detail, 5)).toBeNull()
    const { detail: sent, cut } = detailInStepWindow(detail, null)
    expect(sent).toBe(detail)
    expect(cut).toMatchObject({ start: null, steps: 5 })
  })

  it('holds the newest steps, from the message before the oldest of them, cutting a long run inside', () => {
    const detail = thread([4, 3, 2])
    // The newest four steps reach two into turn 1's run of three, so the window starts at turn 1's question.
    const start = stepWindowStart(detail, 4)
    expect(start).toEqual({ from: 'ask-1', minSequence: 8 })
    const { detail: sent, cut } = detailInStepWindow(detail, start)
    expect(sent.messages.map(message => message.id)).toEqual(['ask-1', 'answer-1', 'ask-2', 'answer-2'])
    expect(stepIds(sent)).toEqual(['step-1-1', 'step-1-2', 'step-2-0', 'step-2-1'])
    // Turn records all stay: the phone reads none as a step.
    expect(sent.activities?.filter(record => record.kind === 'turn')).toHaveLength(3)
    expect(sent).toMatchObject({ earlierAvailable: true, earlierSteps: 5 })
    expect(cut).toMatchObject({ start, steps: 4 })
    expect([...cut.above]).toEqual(['ask-0', 'answer-0'])
  })

  it('places a step after the message it names before going by time', () => {
    const detail = thread([2, 2])
    const late = { ...detail.activities![1]!, afterMessageId: 'answer-0', startedAt: at(0) }
    const named = { ...detail, activities: [detail.activities![0]!, late, ...detail.activities!.slice(2)] }
    // Turn 0's first step now sits after its answer, so a window reaching it starts at that answer, not at the question.
    expect(stepWindowStart(named, 3)?.from).toBe('answer-0')
    expect(stepWindowStart(detail, 3)?.from).toBe('ask-0')
  })

  it('keeps a window\'s start while the thread grows, and gives the whole detail for a start it no longer holds', () => {
    const detail = thread([4, 3, 2])
    const start = stepWindowStart(detail, 4)!
    const grown = thread([4, 3, 4])
    expect(stepIds(detailInStepWindow(grown, start).detail)).toEqual(['step-1-1', 'step-1-2', 'step-2-0', 'step-2-1', 'step-2-2', 'step-2-3'])
    expect(detailInStepWindow(detail, { from: 'gone', minSequence: 1 }).detail).toBe(detail)
  })

  it('leaves out of a delta a record and a message above the window, and keeps the rest', () => {
    const detail = thread([4, 3, 2])
    const { cut } = detailInStepWindow(detail, stepWindowStart(detail, 4))
    const old = detail.activities!.find(record => record.id === 'step-1-0')!
    const fresh = { id: 'step-new', sequence: 99, kind: 'command', status: 'running', title: 'Ran' } as AgentActivity
    const delta = deltaInStepWindow({ threadId: 't', baseRevision: 1, revision: 2,
      messageDeltas: [{ id: 'answer-0', appendText: '!' }, { id: 'answer-2', appendText: '!' }],
      activityDeltas: [{ record: old }, { id: 'step-0-1', removed: true }, { record: fresh }] }, cut)
    expect(delta.messageDeltas).toEqual([{ id: 'answer-2', appendText: '!' }])
    expect(delta.activityDeltas).toEqual([{ id: 'step-0-1', removed: true }, { record: fresh }])
  })

  it('places steps with no times as the iPhone does: after the last question', () => {
    const detail = thread([3, 3])
    const untimed = { ...detail, activities: detail.activities!.map(record => { const { startedAt, ...rest } = record; void startedAt; return rest as AgentActivity }) }
    // With no step times every step sits after turn 1's question, so the window starts there and holds the newest two.
    expect(stepWindowStart(untimed, 2)).toEqual({ from: 'ask-1', minSequence: 7 })
    expect(stepIds(detailInStepWindow(untimed, stepWindowStart(untimed, 2)).detail)).toEqual(['step-1-1', 'step-1-2'])
  })

  it('counts the new steps a delta brings, and nothing else', () => {
    const detail = thread([4, 3, 2])
    const { cut } = detailInStepWindow(detail, stepWindowStart(detail, 4))
    const fresh = { id: 'step-new', sequence: 99, kind: 'command', status: 'running', title: 'Ran' } as AgentActivity
    const changed = { ...detail.activities!.at(-1)!, status: 'failed' } as AgentActivity
    const grown = stepWindowAfterDelta(cut, { threadId: 't', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ record: changed }, { record: fresh }] })
    expect(grown).toMatchObject({ steps: 5, newest: 99 })
    expect(stepWindowAfterDelta(grown, { threadId: 't', baseRevision: 2, revision: 3, messageDeltas: [], activityDeltas: [{ record: fresh }] })).toBe(grown)
  })

  it('places a step under the message it names even when its sequence came after newer steps (#2328)', () => {
    // The Samurai thread's shape: replies each followed by the steps that name them, with the steps of replies 2 to 6
    // given sequences past the newest, as the step cap did (#2330). Read by sequence alone, every renumbered step sat
    // after the last reply, so the window held that reply and nothing above it, and Show earlier added steps under it.
    const messages: AgentThreadDetail['messages'] = [{ id: 'ask', role: 'user', text: 'Go on', createdAt: at(0) }]
    const activities: AgentActivity[] = []
    let sequence = 0
    for (let reply = 0; reply < 10; reply++) {
      messages.push({ id: `m-${reply}`, role: 'assistant', text: 'Working', createdAt: at(1 + reply * 5) })
      for (let step = 0; step < 4; step++) {
        activities.push({ id: `step-${reply}-${step}`, sequence: ++sequence, afterMessageId: `m-${reply}`, kind: 'command', status: 'completed', title: 'Ran', startedAt: at(2 + reply * 5) } as AgentActivity)
      }
    }
    for (const record of activities) if (/^step-[2-6]-/.test(record.id)) (record as { sequence: number }).sequence += 1000
    const detail: AgentThreadDetail = { threadId: 't', revision: 1, messages, activities }
    const start = stepWindowStart(detail, 8)
    expect(start).toEqual({ from: 'm-8', minSequence: 33 })
    const { detail: sent, cut } = detailInStepWindow(detail, start)
    expect(sent.messages.map(message => message.id)).toEqual(['m-8', 'm-9'])
    expect(stepIds(sent)).toEqual(['step-8-0', 'step-8-1', 'step-8-2', 'step-8-3', 'step-9-0', 'step-9-1', 'step-9-2', 'step-9-3'])
    expect(cut.steps).toBe(8)
    // Each press reaches further up: 16 steps start at reply 6, whose steps were renumbered.
    const wider = stepWindowStart(detail, 16)
    expect(wider?.from).toBe('m-6')
    const widened = detailInStepWindow(detail, wider).detail
    expect(widened.messages.map(message => message.id)).toEqual(['m-6', 'm-7', 'm-8', 'm-9'])
    expect(stepIds(widened)).toHaveLength(16)
    // A change to a renumbered step above the window stays out of a delta; one to a step inside it goes through.
    const above = activities.find(record => record.id === 'step-3-0')!
    const inside = activities.find(record => record.id === 'step-9-0')!
    const delta = deltaInStepWindow({ threadId: 't', baseRevision: 1, revision: 2, messageDeltas: [],
      activityDeltas: [{ record: { ...above, status: 'failed' } }, { record: { ...inside, status: 'failed' } }] }, cut)
    expect(delta.activityDeltas.map(item => 'record' in item ? item.record.id : item.id)).toEqual(['step-9-0'])
  })

  it('reads a delta by what the window holds, not by sequence', () => {
    // A step placed by time under the last message has a sequence below the window's oldest, and is inside it.
    const messages: AgentThreadDetail['messages'] = [
      { id: 'ask', role: 'user', text: 'Go on', createdAt: at(0) },
      { id: 'first', role: 'assistant', text: 'Working', createdAt: at(10) },
      { id: 'second', role: 'assistant', text: 'Working', createdAt: at(20) },
      { id: 'third', role: 'assistant', text: 'Working', createdAt: at(30) },
    ]
    const step = (id: string, sequence: number, extra: Partial<AgentActivity>) =>
      ({ id, sequence, kind: 'command', status: 'running', title: 'Ran', ...extra }) as AgentActivity
    const activities = [
      step('timed', 2, { startedAt: at(31) }),
      step('old', 999, { afterMessageId: 'first', startedAt: at(11) }),
      step('named', 1000, { afterMessageId: 'second', startedAt: at(21) }),
    ]
    const detail: AgentThreadDetail = { threadId: 't', revision: 1, messages, activities }
    const start = stepWindowStart(detail, 2)
    expect(start).toEqual({ from: 'second', minSequence: 1000 })
    const { detail: sent, cut } = detailInStepWindow(detail, start)
    expect(stepIds(sent)).toEqual(['timed', 'named'])
    const delta = deltaInStepWindow({ threadId: 't', baseRevision: 1, revision: 2, messageDeltas: [],
      activityDeltas: activities.map(record => ({ record: { ...record, status: 'completed' } as AgentActivity })) }, cut)
    expect(delta.activityDeltas.map(item => 'record' in item ? item.record.id : item.id)).toEqual(['timed', 'named'])
  })

  it('hands a delta on untouched while the phone holds the whole thread', () => {
    const delta = { threadId: 't', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [] }
    expect(deltaInStepWindow(delta, detailInStepWindow(thread([1]), null).cut)).toBe(delta)
  })
})
