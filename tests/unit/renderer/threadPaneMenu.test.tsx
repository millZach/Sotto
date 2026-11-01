import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { openPaneMenu, paneMenuItems } from '../../fixtures/renderer/paneMenu'
import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { machinesConnected, moveSheetStore } from '../../../src/renderer/src/watcher/MoveThreads'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>()
  return { ...original, useWatcherRoom: vi.fn(original.useWatcherRoom) }
})
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>()
  return { ...original, useOptionalApp: vi.fn(original.useOptionalApp) }
})
const THREAD = 'grok-previews'

/** One idle thread of the fixture, on its own, with a provider that can compact and a place to open beside. */
function mount({ beside = true, state = threadsStateFixture(), patch }: { readonly beside?: boolean; readonly state?: AgentState; readonly patch?: Partial<AgentState['host']['threads'][number]> } = {}) {
  if (patch) Object.assign(state.host.threads.find(thread => thread.id === THREAD)!, patch)
  state.activeThreadId = THREAD
  state.host.capabilities = { ...state.host.capabilities, compact: true }
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const command = live.command
  const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === THREAD)!
  const onOpenBeside = vi.fn()
  render(<ThreadPane row={row} state={state} command={command} store={new ThreadDraftStore(command)} focused promptId="prompt" error={null} onOpenBeside={beside ? onOpenBeside : undefined} />)
  const head = (): HTMLElement => document.querySelector('.thread-workspace__head')!
  return { command, onOpenBeside, head, requests: (): AgentCommand[] => command.mock.calls.map(([request]) => request) }
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })
afterEach(cleanup)

describe('the pane header’s More menu', () => {
  it('lists what the beta offers, in groups, with nothing about the hidden voice coordinator', () => {
    const view = mount()
    const menu = openPaneMenu(view.head())
    expect(paneMenuItems(menu)).toEqual(['Open beside', 'Rename', 'Regenerate title', 'Compact context', 'Settle'])
    // Four groups: the layout (ADR-0163), naming the thread, its context, and where it rests.
    expect(menu.querySelectorAll('hr')).toHaveLength(3)
  })

  it('leaves Open beside out where the caller has nowhere to put a second pane', () => {
    const view = mount({ beside: false })
    expect(paneMenuItems(openPaneMenu(view.head()))).toEqual(['Rename', 'Regenerate title', 'Compact context', 'Settle'])
  })

  it('runs the item chosen and closes, and closes on Escape or a pointer outside without running anything', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Compact context' }))
    expect(view.requests()).toContainEqual({ type: 'compact-thread', threadId: THREAD })
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    // Escape returns focus to the button the menu came from, so the keyboard never lands on the page.
    const more = within(view.head()).getByRole('button', { name: 'More actions' })
    fireEvent.keyDown(openPaneMenu(view.head()), { key: 'Escape' })
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    expect(more).toHaveFocus()
    expect(more).toHaveAttribute('aria-expanded', 'false')
    openPaneMenu(view.head())
    expect(more).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(document.body)
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    expect(view.requests().filter(request => request.type === 'compact-thread')).toHaveLength(1)
  })

  it('renames in place from the menu, which is where the header keeps its name', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Rename' }))
    const field = within(view.head()).getByRole('textbox', { name: 'Rename Grok voice previews' })
    fireEvent.change(field, { target: { value: 'Voice previews' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(view.requests()).toContainEqual({ type: 'rename-thread', threadId: THREAD, title: 'Voice previews' })
  })

  it('opens the thread beside this one through the caller’s own handler', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Open beside' }))
    expect(view.onOpenBeside).toHaveBeenCalledOnce()
  })
})

describe('Continue on another machine… (#1178 part 2, Owl Work across machines)', () => {
  const FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10'
  afterEach(() => { machinesConnected.clear(); moveSheetStore.close(); vi.mocked(useOptionalApp).mockReset(); vi.mocked(useWatcherRoom).mockReset(); delete (window as unknown as { sotto?: unknown }).sotto })
  const offer = (phase: 'connected' | 'disconnected') => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'cross-machine-work': true, watcher: true } } } as unknown as ReturnType<typeof useOptionalApp>)
    vi.mocked(useWatcherRoom).mockReturnValue({ state: { current: { createdAt: '2026-10-29T14:00:00.000Z' } } } as unknown as ReturnType<typeof useWatcherRoom>)
    const hosts = hostsBridgeFixture({ initial: hostsState({ hosts: [hostStatus({ id: FORGE, hostId: FORGE, name: 'forge', phase })] }) }).bridge
    ;(window as unknown as { sotto: unknown }).sotto = { hosts, threadMoves: { prepare: vi.fn(), start: vi.fn(), read: vi.fn(async () => ({ cards: [] })), answer: vi.fn(), onChanged: vi.fn(() => () => undefined) } }
  }
  it('opens Move threads’ sheet for this one thread while another machine is connected', async () => {
    offer('connected')
    const view = mount()
    await act(async () => { await Promise.resolve() })
    const menu = openPaneMenu(view.head())
    expect(paneMenuItems(menu)).toContain('Continue on another machine…')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Continue on another machine…' }))
    expect(moveSheetStore.get()).toMatchObject({ kind: 'one', threadId: THREAD })
  })
  it('is offered for a connected host’s thread, which can always come to This computer, naming its machine (part 3)', async () => {
    offer('disconnected')
    const LAB = '3f2a9c71-6e4b-4d18-9a52-7b1c0e8d6f24'
    const view = mount({ patch: { remoteHost: true, hostId: LAB, hostLabel: 'lab' } })
    await act(async () => { await Promise.resolve() })
    const menu = openPaneMenu(view.head())
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Continue on another machine…' }))
    expect(moveSheetStore.get()).toMatchObject({ kind: 'one', threadId: THREAD, hostId: LAB })
  })
  it('is left out while no other machine is connected', async () => {
    offer('disconnected')
    const view = mount()
    await act(async () => { await Promise.resolve() })
    expect(paneMenuItems(openPaneMenu(view.head()))).not.toContain('Continue on another machine…')
  })
})

