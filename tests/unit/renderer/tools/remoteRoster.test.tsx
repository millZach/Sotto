import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../../src/shared/agents'
import type { DelegatedView, DelegationsBridge, DelegationsChanged, DelegationsRead, DelegationView } from '../../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentsBridge } from '../../../../src/shared/subagents'
import { delegatedRoster, machineCount, rosterByMachine, rosterCounts, rosterMachine, THIS_COMPUTER, type DelegationReadOf } from '../../../../src/renderer/src/tools/delegatedRoster'
import { delegatedStatusWord } from '../../../../src/renderer/src/tools/DelegatedThreads'
import { askedFor, delegationRefusalLine, heldLine, heldOutcome, lastReadOutcome } from '../../../../src/renderer/src/agents/delegationWords'
import { clockLabel } from '../../../../src/renderer/src/agents/threadFacts'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { DelegationCardProvider, delegationsByTurn, type DelegationCardWorld } from '../../../../src/renderer/src/agents/DelegationCards'
import { MessageList, type ActivityContext } from '../../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../../src/renderer/src/agents/threadActivityView'
import type { AgentMessage } from '../../../../src/shared/agents'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/**
 * A remote parent's delegated threads in Tools › Agents (#1310, Zach's pick on October 23, 2026: variant B of the remote
 * roster prototype): grouped under a heading per machine with a count; when that machine is not connected, each keeps its
 * last outcome greyed ("Working when last read"), as of when Sotto lost it. Stable shows none of it.
 */
function owl(crossMachine: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.40-owl.20261023.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: false, 'thread-delegation': true, 'cross-machine-work': crossMachine } } } as unknown as AppContextValue)
}

const NOW = E2E_THREADS_NOW
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
const FORGE = '33333333-3333-4333-8333-333333333333', LOCAL = '44444444-4444-4444-8444-444444444444'
const PARENT = 'visual-gate', REVIEW = 'forge-review', TESTS = 'forge-tests', LIST = 'forge-list'
const LOST = Date.parse(at(2))

function view(thread: string, minutes: number, patch: Partial<DelegatedView> = {}): DelegatedView {
  return { id: crypto.randomUUID(), thread, action: 'start', work: 'building', rootUserMessageId: 'visual-gate-1', anchorMessageId: 'visual-gate-1',
    briefMessageId: `${thread}-brief`, outcome: 'working', told: false, createdAt: at(minutes), waiting: false, ...patch }
}

/** The parent runs on forge and delegated a review (working, held to Ask for approval), the tests (failed), and the review a list (answered). */
function remoteState(connected = true): AgentState {
  const state = threadsStateFixture()
  const onForge = { remoteHost: true, hostId: FORGE, hostLabel: 'forge' } as const
  const delegated = (id: string, title: string, delegatedBy: string, minutes: number, status: AgentThread['status']): AgentThread => ({
    id, title, projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status, delegatedBy, requests: [], updatedAt: at(minutes), reasoningEffort: 'high', ...onForge,
    messages: [{ id: `${id}-brief`, role: 'user', text: `Brief for ${title}`, createdAt: at(minutes) }] })
  state.host.threads.push(delegated(REVIEW, 'Review the socket changes', PARENT, 12, 'running'), delegated(TESTS, 'Run the contract tests', PARENT, 20, 'idle'),
    delegated(LIST, 'List the agents-view fields', REVIEW, 10, 'idle'))
  const parent = state.host.threads.find(thread => thread.id === PARENT)!
  Object.assign(parent, onForge, { requests: [], providerId: 'claude' })
  state.connections = [{ hostId: '44444444-4444-4444-8444-444444444444', name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected }]
  return state
}
function answers(): Record<string, DelegationView[]> {
  return {
    [PARENT]: [view(TESTS, 20, { outcome: 'failed', outcomeAt: at(18) }), view(REVIEW, 12, { work: 'code-review', held: 'not-told' }),
      { id: crypto.randomUUID(), action: 'start', work: 'building', outcome: 'refused', refusal: 'MACHINE_UNAVAILABLE', provider: 'codex', asked: { machine: LOCAL }, createdAt: at(11), anchorMessageId: 'visual-gate-1' }],
    [REVIEW]: [view(LIST, 10, { work: 'research', outcome: 'answered', outcomeAt: at(8) })],
  }
}
const reads = (lastReadAt?: number): Map<string, DelegationReadOf> => new Map(Object.entries(answers()).map(([id, made]) => [id, { made, received: [], ...lastReadAt === undefined ? {} : { lastReadAt } }]))

