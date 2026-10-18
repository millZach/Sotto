import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../../src/shared/agents'
import type { DelegatedView, DelegationsBridge, DelegationsChanged, DelegationView } from '../../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentRow, type SubagentsBridge } from '../../../../src/shared/subagents'
import { delegatedBelow, delegatedRoster, mixedRoster, openAction, openDelegatedThread, rosterCounts, threadsMissingStarts, type DelegatedRosterRow, type DelegationReadOf, type DelegationReads } from '../../../../src/renderer/src/tools/delegatedRoster'
import { ToolsPanel, ToolsPanelToggle } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/**
 * Delegated threads in Tools › Agents (ADR-0081, as Zach settled it on October 17, 2026; variant B of the roster
 * prototype): listed with the provider's own agents, newest start first, each opening as a thread.
 */
function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.37-owl.20261017.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: false, 'thread-delegation': on } } } as unknown as AppContextValue)
}

const NOW = E2E_THREADS_NOW
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
const PARENT = 'visual-gate', MERGE = 'pr-merge', SCOUT = 'pr-scout', REVIEW = 'pr-review'

function view(thread: string, minutes: number, patch: Partial<DelegatedView> = {}): DelegatedView {
  return { id: crypto.randomUUID(), thread, action: 'start', work: 'building', rootUserMessageId: 'visual-gate-1', anchorMessageId: 'visual-gate-1',
    briefMessageId: `${thread}-brief`, outcome: 'working', told: false, createdAt: at(minutes), waiting: false, ...patch }
}

/**
 * Visual gate flake delegated a scout (answered, 20 minutes ago) and a merge (working, 13 minutes ago), and the merge
 * delegated a review in turn. The merge thread's reply is in its history and must never show in the roster.
 */
function delegatingState(): AgentState {
  const state = threadsStateFixture()
  const delegated = (id: string, title: string, delegatedBy: string, minutes: number, status: AgentThread['status'], providerId: AgentThread['providerId'] = 'codex'): AgentThread => ({
    id, title, projectId: 'workshop', modelId: 'codex:gpt', providerId, status, delegatedBy, requests: [], updatedAt: at(minutes), reasoningEffort: 'high',
    messages: [{ id: `${id}-brief`, role: 'user', text: `Brief for ${title}`, createdAt: at(minutes) }, { id: `${id}-reply`, role: 'assistant', text: `Reply words of ${title}`, createdAt: at(minutes - 1) }] })
  state.host.threads.push(delegated(SCOUT, 'PR 1121 state scout', PARENT, 20, 'idle'), delegated(MERGE, 'PR 1150 to merge', PARENT, 13, 'running'),
    delegated(REVIEW, 'PR 1150 native review', MERGE, 11, 'idle', 'claude'))
  const parent = state.host.threads.find(thread => thread.id === PARENT)!
  parent.requests = []
  parent.providerId = 'claude'
  return state
}
function views(): Record<string, DelegationView[]> {
  return {
    [PARENT]: [view(SCOUT, 20, { work: 'research', outcome: 'answered', outcomeAt: at(14) }), view(MERGE, 13)],
    [MERGE]: [view(REVIEW, 11, { work: 'code-review', outcome: 'answered', outcomeAt: at(6) })],
  }
}

function delegationsBridge(answers: Record<string, DelegationView[]>, briefs: Record<string, string> = {}) {
  const listeners = new Set<(change: DelegationsChanged) => void>()
  const bridge: DelegationsBridge & { reads: string[] } = {
    reads: [],
    read: vi.fn(async ({ threadId }: { threadId: string }) => { bridge.reads.push(threadId); return { threadId, delegations: answers[threadId] ?? [], received: [] } }),
    brief: vi.fn(async ({ threadId }: { threadId: string }) => briefs[threadId] === undefined ? null : { threadId, text: briefs[threadId] }),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, change: (threadIds: string[]) => { for (const listener of [...listeners]) listener({ threadIds }) } }
}

const agent = (id: string, minutes: number, patch: Partial<SubagentRow> = {}): SubagentRow => ({ id, sequence: 1, revision: 1, assignmentId: `${id}-run`, assignmentCount: 1,
  title: `Agent ${id}`, description: `Work on ${id}`, status: 'running', startedAt: at(minutes), lastObservedAt: at(minutes), model: 'Sonnet', ...patch })
