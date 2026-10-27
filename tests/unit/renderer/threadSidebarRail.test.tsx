import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { railMark, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * The collapsed rail (ADR-0146): with its Owl feature on, Watcher's tile under Expand, a Needs you tray while
 * something waits, the moving threads, then a hairline and the resting ones smaller. Off, the rail is today's.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

const navigate = vi.fn()
function owl(on: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', actions: { navigate },
    update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'sidebar-rail': on, watcher: true } } } as unknown as AppContextValue)
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); navigate.mockReset(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })
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

  it('holds what waits in a tray first, then the moving threads, then a hairline and the resting ones', () => {
    owl(true)
    const rail = mountCollapsed(threadsStateFixture())
    const tray = rail.querySelector<HTMLElement>('.thread-nav__rail-tray')!
    expect(tray).toHaveAccessibleName('2 waiting on you')
    expect(tray.querySelector('.thread-nav__rail-tray-count')).toHaveTextContent('2')
    const inTray = within(tray).getAllByRole('button')
    expect(inTray.map(button => button.getAttribute('aria-label')).sort()).toEqual(['Streaming WAV stall', 'Visual gate flake'])
    for (const button of inTray) expect(button.querySelector('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
    const moving = tile(rail, 'Footer links')
    expect(moving).not.toHaveAttribute('data-resting')
    const rule = rail.querySelector('.thread-nav__rail-list .thread-nav__rail-rule')!
    const resting = [...rail.querySelectorAll<HTMLElement>('.thread-nav__rail-thread[data-resting]')]
    expect(resting.length).toBeGreaterThan(0)
    expect(follows(tray, moving)).toBe(true)
    expect(follows(moving, rule)).toBe(true)
    for (const button of resting) {
      expect(follows(rule, button)).toBe(true)
      expect(button.querySelector('.thread-nav__ring')).not.toHaveAttribute('data-state', 'working')
    }
  })

  it('shows no tray while nothing waits', () => {
    owl(true)
    const rail = mountCollapsed(calm(threadsStateFixture()))
    expect(rail.querySelector('.thread-nav__rail-tray')).toBeNull()
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
