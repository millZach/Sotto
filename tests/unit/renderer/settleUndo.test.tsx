import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { describeThreads, holdSettledRows, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { SETTLE_UNDO_MS, settleOffers } from '../../../src/renderer/src/agents/settleUndo'
import { SettleToast } from '../../../src/renderer/src/agents/SettleToast'
import { GAP_CLOSE_MS } from '../../../src/renderer/src/agents/settleGap'
import { openSidebarFolders, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(() => null),
}))

/**
 * After a Settle the user pressed (ADR-0167, Zach's pick B of #1826): the row's place stays empty while the pointer stays
 * over the list, and a toast at the sidebar's foot offers Undo, which is Restore. The nested desktop proves the pointer
 * itself in tests/e2e/settle-undo.spec.ts; these hold the rules a browser is not needed for.
 */
const now = E2E_THREADS_NOW
const settledAt = new Date(now).toISOString()
const pointerOver = { list: false, toast: false }
const matches = Element.prototype.matches
beforeEach(() => {
  pointerOver.list = false
  pointerOver.toast = false
  // jsdom has no pointer to be over anything: `:hover` on the sidebar's scroll area and on the toast answers for it here.
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    if (selector === ':hover') return (pointerOver.list && this.classList.contains('thread-nav__scroll')) || (pointerOver.toast && this.classList.contains('thread-nav__toast'))
    return matches.call(this, selector)
  })
})
afterEach(() => {
  const offer = settleOffers.get()
  if (offer) settleOffers.dismiss(offer.id)
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(useOptionalApp).mockReturnValue(null)
  document.documentElement.removeAttribute('data-reduced-motion')
})

/** The design fixture's sidebar over a state that settles and restores the way main does, and the commands it got. */
/** `refuse` answers a command with main's refusal; `lose` carries it out but loses its answer, as a dropped reply would. */
function mount(patch: (state: AgentState) => void = () => undefined, refuse: Partial<Record<AgentCommand['type'], string>> = {}, lose: readonly AgentCommand['type'][] = []) {
  const initial = threadsStateFixture()
  patch(initial)
  openSidebarFolders(initial)
  const commands: AgentCommand[] = []
  let current = initial
  let publish: (state: AgentState) => void = () => undefined
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState> => {
    commands.push(request)
    const refusal = refuse[request.type]
    if (refusal !== undefined) return { ...current, error: refusal }
    if (request.type === 'preview-reclaim-thread-worktree') {
      const worktree = current.host.threads.find(thread => thread.id === request.threadId)?.worktree
      return { ...current, worktreeReclaimPreview: { path: worktree?.path ?? '', ...worktree?.branch ? { branch: worktree.branch } : {}, dirty: false, ignored: [], items: [], repositories: [], untracked: [] } }
    }
    if (request.type === 'settle-thread' || request.type === 'restore-thread') {
      const settling = request.type === 'settle-thread'
      current = { ...current, host: { ...current.host, threads: current.host.threads.map((thread): AgentThread => thread.id === request.threadId ? { ...thread, workspaceSettledAt: settling ? settledAt : null } : thread) } }
      publish(current)
    }
    return lose.includes(request.type) ? null as unknown as AgentState : current
  })
  function Sidebar() {
    const [state, setState] = useState(initial)
    publish = setState
    return <ThreadSidebar state={state} command={command} organization={organizeWorkspace(state, describeThreads(state, now), '', state.activeProjectId)}
      query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} currentThreadId="visual-gate" openThreadIds={['visual-gate']} onOpenBeside={vi.fn()} onDragThread={vi.fn()} shortcutsLive />
  }
  const view = render(<Sidebar />)
  return { commands, projects: () => within(screen.getByRole('region', { name: 'Projects' })), unmount: view.unmount }
}

/** A press of the row's hover Settle with the pointer over the list, as a mouse makes it. */
function pointerSettle(title: string): void {
  pointerOver.list = true
  const button = screen.getByRole('button', { name: `Settle ${title}` })
  fireEvent.pointerDown(button)
  fireEvent.click(button)
}

/** The settle toast, at the sidebar's foot. */
const toast = (): HTMLElement => document.querySelector<HTMLElement>('.thread-nav__toast [role="status"]')!

