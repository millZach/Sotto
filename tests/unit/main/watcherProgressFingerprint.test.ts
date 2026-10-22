// @vitest-environment node
/**
 * Watcher's progress fingerprint is worked out from what changed rather than from each watched thread's whole history on
 * every pass (#1331). Its value must not change at all: a paired host reports it to the desktop, and every pass compares it
 * with the last, so these pin it to the digest the pass made before, and pin when it is made again and when it is reused.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'
import { observationDigest, targetKey } from '../../../src/main/agents/watcherEvidence'
import { watcherProgressFingerprint } from '../../../src/main/agents/watcherWakeUp'
import { activityBodySize, cutActivityBodies } from '../../../src/shared/activityBodies'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentThread } from '../../../src/shared/agents'

const hashes = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:crypto', async importActual => {
  const actual = await importActual<typeof import('node:crypto')>()
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => { hashes.count++; return actual.createHash(...args) } }
})
afterEach(() => { vi.restoreAllMocks() })

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** The fingerprint exactly as the pass worked it out before #1331, from the whole thread every time. */
function reference(thread: AgentThread): string {
  return sha(JSON.stringify([thread.status, thread.lastTurn, thread.messages.map(message => [message.id, message.text.length]),
    thread.activities?.map(activity => [activity.id, activity.status, activity.startedAt, activity.completedAt, activityBodySize(activity, 'text'), activityBodySize(activity, 'output'), ...activity.cut?.diffs ? [activity.cut.diffs] : [], activity.steps?.map(step => [step.status, step.text.length]), activity.agents?.map(agent => [agent.id, agent.status, agent.progress, agent.message?.length]) ]), thread.subagentSummary, thread.backgroundWork?.map(work => [work.id, work.type]), thread.monitoring?.map(work => work.id), thread.requests.map(card => [card.id, card.kind])]))
}
const at = '2026-10-22T10:00:00.000Z'
const activity = (index: number, extra: Partial<AgentActivity> = {}): AgentActivity => ({ id: `activity-${index}`, turnId: 'turn', sequence: index, kind: 'command',
  status: 'completed', title: 'Synthetic step', output: 'synthetic output', startedAt: at, completedAt: at, ...extra })
const plan = (index: number, text: string): AgentActivity => activity(index, { kind: 'plan', output: undefined, steps: [{ text, status: 'running' }, { text: 'Next', status: 'pending' }] })
const history = (count: number) => Array.from({ length: count }, (_, index) => index % 4 === 0 ? plan(index, 'Plan step') : activity(index))
const thread = (activities: AgentActivity[] | undefined, extra: Partial<AgentThread> = {}): AgentThread => ({ id: 'thread', providerId: 'codex', projectId: 'project',
  modelId: 'model', title: 'Worker', status: 'running', lastTurn: { id: 'turn', status: 'running' }, requests: [],
  messages: [{ id: 'first', role: 'user', text: 'Synthetic prompt', createdAt: at }, { id: 'reply', role: 'assistant', text: 'Synthetic reply', createdAt: at }],
  ...activities ? { activities } : {}, ...extra }) as AgentThread
/** How many hashes `run` made: a fingerprint worked out again makes one, a reused one none. */
function hashed(run: () => void): number { const before = hashes.count; run(); return hashes.count - before }