function agentsBridge(rows: SubagentRow[]): SubagentsBridge {
  return {
    page: vi.fn(async ({ threadId }) => ({ threadId, revision: 1, rows, summary: { ...EMPTY_SUBAGENT_SUMMARY, total: rows.length, working: rows.filter(row => row.status === 'running').length } })),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })),
    onChanged: vi.fn(() => () => undefined),
  }
}

beforeEach(() => { vi.mocked(useOptionalApp).mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the roster of delegated threads', () => {
  it('lists the first level newest start first, each with its own delegated threads under it', () => {
    const state = delegatingState()
    const made = new Map(Object.entries(views()).map(([id, list]) => [id, { made: list, received: [] }]))
    const families = delegatedRoster(PARENT, state.host.threads, made, state.host)
    expect(families.map(family => family.map(row => [row.thread.id, row.level]))).toEqual([[[MERGE, 1], [REVIEW, 2]], [[SCOUT, 1]]])
    const [merge, review] = families[0]!
    expect(merge).toMatchObject({ status: 'working', brief: 'Brief for PR 1150 to merge', delegatedBy: undefined })
    expect(merge!.meta).toEqual(expect.arrayContaining(['Codex', 'Building', 'High']))
    expect(merge!.meta.at(-1)).toMatch(/\d:\d\d/u)
    expect(review).toMatchObject({ status: 'answered', delegatedBy: 'PR 1150 to merge', provider: 'Claude Code' })
    expect(review!.meta).toContain('Code review')
    // Before the delegation is read, nothing is guessed: no outcome, no kind of work, no start time.
    const unread = delegatedRoster(PARENT, state.host.threads, new Map(), state.host)[0]![0]!
    expect(unread.status).toBeUndefined()
    expect(unread.meta).not.toContain('Building')
    expect(Number.isNaN(unread.startedAt)).toBe(true)
  })

  it('mixes them with the provider\'s agents by start, each agent keeping the agents under it', () => {
    const state = delegatingState()
    const made = new Map(Object.entries(views()).map(([id, list]) => [id, { made: list, received: [] }]))
    const families = delegatedRoster(PARENT, state.host.threads, made, state.host)
    const blocks = mixedRoster([{ row: agent('newest', 2), depth: 0 }, { row: agent('under', 1, { parentId: 'newest' }), depth: 1 }, { row: agent('oldest', 30), depth: 0 }], families)
    expect(blocks.map(block => block.kind === 'agents' ? block.rows.map(({ row }) => row.id) : block.rows.map(row => row.thread.id)))
      .toEqual([['newest', 'under'], [MERGE, REVIEW], [SCOUT], ['oldest']])
  })

  it('keeps a delegated thread\'s start, time and outcome when its delegating thread\'s read no longer holds the brief that started it', () => {
    const state = delegatingState()
    // Main returns every open delegation but only the newest finished ones: the scout's start is gone, a later send stays.
    const send = view(SCOUT, 3, { action: 'send', outcome: 'answered', outcomeAt: at(2) })
    const parentRead = { made: [send, view(MERGE, 13)], received: [] }
    const reads = new Map<string, DelegationReadOf>([[PARENT, parentRead], [MERGE, { made: [], received: [] }]])
    expect(threadsMissingStarts(PARENT, state.host.threads, reads)).toEqual([SCOUT, REVIEW])
    // Before the scout's own read answers, the later send is never taken for its start.
    const scout = (given: DelegationReads): DelegatedRosterRow => delegatedRoster(PARENT, state.host.threads, given, state.host).flat().find(row => row.thread.id === SCOUT)!
    expect(Number.isNaN(scout(reads).startedAt)).toBe(true)
    expect(scout(reads)).toMatchObject({ status: 'answered', newest: { id: send.id } })
    // Its own read of the briefs it was sent still holds the start.
    const start = view(SCOUT, 20, { work: 'research', outcome: 'answered', outcomeAt: at(14) })
    const withOwn = new Map<string, DelegationReadOf>([...reads, [SCOUT, { made: [], received: [start, send] }]])
    expect(scout(withOwn).startedAt).toBe(Date.parse(start.createdAt))
    expect(scout(withOwn).meta).toContain('Research')
    expect(scout(withOwn).newest?.id).toBe(send.id)
    // Once both reads have answered with nothing of it, its outcome is unknown, and nothing else is guessed.
    const review = delegatedRoster(PARENT, state.host.threads, new Map<string, DelegationReadOf>([...withOwn, [REVIEW, { made: [], received: [] }]]), state.host).flat().find(row => row.thread.id === REVIEW)!
    expect(review.status).toBe('unknown')
    expect(Number.isNaN(review.startedAt)).toBe(true)
  })

  it('says what opening does: as a thread, to answer its request, or that it is in the pane', () => {
    const thread = { title: 'PR 1150 to merge' } as AgentThread
    expect(openAction({ thread, waitingFor: null }, false)).toEqual({ kind: 'open', label: 'Open as thread', name: 'Open PR 1150 to merge as a thread' })
    expect(openAction({ thread, waitingFor: 'approval' }, false)).toEqual({ kind: 'answer', label: 'Open to answer', name: 'Open PR 1150 to merge to answer its request' })
    expect(openAction({ thread, waitingFor: 'question' }, false)).toMatchObject({ kind: 'answer', label: 'Open to answer' })
    expect(openAction({ thread, waitingFor: 'approval' }, true)).toEqual({ kind: 'shown' })
  })

  it('counts delegated threads and agents together, and what needs you', () => {
    const row = (status: DelegatedRosterRow['status']): DelegatedRosterRow => ({ status } as DelegatedRosterRow)
    expect(rosterCounts([row('needs'), row('working'), row('answered'), row('answered')], { total: 2, working: 1, unknown: 0 }))
      .toEqual({ title: '4 delegated threads · 2 agents', detail: '1 needs you · 2 working' })
    expect(rosterCounts([row('answered')], { total: 0, working: 0, unknown: 0 })).toEqual({ title: '1 delegated thread', detail: 'None working' })
  })

  it('marks the delegated threads below a thread that wait on you or work, both levels, from the snapshot', () => {
    const state = delegatingState()
    expect(delegatedBelow(state.host.threads, PARENT)).toEqual({ needs: 0, working: 1 })
    state.host.threads.find(thread => thread.id === REVIEW)!.requests = [{ id: 'merge-permission', kind: 'permission', text: 'gh pr merge', options: [] }]
    expect(delegatedBelow(state.host.threads, PARENT)).toEqual({ needs: 1, working: 1 })
  })

  it('opens a delegated thread in the pane and pins an open Tools to the thread it was opened from', () => {
    const store = new ToolsPanelStore()
    const command = vi.fn(async () => null as unknown as AgentState)
    openDelegatedThread(command, MERGE, PARENT, store)
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: MERGE })
    expect(store.getSnapshot().pinnedThreadId).toBeNull()
    store.setOpen(true)
    openDelegatedThread(command, REVIEW, PARENT, store)
    expect(store.getSnapshot().pinnedThreadId).toBe(PARENT)
  })
})

