// @vitest-environment node
/**
 * The seam of desktop notifications (ADR-0117): the real router publishes the joined state of this computer's host and a
 * paired host, the real tracker reads it and the real notifier makes the notification. Only Electron's `Notification` is
 * a fake, so every field the tracker reads must survive the router's join, in window-space keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { ThreadAlerts } from '../../../src/main/notifications/threadAlerts'
import { createDesktopNotifier, type DesktopNotifier } from '../../../src/main/notifications/desktopNotifier'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { ALERT_SETTLE_MS } from '../../../src/shared/desktopNotifications'
import type { AgentFollowup, AgentState, AgentThread } from '../../../src/shared/agents'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const AT = '2026-10-22T10:00:00.000Z'
const UUID = '00000000-0000-4000-8000-000000000001'

function thread(id: string, shape: Partial<AgentThread> = {}): AgentThread {
  return { id, projectId: 'project', title: `Task ${id}`, modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [], ...shape }
}
const ask = (id: string, kind: 'question' | 'permission' = 'question'): AgentThread['requests'][number] => ({ id, kind, text: 'secret', options: [] })
const followup = (threadId: string): AgentFollowup =>
  ({ id: UUID, threadId, draftId: UUID, text: '', attachments: [], createdAt: AT, updatedAt: AT, status: 'queued' }) as AgentFollowup

/** One host whose state a test changes and pushes, as a host's service broadcasts a change. */
function host(hostId: string, kind: 'local' | 'remote', threads: AgentThread[]) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = threads
  let broadcast: (next: AgentState) => void = () => undefined
  const connection: DesktopHostConnection = { hostId, name: kind === 'local' ? 'This computer' : 'Forge', kind, preview: () => null,
    detail: async threadId => ({ threadId, revision: 1, messages: [] }), observe: async () => undefined,
    service: { shell: () => state, subscribe: listener => { broadcast = listener; return () => undefined }, command: async () => state } }
  // New thread objects each time: the router reuses its window copy of a thread whose object did not change.
  const push = (next: AgentThread[], followups: AgentFollowup[] = []): void => {
    state.host.threads = next
    state.followups = followups
    broadcast(state)
  }
  return { connection, push }
}

interface Made { readonly options: Record<string, unknown>; press(): void }