describe('Watcher progress fingerprint (#1331)', () => {
  it('is the digest it always was, for certified and uncertified history alike', () => {
    const agents: AgentActivity = activity(90, { kind: 'subagent', agents: [{ id: 'agent', status: 'working', message: 'Busy', progress: { total: 3, working: 1, completed: 2, failed: 0, interrupted: 0 } },
      { id: 'other', status: 'done' }] })
    const cut = cutActivityBodies(activity(91, { output: Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n') }))
    const diffs = activity(92, { cut: { diffs: [{ index: 0, bytes: 12 }] } })
    const bare: AgentActivity = { id: 'bare', turnId: 'turn', sequence: 93, kind: 'status', status: 'unknown', title: 'Bare' }
    const records = [...history(30), agents, cut, diffs, bare]
    const sparse = [...records]; delete sparse[3]
    const cases: AgentThread[] = [
      thread(records), thread(immutableActivities(records)), thread(undefined), thread([]), thread(immutableActivities([])), thread(sparse),
      thread(immutableActivities(records), { status: 'idle', lastTurn: undefined, subagentSummary: { total: 2, working: 1, completed: 1, failed: 0, interrupted: 0, unknown: 0 },
        backgroundWork: [{ id: 'work', type: 'subagent' }] as AgentThread['backgroundWork'], monitoring: [{ id: 'watch' }] as AgentThread['monitoring'],
        requests: [{ id: 'card', kind: 'question' }] as unknown as AgentThread['requests'] }),
      // Records an adapter has not certified, inside a certified array's place, are read each time.
      thread([...immutableActivities(records.slice(0, 10)), ...records.slice(10)]),
    ]
    for (const item of cases) {
      expect(watcherProgressFingerprint(item)).toBe(reference(item))
      // Asked again, reused or not, it is the same.
      expect(watcherProgressFingerprint(item)).toBe(reference(item))
    }
  })

  it('is reused while nothing that counts changed', () => {
    const item = thread(immutableActivities(history(500)))
    const first = watcherProgressFingerprint(item)
    expect(hashed(() => expect(watcherProgressFingerprint(item)).toBe(first))).toBe(0)
    // The same facts in new objects, as a shell copy carries them, are the same fingerprint, still reused.
    const copy = { ...item, lastTurn: { ...item.lastTurn! }, messages: item.messages.map(message => ({ ...message })) }
    expect(hashed(() => expect(watcherProgressFingerprint(copy)).toBe(first))).toBe(0)
  })

  it('is worked out again, and differs, exactly when something that counts changed', () => {
    const records = history(500), item = thread(immutableActivities(records))
    let last = watcherProgressFingerprint(item)
    const changes: [string, () => void][] = [
      // Messages are not frozen, and a streamed reply grows in place under the same array.
      ['a message grows', () => { item.messages[1]!.text += ' and more' }],
      ['a message arrives', () => { item.messages.push({ id: 'next', role: 'user', text: 'Synthetic follow-up', createdAt: at }) }],
      ['an activity is replaced', () => { item.activities = immutableActivities([...item.activities!.slice(0, -1), { ...item.activities!.at(-1)!, status: 'failed' }]) }],
      ['a record\'s output grows', () => { item.activities = immutableActivities([...item.activities!.slice(0, -1), { ...item.activities!.at(-1)!, output: 'synthetic output, longer' }]) }],
      ['a step\'s text grows', () => { item.activities = immutableActivities(item.activities!.map(record => record.id === 'activity-0' ? plan(0, 'Plan step, longer') : record)) }],
      ['an activity is added', () => { item.activities = immutableActivities([...item.activities!, activity(500)]) }],
      ['a request card appears', () => { item.requests.push({ id: 'card', kind: 'question' } as unknown as AgentThread['requests'][number]) }],
      ['background work starts', () => { item.backgroundWork = [{ id: 'work', type: 'subagent' }] as AgentThread['backgroundWork'] }],
      ['the turn ends', () => { item.status = 'idle'; item.lastTurn = { id: 'turn', status: 'completed' } }],
    ]
    for (const [change, run] of changes) {
      run()
      let next = ''
      expect(hashed(() => { next = watcherProgressFingerprint(item) }), change).toBe(1)
      expect(next, change).not.toBe(last)
      expect(next, change).toBe(reference(item))
      expect(hashed(() => watcherProgressFingerprint(item)), `${change}, asked again`).toBe(0)
      last = next
    }
  })

  it('a step\'s text that grows only in words of the same length is no progress, as before', () => {
    const before = thread(immutableActivities([plan(0, 'Plan step')])), after = thread(immutableActivities([plan(0, 'Plan stop')]))
    expect(watcherProgressFingerprint(after)).toBe(watcherProgressFingerprint(before))
  })

  it('turns only a new record into JSON when one record of a long history changes', () => {
    const item = thread(immutableActivities(history(2_000)))
    watcherProgressFingerprint(item)
    item.activities = immutableActivities([...item.activities!.slice(0, -1), { ...item.activities!.at(-1)!, output: 'synthetic output, longer' }])
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(watcherProgressFingerprint(item)).toBe(reference(item))
    const records = stringify.mock.calls.filter(([value]) => Array.isArray(value) && typeof value[0] === 'string' && value[0].startsWith('activity-'))
    stringify.mockRestore()
    expect(records).toHaveLength(1)
  })
})

describe('Watcher keys and digests (#1331)', () => {
  it('builds the same target key it always did, however often it is asked', () => {
    const targets = [{ hostId: 'host', threadId: 'thread' }, { hostId: 'host', threadId: 'other' }, { hostId: 'hö"st', threadId: 'thr\\ead' },
      { hostId: undefined, threadId: 'thread' }, { hostId: 'host', threadId: 7 }] as unknown as Parameters<typeof targetKey>[0][]
    for (let round = 0; round < 3; round++) for (const target of targets) expect(targetKey(target)).toBe(JSON.stringify([target.hostId, target.threadId]))
    // Past its bound it lets go of what it kept, and still builds the same keys.
    for (let index = 0; index < 10_050; index++) expect(targetKey({ hostId: 'bulk', threadId: `t-${index}` })).toBe(JSON.stringify(['bulk', `t-${index}`]))
    expect(targetKey(targets[0]!)).toBe('["host","thread"]')
  })

  it('makes the same digest it always did, kept or not', () => {
    const values: unknown[] = [[], ['turn-finished', { hostId: 'host', threadId: 'thread' }, ['turn', 'completed']], 'x'.repeat(2_000), { a: undefined, b: [undefined] }, 0, null]
    for (let round = 0; round < 3; round++) for (const value of values) expect(observationDigest(value)).toBe(sha(JSON.stringify(value)))
    for (let index = 0; index < 4_200; index++) expect(observationDigest(['bulk', index])).toBe(sha(JSON.stringify(['bulk', index])))
    expect(observationDigest(values[1])).toBe(sha(JSON.stringify(values[1])))
    expect(() => observationDigest(undefined)).toThrow()
  })
})
