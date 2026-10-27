import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
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
 * under it with the owl at each tile's corner, then a hairline and the rest: in each part what waits on you first,
 * edged in the attention colour, then the moving threads, then the resting ones smaller. Off, the rail is today's.
 */
vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatchedThreadIds: vi.fn(() => new Set()) }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

const navigate = vi.fn()
function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', actions: { navigate },
    update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'sidebar-rail': on, watcher: true } } } as unknown as AppContextValue)
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); vi.mocked(useWatchedThreadIds).mockReturnValue(new Set()); navigate.mockReset(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })
afterEach(() => { cleanup(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })

/** Nothing waits: every thread's requests answered and failures seen. */
const calm = (state: AgentState): AgentState => ({ ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, requests: [], status: thread.status === 'error' ? 'idle' : thread.status })) } })

function mountCollapsed(state: AgentState): HTMLElement {
  render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW)}
    command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()}
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

  it('puts what waits first, edged, then the moving threads, then a hairline and the resting ones', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    expect(rail.querySelector('.thread-nav__rail-tray, .thread-nav__rail-watched, .thread-nav__rail-watched-mark')).toBeNull()
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
    const rule = rail.querySelector('.thread-nav__rail-list .thread-nav__rail-rule')!
    const resting = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-thread[data-resting]')]
    expect(resting.length).toBeGreaterThan(0)
    for (const button of waiting) expect(follows(button, moving)).toBe(true)
    expect(follows(moving, rule)).toBe(true)
    for (const button of resting) {
      expect(follows(rule, button)).toBe(true)
      expect(button.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state', 'working')
    }
  })

  it('puts the threads Watcher watches under its tile, each with the owl, before a hairline and the rest', () => {
    owl(true)
    const state = threadsStateFixture()
    const id = (title: string): string => state.host.threads.find(thread => thread.title === title)!.id
    vi.mocked(useWatchedThreadIds).mockReturnValue(new Set([id('Footer links'), id('Visual gate flake')]))
    const rail = mountCollapsed(state)
    const group = rail.querySelector<HTMLElement>('.thread-nav__rail-watched')!
    expect(group).toHaveAccessibleName('Watched by Watcher')
    expect(within(group).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Visual gate flake', 'Footer links'])
    for (const button of within(group).getAllByRole('button')) {
      expect(button.querySelector('.thread-nav__rail-watched-mark')).not.toBeNull()
      expect(button).toHaveAttribute('title', expect.stringMatching(/ · Watched by Watcher$/))
    }
    expect(tile(rail, 'Visual gate flake')).toHaveAttribute('data-waiting')
    expect(tile(rail, 'Footer links')).not.toHaveAttribute('data-waiting')
    const rule = group.nextElementSibling!
    expect(rule).toHaveClass('thread-nav__rail-rule')
    const unwatched = tile(rail, 'Streaming WAV stall')
    expect(unwatched).toHaveAttribute('data-waiting')
    expect(unwatched.querySelector('.thread-nav__rail-watched-mark')).toBeNull()
    expect(follows(rule, unwatched)).toBe(true)
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
