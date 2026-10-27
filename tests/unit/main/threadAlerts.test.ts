// @vitest-environment node
/** When a desktop notification is due (ADR-0117), on states built by hand with fake timers. The sink's words are in desktopNotifier.test.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadAlerts, type ThreadAlertsOptions } from '../../../src/main/notifications/threadAlerts'
import { EMPTY_AGENT_HOST, type AgentDelivery, type AgentFollowup, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { ALERT_DELEGATION_SETTLE_MS, ALERT_SETTLE_MS, type ThreadAlert } from '../../../src/shared/desktopNotifications'

type State = Pick<AgentState, 'host' | 'followups' | 'deliveries'>
const AT = '2026-10-22T10:00:00.000Z'
const UUID = '00000000-0000-4000-8000-000000000001'

function thread(id: string, shape: Partial<AgentThread> = {}): AgentThread {
  return { id, title: `Title ${id}`, projectId: 'project', modelId: 'model', providerId: 'claude', status: 'idle', messages: [], requests: [], ...shape }
}
const marked = (id: string, shape: Partial<AgentThread> = {}): AgentThread => thread(id, { finishedUnread: true, ...shape })
const ask = (id: string, kind: 'question' | 'permission' = 'question'): AgentThread['requests'][number] => ({ id, kind, text: 'secret', options: [] })
function state(threads: AgentThread[], extra: Partial<State> = {}): State {
  return { host: { ...EMPTY_AGENT_HOST, connected: true, threads }, ...extra }
}
const followup = (threadId: string, status: AgentFollowup['status'], wakeUp = false): AgentFollowup =>
  ({ id: UUID, threadId, draftId: UUID, text: '', attachments: [], createdAt: AT, updatedAt: AT, status, ...(wakeUp ? { wakeUp: true } : {}) }) as AgentFollowup
const delivery = (threadId: string, status: AgentDelivery['status']): AgentDelivery => ({ threadId, draftId: UUID, status, createdAt: AT, updatedAt: AT })
const work = [{ id: UUID, label: 'Build', type: 'workflow' as const }]
const subagents = (working: number, unknown: number): NonNullable<AgentThread['subagentSummary']> =>
  ({ total: working + unknown, working, completed: 0, failed: 0, interrupted: 0, unknown })
/** A finished id without its run token. */
const plain = (id: string): string => id.replace(/\/finished\/[0-9a-f]{8}-/u, '/finished/')

afterEach(() => { vi.useRealTimers() })

function setup(options: Partial<ThreadAlertsOptions> = {}) {
  vi.useFakeTimers()
  const alerts: ThreadAlert[] = []
  const shown = new Set<string>()
  const tracker = new ThreadAlerts({ shows: id => shown.has(id), emit: alert => { alerts.push(alert) }, timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) } }, ...options })
  const settle = (ms = ALERT_SETTLE_MS): void => { vi.advanceTimersByTime(ms) }
  return { alerts, shown, tracker, settle }
}

