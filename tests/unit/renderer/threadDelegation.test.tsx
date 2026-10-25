import { readFileSync } from 'node:fs'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentState, AgentThread } from '../../../src/shared/agents'
import type { DelegatedView, DelegationsBridge, DelegationsChanged, DelegationView, RefusedView } from '../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { DelegationCardProvider, delegationsByTurn, type DelegationCardWorld } from '../../../src/renderer/src/agents/DelegationCards'
import { DelegationStore } from '../../../src/renderer/src/agents/delegations'
import { delegatedNote, delegationDuration, delegationRefusalLine, delegationWaitLine, stopLabel, stopLine, userTurnRunning, workingDelegatedThreads } from '../../../src/renderer/src/agents/delegationWords'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { describeThreads, organizeWorkspace, type ThreadRow } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/** Delegation between threads (#1029, design A) as the window shows it, only where the Owl list turns it on. */
function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.37-owl.20261012.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: false, 'thread-delegation': on } } } as unknown as AppContextValue)
}

const NOW = E2E_THREADS_NOW
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
const PARENT = 'visual-gate', CHILD = 'gate-review', GRANDCHILD = 'gate-check'

function view(patch: Partial<DelegatedView> = {}): DelegatedView {
  return { id: crypto.randomUUID(), thread: CHILD, action: 'start', work: 'code-review', rootUserMessageId: 'visual-gate-1', anchorMessageId: 'visual-gate-1',
    briefMessageId: 'gate-review-1', outcome: 'working', told: false, createdAt: at(5), waiting: false, ...patch }
}
/** A delegation Sotto refused: a start names a provider and no thread; a send names the thread it would have gone to. */
function refusedView(patch: Partial<RefusedView> = {}): RefusedView {
  return { id: crypto.randomUUID(), provider: 'codex', action: 'start', work: 'research', outcome: 'refused', refusal: 'PERMISSION_TOO_WIDE',
    rootUserMessageId: 'visual-gate-1', anchorMessageId: 'visual-gate-1', createdAt: at(4), ...patch }
}

/** Visual gate flake (Claude, running) delegated a review to Codex, which delegated a check in turn; both still work. */
function delegatingState(): AgentState {
  const state = threadsStateFixture()
  const child = (id: string, title: string, delegatedBy: string, minutes: number): AgentThread => ({ id, title, projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'running',
    delegatedBy, requests: [], updatedAt: at(minutes),
    messages: [{ id: `${id}-1`, role: 'user', text: `Brief for ${title}`, createdAt: at(minutes) }] })
  state.host.threads.push(child(CHILD, 'Review the gate fix', PARENT, 3), child(GRANDCHILD, 'Check the capture', CHILD, 2))
  state.host.threads.find(thread => thread.id === PARENT)!.providerId = 'claude'
  return state
}

