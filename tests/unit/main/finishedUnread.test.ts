// @vitest-environment node
/**
 * The rules for a thread that finished while no client showed it (ADR-0046), on snapshots built by hand. The
 * coordinator around them, its persistence and the socket are in finishedUnreadControl.test.ts and tests/integration/socketClientIsolation.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { FINISHED_UNREAD_MAX, FinishedUnread } from '../../../src/main/agents/finishedUnread'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

type Shape = Partial<Pick<AgentThread, 'status' | 'backgroundWork' | 'clientConnected' | 'providerId'>>

function thread(id: string, shape: Shape = {}): AgentThread {
  return { id, title: id, projectId: 'project', modelId: 'model', status: 'idle', messages: [], requests: [], ...shape }
}
function snapshot(threads: AgentThread[], extra: Partial<AgentHostSnapshot> = {}): AgentHostSnapshot {
  return { ...structuredClone(EMPTY_AGENT_HOST), connected: true, threads, ...extra }
}
const running = (id: string, shape: Shape = {}): AgentThread => thread(id, { status: 'running', ...shape })
const agentWork = [{ id: 'build', label: 'Build', type: 'workflow' as const }]

describe('a thread that finishes out of sight', () => {
  it('earns the mark when a running turn ends while nothing shows it', () => {
    const marks = new FinishedUnread()
    expect(marks.track(snapshot([running('a'), thread('b')]))).toBe(false)
    expect(marks.track(snapshot([thread('a'), thread('b')]))).toBe(true)
    expect(marks.has('a')).toBe(true)
    // A thread that was idle all along finished nothing.
    expect(marks.has('b')).toBe(false)
    expect(marks.saved()).toEqual(['a'])
  })

  it('earns it only once background work the turn started has ended too', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a')]))
    marks.track(snapshot([thread('a', { backgroundWork: agentWork })]))
    expect(marks.has('a')).toBe(false)
    marks.track(snapshot([thread('a')]))
    expect(marks.has('a')).toBe(true)
  })

  it('never marks a thread that is shown when it finishes, and leaving it afterwards does not mark it after the fact', () => {
    const marks = new FinishedUnread()
    marks.show(['a'])
    marks.track(snapshot([running('a')]))
    marks.track(snapshot([thread('a')]))
    expect(marks.has('a')).toBe(false)
    marks.show([])
    marks.track(snapshot([thread('a')]))
    expect(marks.has('a')).toBe(false)
  })

  it('clears the mark when a client shows the thread', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a'), running('b')]))
    marks.track(snapshot([thread('a'), thread('b')]))
    expect(marks.show(['a'])).toBe(true)
    expect(marks.has('a')).toBe(false)
    expect(marks.has('b')).toBe(true)
    // Showing it again, or showing nothing, changes nothing.
    expect(marks.show(['a'])).toBe(false)
    expect(marks.show([])).toBe(false)
  })

  it('drops the mark when the thread works again or its turn fails, and earns it again on the next finish', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a')]))
    marks.track(snapshot([thread('a')]))
    expect(marks.track(snapshot([running('a')]))).toBe(true)
    expect(marks.has('a')).toBe(false)
    marks.track(snapshot([thread('a')]))
    expect(marks.has('a')).toBe(true)
    marks.track(snapshot([thread('a', { status: 'error' })]))
    expect(marks.has('a')).toBe(false)
  })

  it('does not count a turn that stopped to ask you something as finished', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a')]))
    const asking = thread('a'); asking.requests = [{ id: 'q', kind: 'question', text: 'Which one?', options: [] }]
    marks.track(snapshot([asking]))
    expect(marks.has('a')).toBe(false)
  })

  it('takes the saved marks back without undoing what a client showed first', () => {
    const marks = new FinishedUnread()
    marks.show(['a'])
    marks.restore(['a', 'b'])
    expect(marks.saved()).toEqual(['b'])
  })

  it('does not count a failed turn as finished', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a')]))
    marks.track(snapshot([thread('a', { status: 'error' })]))
    expect(marks.has('a')).toBe(false)
  })
})

describe('a disconnect', () => {
  it('ends the work without earning the mark when the thread\'s own provider is gone', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a', { backgroundWork: agentWork })]))
    marks.track(snapshot([thread('a', { clientConnected: false })]))
    expect(marks.has('a')).toBe(false)
    // Coming back finished is not finishing while you were away: the work was cut off, not done.
    marks.track(snapshot([thread('a')]))
    expect(marks.has('a')).toBe(false)
  })

  it('reads the provider list when the thread does not say', () => {
    const marks = new FinishedUnread()
    const providers = (connection: 'connected' | 'disconnected'): Partial<AgentHostSnapshot> => ({ providers: [{ id: 'codex', connection, name: 'Codex', version: '1',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true } }] })
    marks.track(snapshot([running('a', { providerId: 'codex' })], providers('connected')))
    marks.track(snapshot([thread('a', { providerId: 'codex' })], providers('disconnected')))
    expect(marks.has('a')).toBe(false)
  })

  it('earns nothing while the whole host is disconnected and keeps the marks it had', () => {
    const marks = new FinishedUnread()
    marks.track(snapshot([running('a'), running('b')]))
    marks.track(snapshot([thread('a'), running('b')]))
    expect(marks.track(snapshot([thread('a'), thread('b')], { connected: false }))).toBe(false)
    expect(marks.saved()).toEqual(['a'])
  })
})

describe('the saved record', () => {
  it('starts from the saved marks and keeps marks for threads it cannot see yet', () => {
    const marks = new FinishedUnread(['a', 'b', 'a'])
    expect(marks.saved()).toEqual(['a', 'b'])
    // At start a provider may not have listed its threads yet: an absent thread keeps its mark.
    marks.track(snapshot([thread('b')]))
    expect(marks.saved()).toEqual(['a', 'b'])
  })

  it('keeps the newest marks when there are more than it holds', () => {
    const ids = Array.from({ length: FINISHED_UNREAD_MAX + 5 }, (_, index) => `t${index}`)
    expect(new FinishedUnread(ids).saved()).toEqual(ids.slice(5))
    const marks = new FinishedUnread(ids.slice(0, FINISHED_UNREAD_MAX))
    marks.track(snapshot([running('new')]))
    marks.track(snapshot([thread('new')]))
    expect(marks.saved()).toHaveLength(FINISHED_UNREAD_MAX)
    expect(marks.saved().at(-1)).toBe('new')
    expect(marks.has('t0')).toBe(false)
  })

  it('publishes the field only on a marked thread', () => {
    const marks = new FinishedUnread(['a'])
    expect(marks.publish(thread('a')).finishedUnread).toBe(true)
    expect(marks.publish(thread('b'))).not.toHaveProperty('finishedUnread')
    expect(marks.publish({ ...thread('b'), finishedUnread: true })).not.toHaveProperty('finishedUnread')
  })
})