describe('the held gap', () => {
  it('keeps a settled row\'s place empty while the pointer stays over the list, and closes once it leaves', async () => {
    const { projects, commands } = mount()
    const order = (): string[] => [...document.querySelectorAll('.thread-folder[data-section="open"] li')].map(item => item.classList.contains('thread-nav__gap') ? 'gap' : item.querySelector('.thread-nav__title')?.textContent ?? '')
    const before = order()
    expect(before.slice(0, 3)).toEqual(['Visual gate flake', 'Grok voice previews', 'Streaming WAV stall'])
    pointerSettle('Grok voice previews')
    await waitFor(() => expect(projects().queryByRole('button', { name: 'Grok voice previews' })).not.toBeInTheDocument())
    // The place stays, holding nothing a screen reader or a click can reach; the folder counts its open threads.
    expect(order().slice(0, 3)).toEqual(['Visual gate flake', 'gap', 'Streaming WAV stall'])
    expect(document.querySelector('.thread-nav__gap')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelector('.thread-nav__gap button')).toBeNull()
    expect(projects().getByRole('button', { name: /^workshop 2 threads$/ })).toBeVisible()
    fireEvent.click(document.querySelector('.thread-nav__gap')!)
    expect(commands.filter(request => request.type === 'settle-thread')).toEqual([{ type: 'settle-thread', threadId: 'grok-previews' }])
    // The pointer leaves the list: the gap folds away, and the next row moves up into it.
    vi.useFakeTimers()
    pointerOver.list = false
    fireEvent.pointerLeave(document.querySelector('.thread-nav__scroll')!)
    expect(document.querySelector('.thread-nav__gap')).toHaveAttribute('data-closing', 'true')
    act(() => { vi.advanceTimersByTime(GAP_CLOSE_MS) })
    expect(document.querySelector('.thread-nav__gap')).toBeNull()
    expect(order().slice(0, 2)).toEqual(['Visual gate flake', 'Streaming WAV stall'])
  })

  it('closes at once under reduced motion', async () => {
    document.documentElement.dataset.reducedMotion = 'on'
    mount()
    pointerSettle('Grok voice previews')
    await waitFor(() => expect(document.querySelector('.thread-nav__gap')).not.toBeNull())
    pointerOver.list = false
    fireEvent.pointerLeave(document.querySelector('.thread-nav__scroll')!)
    expect(document.querySelector('.thread-nav__gap')).toBeNull()
  })

  it('holds nothing for a Settle from the keyboard, or for a pointer that is not over the list', async () => {
    const { projects } = mount()
    pointerOver.list = true
    const button = screen.getByRole('button', { name: 'Settle Grok voice previews' })
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.click(button)
    await waitFor(() => expect(projects().queryByRole('button', { name: 'Grok voice previews' })).not.toBeInTheDocument())
    expect(document.querySelector('.thread-nav__gap')).toBeNull()
    pointerOver.list = false
    const next = screen.getByRole('button', { name: 'Settle Streaming WAV stall' })
    fireEvent.pointerDown(next)
    fireEvent.click(next)
    await waitFor(() => expect(projects().queryByRole('button', { name: 'Streaming WAV stall' })).not.toBeInTheDocument())
    expect(document.querySelector('.thread-nav__gap')).toBeNull()
  })

  it('lets the gap go as soon as its thread comes back', async () => {
    const { projects } = mount()
    pointerSettle('Grok voice previews')
    await waitFor(() => expect(document.querySelector('.thread-nav__gap')).not.toBeNull())
    fireEvent.click(within(toast()).getByRole('button', { name: 'Undo: restore Grok voice previews' }))
    await waitFor(() => expect(projects().getByRole('button', { name: 'Grok voice previews' })).toBeVisible())
    expect(document.querySelector('.thread-nav__gap')).toBeNull()
  })

  it('puts a held row back where its activity stood, keeping an emptied folder in its place with its open counts', () => {
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'footer-links' ? { ...thread, workspaceSettledAt: settledAt } : thread)
    const organization = organizeWorkspace(state, describeThreads(state, now), '', null)
    expect(organization.open.map(folder => folder.id)).not.toContain('sotto-site')
    const before = organizeWorkspace(threadsStateFixture(), describeThreads(threadsStateFixture(), now), '', null).open
    const held = holdSettledRows(organization.open, organization.settled, new Set(['footer-links']))
    expect(held.open.map(folder => folder.id)).toEqual(before.map(folder => folder.id))
    const site = held.open.find(folder => folder.id === 'sotto-site')!
    expect(site.rows.map(row => row.thread.id)).toEqual(['footer-links'])
    expect([site.working, site.needs]).toEqual([0, 0])
    expect(held.placed).toEqual(new Map([['footer-links', 'sotto-site']]))
    // Nothing held, or a thread still open: the folders are the ones given.
    expect(holdSettledRows(organization.open, organization.settled, new Set()).open).toBe(organization.open)
    expect(holdSettledRows(organization.open, organization.settled, new Set(['visual-gate'])).open).toBe(organization.open)
  })

  it('never holds a thread whose whole project was settled', () => {
    const state = threadsStateFixture()
    state.host.projects = state.host.projects.map(project => project.id === 'sotto-site' ? { ...project, workspaceSettledAt: settledAt } : project)
    state.host.threads = state.host.threads.map(thread => thread.id === 'footer-links' ? { ...thread, workspaceSettledAt: settledAt } : thread)
    const organization = organizeWorkspace(state, describeThreads(state, now), '', null)
    expect(holdSettledRows(organization.open, organization.settled, new Set(['footer-links'])).placed.size).toBe(0)
  })
})