describe('needs you', () => {
  it('baselines the first publication and alerts a new request once, a permission outranking a question', () => {
    const { alerts, tracker } = setup()
    tracker.track(state([thread('a', { requests: [ask('old')] }), marked('b')]))
    expect(alerts).toEqual([])
    tracker.track(state([thread('a', { requests: [ask('old'), ask('q1'), ask('p1', 'permission')] }), marked('b')]))
    expect(alerts).toStrictEqual([{ kind: 'needs-you', threadId: 'a', title: 'Title a', providerId: 'claude', request: 'permission', id: 'a/request/q1' }])
    // Published again, gone and back: still once.
    tracker.track(state([thread('a', { requests: [ask('old'), ask('q1'), ask('p1', 'permission')] })]))
    tracker.track(state([thread('a')]))
    tracker.track(state([thread('a', { requests: [ask('q1')] })]))
    expect(alerts).toHaveLength(1)
    tracker.track(state([thread('a', { requests: [ask('q2')] })]))
    expect(alerts[1]).toMatchObject({ request: 'question', id: 'a/request/q2' })
  })

  it('names the computer only for another computer\'s thread with a label', () => {
    const { alerts, tracker } = setup()
    const threads = [thread('a', { remoteHost: true, hostLabel: 'Studio' }), thread('b', { hostLabel: 'This Mac' }), thread('c', { remoteHost: true })]
    tracker.track(state(threads))
    tracker.track(state(threads.map(item => ({ ...item, requests: [ask('r')] }))))
    expect(alerts.map(alert => alert.computer)).toEqual(['Studio', undefined, undefined])
    expect(alerts[1]).not.toHaveProperty('computer')
  })

  it('never alerts the thread the window shows, nor replays it later', () => {
    const { alerts, shown, tracker } = setup()
    tracker.track(state([thread('a')]))
    shown.add('a')
    tracker.track(state([thread('a', { requests: [ask('r')] })]))
    shown.delete('a')
    tracker.track(state([thread('a', { requests: [ask('r')] })]))
    expect(alerts).toEqual([])
  })

  it('alerts a delegated thread under its top-level title, opening the delegated thread', () => {
    const { alerts, tracker } = setup()
    const top = thread('top'), mid = thread('mid', { delegatedBy: 'top', providerId: 'codex' })
    tracker.track(state([top, mid, thread('leaf', { delegatedBy: 'mid', providerId: 'muse' })]))
    tracker.track(state([top, mid, thread('leaf', { delegatedBy: 'mid', providerId: 'muse', requests: [ask('r')] })]))
    expect(alerts).toStrictEqual([{ kind: 'needs-you', threadId: 'leaf', title: 'Title top', providerId: 'muse', request: 'question', id: 'leaf/request/r' }])
  })

  it('skips disconnected, settled and Watcher history threads; Watcher\'s own and watched threads still ask', () => {
    const { alerts, tracker } = setup({ watched: id => id === 'w2' })
    const shapes: [string, Partial<AgentThread>][] = [['off', { clientConnected: false }], ['set', { settledAt: AT }], ['proj', { workspaceSettledAt: AT }],
      ['closed', { archivedAt: AT }], ['hist', { kind: 'watcher-history' }], ['w', { kind: 'watcher' }], ['w2', {}]]
    tracker.track(state(shapes.map(([id, shape]) => thread(id, shape))))
    tracker.track(state(shapes.map(([id, shape]) => thread(id, { ...shape, requests: [ask('r')] }))))
    expect(alerts.map(alert => alert.threadId)).toEqual(['w', 'w2'])
    // The disconnected thread's request was seen: reconnecting replays nothing.
    tracker.track(state([thread('off', { requests: [ask('r')] })]))
    expect(alerts).toHaveLength(2)
  })
})