beforeEach(() => { vi.mocked(useOptionalApp).mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a remote parent\'s roster', () => {
  it('names each row\'s machine and groups the roster per machine only where Work across machines is on and another machine is in it', () => {
    const state = remoteState()
    const machineOf = (thread: AgentThread) => rosterMachine(state.connections, thread)
    const families = delegatedRoster(PARENT, state.host.threads, reads(), state.host, machineOf)
    expect(families.flat().map(row => [row.thread.id, row.machine.name, row.machine.connected, row.lastRead])).toEqual([
      [REVIEW, 'forge', true, false], [LIST, 'forge', true, false], [TESTS, 'forge', true, false]])
    const owner = machineOf(state.host.threads.find(thread => thread.id === PARENT)!)
    expect(rosterByMachine(owner, families, reads(), reads().get(PARENT), false)).toBeNull()
    const groups = rosterByMachine(owner, families, reads(), reads().get(PARENT), true)!
    expect(groups.map(group => [group.machine.name, group.own, group.families.length, group.olderHost])).toEqual([['forge', true, 2, false]])
    expect(machineCount(groups[0]!, { total: 0, working: 0 })).toBe('3 threads · 1 working')
    expect(machineCount(groups[0]!, { total: 2, working: 1 })).toBe('3 threads · 2 agents · 2 working')
    // A roster of this computer's threads alone keeps its single list.
    const local = threadsStateFixture()
    expect(rosterByMachine(THIS_COMPUTER, delegatedRoster(PARENT, local.host.threads, new Map(), local.host), new Map(), undefined, true)).toBeNull()
  })

  it('keeps each row\'s last outcome while its machine is not connected, greyed, as of when Sotto lost it', () => {
    const state = remoteState(false)
    const machineOf = (thread: AgentThread) => rosterMachine(state.connections, thread)
    const rows = delegatedRoster(PARENT, state.host.threads, reads(LOST), state.host, machineOf).flat()
    const review = rows.find(row => row.thread.id === REVIEW)!
    expect(review).toMatchObject({ status: 'working', lastRead: true, asOf: LOST, machine: { name: 'forge', connected: false } })
    expect(delegatedStatusWord(review)).toBe('Working when last read')
    expect(delegatedStatusWord(rows.find(row => row.thread.id === TESTS)!)).toBe('Failed when last read')
    expect(lastReadOutcome('forge', 'working', LOST)).toBe(`It was working at ${clockLabel(LOST)}, when Sotto last read it. forge is not connected, so Sotto cannot read how it went since. It reads it again when forge reconnects.`)
    const groups = rosterByMachine(machineOf(state.host.threads.find(thread => thread.id === PARENT)!), [rows.filter(row => row.level === 1)], reads(LOST), undefined, true)!
    // Not connected: no count of what is working, which Sotto cannot know, in the heading or the line of chrome.
    expect(machineCount(groups[0]!, undefined)).toBe('2 threads')
    expect(rosterCounts(rows, { total: 0, working: 0, unknown: 0 }).detail).toBe('None working')
    // A machine reconnecting is not connected either.
    const reconnecting = { ...state.host.threads.find(thread => thread.id === REVIEW)!, clientReconnecting: true }
    expect(rosterMachine(remoteState().connections, reconnecting).connected).toBe(false)
  })

  it('reads Unknown for a thread both of whose reads answered from its host without it, and stands in the snapshot otherwise', () => {
    const state = remoteState(true)
    const machineOf = (thread: AgentThread) => rosterMachine(state.connections, thread)
    const tests = (given: Map<string, DelegationReadOf>) => delegatedRoster(PARENT, state.host.threads, given, state.host, machineOf).flat().find(row => row.thread.id === TESTS)!
    // The host's record trimmed its ended start: both reads answered, neither holds it.
    expect(tests(new Map([[PARENT, { made: [], received: [] }], [TESTS, { made: [], received: [] }]])).status).toBe('unknown')
    // An older host, or a read not answered yet: the snapshot stands in (idle, so no word).
    expect(tests(new Map([[PARENT, { made: [], received: [], unread: 'older-host' }], [TESTS, { made: [], received: [], unread: 'older-host' }]])).status).toBeUndefined()
    expect(tests(new Map([[PARENT, { made: [], received: [] }]])).status).toBeUndefined()
  })

  it('greys a row read from what Sotto last read even while its machine stays connected, as when a read there failed', () => {
    const state = remoteState(true)
    const rows = delegatedRoster(PARENT, state.host.threads, reads(LOST), state.host, thread => rosterMachine(state.connections, thread)).flat()
    const review = rows.find(row => row.thread.id === REVIEW)!
    expect(review).toMatchObject({ lastRead: true, asOf: LOST, machine: { connected: true } })
    expect(delegatedStatusWord(review)).toBe('Working when last read')
    // Not counted as working now, in the heading or the line of chrome.
    const groups = rosterByMachine(review.machine, [rows.filter(row => row.level === 1)], reads(LOST), undefined, true)!
    expect(machineCount(groups[0]!, undefined)).toBe('2 threads')
    expect(rosterCounts(rows, { total: 0, working: 0, unknown: 0 }).detail).toBe('None working')
    expect(lastReadOutcome('forge', 'working', LOST, true)).toBe(`It was working at ${clockLabel(LOST)}, when Sotto last read it. Sotto could not read it again on forge just now. It reads it again when forge says it changed.`)
  })

  it('says why a start there began at Ask for approval, and why another machine was refused, in the prototype\'s words', () => {
    expect(heldLine('not-told', 'forge')).toBe('Started at Ask for approval: forge had no new-thread default from this computer yet.')
    // The reason only, until a control of its own lets this computer answer there (#1447).
    expect(heldLine('no-answer-grant', 'forge')).toBe("Held at Ask for approval: this computer can't answer on forge.")
    expect(heldOutcome('no-answer-grant', 'forge')).not.toMatch(/Settings|SSH/u)
    // It promises no more than is true: a later start is still held where this computer cannot answer there.
    expect(heldOutcome('not-told', 'forge')).toBe("forge hasn't had this computer's defaults yet. It gets them the next time this computer connects to it; new threads there use them from then, unless this computer can't answer there.")
    // A grant taken away is said as such, with no fix that cannot work.
    expect(heldLine('answers-revoked', 'forge')).toBe('Held at Ask for approval: forge no longer lets this computer answer there.')
    expect(heldOutcome('answers-revoked', 'forge')).not.toMatch(/Settings/u)
    // The machine or system it asked for, by the window's names (Zach, October 23, 2026).
    const names = (hostId: string) => hostId === FORGE ? 'forge' : hostId === LOCAL ? 'this computer' : undefined
    expect(delegationRefusalLine({ action: 'start', refusal: 'MACHINE_UNAVAILABLE' }, 'forge', askedFor({ machine: LOCAL }, names)))
      .toBe('Asked for this computer. forge can start threads only on forge for now. Nothing was started.')
    expect(askedFor({ os: 'macos' }, names)).toBe('a Mac')
    expect(askedFor({ machine: '55555555-5555-4555-8555-555555555555' }, names)).toBe('another machine')
    // A record from before it kept what was asked for keeps the prototype's words.
    expect(delegationRefusalLine({ action: 'start', refusal: 'MACHINE_UNAVAILABLE' }, 'forge'))
      .toBe('This thread runs on forge, and a thread on forge can start threads only on forge. Nothing was started. Ask again without naming a machine to start it on forge.')
    // A thread on this computer keeps its own words.
    expect(delegationRefusalLine({ action: 'start', refusal: 'MACHINE_UNAVAILABLE' })).toMatch(/^The machine or system it asked for could not take it/u)
  })
})

describe('the cards under a remote parent\'s reply', () => {
  const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
  const messages: AgentMessage[] = [{ id: 'visual-gate-1', role: 'user', text: 'Tidy the docs.', createdAt: at(14) }, { id: 'reply', role: 'assistant', text: 'Started them on forge.', createdAt: at(13) }]
  const review = { id: REVIEW, title: 'Review the socket changes', projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'running', messages: [], requests: [], remoteHost: true, hostId: FORGE } as AgentThread
  const world = (away?: DelegationCardWorld['away']): DelegationCardWorld => ({ thread: id => id === REVIEW ? review : undefined, hostName: () => 'forge', open: vi.fn(), liveClock: false, now: NOW, away,
    machineName: hostId => hostId === LOCAL ? 'this computer' : undefined })
  const cards = (): ReturnType<typeof delegationsByTurn> => delegationsByTurn(answers()[PARENT]!, messages)

  it('names forge, says why a start began at Ask for approval, and words the refusal for another machine', () => {
    render(<DelegationCardProvider world={world({ name: 'forge', connected: true, lastReadAt: Number.NaN })}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} delegations={cards()} /></DelegationCardProvider>)
    const card = screen.getByRole('group', { name: 'Delegated to Review the socket changes' })
    expect(card.querySelector('.delegation-card__meta')).toHaveTextContent('Codex·forge')
    expect(card.querySelector('.delegation-card__outcome')).toHaveTextContent('Working')
    expect(card.querySelector('.delegation-card__held')).toHaveTextContent('Started at Ask for approval: forge had no new-thread default from this computer yet.')
    const refused = screen.getByRole('note', { name: 'Not delegated: Building' })
    expect(refused).toHaveTextContent('Asked for this computer. forge can start threads only on forge for now. Nothing was started.')
    // It names no machine it could have started on: none was.
    expect(refused.querySelector('.delegation-card__machine')).toBeNull()
  })

  it('greys a card read from what Sotto last read while forge stays connected', () => {
    render(<DelegationCardProvider world={world({ name: 'forge', connected: true, lastReadAt: LOST })}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} delegations={cards()} /></DelegationCardProvider>)
    const card = screen.getByRole('group', { name: 'Delegated to Review the socket changes' })
    expect(card.querySelector('.delegation-card__outcome')).toHaveTextContent('Working when last read')
    expect(card.querySelector('.delegation-ring')).toHaveAttribute('data-last-read')
    expect(card.querySelector('.delegation-card__wait')).toHaveTextContent('Sotto could not read it again on forge just now.')
  })

  it('keeps the last outcome greyed while forge is not connected, and says how it stood then', () => {
    render(<DelegationCardProvider world={world({ name: 'forge', connected: false, lastReadAt: LOST })}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])} context={context} delegations={cards()} /></DelegationCardProvider>)
    const card = screen.getByRole('group', { name: 'Delegated to Review the socket changes' })
    const outcome = card.querySelector('.delegation-card__outcome')!
    expect(outcome).toHaveTextContent('Working when last read')
    expect(outcome).toHaveAttribute('data-last-read')
    expect(card.querySelector('.delegation-card__wait')).toHaveTextContent(`It was working at ${clockLabel(LOST)}, when Sotto last read it. forge is not connected, so Sotto cannot read how it went since. It reads it again when forge reconnects.`)
  })
})

