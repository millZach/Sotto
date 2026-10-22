// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clientAgentState, projectClientAgentState } from '../../../src/shared/clientIdentity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { threadsStateFixture } from '../../fixtures/agentState'

const HOST = '33333333-3333-4333-8333-333333333333'

/** A host's next state as a host builds it: every record new, around values that are the same unless `change` makes them otherwise. */
function rebuilt(state: AgentState, change: (next: AgentState) => void = () => undefined): AgentState {
  const next: AgentState = { ...state, configuration: structuredClone(state.configuration),
    host: { ...structuredClone({ ...state.host, threads: [], models: [] }), models: state.host.models, threads: state.host.threads.map(thread => ({ ...thread, messages: thread.messages.length ? thread.messages : [] })) } }
  change(next)
  return next
}

function hostState(): AgentState {
  const state = threadsStateFixture()
  state.hostId = HOST
  const [first, second] = state.host.threads
  second!.delegatedBy = first!.id
  second!.continuedFrom = { threadId: first!.id } as unknown as NonNullable<AgentThread['continuedFrom']>
  state.threadDrafts = [{ threadId: first!.id, text: 'Draft', attachments: [], revision: 1 }] as unknown as AgentState['threadDrafts']
  state.busyThreadIds = [first!.id]
  return state
}

/** The same values under the same names in the same order as projecting the state alone gives. */
function expectFresh(projected: AgentState, state: AgentState): void {
  const fresh = clientAgentState(state)
  expect(projected).toStrictEqual(fresh)
  expect(JSON.stringify(projected)).toBe(JSON.stringify(fresh))
}

/** Whether a thread's record holds what the earlier one did: the same fields with the same values, or messages empty in both. */
function sameRecord(earlier: AgentThread | undefined, later: AgentThread): boolean {
  if (!earlier || Object.keys(earlier).length !== Object.keys(later).length) return false
  return Object.entries(later).every(([name, value]) => (earlier as unknown as Record<string, unknown>)[name] === value
    || name === 'messages' && Array.isArray(value) && value.length === 0 && earlier.messages.length === 0)
}

describe('projecting a host again (#1335)', () => {
  it('reuses every part of a host state that holds the same values, with the values a fresh projection gives', () => {
    const state = hostState(), first = projectClientAgentState(state)
    expectFresh(first.output, state)
    const next = rebuilt(state), again = projectClientAgentState(next, first)
    expectFresh(again.output, next)
    expect(again.output.host.threads).toBe(first.output.host.threads)
    expect(again.output.configuration).toBe(first.output.configuration)
    expect(again.output.threadDrafts).toBe(first.output.threadDrafts)
    expect(again.output.host.projects).toBe(first.output.host.projects)
    expect(again.output.host.capabilities).toBe(first.output.host.capabilities)
    expect(again.output.host.models).toBe(state.host.models)
    // The same state handed again is the same projection.
    expect(projectClientAgentState(next, again)).toBe(again)
  })

  it('reuses nothing from a projection of another host', () => {
    const state = hostState(), first = projectClientAgentState(state)
    const other = { ...rebuilt(state), hostId: '44444444-4444-4444-8444-444444444444' }
    const elsewhere = projectClientAgentState(other, first)
    expectFresh(elsewhere.output, other)
    expect(elsewhere.output.host.threads[0]).not.toBe(first.output.host.threads[0])
    expect(elsewhere.output.activeThreadId).not.toBe(first.output.activeThreadId)
  })

  it.each<[string, (next: AgentState) => void]>([
    ['a thread title', next => { next.host.threads[2] = { ...next.host.threads[2]!, title: 'Renamed' } }],
    ['a thread project', next => { next.host.threads[0] = { ...next.host.threads[0]!, projectId: next.host.projects[1]!.id } }],
    ['the thread that delegated to one', next => { next.host.threads[1] = { ...next.host.threads[1]!, delegatedBy: next.host.threads[2]!.id } }],
    ['a thread field that is gone', next => { const { delegatedBy: _gone, ...rest } = next.host.threads[1]!; void _gone; next.host.threads[1] = rest }],
    ['a thread field that is new', next => { next.host.threads[0] = { ...next.host.threads[0]!, finishedUnread: true } as AgentThread }],
    ['a thread field set to undefined', next => { next.host.threads[0] = { ...next.host.threads[0]!, delegatedBy: undefined } }],
    ['thread messages', next => { next.host.threads[0] = { ...next.host.threads[0]!, messages: [{ id: 'm', role: 'user', text: 'Hello', createdAt: '2026-10-22T00:00:00.000Z' }] } }],
    ['a new thread first', next => { next.host.threads.unshift({ ...next.host.threads[0]!, id: 'new-thread', title: 'New' }) }],
    ['a thread gone', next => { next.host.threads.splice(1, 1) }],
    ['the threads in another order', next => { next.host.threads.reverse() }],
    ['a project title', next => { next.host.projects[0] = { ...next.host.projects[0]!, title: 'Renamed project' } }],
    ['a project gone', next => { next.host.projects.pop() }],
    ['the selected thread', next => { next.activeThreadId = next.host.threads[3]!.id }],
    ['the selected project', next => { next.activeProjectId = next.host.projects[1]!.id }],
    ['a draft thread', next => { next.threadDrafts = [{ ...next.threadDrafts![0]!, threadId: next.host.threads[2]!.id }] }],
    ['the busy threads', next => { next.busyThreadIds = [next.host.threads[2]!.id, next.host.threads[3]!.id] }],
    ['a setting', next => { next.configuration = { ...next.configuration, defaultModelId: 'claude:opus' } }],
    ['a nested host field', next => { next.host.capabilities = { ...next.host.capabilities, interrupt: false } }],
    ['fields that are new', next => { next.composing = true; next.draftThreadId = next.host.threads[0]!.id }],
    ['a field that is gone', next => { delete next.threadDrafts }],
    ['the host name and ID', next => { next.host = { ...next.host, hostId: HOST, name: 'Renamed host' } }],
  ])('shows %s as a fresh projection does, and keeps every thread that did not change', (_name, change) => {
    const state = hostState(), first = projectClientAgentState(state)
    const next = rebuilt(state, change), again = projectClientAgentState(next, first)
    expectFresh(again.output, next)
    const before = new Map(first.output.host.threads.map(thread => [thread.id, thread]))
    const sources = new Map(state.host.threads.map(thread => [thread.id, thread]))
    for (const [position, thread] of next.host.threads.entries()) {
      const output = again.output.host.threads[position]!
      if (sameRecord(sources.get(thread.id), thread)) expect(output).toBe(before.get(output.id))
      else expect(output).not.toBe(before.get(output.id))
    }
    // Each later projection measures from the one before it.
    const third = rebuilt(next), last = projectClientAgentState(third, again)
    expectFresh(last.output, third)
    expect(last.output.host.threads).toBe(again.output.host.threads)
  })
})
