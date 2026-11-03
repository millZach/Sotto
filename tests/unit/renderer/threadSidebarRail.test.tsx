import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { railMark, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useWatchedThreadIds } from '../../../src/renderer/src/watcher/watcherRoom'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * The collapsed rail (ADR-0146): with its Owl feature on, Watcher's tile under Expand, the threads Watcher watches
 * under it with the owl at each tile's corner, then the rest: in each part what waits on you first, edged in the
 * attention colour, then the moving threads, then the resting ones smaller and apart. A part of two or more tiles sits
 * in a tray, the trays taking the theme's group colours in turn. Off, the rail is today's.
 */
vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatchedThreadIds: vi.fn(() => new Set()) }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

const navigate = vi.fn()
function owl(on: boolean, queue = false): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', actions: { navigate },
    update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'sidebar-rail': on, watcher: true, 'needs-you-queue': queue } } } as unknown as AppContextValue)
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); vi.mocked(useWatchedThreadIds).mockReturnValue(new Set()); navigate.mockReset(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })
afterEach(() => { cleanup(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })

/** Nothing waits: every thread's requests answered and failures seen. */
const calm = (state: AgentState): AgentState => ({ ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, requests: [], status: thread.status === 'error' ? 'idle' : thread.status })) } })

function mountCollapsed(state: AgentState, onOpen = vi.fn()): HTMLElement {
  render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW)}
    command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()}
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  act(() => { screen.getByRole('button', { name: 'Collapse sidebar' }).click() })
  return document.querySelector<HTMLElement>('.thread-nav__rail')!
}
/** The waiting threads' titles in the Needs you queue's own order. */
const queueOrder = (state: AgentState): string[] => organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW).needsYou.entries.map(entry => entry.row.thread.title)
const tile = (rail: HTMLElement, title: string): HTMLElement => within(rail).getByRole('button', { name: title })
const follows = (first: Element, second: Element): boolean => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('the collapsed rail (ADR-0146)', () => {
  it('is today\'s rail while the Owl feature is off', () => {
    owl(false)
    const rail = mountCollapsed(threadsStateFixture())
    expect(within(rail).queryByRole('button', { name: 'Open Watcher' })).toBeNull()
    expect(rail.querySelector('.thread-nav__rail-tray, .thread-nav__rail-rule, [data-resting]')).toBeNull()
    expect(tile(rail, 'Visual gate flake')).toHaveTextContent(/^V$/)
  })

  it('puts Watcher under Expand, and a press opens Watcher', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    const watcher = within(rail).getByRole('button', { name: 'Open Watcher' })
    expect(follows(within(rail).getByRole('button', { name: 'Expand sidebar' }), watcher)).toBe(true)
    expect(follows(watcher, rail.querySelector('.thread-nav__rail-list')!)).toBe(true)
    expect(watcher.querySelector('.thread-nav__ring')).not.toBeNull()
    act(() => { watcher.click() })
    expect(navigate).toHaveBeenCalledWith('watcher')
  })

  it('puts what waits first, edged, then the moving threads, then the resting ones in a part of their own', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    expect(rail.querySelector('.thread-nav__rail-rule, .thread-nav__rail-watched, .thread-nav__rail-watched-mark')).toBeNull()
    const waiting = [tile(rail, 'Visual gate flake'), tile(rail, 'Streaming WAV stall')]
    const queued = [...rail.querySelectorAll('.thread-nav__rail-thread[data-waiting]')].map(button => button.getAttribute('aria-label'))
    expect(queued).toEqual(queueOrder(threadsStateFixture()))
    for (const button of waiting) {
      expect(button).toHaveAttribute('data-waiting')
      expect(button.querySelector('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
    }
    const moving = tile(rail, 'Footer links')
    expect(moving).not.toHaveAttribute('data-resting')
    expect(moving).not.toHaveAttribute('data-waiting')
    const resting = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-thread[data-resting]')]
    expect(resting.length).toBeGreaterThan(0)
    for (const button of waiting) expect(follows(button, moving)).toBe(true)
    const awake = moving.parentElement!, asleep = resting[0]!.parentElement!
    expect(awake).not.toBe(asleep)
    for (const part of [awake, asleep]) expect(part).toHaveClass('thread-nav__rail-group')
    // Each part of two or more is a tray, the trays numbered in turn from the first.
    const trays = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-tray')]
    expect(trays.map(tray => tray.dataset.hue)).toEqual(trays.map((_, index) => String(index + 1)))
    expect(trays.includes(awake)).toBe(awake.childElementCount > 1)
    expect(follows(awake, asleep)).toBe(true)
    for (const button of resting) {
      expect(button.parentElement).toBe(asleep)
      expect(button.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state', 'working')
    }
  })

  it('puts the threads Watcher watches under its tile in a tray, each with the owl, before the rest', () => {
    owl(true)
    const state = threadsStateFixture()
    const id = (title: string): string => state.host.threads.find(thread => thread.title === title)!.id
    vi.mocked(useWatchedThreadIds).mockReturnValue(new Set([id('Footer links'), id('Visual gate flake')]))
    const rail = mountCollapsed(state)
    const group = rail.querySelector<HTMLElement>('.thread-nav__rail-watched')!
    expect(group).toHaveAccessibleName('Watched by Watcher')
    expect(group).toHaveClass('thread-nav__rail-tray')
    expect(group).toHaveAttribute('data-hue', '1')
    expect(within(group).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Visual gate flake', 'Footer links'])
    for (const button of within(group).getAllByRole('button')) {
      expect(button.querySelector('.thread-nav__rail-watched-mark')).not.toBeNull()
      expect(button).toHaveAttribute('title', expect.stringMatching(/ · Watched by Watcher$/))
    }
    expect(tile(rail, 'Visual gate flake')).toHaveAttribute('data-waiting')
    expect(tile(rail, 'Footer links')).not.toHaveAttribute('data-waiting')
    const unwatched = tile(rail, 'Streaming WAV stall')
    expect(unwatched).toHaveAttribute('data-waiting')
    expect(unwatched.querySelector('.thread-nav__rail-watched-mark')).toBeNull()
    expect(group.nextElementSibling).toBe(unwatched.parentElement)
  })

  it('pops a waiting tile\'s card beside the rail, as the Needs you entry does, and opens the rest', () => {
    owl(true, true)
    const onOpen = vi.fn()
    const rail = mountCollapsed(threadsStateFixture(), onOpen)
    const approval = within(rail).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })
    expect(approval).toHaveAttribute('aria-haspopup', 'dialog')
    act(() => { approval.click() })
    const card = screen.getByRole('dialog', { name: 'Visual gate flake' })
    expect(card).toHaveTextContent('npm test -- --run tests/unit/agents')
    expect(approval).toHaveAttribute('aria-expanded', 'true')
    expect(onOpen).not.toHaveBeenCalled()
    act(() => { fireEvent.keyDown(card, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(approval)
    act(() => { within(rail).getByRole('button', { name: 'Show why Streaming WAV stall needs attention' }).click() })
    expect(screen.getByRole('dialog', { name: 'Streaming WAV stall' })).toBeInTheDocument()
    // A press on another tile is a press outside the card: it closes, and that tile opens its thread.
    act(() => { fireEvent.pointerDown(tile(rail, 'Footer links')); tile(rail, 'Footer links').click() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onOpen).toHaveBeenCalledWith('footer-links')
  })

  it('gives the focus back to a tile drawn anew when its card closes with the wait it held', async () => {
    owl(true, true)
    const state = threadsStateFixture()
    const failed = { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === 'wav-stall' ? { ...thread, failureId: 'f1' } : thread) } }
    const command = vi.fn(async () => failed)
    const element = (next: AgentState) => <ThreadSidebar state={next} organization={organizeWorkspace(next, describeThreads(next, NOW), '', next.activeProjectId, false, NOW)}
      command={command} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()}
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />
    const view = render(element(failed))
    act(() => { screen.getByRole('button', { name: 'Collapse sidebar' }).click() })
    const rail = document.querySelector<HTMLElement>('.thread-nav__rail')!
    const why = within(rail).getByRole('button', { name: 'Show why Streaming WAV stall needs attention' })
    act(() => { why.click() })
    // The press that opened the card answers Escape too.
    act(() => { why.focus(); fireEvent.keyDown(why, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { why.click() })
    const card = screen.getByRole('dialog', { name: 'Streaming WAV stall' })
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: 'Dismiss Needs attention on Streaming WAV stall' })) })
    expect(command).toHaveBeenCalledWith({ type: 'dismiss-failures', failures: [{ threadId: 'wav-stall', failure: 'f1' }] })
    act(() => { (document.activeElement as HTMLElement | null)?.blur() })
    // Seen, the thread stops waiting and its tile moves out of the waiting group.
    act(() => { view.rerender(element({ ...failed, host: { ...failed.host, threads: failed.host.threads.map(thread => thread.id === 'wav-stall' ? { ...thread, failureSeen: true } : thread) } })) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(tile(rail, 'Streaming WAV stall'))
  })

  it('opens the row menu from a tile that pops a card, where Open names no keys since Enter pops the card (ADR-0164)', () => {
    owl(true, true)
    const onOpen = vi.fn()
    const rail = mountCollapsed(threadsStateFixture(), onOpen)
    const approval = within(rail).getByRole('button', { name: 'Open to answer the approval in Visual gate flake' })
    act(() => approval.focus())
    act(() => { fireEvent.keyDown(approval, { key: 'F10', shiftKey: true }) })
    const menu = within(rail).getByRole('menu', { name: 'Actions for Visual gate flake' })
    expect(screen.queryByRole('dialog')).toBeNull()
    const open = within(menu).getByRole('menuitem', { name: 'Open' })
    expect(open).not.toHaveAttribute('aria-keyshortcuts')
    expect(within(menu).getByRole('menuitem', { name: 'Settle' })).toBeInTheDocument()
    act(() => { fireEvent.click(open) })
    expect(onOpen).toHaveBeenCalledWith('visual-gate')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(approval)
    // A tile whose press opens its thread names Enter, as a row does.
    const footer = tile(rail, 'Footer links')
    act(() => footer.focus())
    act(() => { fireEvent.keyDown(footer, { key: 'ContextMenu' }) })
    expect(within(within(rail).getByRole('menu', { name: 'Actions for Footer links' })).getByRole('menuitem', { name: 'Open' })).toHaveAttribute('aria-keyshortcuts', 'Enter')
  })

  it('edges nothing in the attention colour while nothing waits', () => {
    owl(true)
    const rail = mountCollapsed(calm(threadsStateFixture()))
    expect(rail.querySelector('.thread-nav__rail-thread[data-waiting]')).toBeNull()
    expect(tile(rail, 'Visual gate flake')).toBeInTheDocument()
  })

  it('marks each tile with two letters of its title', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    expect(tile(rail, 'Visual gate flake')).toHaveTextContent(/^Vg$/)
    expect(railMark('Branch picker search')).toBe('Bp')
    expect(railMark('dictation hotkey drift')).toBe('Dh')
    expect(railMark('Sotto')).toBe('So')
    expect(railMark('  x  ')).toBe('X')
  })
})