describe('finished', () => {
  it('alerts once per mark after the settle delay, and again after the mark clears and returns', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a', { status: 'running' })]))
    tracker.track(state([marked('a')]))
    settle(ALERT_SETTLE_MS - 1)
    expect(alerts).toEqual([])
    settle(1)
    const run = /^a\/finished\/([0-9a-f]{8})-1$/u.exec(alerts[0]?.id ?? '')?.[1]
    expect(run).toBeDefined()
    expect(alerts).toStrictEqual([{ kind: 'finished', threadId: 'a', title: 'Title a', providerId: 'claude', id: `a/finished/${run}-1` }])
    tracker.track(state([marked('a')]))
    settle()
    expect(alerts).toHaveLength(1)
    tracker.track(state([thread('a')]))
    tracker.track(state([marked('a')]))
    settle()
    expect(alerts[1]?.id).toBe(`a/finished/${run}-2`)
    // Another run's tracker never reuses an id.
    const next = setup()
    next.tracker.track(state([thread('a')]))
    next.tracker.track(state([marked('a')]))
    next.settle()
    expect(next.alerts[0]?.id).toMatch(/^a\/finished\/[0-9a-f]{8}-1$/u)
    expect(next.alerts[0]?.id).not.toBe(alerts[0]?.id)
  })

  it('baselines a mark present when first seen', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([marked('a')]))
    settle()
    tracker.track(state([marked('a')]))
    settle()
    expect(alerts).toEqual([])
  })

  it('is skipped when the window shows the thread at fire time', () => {
    const { alerts, shown, tracker, settle } = setup()
    tracker.track(state([thread('a')]))
    tracker.track(state([marked('a')]))
    shown.add('a')
    settle()
    expect(alerts).toEqual([])
  })

  const finishes = (alerts: ThreadAlert[]): string[] => alerts.filter(alert => alert.kind === 'finished').map(alert => plain(alert.id))
  const child = (id: string, parent: string, shape: Partial<AgentThread> = {}): AgentThread => thread(id, { delegatedBy: parent, ...shape })
  const holds: [string, Partial<AgentThread>, Partial<State>, AgentThread[]][] = [
    ['a running turn', { status: 'running' }, {}, []], ['a turn still reported running', { lastTurn: { id: 't', status: 'running' } }, {}, []],
    ['background work', { backgroundWork: work }, {}, []], ['monitoring', { monitoring: [{ id: UUID, label: 'Watch' }] }, {}, []],
    ['compaction', { compaction: { commandId: 'c', status: 'running' } }, {}, []],
    ['babysitting', { babysitting: [{ url: 'https://github.com/o/r/pull/1', number: 1, startedBy: 'user', startedAt: AT }] }, {}, []],
    ['a request', { requests: [ask('r')] }, {}, []],
    ['a queued follow-up', {}, { followups: [followup('a', 'queued')] }, []], ['a dispatching follow-up', {}, { followups: [followup('a', 'dispatching')] }, []],
    ['a queued wake-up', {}, { followups: [followup('a', 'queued', true)] }, []],
    ['a queued delivery', {}, { deliveries: [delivery('a', 'queued')] }, []], ['a submitting delivery', {}, { deliveries: [delivery('a', 'submitting')] }, []],
    ['a working sub-agent', { subagentSummary: subagents(1, 0) }, {}, []], ['a sub-agent a restart left unknown', { subagentSummary: subagents(0, 1) }, {}, []],
    ['a running child', {}, {}, [child('c', 'a', { status: 'running' })]],
    ['a child with a working sub-agent', {}, {}, [child('c', 'a', { subagentSummary: subagents(1, 0) })]],
    ['a child that babysits', {}, {}, [child('c', 'a', { babysitting: [{ url: 'https://github.com/o/r/pull/1', number: 1, startedBy: 'agent', startedAt: AT }] })]],
    ['a child that compacts', {}, {}, [child('c', 'a', { compaction: { commandId: 'c', status: 'running' } })]],
    ['a child with a queued send', {}, { followups: [followup('c', 'queued')] }, [child('c', 'a')]],
    ['a child with a submitting delivery', {}, { deliveries: [delivery('c', 'submitting')] }, [child('c', 'a')]],
    ['a child with background work', {}, {}, [child('c', 'a', { backgroundWork: work })]],
    ['a child with monitoring', {}, {}, [child('c', 'a', { monitoring: [{ id: UUID, label: 'Watch' }] })]],
    ['a child that asks', {}, {}, [child('c', 'a', { requests: [ask('r')] })]],
    ['a grandchild that works', {}, {}, [child('c', 'a'), child('g', 'c', { status: 'running' })]],
  ]
  it.each(holds)('is held by %s, then alerts a settle delay after it lets go', (_name, shape, extra, children) => {
    const { alerts, tracker, settle } = setup()
    const idle = children.map(item => child(item.id, item.delegatedBy ?? ''))
    tracker.track(state([thread('a', { status: 'running' }), ...idle]))
    tracker.track(state([marked('a', shape), ...children], extra))
    settle(ALERT_SETTLE_MS * 3)
    tracker.track(state([marked('a', shape), ...children], extra))
    settle(ALERT_SETTLE_MS * 3)
    expect(finishes(alerts)).toEqual([])
    tracker.track(state([marked('a'), ...idle]))
    // A thread that delegated waits longer for the answer it may be owed.
    const wait = children.length > 0 ? ALERT_DELEGATION_SETTLE_MS : ALERT_SETTLE_MS
    settle(wait - 1)
    expect(finishes(alerts)).toEqual([])
    settle(1)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  const quiet: [string, Partial<State>, AgentThread[]][] = [
    ['paused follow-up', { followups: [followup('a', 'paused')] }, []], ['failed follow-up', { followups: [followup('a', 'failed')] }, []],
    ['uncertain follow-up', { followups: [followup('a', 'uncertain')] }, []], ['failed delivery', { deliveries: [delivery('a', 'failed')] }, []],
    ['uncertain delivery', { deliveries: [delivery('a', 'uncertain')] }, []], ['accepted delivery', { deliveries: [delivery('a', 'accepted')] }, []],
    ['settled child', {}, [child('c', 'a', { status: 'running', settledAt: AT })]],
    ['roster with no sub-agent working', {}, []],
  ]
  it.each(quiet)('is not held by a %s', (_name, extra, children) => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), ...children]))
    tracker.track(state([marked('a', { subagentSummary: subagents(0, 0) }), ...children], extra))
    settle(ALERT_DELEGATION_SETTLE_MS)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  it('is not held by babysitting once Restart stopped threads retired it (ADR-0144), its own or a child’s', () => {
    const { alerts, tracker, settle } = setup({ babysittingRetired: true })
    const babysitting = [{ url: 'https://github.com/o/r/pull/1', number: 1, startedBy: 'agent' as const, startedAt: AT }]
    tracker.track(state([thread('a', { status: 'running' }), child('c', 'a')]))
    tracker.track(state([marked('a', { babysitting }), child('c', 'a', { babysitting })]))
    settle(ALERT_DELEGATION_SETTLE_MS)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  it('is cancelled by the mark clearing or the thread running again before it fires', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), thread('b')]))
    tracker.track(state([marked('a'), marked('b')]))
    settle(ALERT_SETTLE_MS - 1)
    tracker.track(state([thread('a'), marked('b', { status: 'running' })]))
    settle()
    expect(alerts).toEqual([])
  })

  it('never alerts a failed, stopped or erroring turn', () => {
    const { alerts, tracker, settle } = setup()
    const threads = [marked('e', { status: 'error' }), marked('f', { lastTurn: { id: 't', status: 'failed' } }), marked('i', { lastTurn: { id: 't', status: 'interrupted' } })]
    tracker.track(state(threads.map(item => thread(item.id))))
    tracker.track(state(threads))
    settle()
    expect(alerts).toEqual([])
  })

  it('never alerts a disconnected thread, nor replays its mark on reconnect', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), thread('b')]))
    tracker.track(state([marked('a', { clientConnected: false }), marked('b')]))
    tracker.track(state([marked('a', { clientConnected: false }), marked('b', { clientConnected: false })]))
    settle()
    tracker.track(state([marked('a'), marked('b')]))
    settle()
    expect(alerts).toEqual([])
  })

  it('alerts nothing for settled threads and forgets them', () => {
    const { alerts, tracker, settle } = setup()
    const project: State['host']['projects'][number] = { id: 'done', title: 'Done', path: '/done', workspaceSettledAt: AT }
    tracker.track(state([thread('a'), thread('b', { projectId: 'done' }), thread('c')]))
    const settledState = state([marked('a', { workspaceSettledAt: AT }), marked('b', { projectId: 'done' }), marked('c', { settledOverride: 'settled' })])
    settledState.host.projects = [project]
    tracker.track(settledState)
    settle()
    expect(alerts).toEqual([])
    // Forgotten: back unsettled, it is a new baseline.
    tracker.track(state([marked('a'), marked('b'), marked('c')]))
    settle()
    expect(alerts).toEqual([])
  })

  it('leaves a delegated thread\'s finish to its delegating thread, unless that thread is gone', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('top'), thread('child', { delegatedBy: 'top' }), thread('orphan', { delegatedBy: 'gone' })]))
    tracker.track(state([thread('top', { status: 'running' }), marked('child', { delegatedBy: 'top' }), marked('orphan', { delegatedBy: 'gone' })]))
    settle()
    expect(alerts.map(alert => alert.threadId)).toEqual(['orphan'])
  })

  it('never alerts Watcher\'s threads or a thread Watcher keeps going', () => {
    const { alerts, tracker, settle } = setup({ watched: id => id === 'kept' })
    const threads = [marked('w', { kind: 'watcher' }), marked('h', { kind: 'watcher-history' }), marked('kept')]
    tracker.track(state(threads.map(item => thread(item.id, { kind: item.kind }))))
    tracker.track(state(threads))
    settle()
    expect(alerts).toEqual([])
  })

  it('forgets a thread absent from a publication and cancels its timer', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a')]))
    tracker.track(state([marked('a')]))
    tracker.track(state([]))
    settle()
    tracker.track(state([marked('a')]))
    settle()
    expect(alerts).toEqual([])
  })
})

