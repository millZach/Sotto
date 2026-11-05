import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useWatchedThreadIds } from '../../../src/renderer/src/watcher/watcherRoom'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * The collapsed rail (ADR-0146): with its Owl feature on, Watcher's tile under Expand, then a tray for each project's
 * waiting and moving threads with the project's name at its head, what waits on you first and edged in the attention
 * colour, and the resting threads' smaller tiles in one tray at the foot. Each tile is its provider's mark and its status
 * ring, and a thread Watcher watches wears the owl at its corner (Zach's pick C, November 5, 2026). Off, the rail is today's.
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

  it('puts each project\'s waiting and moving threads in a tray under its name, what waits first, and the resting ones at the foot', () => {
    owl(true)
    const state = threadsStateFixture()
    const rail = mountCollapsed(state)
    expect(rail.querySelector('.thread-nav__rail-rule, .thread-nav__rail-watched, .thread-nav__rail-watched-mark')).toBeNull()
    const waiting = [tile(rail, 'Visual gate flake'), tile(rail, 'Streaming WAV stall')]
    const queued = [...rail.querySelectorAll('.thread-nav__rail-thread[data-waiting]')].map(button => button.getAttribute('aria-label'))
    expect(queued).toEqual(queueOrder(state))
    for (const button of waiting) {
      expect(button).toHaveAttribute('data-waiting')
      expect(button.querySelector('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
    }
    // Every project with a thread that waits or moves has its tray, named for the project, its name at the head.
    const projects = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-project')]
    const title = (id: string | undefined): string => state.host.projects.find(project => project.id === id)!.title
    const projectOf = (button: HTMLElement): string => title(state.host.threads.find(thread => thread.title === button.getAttribute('aria-label'))!.projectId)
    expect(projects.length).toBeGreaterThan(1)
    for (const tray of projects) {
      expect(tray).toHaveAttribute('role', 'group')
      expect(tray.querySelector('.thread-nav__rail-label')).toHaveTextContent(tray.getAttribute('aria-label')!)
      for (const button of within(tray).getAllByRole('button')) expect(projectOf(button)).toBe(tray.getAttribute('aria-label'))
    }
    expect(new Set(projects.map(tray => tray.getAttribute('aria-label'))).size).toBe(projects.length)
    // The trays take one theme role: no tray says a colour of its own.
    for (const tray of projects) expect(tray).not.toHaveAttribute('data-hue')
    // The project of the first waiting thread leads, and inside a tray what waits comes before what moves.
    expect(projects[0]).toHaveAttribute('aria-label', projectOf(waiting[0]!))
    for (const tray of projects) {
      const kinds = within(tray).getAllByRole('button').map(button => button.hasAttribute('data-waiting'))
      expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)))
    }
    const moving = tile(rail, 'Footer links')
    expect(moving).not.toHaveAttribute('data-resting')
    expect(moving).not.toHaveAttribute('data-waiting')
    expect(moving.closest('.thread-nav__rail-project')).toHaveAttribute('aria-label', projectOf(moving))
    // The resting ones share one tray at the foot, under every project's.
    const resting = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-thread[data-resting]')]
    expect(resting.length).toBeGreaterThan(0)
    const asleep = rail.querySelector<HTMLElement>('.thread-nav__rail-resting')!
    expect(asleep).toHaveClass('thread-nav__rail-tray')
    for (const tray of projects) expect(follows(tray, asleep)).toBe(true)
    for (const button of resting) {
      expect(button.parentElement).toBe(asleep)
      expect(button.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state', 'working')
    }
    // The tooltip names the title, the project and what it is doing.
    expect(moving).toHaveAttribute('title', `Footer links · ${projectOf(moving)} · Working`)
  })

  it('marks each thread Watcher watches with the owl in its own project\'s tray', () => {
    owl(true)
    const state = threadsStateFixture()
    const id = (title: string): string => state.host.threads.find(thread => thread.title === title)!.id
    vi.mocked(useWatchedThreadIds).mockReturnValue(new Set([id('Footer links'), id('Visual gate flake')]))
    const rail = mountCollapsed(state)
    expect(rail.querySelector('.thread-nav__rail-watched')).toBeNull()
    for (const title of ['Visual gate flake', 'Footer links']) {
      const button = tile(rail, title)
      expect(button.querySelector('.thread-nav__rail-watched-mark')).not.toBeNull()
      expect(button).toHaveAttribute('title', expect.stringMatching(/ · Watched by Watcher$/))
      expect(button.closest('.thread-nav__rail-project')).not.toBeNull()
    }
    expect(tile(rail, 'Visual gate flake')).toHaveAttribute('data-waiting')
    const unwatched = tile(rail, 'Streaming WAV stall')
    expect(unwatched.querySelector('.thread-nav__rail-watched-mark')).toBeNull()
    expect(unwatched.closest('.thread-nav__rail-project')).toBe(tile(rail, 'Visual gate flake').closest('.thread-nav__rail-project'))
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

  it('draws each tile as its provider\'s mark with its status ring, and no letters', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    for (const [title, provider] of [['Visual gate flake', 'claude'], ['Footer links', 'codex'], ['Weekly note', 'grok']] as const) {
      const button = tile(rail, title)
      expect(button).toHaveTextContent(/^$/)
      expect(button.querySelector('.thread-nav__rail-provider')).toHaveAttribute('data-provider', provider)
      expect(button.querySelector('.thread-nav__rail-provider svg')).not.toBeNull()
      expect(button.querySelector('.thread-nav__ring')).not.toBeNull()
    }
  })
})
