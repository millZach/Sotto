import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentState, AgentThread } from '../../../src/shared/agents'
import type { DelegationsBridge, DelegationsChanged, DelegationView } from '../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { DelegationCardProvider, delegationsByTurn, type DelegationCardWorld } from '../../../src/renderer/src/agents/DelegationCards'
import { DelegationStore } from '../../../src/renderer/src/agents/delegations'
import { delegationDuration, delegationWaitLine, stopLabel, stopLine, workingDelegatedThreads } from '../../../src/renderer/src/agents/delegationWords'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
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

function view(patch: Partial<DelegationView> = {}): DelegationView {
  return { id: crypto.randomUUID(), thread: CHILD, action: 'start', work: 'code-review', rootUserMessageId: 'visual-gate-1', anchorMessageId: 'visual-gate-1',
    briefMessageId: 'gate-review-1', outcome: 'working', told: false, createdAt: at(5), waiting: false, ...patch }
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
function bridge(views: Record<string, DelegationView[]>, received: Record<string, DelegationView[]> = {}) {
  const listeners = new Set<(change: DelegationsChanged) => void>()
  const fake: DelegationsBridge & { readonly reads: string[] } = {
    reads: [],
    read: vi.fn(async ({ threadId }: { threadId: string }) => { fake.reads.push(threadId); return { threadId, delegations: views[threadId] ?? [], received: received[threadId] ?? [] } }),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { fake, views, change: (threadIds: string[]) => { for (const listener of [...listeners]) listener({ threadIds }) }, listening: () => listeners.size }
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
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
  it('lists each under the thread that delegated to it, two levels deep, only while delegation is on', () => {
    const state = delegatingState()
    const nested = organizeWorkspace(state, describeThreads(state, NOW), '', null, true).open.find(folder => folder.id === 'workshop')!
    const order = nested.rows.map(row => row.thread.id)
    expect(order.slice(order.indexOf(PARENT), order.indexOf(PARENT) + 3)).toEqual([PARENT, CHILD, GRANDCHILD])
    expect(nested.delegation?.get(CHILD)).toEqual({ level: 1, parent: 'Visual gate flake' })
    expect(nested.delegation?.get(GRANDCHILD)).toEqual({ level: 2, parent: 'Review the gate fix' })
    expect(nested.delegation?.has(PARENT)).toBe(false)
    const flat = organizeWorkspace(state, describeThreads(state, NOW), '', null, false).open.find(folder => folder.id === 'workshop')!
    expect(flat.delegation).toBeUndefined()
    // A delegated thread whose delegating thread is not listed, as when a search leaves it out, stands on its own. (The
    // search keeps Visual gate flake, which waits on the user, without the review it delegated.)
    const searched = organizeWorkspace(state, describeThreads(state, NOW), 'Check the capture', null, true).open.find(folder => folder.id === 'workshop')!
    expect(searched.rows.map(row => row.thread.id)).toEqual([PARENT, GRANDCHILD])
    expect(searched.delegation).toBeUndefined()
  })

  it('indents them with their machine badge and says who delegated them; stable lists them as any other thread', () => {
    owl(true)
    vi.stubGlobal('sotto', { delegations: bridge({}).fake })
    mount(delegatingState())
    openFolder(/^workshop \d+ threads?$/u)
    const row = screen.getByRole('button', { name: 'Review the gate fix' }).closest('li')!
    expect(row).toHaveAttribute('data-delegation-level', '1')
    expect(row).toHaveAttribute('aria-level', '2')
    expect(within(row).getByText('This computer')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review the gate fix' })).toHaveAccessibleDescription(/Delegated by Visual gate flake, on This computer/u)
    expect(screen.getByRole('button', { name: 'Check the capture' }).closest('li')).toHaveAttribute('data-delegation-level', '2')
    cleanup()
    owl(false)
    mount(delegatingState())
    openFolder(/^workshop \d+ threads?$/u)
    expect(document.querySelector('[data-delegation-level]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review the gate fix' })).not.toHaveAccessibleDescription(/Delegated by/u)
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

  it('stable shows none of it and asks main nothing', () => {
    owl(false)
    const reads = bridge({ [PARENT]: [view()] })
    vi.stubGlobal('sotto', { delegations: reads.fake })
    mount(stateWith(PARENT))
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeInTheDocument()
    expect(document.querySelector('.delegation-card, .delegated-by, .delegation-note, [data-delegation-level]')).toBeNull()
    expect(reads.fake.reads).toEqual([])
    expect(reads.listening()).toBe(0)
  })
})