describe('a thread that delegated', () => {
  const finishes = (alerts: ThreadAlert[]): string[] => alerts.filter(alert => alert.kind === 'finished').map(alert => plain(alert.id))
  const child = (id: string, parent: string, shape: Partial<AgentThread> = {}): AgentThread => thread(id, { delegatedBy: parent, ...shape })

  it('waits the delegation settle for the answer its delegated thread may still send', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), child('c', 'a', { status: 'running' })]))
    tracker.track(state([marked('a'), child('c', 'a')]))
    settle(ALERT_SETTLE_MS)
    expect(finishes(alerts)).toEqual([])
    settle(ALERT_DELEGATION_SETTLE_MS - ALERT_SETTLE_MS - 1)
    expect(finishes(alerts)).toEqual([])
    settle(1)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  it('is never told when the answer starts a turn inside that wait', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), child('c', 'a', { status: 'running' })]))
    tracker.track(state([marked('a'), child('c', 'a')]))
    settle(10_000)
    tracker.track(state([thread('a', { status: 'running' }), child('c', 'a')]))
    tracker.track(state([thread('a'), child('c', 'a')]))
    settle(ALERT_DELEGATION_SETTLE_MS * 2)
    expect(finishes(alerts)).toEqual([])
  })

  it('waits the ordinary settle without a delegated thread present', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a'), thread('c')]))
    tracker.track(state([marked('a'), thread('c')]))
    settle(ALERT_SETTLE_MS)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  it('waits for a settled delegated thread too, which does not hold it', () => {
    const { alerts, tracker, settle } = setup()
    const settledChild = child('c', 'a', { status: 'running', settledAt: AT })
    tracker.track(state([thread('a'), settledChild]))
    tracker.track(state([marked('a'), settledChild]))
    settle(ALERT_DELEGATION_SETTLE_MS - 1)
    expect(finishes(alerts)).toEqual([])
    settle(1)
    expect(finishes(alerts)).toEqual(['a/finished/1'])
  })

  it('waits at each of two levels', () => {
    const { alerts, tracker, settle } = setup()
    // The top thread over a child that delegated again, and an orphaned child that delegated again.
    const before = [thread('a'), child('c', 'a'), child('g', 'c', { status: 'running' }), child('o', 'gone'), child('og', 'o', { status: 'running' })]
    tracker.track(state(before))
    tracker.track(state([marked('a'), marked('c', { delegatedBy: 'a' }), child('g', 'c'), marked('o', { delegatedBy: 'gone' }), child('og', 'o')]))
    settle(ALERT_DELEGATION_SETTLE_MS - 1)
    expect(finishes(alerts)).toEqual([])
    settle(1)
    expect(finishes(alerts)).toEqual(['a/finished/1', 'o/finished/2'])
  })
})