describe('Tools › Agents with delegated threads', () => {
  function setup(state: AgentState, focused = PARENT, answers = views(), briefs: Record<string, string> = {}) {
    const reads = delegationsBridge(answers, briefs)
    vi.stubGlobal('sotto', { delegations: reads.bridge })
    const store = new ToolsPanelStore()
    const command = vi.fn(async () => state)
    const subagents = agentsBridge([agent('explore', 2)])
    const ui = (focusedThreadId: string) => <div className="thread-workspace__body">
      <section className="thread-pane" data-thread-id={focusedThreadId}><ToolsPanelToggle store={store} state={state} /></section>
      <ToolsPanel focusedThreadId={focusedThreadId} state={state} command={command} subagents={subagents} store={store} />
    </div>
    const view = render(ui(focused))
    act(() => { store.setOpen(true); store.setSurface('agents') })
    return { store, command, reads, rerender: (next: string) => view.rerender(ui(next)) }
  }
  const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Tools' })
  const list = (): HTMLElement => within(panel()).getByRole('list', { name: 'Delegated threads and agents, newest first' })

  it('lists them with the agents, newest first, with their marks, briefs, facts, outcomes and an open control', async () => {
    owl(true)
    const { command, store, reads } = setup(delegatingState())
    await waitFor(() => expect(within(list()).getByRole('button', { name: 'Open PR 1150 to merge as a thread' })).toBeInTheDocument())
    expect(within(panel()).getByText('3 delegated threads · 1 agent')).toBeInTheDocument()
    expect(within(panel()).getByText('2 working')).toBeInTheDocument()
    const order = [...list().querySelectorAll(':scope > li')].map(item => item.getAttribute('data-thread-id') ?? item.getAttribute('data-agent-id'))
    expect(order).toEqual(['explore', MERGE, REVIEW, SCOUT])
    const merge = list().querySelector<HTMLElement>(`[data-thread-id="${MERGE}"]`)!
    expect(within(merge).getByText('Thread')).toBeInTheDocument()
    expect(within(merge).getByText('Brief for PR 1150 to merge')).toBeInTheDocument()
    expect(within(merge).getByText(/^Codex · Building · .*High · \d/u)).toBeInTheDocument()
    expect(within(merge).getByRole('button', { name: 'PR 1150 to merge, delegated thread on Codex, Working' })).toBeInTheDocument()
    const review = list().querySelector<HTMLElement>(`[data-thread-id="${REVIEW}"]`)!
    expect(review).toHaveAttribute('data-nested')
    expect(within(review).getByText('Answered')).toBeInTheDocument()
    // The roster reads what the thread delegated and what its delegated thread delegated, once each.
    expect([...reads.bridge.reads].sort()).toEqual([MERGE, PARENT].sort())
    // A delegated thread's reply never shows here.
    expect(within(panel()).queryByText(/Reply words of/u)).toBeNull()
    // Opening one shows it in the pane and keeps Tools here, pinned to this thread.
    fireEvent.click(within(merge).getByRole('button', { name: 'Open PR 1150 to merge as a thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: MERGE })
    expect(store.getSnapshot().pinnedThreadId).toBe(PARENT)
  })

  it('stays on the pinned thread\'s roster when the delegated thread is in the pane, whose row says In the pane', async () => {
    owl(true)
    const { store, rerender } = setup(delegatingState())
    await waitFor(() => expect(within(list()).getByRole('button', { name: 'Open PR 1150 to merge as a thread' })).toBeInTheDocument())
    act(() => store.pin(PARENT))
    rerender(MERGE)
    const merge = list().querySelector<HTMLElement>(`[data-thread-id="${MERGE}"]`)!
    expect(within(merge).getByText('In the pane')).toBeInTheDocument()
    expect(within(merge).queryByRole('button', { name: /^Open PR 1150 to merge/u })).toBeNull()
    expect(merge.querySelector('.delegated-row')).toHaveAttribute('data-shown')
    expect(within(panel()).getByRole('button', { name: 'Unpin from Visual gate flake' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('marks one that waits on you: Open to answer, the attention edge, and dots on the Agents tab and the Tools toggle', async () => {
    owl(true)
    const state = delegatingState()
    state.host.threads.find(thread => thread.id === REVIEW)!.requests = [{ id: 'merge-question', kind: 'question', text: 'Which branch?', options: [] }]
    setup(state)
    const review = await waitFor(() => { const item = list().querySelector<HTMLElement>(`[data-thread-id="${REVIEW}"]`); expect(item).not.toBeNull(); return item! })
    const answer = within(review).getByRole('button', { name: 'Open PR 1150 native review to answer its request' })
    expect(answer).toHaveTextContent('Open to answer')
    expect(review.querySelector('.delegated-row')).toHaveAttribute('data-needs')
    expect(within(review).getByText('Needs your answer')).toBeInTheDocument()
    expect(within(panel()).getByText('1 needs you · 2 working')).toBeInTheDocument()
    expect(within(panel()).getByRole('tab', { name: 'Agents' })).toHaveAccessibleDescription('A delegated thread needs you')
    expect(panel().querySelector('#tools-tab-agents .tools-rail__live')).toHaveAttribute('data-needs')
    expect(document.querySelector('.tools-toggle__agents-dot')).toHaveAttribute('data-needs')
    // Its details: the brief and the latest outcome, never the reply; Escape closes them.
    const head = within(review).getByRole('button', { name: 'PR 1150 native review, delegated thread on Claude Code, Needs your answer' })
    fireEvent.click(head)
    expect(within(review).getByRole('heading', { name: 'Brief' })).toBeInTheDocument()
    expect(within(review).getByText(/It is waiting for your answer\. Open it to answer there/u)).toBeInTheDocument()
    expect(within(review).getByText(/PR 1150 to merge waited|while PR 1150 to merge waited/u)).toBeInTheDocument()
    expect(within(review).queryByText(/Reply words of/u)).toBeNull()
    fireEvent.keyDown(head, { key: 'Escape' })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveFocus()
  })

  it('reads the whole brief from main when a row is opened, not before', async () => {
    owl(true)
    const whole = `Take PR 1150 to merge. ${'Check every gate before merging. '.repeat(80)}End of brief.`
    const { reads } = setup(delegatingState(), PARENT, views(), { [MERGE]: whole })
    const head = await waitFor(() => within(list()).getByRole('button', { name: 'PR 1150 to merge, delegated thread on Codex, Working' }))
    expect(reads.bridge.brief).not.toHaveBeenCalled()
    fireEvent.click(head)
    await waitFor(() => expect(within(list()).getByText(whole)).toBeInTheDocument())
    expect(reads.bridge.brief).toHaveBeenCalledWith({ threadId: MERGE })
    expect(within(panel()).queryByText(/Reply words of/u)).toBeNull()
  })

  it('reads the brief again when a newer one is sent while the row is open, never leaving the earlier one shown', async () => {
    owl(true)
    const answers = views(), briefs: Record<string, string> = { [MERGE]: 'First brief to merge.' }
    const { reads } = setup(delegatingState(), PARENT, answers, briefs)
    const head = await waitFor(() => within(list()).getByRole('button', { name: 'PR 1150 to merge, delegated thread on Codex, Working' }))
    fireEvent.click(head)
    await waitFor(() => expect(within(list()).getByText('First brief to merge.')).toBeInTheDocument())
    // The parent sends the merge thread a second brief while its details are open.
    answers[PARENT] = [...answers[PARENT]!, view(MERGE, 2, { action: 'send', briefMessageId: `${MERGE}-second` })]
    briefs[MERGE] = 'Second brief to merge.'
    act(() => reads.change([PARENT]))
    await waitFor(() => expect(within(list()).getByText('Second brief to merge.')).toBeInTheDocument())
    expect(within(list()).queryByText('First brief to merge.')).toBeNull()
    expect(reads.bridge.brief).toHaveBeenCalledTimes(2)
  })

  it('keeps the Tools dot for a delegated thread still waiting while you answer another of the pinned roster\'s', async () => {
    owl(true)
    // The scout waits; the merge thread, whose request you just answered, is in the pane, and Tools is pinned to its parent.
    const state = delegatingState()
    state.host.threads.find(thread => thread.id === SCOUT)!.requests = [{ id: 'scout-question', kind: 'question', text: 'Which base?', options: [] }]
    const { store, rerender } = setup(state)
    await waitFor(() => expect(within(list()).getByRole('button', { name: 'Open PR 1121 state scout to answer its request' })).toBeInTheDocument())
    act(() => store.pin(PARENT))
    rerender(MERGE)
    expect(document.querySelector('.tools-toggle__agents-dot')).toHaveAttribute('data-needs')
    // Unpinned, the toggle is the merge thread's own again, and nothing below it waits (#331).
    act(() => store.unpin())
    expect(document.querySelector('.tools-toggle__agents-dot[data-needs]')).toBeNull()
  })

  it('shows none of it in stable: agents alone, following the focused thread, with no pin on Agents', async () => {
    owl(false)
    const { reads } = setup(delegatingState())
    await waitFor(() => expect(within(panel()).getByRole('list', { name: 'Spawned agents' })).toBeInTheDocument())
    expect(panel().querySelector('[data-thread-id]')).toBeNull()
    expect(within(panel()).queryByRole('button', { name: /^Pin to/u })).toBeNull()
    expect(reads.bridge.reads).toEqual([])
  })
})