describe('Tools › Agents for a remote parent', () => {
  function setup(state: AgentState, read: (threadId: string) => Partial<DelegationsRead> = () => ({})) {
    const listeners = new Set<(change: DelegationsChanged) => void>()
    const bridge: DelegationsBridge = {
      read: vi.fn(async ({ threadId }: { threadId: string }) => ({ threadId, delegations: answers()[threadId] ?? [], received: [], ...read(threadId) })),
      brief: vi.fn(async () => null),
      onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    vi.stubGlobal('sotto', { delegations: bridge })
    const store = new ToolsPanelStore()
    const subagents: SubagentsBridge = { page: vi.fn(async ({ threadId }) => ({ threadId, revision: 1, rows: [], summary: EMPTY_SUBAGENT_SUMMARY })),
      assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })), onChanged: vi.fn(() => () => undefined) }
    const ui = (next: AgentState) => <div className="thread-workspace__body"><ToolsPanel focusedThreadId={PARENT} state={next} command={vi.fn(async () => next)} subagents={subagents} store={store} /></div>
    const view = render(ui(state))
    act(() => { store.setOpen(true); store.setSurface('agents') })
    return { bridge, rerender: (next: AgentState) => view.rerender(ui(next)), change: (threadIds: string[]) => { for (const listener of [...listeners]) listener({ threadIds }) } }
  }
  const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Tools' })

  it('groups them under forge with its count, with the held line, and opens a row to the held reason', async () => {
    owl(true)
    setup(remoteState())
    const group = await screen.findByRole('region', { name: /^forge/u })
    expect(within(group).getByRole('heading', { level: 3 })).toHaveTextContent('forge3 threads · 1 working')
    const list = within(group).getByRole('list', { name: 'Delegated threads on forge, newest first' })
    const review = list.querySelector<HTMLElement>(`[data-thread-id="${REVIEW}"]`)!
    expect(within(review).getByText('Started at Ask for approval: forge had no new-thread default from this computer yet.')).toBeInTheDocument()
    const head = within(review).getByRole('button', { name: /^Review the socket changes, delegated thread on Codex, Working, Started at Ask for approval/u })
    fireEvent.click(head)
    expect(within(review).getByText(/^forge hasn't had this computer's defaults yet\. It gets them the next time this computer connects to it/u)).toBeInTheDocument()
    // Escape closes it and gives the focus back to the row.
    fireEvent.keyDown(head, { key: 'Escape' })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(panel().querySelector('.roster-notice')).toBeNull()
  })

  it('keeps the rows greyed with their last outcome while forge is not connected, and says so above them', async () => {
    owl(true)
    setup(remoteState(false), () => ({ lastRead: new Date(LOST).toISOString() }))
    const group = await screen.findByRole('region', { name: /^forge/u })
    await waitFor(() => expect(within(group).getByText('Working when last read')).toBeInTheDocument())
    expect(within(group).getByRole('heading', { level: 3 })).toHaveTextContent('forge3 threadsnot connected')
    const review = group.querySelector<HTMLElement>(`[data-thread-id="${REVIEW}"]`)!
    expect(review).toHaveAttribute('data-last-read')
    expect(within(review).getByText(`as of ${clockLabel(LOST)}`)).toBeInTheDocument()
    expect(within(review).getByText('Working when last read')).toHaveAttribute('data-last-read')
    // The held line is not repeated on a row that is only as Sotto last read it.
    expect(within(review).queryByText(/^Started at Ask for approval/u)).toBeNull()
    expect(panel().querySelector('.roster-notice')).toHaveTextContent(`forge is not connected. These threads are as Sotto last read them at ${clockLabel(LOST)}. Losing the connection stops nothing on forge.`)
    fireEvent.click(within(review).getByRole('button', { name: /^Review the socket changes, delegated thread on Codex, Working when last read/u }))
    expect(within(review).getByText(/^It was working at .*, when Sotto last read it\. forge is not connected/u)).toBeInTheDocument()
    expect(within(review).getByText('The start of the brief, as Sotto last read it from forge.')).toBeInTheDocument()
  })

  it('says plainly when forge\'s Sotto does not report its threads\' delegations', async () => {
    owl(true)
    setup(remoteState(), () => ({ delegations: [], unread: 'older-host' }))
    const group = await screen.findByRole('region', { name: /^forge/u })
    await waitFor(() => expect(within(group).getByText(/^forge’s Sotto does not report how these threads’ delegations stand/u)).toBeInTheDocument())
    // Its rows show as before: what the snapshot says, Working while a turn runs.
    expect(within(group).getByRole('button', { name: 'Review the socket changes, delegated thread on Codex, Working' })).toBeInTheDocument()
  })

  it('shows none of it in stable: one list, no heading, no last-read words', async () => {
    owl(false)
    setup(remoteState(false), () => ({ lastRead: new Date(LOST).toISOString() }))
    await waitFor(() => expect(within(panel()).getByRole('list', { name: 'Delegated threads and agents, newest first' })).toBeInTheDocument())
    expect(within(panel()).queryByRole('region', { name: /^forge/u })).toBeNull()
    expect(within(panel()).queryByText(/when last read/u)).toBeNull()
    expect(panel().querySelector('.roster-notice')).toBeNull()
  })
})