describe('the tracker', () => {
  it('cancels its timers on dispose and ignores later publications', () => {
    const { alerts, tracker, settle } = setup()
    tracker.track(state([thread('a')]))
    tracker.track(state([marked('a')]))
    tracker.dispose()
    expect(vi.getTimerCount()).toBe(0)
    settle()
    tracker.track(state([thread('a', { requests: [ask('r')] })]))
    expect(alerts).toEqual([])
  })

  it('keeps going when the sink throws', () => {
    const emitted: string[] = []
    const { tracker, settle } = setup({ emit: alert => { emitted.push(alert.id); throw new Error('sink') } })
    tracker.track(state([thread('a'), thread('b'), thread('c')]))
    tracker.track(state([thread('a', { requests: [ask('r')] }), thread('b', { requests: [ask('r')] }), marked('c')]))
    settle()
    tracker.track(state([thread('a', { requests: [ask('r'), ask('s')] }), thread('b'), marked('c')]))
    expect(emitted.map(plain)).toEqual(['a/request/r', 'b/request/r', 'c/finished/1', 'a/request/s'])
  })

  it('uses unref\'d real timers by default', () => {
    vi.useRealTimers()
    const tracker = new ThreadAlerts({ shows: () => false, emit: () => undefined })
    tracker.track(state([thread('a')]))
    expect(() => { tracker.track(state([marked('a')])); tracker.dispose() }).not.toThrow()
  })
})