describe('the settle toast', () => {
  it('says what was settled with Undo, which restores it and leaves the focus on its row', async () => {
    const { commands, projects } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    const undo = await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })
    expect(toast()).toContainElement(undo)
    expect(toast()).toHaveTextContent('Settled Grok voice previews')
    expect(undo).toHaveAttribute('title', 'Undo (Ctrl+Z)')
    expect(undo).toHaveAttribute('aria-keyshortcuts', 'Control+Z')
    // It never takes the focus.
    expect(undo).not.toHaveFocus()
    undo.focus()
    fireEvent.click(undo)
    await waitFor(() => expect(projects().getByRole('button', { name: 'Grok voice previews' })).toHaveFocus())
    expect(commands.at(-1)).toEqual({ type: 'restore-thread', threadId: 'grok-previews' })
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument()
  })

  it('answers Ctrl+Z while it stands, but not in a text field or once dictation holds those keys', async () => {
    const { commands } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search threads' }), { key: 'z', ctrlKey: true })
    expect(commands.filter(request => request.type === 'restore-thread')).toEqual([])
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(commands.at(-1)).toEqual({ type: 'restore-thread', threadId: 'grok-previews' }))
    cleanup()
    vi.mocked(useOptionalApp).mockReturnValue({ platform: 'win32', settings: { ...DEFAULT_SETTINGS, hotkey: 'Control+Z' } } as unknown as ReturnType<typeof useOptionalApp>)
    const dictating = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Streaming WAV stall' }))
    const undo = await screen.findByRole('button', { name: 'Undo: restore Streaming WAV stall' })
    expect(undo).not.toHaveAttribute('aria-keyshortcuts')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(dictating.commands.filter(request => request.type === 'restore-thread')).toEqual([])
  })

  it('goes after six seconds, and stands still while the pointer is on it', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })
    vi.useFakeTimers()
    fireEvent.pointerEnter(document.querySelector('.thread-nav__toast')!)
    act(() => { vi.advanceTimersByTime(SETTLE_UNDO_MS * 2) })
    expect(screen.getByRole('button', { name: 'Undo: restore Grok voice previews' })).toBeVisible()
    fireEvent.pointerLeave(document.querySelector('.thread-nav__toast')!)
    act(() => { vi.advanceTimersByTime(SETTLE_UNDO_MS) })
    expect(screen.queryByRole('button', { name: 'Undo: restore Grok voice previews' })).not.toBeInTheDocument()
  })

  it('offers Undo for the Settle shortcut too, and goes when the thread is restored some other way', async () => {
    const { commands } = mount()
    fireEvent.keyDown(document.body, { key: 'E', ctrlKey: true, shiftKey: true })
    await screen.findByRole('button', { name: 'Undo: restore Visual gate flake' })
    expect(commands).toContainEqual({ type: 'settle-thread', threadId: 'visual-gate' })
    fireEvent.keyDown(document.body, { key: 'r', ctrlKey: true, altKey: true })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo: restore Visual gate flake' })).not.toBeInTheDocument())
  })

  it('waits for the worktree question, and offers no Undo once the folder went with the thread', async () => {
    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: 'C:/owned/grok', branch: 'sotto/grok', dirty: false }
    const ask = (answer: 'Keep folder' | 'Remove worktree') => async () => {
      mount(state => { state.host.threads = state.host.threads.map(thread => thread.id === 'grok-previews' ? { ...thread, nativeSessionStarted: true, worktree } : thread) })
      fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
      const dialog = await screen.findByRole('dialog', { name: 'Remove its worktree too?' })
      expect(screen.queryByText(/^Settled Grok voice previews/)).not.toBeInTheDocument()
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Remove worktree' })).toBeEnabled())
      fireEvent.click(within(dialog).getByRole('button', { name: answer }))
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    }
    const offered = vi.spyOn(settleOffers, 'settled')
    await ask('Keep folder')()
    expect(offered).toHaveBeenCalledWith('grok-previews', 'Grok voice previews', { asking: true })
    expect(await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })).toBeVisible()
    cleanup()
    await ask('Remove worktree')()
    expect(await screen.findByText('Settled Grok voice previews and removed its worktree. The branch is kept.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument()
  })

  it('stays held when a later Settle replaces it under a still pointer, and lets go when the sidebar goes', async () => {
    const { unmount } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })
    pointerOver.toast = true
    fireEvent.pointerEnter(document.querySelector('.thread-nav__toast')!)
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settle Streaming WAV stall' })) })
    expect(screen.getByRole('button', { name: 'Undo: restore Streaming WAV stall' })).toBeVisible()
    act(() => { vi.advanceTimersByTime(SETTLE_UNDO_MS * 2) })
    expect(settleOffers.get()?.title).toBe('Streaming WAV stall')
    // Taken away while held, as by another page, its time runs again rather than standing for good.
    unmount()
    act(() => { vi.advanceTimersByTime(SETTLE_UNDO_MS) })
    expect(settleOffers.get()).toBeNull()
  })

  it('lets a thread shortcut saved on Ctrl+Z keep it', async () => {
    vi.mocked(useOptionalApp).mockReturnValue({ platform: 'win32', settings: { ...DEFAULT_SETTINGS, threadShortcuts: { 'focus-prompt': 'mod+z' } } } as unknown as ReturnType<typeof useOptionalApp>)
    const { commands } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    expect(await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })).not.toHaveAttribute('aria-keyshortcuts')
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(commands.filter(request => request.type === 'restore-thread')).toEqual([])
  })

  it('says it cannot tell when Undo got no answer, and goes once the thread is seen back', async () => {
    mount(() => undefined, {}, ['restore-thread'])
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' }))
    // The restore took, so the thread is seen back and the toast that could not tell goes.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Projects' })).toHaveTextContent('Grok voice previews'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(settleOffers.get()).toBeNull()
  })

  it('keeps a later Settle\'s Undo when an earlier Undo is refused', () => {
    settleOffers.settled('b', 'B')
    settleOffers.refused('a', 'A', 'That thread is unavailable.')
    expect(settleOffers.get()).toMatchObject({ threadId: 'b', kind: 'undo' })
    settleOffers.dismiss(settleOffers.get()!.id)
    settleOffers.refused('a', 'A', undefined)
    expect(settleOffers.get()).toMatchObject({ threadId: 'a', kind: 'unconfirmed' })
  })

  it('says while the on-settle rule removes the folder, then offers Undo only if the folder stayed', async () => {
    const worktree = { mode: 'independent' as const, status: 'ready' as const, path: 'C:/owned/grok', branch: 'sotto/grok', dirty: false }
    const owned = (state: AgentState): void => { state.host.threads = state.host.threads.map(thread => thread.id === 'grok-previews' ? { ...thread, nativeSessionStarted: true, worktree } : thread) }
    vi.mocked(useOptionalApp).mockReturnValue({ platform: 'win32', settings: { ...DEFAULT_SETTINGS, worktreeCleanup: { ...DEFAULT_SETTINGS.worktreeCleanup, onSettle: true } } } as unknown as ReturnType<typeof useOptionalApp>)
    mount(owned)
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    expect(await screen.findByText('Settled Grok voice previews and removed its worktree. The branch is kept.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument()
    cleanup()
    mount(owned, { 'reclaim-thread-worktree': 'This folder has files Git ignores. Nothing was removed.' })
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    expect(await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' })).toBeVisible()
    // While main still removes it, the toast says so and its time stands still.
    settleOffers.settled('grok-previews', 'Grok voice previews', { removing: true })
    expect(await screen.findByText('Settled Grok voice previews. Removing its worktree…')).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument()
  })

  it('stands in the window\'s corner where there is no sidebar', () => {
    const state = threadsStateFixture()
    render(<SettleToast command={vi.fn()} threads={state.host.threads} placement="corner" />)
    act(() => settleOffers.settled('grok-previews', 'Grok voice previews'))
    const region = screen.getByRole('button', { name: 'Undo: restore Grok voice previews' }).closest('.tt-toast-region')!
    expect(region).not.toHaveAttribute('data-placement')
    expect(region.closest('.settle-toast-corner')).not.toBeNull()
  })

  it('says plainly when Undo could not restore the thread', async () => {
    mount(() => undefined, { 'restore-thread': 'That thread is unavailable.' })
    fireEvent.click(screen.getByRole('button', { name: 'Settle Grok voice previews' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo: restore Grok voice previews' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Grok voice previews is still settled. That thread is unavailable.')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