/** A stand-in for main's read: what each thread delegated and was sent, and main's word that some changed. */
function bridge(views: Record<string, DelegationView[]>, received: Record<string, DelegatedView[]> = {}) {
  const listeners = new Set<(change: DelegationsChanged) => void>()
  const fake: DelegationsBridge & { readonly reads: string[] } = {
    reads: [],
    read: vi.fn(async ({ threadId }: { threadId: string }) => { fake.reads.push(threadId); return { threadId, delegations: views[threadId] ?? [], received: received[threadId] ?? [] } }),
    brief: vi.fn(async () => null),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { fake, views, change: (threadIds: string[]) => { for (const listener of [...listeners]) listener({ threadIds }) }, listening: () => listeners.size }
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  // A layout of its own, so a split one test opens is not the next test's.
  render(<ThreadsView now={NOW} layoutStore={new SplitLayoutStore()} />)
  return live
}
const openFolder = (name: RegExp): void => {
  const toggle = screen.getByRole('button', { name })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('delegation words', () => {
  it('says a wait and an answer in minutes and seconds', () => {
    expect([0, 12_000, 100_000, 300_000, 3_840_000].map(delegationDuration)).toEqual(['0 s', '12 s', '1 min 40 s', '5 min', '1 h 4 min'])
  })

  it('says how the delegating thread\'s wait went, for each outcome as the prototype words it', () => {
    const started = at(5), now = Date.parse(started) + 72_000
    expect(delegationWaitLine(view({ waiting: true }), now)).toBe('Sotto is starting it and sending the brief.')
    expect(delegationWaitLine(view({ waiting: true, action: 'send' }), now)).toBe('Sotto is sending it the brief.')
    expect(delegationWaitLine(view({ waiting: true, wait: { seconds: 300, startedAt: started } }), now)).toBe('This thread waits up to 5 min for it. 1 min 12 s so far.')
    expect(delegationWaitLine(view({ wait: { seconds: 300, startedAt: started, wentOnAt: at(0) } }), now)).toBe('This thread waited 5 min, then went on. The answer comes back as a wake-up.')
    expect(delegationWaitLine(view({ wait: { seconds: 0, startedAt: started, wentOnAt: started } }), now)).toBe('This thread did not wait for it. The answer comes back as a wake-up.')
    expect(delegationWaitLine(view({ outcome: 'answered', outcomeAt: new Date(Date.parse(started) + 100_000).toISOString(), wait: { seconds: 300, startedAt: started } }), now))
      .toBe('Answered in 1 min 40 s, while this thread waited for it.')
    expect(delegationWaitLine(view({ outcome: 'answered', outcomeAt: new Date(Date.parse(started) + 420_000).toISOString(), told: true, wait: { seconds: 300, startedAt: started, wentOnAt: at(0) } }), now))
      .toBe('Answered in 7 min, after this thread went on. This thread has been told.')
    // A wake-up can wait in the queue, or not be taken: until the thread is told, the card says so.
    expect(delegationWaitLine(view({ outcome: 'answered', outcomeAt: new Date(Date.parse(started) + 420_000).toISOString(), wait: { seconds: 300, startedAt: started, wentOnAt: at(0) } }), now))
      .toBe('Answered in 7 min, after this thread went on. This thread has not been told yet.')
    expect(delegationWaitLine(view({ outcome: 'background' }), now)).toBe('Its turn ended with background work still running. This thread hears when it settles.')
    expect(delegationWaitLine(view({ outcome: 'failed', told: true, wait: { seconds: 0, startedAt: started, wentOnAt: started } }), now)).toBe('Its last turn failed. Open it to see why.')
    expect(delegationWaitLine(view({ outcome: 'failed', wait: { seconds: 0, startedAt: started, wentOnAt: started } }), now)).toBe('Its last turn failed. This thread has not been told yet. Open it to see why.')
    expect(delegationWaitLine(view({ outcome: 'failed', notSent: 'provider' }), now)).toBe('Sotto could not start it or send it the brief. Nothing was sent.')
    expect(delegationWaitLine(view({ outcome: 'stopped', outcomeAt: started }), now)).toMatch(/^Stopped at \d{1,2}:\d{2}\s?[ap]m\. Nothing more will come of it\.$/u)
    expect(delegationWaitLine(view({ outcome: 'paused', notSent: 'target-changed', outcomeAt: started }), now)).toMatch(/^You sent to it at .+, so Sotto did not send this brief\.$/u)
    expect(delegationWaitLine(view({ outcome: 'paused', outcomeAt: started }), now)).toMatch(/^You sent to it at .+\. This thread sends it nothing more until your turn there ends\.$/u)
    expect(delegationWaitLine(view({ outcome: 'unknown', unknownWhy: 'restarted' }), now)).toBe('Sotto restarted while it worked. Nothing was resent. Open it to see where it got to.')
    expect(delegationWaitLine(view({ outcome: 'unknown', unknownWhy: 'unconfirmed' }), now)).toBe('Its provider did not confirm the brief arrived. Sotto has not sent it again. Open it to see whether it is working on it.')
    expect(delegationWaitLine(view({ outcome: 'unknown', unknownWhy: 'gone' }), now)).toBe('Its thread is gone from Sotto, so nothing more will come of it.')
  })

  it('words a delegation no machine could take as a message of the threads catalog (#1032, ADR-0123)', () => {
    const line = 'The machine or system it asked for could not take it: none was connected, it had no copy of this project, or it was not This computer, where delegated threads start for now. {nothing}'
    expect(delegationRefusalLine({ action: 'start', refusal: 'MACHINE_UNAVAILABLE' })).toBe(line.replace('{nothing}', 'Nothing was started.'))
    expect(readFileSync('src/locales/threads/en.po', 'utf8')).toContain(`msgid "${line}"`)
  })

  it('says why Sotto refused a delegation, that nothing was started or sent, and what would let it through', () => {
    expect(delegationRefusalLine({ action: 'start', refusal: 'PERMISSION_TOO_WIDE' })).toBe('It asked for more permission than this thread has, or than your new-thread default allows. '
      + 'A delegated thread gets no more than either. Nothing was started. To give it more, raise the lower of the two first.')
    expect(delegationRefusalLine({ action: 'start', refusal: 'LEVEL_LIMIT' })).toBe('This thread was started by a delegated thread, and delegation goes two levels deep, so it cannot delegate. Nothing was started.')
    // Only a refusal recorded before #1183 has it: Sotto no longer limits how many threads start.
    expect(delegationRefusalLine({ action: 'start', refusal: 'IN_FLIGHT_LIMIT' })).toBe('This computer already had as many new threads working as Threads in flight allowed, a limit Sotto no longer has. Nothing was started.')
    expect(delegationRefusalLine({ action: 'send', refusal: 'PAUSED' })).toBe('You were working in that thread, so it takes no brief until your turn there ends. Nothing was sent.')
    expect(delegationRefusalLine({ action: 'send', refusal: 'PROMPT_LIMIT' })).toBe('That thread already had 4 briefs from this thread in this turn. Your next message to this thread renews the limit. Nothing was sent.')
    expect(delegationRefusalLine({ action: 'send', refusal: 'PROVIDER_UNAVAILABLE' })).toMatch(/^That thread's provider or model was not available/u)
    expect(delegationRefusalLine({ action: 'start', refusal: 'PROVIDER_UNAVAILABLE' })).toMatch(/^The model it asked for was not ready on this computer/u)
    // #1032: a machine or system a new thread named could not take it.
    expect(delegationRefusalLine({ action: 'start', refusal: 'MACHINE_UNAVAILABLE' })).toBe('The machine or system it asked for could not take it: none was connected, '
      + 'it had no copy of this project, or it was not This computer, where delegated threads start for now. Nothing was started.')
    // Every rule main records has its own words, and none is an error code.
    for (const refusal of ['NOT_ADMITTED', 'NO_USER_MESSAGE', 'PERMISSION_NOT_COMPARABLE', 'TARGET_CHANGED', 'PENDING_USER_REQUEST', 'UNKNOWN_THREAD'] as const) {
      const line = delegationRefusalLine({ action: 'send', refusal })
      expect(line, refusal).not.toMatch(/Sotto turned it down|[A-Z]{2,}_[A-Z]/u)
      expect(line, refusal).toMatch(/Nothing was sent\.$/u)
    }
  })

  it('says the pause only while the user\'s own turn in the delegated thread runs (decision 6)', () => {
    const brief = view({ outcome: 'answered', briefMessageId: 'brief-1' })
    const thread = (status: AgentThread['status'], newestUser: string): AgentThread => ({ id: CHILD, title: 'Review the gate fix', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex',
      status, delegatedBy: PARENT, requests: [], messages: [{ id: 'brief-1', role: 'user', text: 'Brief', createdAt: at(5) },
        ...newestUser === 'brief-1' ? [] : [{ id: newestUser, role: 'user' as const, text: 'Mine', createdAt: at(1) }]] })
    // Done, with nothing running: nothing holds either thread back, so nothing is said.
    expect(userTurnRunning(thread('idle', 'brief-1'), [brief])).toBe(false)
    expect(delegatedNote('Visual gate flake', brief, false, false)).toBeUndefined()
    // The brief's own turn running is not the user's.
    expect(userTurnRunning(thread('running', 'brief-1'), [brief])).toBe(false)
    // The user's own message started the turn that runs: the thread that delegated waits it out.
    expect(userTurnRunning(thread('running', 'mine-1'), [brief])).toBe(true)
    expect(delegatedNote('Visual gate flake', brief, true, true)).toBe('Your turn is running. Visual gate flake sends nothing here until it ends.')
    // Until its briefs are read, a running turn is not called the user's.
    expect(userTurnRunning(thread('running', 'mine-1'), [])).toBe(false)
    // A brief the user's turn paused says so while the turn runs; one still being worked on warns before a send.
    expect(delegatedNote('Visual gate flake', { outcome: 'paused' }, false, true)).toBe('Your turn is running. Visual gate flake sends nothing here until it ends.')
    expect(delegatedNote('Visual gate flake', { outcome: 'paused' }, false, false)).toBeUndefined()
    expect(delegatedNote('Visual gate flake', { outcome: 'working' }, false, true)).toBe('If you send here, Visual gate flake sends nothing more until your turn ends.')
    for (const outcome of ['answered', 'failed', 'stopped', 'unknown'] as const) expect(delegatedNote('Visual gate flake', { outcome }, false, false), outcome).toBeUndefined()
  })

  it('names what Stop also stops: the delegated threads below, both levels, whose turn still runs', () => {
    const threads = delegatingState().host.threads
    expect(workingDelegatedThreads(threads, PARENT)).toBe(2)
    expect(workingDelegatedThreads(threads, CHILD)).toBe(1)
    expect(workingDelegatedThreads(threads.map(thread => thread.id === GRANDCHILD ? { ...thread, status: 'idle' as const } : thread), PARENT)).toBe(1)
    expect([0, 1, 2].map(stopLabel)).toEqual(['Stop agent', 'Stop agent and the thread it delegated that is working', 'Stop agent and the 2 threads it delegated that are working'])
    expect(stopLine(2)).toBe('Stop also stops the 2 threads it delegated that are working.')
  })
})

describe('delegated threads in the sidebar', () => {
  const folderOf = (state: AgentState, query = '', delegation = true) => organizeWorkspace(state, describeThreads(state, NOW), query, null, delegation)
  const ids = (state: AgentState, query = '', delegation = true): string[] => [...folderOf(state, query, delegation).open, ...folderOf(state, query, delegation).settled].flatMap(folder => folder.rows.map(row => row.thread.id))

  it('lists no row for a delegated thread at either level while delegation is on, and each as any thread while it is off', () => {
    const state = delegatingState()
    expect(ids(state)).toContain(PARENT)
    expect(ids(state)).not.toContain(CHILD)
    expect(ids(state)).not.toContain(GRANDCHILD)
    // Each is reached from the top of its delegation, the row the sidebar marks while it is in the pane.
    expect(folderOf(state).listedAs).toEqual(new Map([[CHILD, PARENT], [GRANDCHILD, PARENT]]))
    // With the Owl switch off nothing changes: they list as ordinary rows, in activity order, with no nesting.
    expect(ids(state, '', false)).toEqual(expect.arrayContaining([PARENT, CHILD, GRANDCHILD]))
    expect(folderOf(state, '', false).listedAs).toBeUndefined()
  })

  it('keeps a delegated thread whose delegating thread is gone, and hides the one it delegated in turn', () => {
    const state = delegatingState()
    state.host.threads = state.host.threads.filter(thread => thread.id !== PARENT)
    expect(ids(state)).toContain(CHILD)
    expect(ids(state)).not.toContain(GRANDCHILD)
    expect(folderOf(state).listedAs).toEqual(new Map([[GRANDCHILD, CHILD]]))
    // A loop of links is no delegation: both threads stay reachable.
    const looped = delegatingState()
    looped.host.threads.find(thread => thread.id === PARENT)!.delegatedBy = GRANDCHILD
    expect(ids(looped)).toEqual(expect.arrayContaining([PARENT, CHILD, GRANDCHILD]))
  })

  it('lists an open delegated thread on its own in Open when the thread above it is settled, at either level', () => {
    const state = delegatingState()
    const thread = (id: string): AgentThread => state.host.threads.find(item => item.id === id)!
    const open = (given: AgentState): string[] => folderOf(given).open.flatMap(folder => folder.rows.map(row => row.thread.id))
    // The top is settled while the review it delegated still works: the review stands in Open, the check it
    // delegated in turn under it.
    thread(PARENT).workspaceSettledAt = at(1)
    thread(CHILD).requests = [{ id: 'review-permission', kind: 'permission', text: 'Run gh pr merge', options: [] }]
    expect(open(state)).toContain(CHILD)
    expect(open(state)).not.toContain(GRANDCHILD)
    expect(folderOf(state).listedAs).toEqual(new Map([[GRANDCHILD, CHILD]]))
    expect(folderOf(state).open.flatMap(folder => folder.rows).find(row => row.thread.id === CHILD)).toMatchObject({ waitingFor: 'approval', stateLabel: 'Needs your approval' })
    // The first level is settled and the second is open: the second stands alone; the settled one stays with its top.
    const second = delegatingState()
    second.host.threads.find(item => item.id === CHILD)!.workspaceSettledAt = at(1)
    expect(open(second)).toContain(GRANDCHILD)
    expect(folderOf(second).listedAs).toEqual(new Map([[CHILD, PARENT]]))
    // With the top open, nothing changes: both stay hidden under it.
    expect(open(delegatingState())).not.toContain(CHILD)
  })

  it('keeps delegated threads settled with their thread out of Open, and says on its Settled row when one waits', () => {
    const state = delegatingState()
    // What main records when the user settles Visual gate flake: its delegated threads settle with it, under its timestamp.
    for (const thread of state.host.threads) if ([PARENT, CHILD, GRANDCHILD].includes(thread.id)) thread.workspaceSettledAt = at(1)
    const parent = state.host.threads.find(thread => thread.id === PARENT)!
    parent.requests = []; parent.status = 'idle'
    state.host.threads.find(thread => thread.id === CHILD)!.requests = [{ id: 'review-permission', kind: 'permission', text: 'Run gh pr merge', options: [] }]
    const organized = folderOf(state)
    const open = organized.open.flatMap(folder => folder.rows.map(row => row.thread.id))
    for (const id of [PARENT, CHILD, GRANDCHILD]) expect(open).not.toContain(id)
    expect(ids(state)).not.toContain(CHILD)
    expect(ids(state)).not.toContain(GRANDCHILD)
    expect(organized.listedAs).toEqual(new Map([[CHILD, PARENT], [GRANDCHILD, PARENT]]))
    const shelf = organized.settled.find(folder => folder.id === 'workshop')!
    expect(shelf.rows.find(row => row.thread.id === PARENT)).toMatchObject({ waitingFor: 'approval', stateLabel: 'Needs your approval', waitingIn: 'Review the gate fix' })
    expect(shelf.needs).toBeGreaterThan(0)
  })

  it('rolls a delegated thread\'s error up onto the delegating row in its own words, below a waiting request', () => {
    const state = delegatingState()
    const parent = state.host.threads.find(thread => thread.id === PARENT)!
    parent.requests = []
    parent.status = 'idle'
    const row = (): ThreadRow => folderOf(state).open.flatMap(folder => folder.rows).find(item => item.thread.id === PARENT)!
    state.host.threads.find(thread => thread.id === GRANDCHILD)!.status = 'error'
    expect(row()).toMatchObject({ state: 'needs', waitingFor: null, stateLabel: 'Needs attention', attention: true, waitingIn: 'Check the capture' })
    // A question below outranks an error below.
    state.host.threads.find(thread => thread.id === CHILD)!.requests = [{ id: 'review-question', kind: 'question', text: 'Which theme?', options: [] }]
    expect(row()).toMatchObject({ waitingFor: 'question', stateLabel: 'Needs your answer', waitingIn: 'Review the gate fix' })
    // The thread's own error outranks an error below.
    state.host.threads.find(thread => thread.id === CHILD)!.requests = []
    parent.status = 'error'
    expect(row()).toMatchObject({ stateLabel: 'Needs attention' })
    expect(row().waitingIn).toBeUndefined()
  })

  it('finds no delegated thread by search', () => {
    const state = delegatingState()
    expect(folderOf(state, 'Check the capture').matching).toBe(0)
    expect(ids(state, 'Check the capture')).not.toContain(GRANDCHILD)
    expect(ids(state, 'Check the capture', false)).toContain(GRANDCHILD)
  })

  it('says Needs your approval or Needs your answer on the delegating row when a thread below it waits, its own waiting first', () => {
    const state = delegatingState()
    const parent = state.host.threads.find(thread => thread.id === PARENT)!
    parent.requests = []
    parent.status = 'idle'
    const thread = (id: string): AgentThread => state.host.threads.find(item => item.id === id)!
    const row = (): ThreadRow => folderOf(state).open.flatMap(folder => folder.rows).find(item => item.thread.id === PARENT)!
    expect(row()).toMatchObject({ state: 'done', waitingFor: null })
    thread(GRANDCHILD).requests = [{ id: 'check-question', kind: 'question', text: 'Which theme?', options: [] }]
    expect(row()).toMatchObject({ state: 'needs', waitingFor: 'question', stateLabel: 'Needs your answer', attention: true, waitingIn: 'Check the capture' })
    // A permission below outranks a question below.
    thread(CHILD).requests = [{ id: 'review-permission', kind: 'permission', text: 'Run gh pr merge', options: [] }]
    expect(row()).toMatchObject({ waitingFor: 'approval', stateLabel: 'Needs your approval', waitingIn: 'Review the gate fix' })
    // The thread's own waiting wins.
    parent.requests = [{ id: 'own-question', kind: 'question', text: 'Ship it?', options: [] }]
    expect(row()).toMatchObject({ waitingFor: 'question', stateLabel: 'Needs your answer' })
    expect(row().waitingIn).toBeUndefined()
    // The panes keep the thread's own row: the roll-up is the sidebar's.
    expect(describeThreads(state, NOW).find(item => item.thread.id === PARENT)!.waitingIn).toBeUndefined()
  })

  it('shows the delegating row only, marks it current while a delegated thread is in the pane, and says what waits below it', () => {
    owl(true)
    vi.stubGlobal('sotto', { delegations: bridge({}).fake })
    const state = delegatingState()
    state.activeThreadId = GRANDCHILD
    const parent = state.host.threads.find(thread => thread.id === PARENT)!
    parent.requests = []
    state.host.threads.find(thread => thread.id === CHILD)!.requests = [{ id: 'review-permission', kind: 'permission', text: 'Run gh pr merge', options: [] }]
    mount(state)
    openFolder(/^workshop \d+ threads?$/u)
    const nav = screen.getByRole('complementary', { name: 'Thread sidebar' })
    expect(within(nav).queryByRole('button', { name: 'Review the gate fix' })).toBeNull()
    expect(within(nav).queryByRole('button', { name: 'Check the capture' })).toBeNull()
    const row = within(nav).getByRole('button', { name: 'Visual gate flake' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row).toHaveAccessibleDescription(/Needs your approval.*Waiting in Review the gate fix/u)
    expect(document.querySelector('[data-delegation-level]')).toBeNull()
    // The mark is all that moves: the delegating row still opens beside the delegated thread in the pane, by its button,
    // by Ctrl+Enter and by Ctrl+click, rather than replacing it.
    expect(row).toHaveAttribute('aria-keyshortcuts', 'Control+Enter')
    expect(within(nav).getByRole('button', { name: 'Open Visual gate flake beside' })).toBeInTheDocument()
    fireEvent.click(row, { ctrlKey: true })
    const panes = (): string[] => [...document.querySelectorAll('section.thread-pane[data-thread-id]')].map(pane => pane.getAttribute('data-thread-id')!)
    expect(panes()).toEqual(expect.arrayContaining([GRANDCHILD, PARENT]))
    cleanup()
    owl(false)
    mount(delegatingState())
    openFolder(/^workshop \d+ threads?$/u)
    expect(screen.getByRole('button', { name: 'Review the gate fix' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check the capture' })).toBeInTheDocument()
  })
})

describe('delegation cards in the delegating thread', () => {
  const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
  const messages: AgentMessage[] = [
    { id: 'ask', role: 'user', text: 'Fix the flake and have it reviewed.', createdAt: at(10) },
    { id: 'reply', role: 'assistant', text: 'Fixed, and I handed the review to Codex.', createdAt: at(9) },
    { id: 'later', role: 'user', text: 'Thanks.', createdAt: at(4) },
  ]
  const world = (open = vi.fn()): DelegationCardWorld => ({
    thread: id => id === CHILD ? { id: CHILD, title: 'Review the gate fix', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'idle', messages: [], requests: [] } : undefined,
    hostName: () => 'This computer', open, liveClock: false, now: NOW,
  })

  it('sits under the reply of the turn the call was made in, with the thread as a link, its provider, machine, outcome and wait', () => {
    const open = vi.fn()
    const cards = delegationsByTurn([view({ anchorMessageId: 'ask', outcome: 'answered', outcomeAt: at(8), wait: { seconds: 300, startedAt: at(9) } })], messages)
    render(<DelegationCardProvider world={world(open)}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} delegations={cards} /></DelegationCardProvider>)
    const card = screen.getByRole('group', { name: 'Delegated to Review the gate fix' })
    expect(card).toHaveTextContent('Delegated to')
    expect(card).toHaveTextContent('Codex')
    expect(card).toHaveTextContent('This computer')
    expect(card.querySelector('.delegation-card__outcome')).toHaveTextContent('Answered')
    expect(card).toHaveTextContent('Answered in 1 min, while this thread waited for it.')
    // After the reply it belongs to, before the next message.
    const order = [...document.querySelectorAll('[data-message-id], .delegation-card')].map(element => element.getAttribute('data-message-id') ?? 'card')
    expect(order).toEqual(['ask', 'reply', 'card', 'later'])
    const link = within(card).getByRole('button', { name: 'Open Review the gate fix' })
    link.focus()
    fireEvent.click(link)
    expect(open).toHaveBeenCalledWith(CHILD)
  })

  it('shows a refused delegation in the turn it was asked in: what was refused and why, with no link, since nothing started', () => {
    // Sotto found no message of the user's for this one, so it has no turn.
    const { anchorMessageId: _anchor, rootUserMessageId: _root, ...turnless } = refusedView({ refusal: 'NO_USER_MESSAGE', createdAt: at(1) })
    void _anchor; void _root
    const cards = delegationsByTurn([view({ anchorMessageId: 'ask', outcome: 'answered', outcomeAt: at(8) }), refusedView({ anchorMessageId: 'ask', createdAt: at(8) }),
      refusedView({ anchorMessageId: 'ask', action: 'send', thread: CHILD, refusal: 'PAUSED', createdAt: at(7) }), turnless], messages)
    render(<DelegationCardProvider world={world()}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} delegations={cards} /></DelegationCardProvider>)
    const start = screen.getAllByRole('note', { name: 'Not delegated: Research' })[0]!
    expect(start).toHaveAttribute('data-outcome', 'refused')
    expect(start).toHaveTextContent('Not delegated:Research')
    expect(start.querySelector('.delegation-card__meta')).toHaveTextContent('Codex·This computer')
    expect(start).toHaveTextContent('It asked for more permission than this thread has, or than your new-thread default allows. A delegated thread gets no more than either. Nothing was started.')
    expect(within(start).queryByRole('button')).toBeNull()
    // A refused send names the thread it would have gone to, its provider and machine, and links nowhere: nothing was sent.
    const send = screen.getByRole('note', { name: 'Not sent to Review the gate fix' })
    expect(send).toHaveTextContent('You were working in that thread, so it takes no brief until your turn there ends. Nothing was sent.')
    expect(send.querySelector('.delegation-card__meta')).toHaveTextContent('Codex·This computer')
    expect(within(send).queryByRole('button')).toBeNull()
    // In the turn it was asked in, beside the delegation that started; one with no turn Sotto could find goes last.
    const order = [...document.querySelectorAll('[data-message-id], .delegation-card')].map(element => element.getAttribute('data-message-id') ?? element.getAttribute('aria-label'))
    expect(order).toEqual(['ask', 'reply', 'Delegated to Review the gate fix', 'Not delegated: Research', 'Not sent to Review the gate fix', 'later', 'Not delegated: Research'])
  })

  it('goes in a wake-up\'s turn when the call was made there, and last when its turn is not shown unless it is older than what is', () => {
    // A call in a wake-up's turn keeps the user's message as its budget's root, and its card goes in the wake-up's turn.
    const woken = view({ rootUserMessageId: 'ask', anchorMessageId: 'later' })
    const missing = view({ anchorMessageId: 'elsewhere', createdAt: at(5) })
    const older = view({ anchorMessageId: 'elsewhere', createdAt: at(60) })
    const byTurn = delegationsByTurn([view({ anchorMessageId: 'ask' }), woken, missing, older], messages)
    expect(byTurn.get('later')).toEqual([woken])
    expect([...byTurn.keys()]).toEqual(['ask', 'later', ''])
    expect(byTurn.get('')).toEqual([missing])
  })
})

describe('the window\'s read of delegations', () => {
  it('asks main once for a shown thread, and again only when main names it', async () => {
    const { fake, change } = bridge({ [PARENT]: [view()] })
    const store = new DelegationStore(() => fake)
    const heard = vi.fn()
    const stop = store.subscribe(PARENT, heard)
    expect(fake.reads).toEqual([])
    store.want(PARENT); store.want(PARENT)
    await waitFor(() => expect(store.delegations(PARENT).made).toHaveLength(1))
    expect(fake.reads).toEqual([PARENT])
    change(['another-thread'])
    expect(fake.reads).toEqual([PARENT])
    change([PARENT]); change([PARENT])
    await waitFor(() => expect(fake.reads).toEqual([PARENT, PARENT, PARENT]))
    expect(heard).toHaveBeenCalled()
    stop()
    change([PARENT])
    expect(fake.reads).toHaveLength(3)
    expect(store.delegations(PARENT)).toEqual({ made: [], received: [] })
  })
})

describe('the delegating and the delegated thread\'s panes', () => {
  function stateWith(active: string): AgentState {
    const state = delegatingState()
    state.activeThreadId = active
    return state
  }

  it('Stop names the delegated threads it also stops, and the line under the composer says so', async () => {
    owl(true)
    const reads = bridge({ [PARENT]: [view({ rootUserMessageId: 'visual-gate-1', wait: { seconds: 300, startedAt: at(4) }, waiting: true })] })
    vi.stubGlobal('sotto', { delegations: reads.fake })
    const live = mount(stateWith(PARENT))
    const stop = screen.getByRole('button', { name: 'Stop agent and the 2 threads it delegated that are working' })
    expect(screen.getByText('Stop also stops the 2 threads it delegated that are working.')).toBeInTheDocument()
    fireEvent.click(stop)
    expect(live.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: PARENT })
    // The pane read its delegations once, and draws the card under the turn it answers.
    await waitFor(() => expect(screen.getByRole('group', { name: 'Delegated to Review the gate fix' })).toBeInTheDocument())
    expect(reads.fake.reads).toEqual([PARENT])
    await act(async () => { reads.views[PARENT] = [view({ outcome: 'answered', outcomeAt: at(1), wait: { seconds: 300, startedAt: at(4) } })]; reads.change([PARENT]) })
    await waitFor(() => expect(document.querySelector('.delegation-card__outcome')).toHaveTextContent('Answered'))
  })

  it('a delegated thread says Delegated by its parent, a link back, and shows the brief as the parent\'s', async () => {
    owl(true)
    // The delegated thread reads the briefs it was sent with its own delegations, not its parent's list.
    const reads = bridge({}, { [CHILD]: [view({ outcome: 'working' })] })
    vi.stubGlobal('sotto', { delegations: reads.fake })
    const state = stateWith(CHILD)
    // The check it delegated in turn has finished, so its own Stop stops it alone.
    state.host.threads.find(thread => thread.id === GRANDCHILD)!.status = 'idle'
    const live = mount(state)
    const by = await waitFor(() => { const element = document.querySelector('.delegated-by'); expect(element).not.toBeNull(); return element as HTMLElement })
    expect(by).toHaveTextContent('Delegated by Visual gate flake')
    await waitFor(() => expect(by.querySelector('.delegation-card__outcome')).toHaveTextContent('Working'))
    await waitFor(() => expect(document.querySelector('.thread-message[data-from="delegation"] header')).toHaveTextContent('Visual gate flakedelegated'))
    expect(screen.getByText('If you send here, Visual gate flake sends nothing more until your turn ends.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeInTheDocument()
    expect(reads.fake.reads).toEqual([CHILD])
    fireEvent.click(within(by).getByRole('button', { name: 'Open Visual gate flake, the thread that delegated to this one' }))
    expect(live.command).toHaveBeenCalledWith({ type: 'select-thread', threadId: PARENT })
  })

  it('a delegated thread says nothing under its composer once done, and the pause only while the user\'s own turn runs', async () => {
    owl(true)
    const reads = bridge({}, { [CHILD]: [view({ outcome: 'answered', outcomeAt: at(2) })] })
    vi.stubGlobal('sotto', { delegations: reads.fake })
    const state = stateWith(CHILD)
    const child = state.host.threads.find(thread => thread.id === CHILD)!
    child.status = 'idle'
    state.host.threads.find(thread => thread.id === GRANDCHILD)!.status = 'idle'
    const live = mount(state)
    await waitFor(() => expect(document.querySelector('.delegated-by .delegation-card__outcome')).toHaveTextContent('Answered'))
    expect(document.querySelector('.delegation-note')).toBeNull()
    // The user sends their own message there: while its turn runs, the thread that delegated waits it out.
    const onChild = (patch: (thread: AgentThread) => Partial<AgentThread>): void => {
      act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === CHILD ? { ...thread, ...patch(thread) } : thread) } }) })
    }
    onChild(thread => ({ status: 'running', messages: [...thread.messages, { id: 'gate-review-mine', role: 'user', text: 'Also check the light theme.', createdAt: at(1) }] }))
    await waitFor(() => expect(document.querySelector('.delegation-note')).toHaveTextContent('Your turn is running. Visual gate flake sends nothing here until it ends.'))
    // Its turn ends: nothing holds either thread back, and the line goes.
    onChild(() => ({ status: 'idle' }))
    await waitFor(() => expect(document.querySelector('.delegation-note')).toBeNull())
  })

  it('stable shows none of it and asks main nothing', () => {
    owl(false)
    const reads = bridge({ [PARENT]: [view()] })
    vi.stubGlobal('sotto', { delegations: reads.fake })
    mount(stateWith(PARENT))
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeInTheDocument()
    expect(document.querySelector('.delegation-card, .delegated-by, .delegation-note')).toBeNull()
    expect(reads.fake.reads).toEqual([])
    expect(reads.listening()).toBe(0)
  })
})