describe('desktop notifications across the router, tracker and notifier (ADR-0117)', () => {
  let router: DesktopHostRouter, tracker: ThreadAlerts, notifier: DesktopNotifier
  let made: Made[], opened: string[], pending: Promise<void>[]
  let switches: { needsYou: boolean; finished: boolean }
  let local: ReturnType<typeof host>, remote: ReturnType<typeof host>

  /** Lets every alert reach the notifier, which reads the switches asynchronously. */
  const flush = async (): Promise<void> => { await Promise.all(pending) }
  const settle = async (ms = ALERT_SETTLE_MS): Promise<void> => { vi.advanceTimersByTime(ms); await flush() }

  beforeEach(() => {
    vi.useFakeTimers()
    made = []; opened = []; pending = []
    switches = { needsYou: true, finished: true }
    router = new DesktopHostRouter(emptyDesktopState)
    notifier = createDesktopNotifier({
      create: options => {
        const listeners = new Map<string, (...args: unknown[]) => void>()
        made.push({ options, press: () => listeners.get('click')?.() })
        return { show: () => undefined, on: (event, listener) => { listeners.set(event, listener) } }
      },
      isSupported: () => true,
      switches: async () => ({ ...switches }),
      open: threadId => { opened.push(threadId) },
      log: () => undefined,
    })
    tracker = new ThreadAlerts({
      shows: id => router.windowShows(id),
      emit: alert => { pending.push(notifier.notify(alert)) },
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) } },
    })
    local = host(LOCAL, 'local', [thread('mine')])
    remote = host(REMOTE, 'remote', [thread('theirs', { requests: [ask('old')] }), thread('top')])
    router.add(local.connection); router.add(remote.connection)
    // The first publication carries every thread already there, on both hosts: the baseline.
    router.subscribe(state => tracker.track(state))
    local.push([thread('mine')])
  })

  afterEach(() => {
    tracker.dispose(); notifier.dispose(); router.dispose()
    vi.useRealTimers()
  })

  it('says a paired host\'s new question or permission request once, named by the thread and its computer, and opens it', async () => {
    // A request the thread already had at the baseline is not news, then or later.
    remote.push([thread('theirs', { requests: [ask('old')] }), thread('top')])
    await flush()
    expect(made).toEqual([])

    remote.push([thread('theirs', { requests: [ask('old'), ask('q1')] }), thread('top')])
    await flush()
    const key = hostEntityKey(REMOTE, 'theirs')
    expect(made.map(item => item.options)).toStrictEqual([{ id: `${key}/request/q1`, groupId: key, title: 'Task theirs', body: 'Codex is asking a question on Forge.' }])
    remote.push([thread('theirs', { requests: [ask('old'), ask('q1'), ask('p1', 'permission')] }), thread('top')])
    await flush()
    expect(made[1]?.options).toMatchObject({ groupId: key, body: 'Codex is asking for permission on Forge.' })
    for (const option of ['actions', 'hasReply', 'silent']) expect(made[1]?.options).not.toHaveProperty(option)

    made[0]!.press()
    expect(opened).toEqual([key])
  })

  it('says nothing for the thread the window shows, and a new request once the window loses the focus', async () => {
    const key = hostEntityKey(REMOTE, 'theirs')
    await router.command({ type: 'observe-threads', threadIds: [key] }, desktopWindowClient())
    remote.push([thread('theirs', { requests: [ask('r1')] }), thread('top')])
    await flush()
    expect(made).toEqual([])
    router.setWindowFocused(false)
    remote.push([thread('theirs', { requests: [ask('r1'), ask('r2', 'permission')] }), thread('top')])
    await flush()
    expect(made.map(item => item.options.id)).toEqual([`${key}/request/r2`])
  })

  it('says this computer\'s thread finished once it stays quiet for the settle delay, without naming the computer', async () => {
    const key = hostEntityKey(LOCAL, 'mine')
    local.push([thread('mine', { status: 'running' })])
    local.push([thread('mine', { finishedUnread: true })])
    await settle(ALERT_SETTLE_MS - 1)
    expect(made).toEqual([])
    await settle(1)
    expect(made.map(item => item.options)).toStrictEqual([{ id: expect.stringMatching(new RegExp(`^${key}/finished/[0-9a-f]{8}-1$`)), groupId: key, title: 'Task mine', body: 'Codex finished.' }])

    // The mark clears and comes back: a second finish says again.
    local.push([thread('mine', { status: 'running' })])
    local.push([thread('mine', { finishedUnread: true })])
    await settle()
    expect(made.map(item => item.options.body)).toEqual(['Codex finished.', 'Codex finished.'])
  })

  it.each([
    // The control: the same steps with nothing holding it say once, so the cases below are not quiet by accident.
    ['staying quiet', [thread('mine', { finishedUnread: true })], [], 1],
    ['running again', [thread('mine', { status: 'running', finishedUnread: true })], [], 0],
    ['babysitting a pull request', [thread('mine', { finishedUnread: true, babysitting: [{ url: 'https://github.com/o/r/pull/1', number: 1, startedBy: 'user', startedAt: AT }] })], [], 0],
    ['holding a queued follow-up', [thread('mine', { finishedUnread: true })], [followup('mine')], 0],
  ] as const)('holds this computer\'s finish while the thread is %s before the settle delay runs out', async (_case, held, followups, count) => {
    local.push([thread('mine', { status: 'running' })])
    local.push([thread('mine', { finishedUnread: true })])
    await settle(ALERT_SETTLE_MS / 2)
    local.push([...held], [...followups])
    await settle(ALERT_SETTLE_MS * 2)
    expect(made).toHaveLength(count)
  })

  it('says nothing while both switches are off, and replays nothing once they are back on', async () => {
    switches = { needsYou: false, finished: false }
    remote.push([thread('theirs', { requests: [ask('r1')] }), thread('top')])
    local.push([thread('mine', { status: 'running' })])
    local.push([thread('mine', { finishedUnread: true })])
    await settle()
    switches = { needsYou: true, finished: true }
    remote.push([thread('theirs', { requests: [ask('r1')] }), thread('top')])
    local.push([thread('mine', { finishedUnread: true })])
    await settle()
    expect(made).toEqual([])
  })

  it('never says a delegated thread finished, and names its question by the top-level thread while opening the asking one', async () => {
    const child = (shape: Partial<AgentThread> = {}) => thread('child', { delegatedBy: 'top', providerId: 'claude', ...shape })
    remote.push([thread('theirs'), thread('top', { status: 'running' }), child()])
    remote.push([thread('theirs'), thread('top', { status: 'running' }), child({ status: 'running' })])
    remote.push([thread('theirs'), thread('top', { status: 'running' }), child({ finishedUnread: true })])
    await settle()
    expect(made).toEqual([])

    remote.push([thread('theirs'), thread('top', { status: 'running' }), child({ requests: [ask('r')] })])
    await flush()
    const key = hostEntityKey(REMOTE, 'child')
    expect(made.map(item => item.options)).toStrictEqual([{ id: `${key}/request/r`, groupId: key, title: 'Task top', body: 'Claude Code is asking a question on Forge.' }])
  })
})