describe('the manual composer', () => {
  it('writes by hand even in a thread the saved state says Sotto manages', () => {
    const state = threadsStateFixture()
    state.activeThreadId = 'visual-gate'

    const live = liveAgentState(state)
    vi.mocked(useAgents).mockImplementation(live.useLive)
    const row = describeThreads(live.state, E2E_THREADS_NOW).find(item => item.thread.id === 'visual-gate')!
    expect(row).not.toHaveProperty('assignment')
    render(<ThreadPane row={row} state={live.state} command={live.command} store={new ThreadDraftStore(live.command)} focused promptId="manual" error={null} />)
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveAttribute('id', 'manual')
    expect(screen.queryByRole('button', { name: 'Write here' })).toBeNull()
  })

  it.each([false, true])('keeps one branch toolbar in the right place with quiet composer %s', quiet => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'quiet-composer': quiet } } } as unknown as ReturnType<typeof useOptionalApp>)
    const state = threadsStateFixture()
    const thread = state.host.threads.find(item => item.id === THREAD)!
    thread.nativeSessionStarted = false
    thread.messages = []
    thread.worktree = { mode: 'independent', status: 'pending', baseBranch: 'main' }
    const view = mount({ state })
    const toolbar = screen.getByRole('group', { name: 'Branch toolbar' })
    const compose = document.querySelector('.thread-workspace__compose')!
    expect(view.head().contains(toolbar)).toBe(quiet)
    expect(compose.contains(toolbar)).toBe(!quiet)
    expect(document.querySelector('.thread-prompt')?.hasAttribute('data-quiet')).toBe(quiet)
    expect(document.querySelectorAll('.branch-toolbar')).toHaveLength(1)
    expect(toolbar).toContainElement(screen.getByRole('combobox', { name: 'Choose branch' }))
    fireEvent.click(within(toolbar).getByRole('combobox', { name: 'Choose workspace' }))
    fireEvent.click(screen.getByRole('option', { name: 'Current checkout' }))
    expect(view.requests()).toContainEqual({ type: 'configure-thread-working-copy', threadId: THREAD, workingCopy: 'shared' })
  })

  it('draws Zach\'s composer under an answer too, with the branch controls in the pane header', () => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'quiet-composer': true } } } as unknown as ReturnType<typeof useOptionalApp>)
    const state = threadsStateFixture()
    const thread = state.host.threads.find(item => item.id === THREAD)!
    thread.nativeSessionStarted = false
    thread.worktree = { mode: 'independent', status: 'pending', baseBranch: 'main' }
    thread.requests = [{ id: 'question', kind: 'question', text: 'Which folder should I use?', options: [] }]
    thread.status = 'running'
    const view = mount({ state })
    const toolbar = screen.getByRole('group', { name: 'Branch toolbar' })
    expect(document.querySelector('.thread-prompt')).toHaveAttribute('data-quiet')
    expect(view.head()).toContainElement(toolbar)
  })

  it('draws Zach\'s composer: the prompt above, permissions before the model, and the disc as Stop while a turn runs with nothing typed', () => {
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'quiet-composer': true } } } as unknown as ReturnType<typeof useOptionalApp>)
    const state = threadsStateFixture()
    state.host.capabilities.configureThread = true
    const thread = state.host.threads.find(item => item.id === THREAD)!
    thread.status = 'running'
    thread.requests = []
    state.host.models.find(model => model.id === thread.modelId)!.runtimeModes = ['approval-required', 'full-access']
    mount({ state })
    const form = document.querySelector('form.thread-prompt')!
    expect(form.querySelector('.thread-prompt__lead')).toBeNull()
    const shield = screen.getByRole('combobox', { name: 'Thread permissions' })
    const model = form.querySelector('.model-picker__trigger')!
    // In the footer, in the order the eye and Tab take them: permissions, the model, then the disc.
    expect(shield.closest('.thread-prompt__shield')).not.toBeNull()
    expect(shield.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const actions = form.querySelector('.thread-prompt__actions')!
    expect([...actions.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['Stop agent'])
    const stop = screen.getByRole('button', { name: 'Stop agent' })
    expect(stop).toHaveClass('thread-prompt__disc')
    expect(stop).toHaveAttribute('data-face', 'stop')
    expect(screen.queryByRole('button', { name: 'Queue prompt' })).toBeNull()
  })
})
