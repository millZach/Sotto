import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { FOLDER_TOGGLES_KEY, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

/**
 * Zach's pick C of November 5, 2026 (ADR-0110): below a 1000 pixel window the rail stands, and Expand or Ctrl+Shift+B
 * opens the whole sidebar over the thread, which never moves.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

function owl(queue: boolean, settings: Record<string, unknown> = {}): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', settings: { ...DEFAULT_SETTINGS, ...settings },
    actions: { navigate: vi.fn() }, update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'needs-you-queue': queue } } } as unknown as AppContextValue)
}
function atWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  fireEvent(window, new Event('resize'))
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); localStorage.removeItem('sotto.threadWorkspace.sidebar'); sessionStorage.setItem(FOLDER_TOGGLES_KEY, JSON.stringify(['open:workshop'])) })
afterEach(() => { cleanup(); atWindowWidth(1024); localStorage.removeItem('sotto.threadWorkspace.sidebar'); sessionStorage.removeItem(FOLDER_TOGGLES_KEY) })

function mount(state: AgentState = threadsStateFixture()) {
  const onOpen = vi.fn()
  render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW)}
    command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()} shortcutsLive
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  return { onOpen }
}
const sidebar = (): HTMLElement => document.querySelector<HTMLElement>('aside.thread-nav')!
const panel = (): HTMLElement => document.querySelector<HTMLElement>('.thread-nav__expanded')!
const keys = (target: Element = document.body): void => { fireEvent.keyDown(target, { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }) }

describe('the sidebar over the thread below a 1000 pixel window (ADR-0110, November 5, 2026)', () => {
  it('stands as the rail below 1000 whatever was chosen, and as the sidebar from 1000 up', () => {
    owl(false)
    atWindowWidth(999)
    mount()
    expect(sidebar()).toHaveAttribute('data-collapsed')
    expect(panel()).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-haspopup', 'dialog')
    act(() => atWindowWidth(1000))
    expect(sidebar()).not.toHaveAttribute('data-collapsed')
    expect(panel()).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull()
  })

  it('opens over the thread from Expand, takes the focus, keeps Tab inside, and gives the focus back on Escape', () => {
    owl(false)
    atWindowWidth(820)
    mount()
    const expand = screen.getByRole('button', { name: 'Expand sidebar' })
    expect(expand).toHaveAttribute('title', 'Expand sidebar (Ctrl+Shift+B)')
    expect(expand).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+B')
    expand.focus()
    act(() => { expand.click() })
    const dialog = screen.getByRole('dialog', { name: 'Thread sidebar' })
    expect(dialog).toBe(panel())
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(sidebar()).toHaveAttribute('data-over')
    // The rail keeps its place under it, out of reach, so the thread beside it does not move.
    expect(sidebar().style.width).toBe('52px')
    expect(document.querySelector('.thread-nav__rail')).toHaveAttribute('inert')
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search threads' }))
    // Shift+Tab from the first stop goes round to the last, inside the sidebar.
    const stops = [...dialog.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]')].filter(item => item.tabIndex >= 0 && !(item as HTMLButtonElement).disabled)
    stops[0]!.focus()
    fireEvent.keyDown(stops[0]!, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(stops[0])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(sidebar()).not.toHaveAttribute('data-over')
    expect(screen.queryByRole('dialog', { name: 'Thread sidebar' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus()
    expect(localStorage.getItem('sotto.threadWorkspace.sidebar')).toBeNull()
  })

  it('lets the search take Escape first while it holds words', () => {
    owl(false)
    atWindowWidth(820)
    const state = threadsStateFixture()
    render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), 'gate', state.activeProjectId, false, NOW)}
      command={vi.fn(async () => state)} query="gate" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()}
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    act(() => { screen.getByRole('button', { name: 'Expand sidebar' }).click() })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search threads' }), { key: 'Escape' })
    expect(sidebar()).toHaveAttribute('data-over')
  })

  it('closes when a thread is chosen, and opens that thread', () => {
    owl(false)
    atWindowWidth(820)
    const { onOpen } = mount()
    act(() => { screen.getByRole('button', { name: 'Expand sidebar' }).click() })
    act(() => { within(panel()).getByRole('button', { name: 'Visual gate flake' }).click() })
    expect(onOpen).toHaveBeenCalledWith('visual-gate')
    expect(sidebar()).not.toHaveAttribute('data-over')
  })

  it('closes on a press beside it, and on Collapse sidebar', () => {
    owl(false)
    atWindowWidth(820)
    mount()
    act(() => { screen.getByRole('button', { name: 'Expand sidebar' }).click() })
    act(() => { (document.querySelector('.thread-nav__scrim') as HTMLElement).click() })
    expect(sidebar()).not.toHaveAttribute('data-over')
    act(() => { screen.getByRole('button', { name: 'Expand sidebar' }).click() })
    act(() => { within(panel()).getByRole('button', { name: 'Collapse sidebar' }).click() })
    expect(sidebar()).not.toHaveAttribute('data-over')
    expect(localStorage.getItem('sotto.threadWorkspace.sidebar')).toBeNull()
  })

  it('opens and closes with Ctrl+Shift+B, and collapses and expands with it from 1000 up', () => {
    owl(false)
    atWindowWidth(900)
    mount()
    act(() => keys())
    expect(sidebar()).toHaveAttribute('data-over')
    act(() => keys(document.activeElement!))
    expect(sidebar()).not.toHaveAttribute('data-over')
    act(() => atWindowWidth(1280))
    expect(sidebar()).not.toHaveAttribute('data-collapsed')
    act(() => keys())
    expect(sidebar()).toHaveAttribute('data-collapsed')
    expect(JSON.parse(localStorage.getItem('sotto.threadWorkspace.sidebar')!)).toEqual({ collapsed: true })
    act(() => keys())
    expect(sidebar()).not.toHaveAttribute('data-collapsed')
  })

  it('leaves the keys to dictation where its shortcut uses them', () => {
    owl(false, { hotkey: 'CommandOrControl+Shift+B' })
    atWindowWidth(900)
    mount()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('title', 'Expand sidebar')
    act(() => keys())
    expect(sidebar()).not.toHaveAttribute('data-over')
  })

  it('closes when the window widens past the line, and the sidebar stands beside the thread', () => {
    owl(false)
    atWindowWidth(820)
    mount()
    act(() => { screen.getByRole('button', { name: 'Expand sidebar' }).click() })
    act(() => atWindowWidth(1100))
    expect(sidebar()).not.toHaveAttribute('data-over')
    expect(panel()).toBeVisible()
    act(() => atWindowWidth(820))
    expect(sidebar()).not.toHaveAttribute('data-over')
  })
})
