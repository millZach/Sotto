import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { FOLDER_TOGGLES_KEY, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { threadChordLabel } from '../../../src/renderer/src/agents/threadShortcuts'
import { threadsStateFixture } from '../../fixtures/agentState'

/**
 * The thread list's keys (ADR-0164, Zach's pick A of #1827): the folders, rows and the Settled shelf are one Tab stop
 * walked with the arrow keys, a row's actions sit in its menu on Shift+F10, the menu key and a right-click, and F2
 * renames. The hover icons stay, out of the Tab order.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

function app(settings: Partial<typeof DEFAULT_SETTINGS> = {}): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', settings: { ...DEFAULT_SETTINGS, ...settings }, actions: { navigate: vi.fn() },
    update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: {} } } as unknown as AppContextValue)
}
beforeEach(() => {
  app()
  // Workshop opens as its toggle would leave it; the other folders and the shelf start closed.
  sessionStorage.setItem(FOLDER_TOGGLES_KEY, JSON.stringify(['open:workshop']))
  localStorage.removeItem('sotto.threadWorkspace.sidebar')
})
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.removeItem('sotto.threadWorkspace.sidebar') })

function sidebar(state: AgentState, overrides: { onOpen?: (id: string) => void; onNewThread?: (projectId?: string) => void; command?: () => Promise<AgentState> } = {}) {
  return <ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '')} command={vi.fn(overrides.command ?? (async () => state))} query="" onQuery={vi.fn()}
    onOpen={overrides.onOpen ?? vi.fn()} onNewThread={overrides.onNewThread ?? vi.fn()} currentThreadId="visual-gate" openThreadIds={['visual-gate']} onOpenBeside={vi.fn()} onDragThread={vi.fn()}
    newThreadShortcut={threadChordLabel('mod+shift+n', 'win32')} />
}
const list = (): HTMLElement => document.querySelector<HTMLElement>('.thread-nav__list')!
const stops = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('[tabindex="0"]')]
const row = (title: string): HTMLElement => within(list()).getByRole('button', { name: title })
const toggle = (name: RegExp): HTMLElement => within(list()).getByRole('button', { name })
const press = (key: string, init: Partial<KeyboardEventInit> = {}): void => { fireEvent.keyDown(document.activeElement as HTMLElement, { key, ...init }) }
const workshopRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.thread-folder[data-section="open"]:first-of-type .thread-nav__item')]

describe('the thread list (ADR-0164)', () => {
  it('is one Tab stop, held by the thread on screen, with the row and folder actions out of the Tab order', () => {
    render(sidebar(threadsStateFixture()))
    expect(stops()).toEqual([row('Visual gate flake')])
    const actions = [...list().querySelectorAll<HTMLElement>('[data-row-actions] button')]
    expect(actions.length).toBeGreaterThan(4)
    for (const action of actions) expect(action).toHaveAttribute('tabindex', '-1')
    // The search field and what stands under it keep their own stops; the list is the next one.
    expect(screen.getByRole('searchbox', { name: 'Search threads' })).not.toHaveAttribute('tabindex', '-1')
  })

  it('walks the list with Up, Down, Home and End, without wrapping, and remembers where it was', () => {
    render(sidebar(threadsStateFixture()))
    const first = row('Visual gate flake')
    act(() => first.focus())
    const rows = workshopRows()
    expect(rows[0]).toBe(first)
    press('ArrowDown')
    expect(rows[1]).toHaveFocus()
    expect(stops()).toEqual([rows[1]])
    press('ArrowUp'); press('ArrowUp')
    expect(toggle(/^workshop \d+ threads?$/)).toHaveFocus()
    press('ArrowUp')
    expect(toggle(/^workshop \d+ threads?$/)).toHaveFocus()
    press('End')
    expect(within(list()).getByRole('button', { name: /^Settled/ })).toHaveFocus()
    press('ArrowDown')
    expect(within(list()).getByRole('button', { name: /^Settled/ })).toHaveFocus()
    press('Home')
    expect(toggle(/^workshop \d+ threads?$/)).toHaveFocus()
    // Leaving and coming back by Tab lands where the list was left.
    act(() => screen.getByRole('searchbox', { name: 'Search threads' }).focus())
    expect(stops()).toEqual([toggle(/^workshop \d+ threads?$/)])
  })

  it('opens and closes a folder with Right and Left, and Left steps out of a row to its folder', () => {
    render(sidebar(threadsStateFixture()))
    const site = toggle(/^sotto-site \d+ threads?$/)
    act(() => site.focus())
    expect(site).toHaveAttribute('aria-expanded', 'false')
    press('ArrowRight')
    expect(site).toHaveAttribute('aria-expanded', 'true')
    press('ArrowRight')
    const inside = document.activeElement as HTMLElement
    expect(inside).toHaveClass('thread-nav__item')
    expect(site.closest('.thread-folder')!.contains(inside)).toBe(true)
    press('ArrowLeft')
    expect(site).toHaveFocus()
    press('ArrowLeft')
    expect(site).toHaveAttribute('aria-expanded', 'false')
    expect(site).toHaveFocus()
  })

  it('opens a row\'s menu on Shift+F10, the menu key and a right-click, in words with their keys', () => {
    const onOpen = vi.fn()
    render(sidebar(threadsStateFixture(), { onOpen }))
    const current = row('Visual gate flake')
    act(() => current.focus())
    press('F10', { shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Actions for Visual gate flake' })
    const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    const words = items.map(item => [item.querySelector('.pane-menu__label')?.textContent ?? item.textContent, item.getAttribute('aria-keyshortcuts')])
    // The thread on screen offers no Open beside; Settle's keys act on it, so its row says them.
    expect(words).toContainEqual(['Open', 'Enter'])
    expect(words).toContainEqual(['Rename', 'F2'])
    expect(words).toContainEqual(['Settle', 'Control+Shift+E'])
    expect(words.map(([label]) => label)).not.toContain('Open beside')
    expect(items[0]).toHaveFocus()
    press('ArrowDown')
    expect(items[1]).toHaveFocus()
    press('Escape')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(current).toHaveFocus()

    // Another row, from the menu key: Open beside with its keys, and Settle without the focused thread's keys.
    const other = workshopRows()[1]!
    act(() => other.focus())
    press('ContextMenu')
    const second = screen.getByRole('menu', { name: `Actions for ${other.getAttribute('aria-label')}` })
    expect(within(second).getByRole('menuitem', { name: 'Open beside' })).toHaveAttribute('aria-keyshortcuts', 'Control+Enter')
    expect(within(second).getByRole('menuitem', { name: 'Settle' })).not.toHaveAttribute('aria-keyshortcuts')
    fireEvent.click(within(second).getByRole('menuitem', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith(expect.any(String))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(other).toHaveFocus()

    // A right-click anywhere on the row, its hover icons included, opens the same menu and moves the list's stop there.
    const event = fireEvent.contextMenu(current.closest('li')!.querySelector('[data-row-actions] button')!, { clientX: 60, clientY: 80 })
    expect(event).toBe(false)
    expect(screen.getByRole('menu', { name: 'Actions for Visual gate flake' })).toBeInTheDocument()
    expect(stops()).toEqual([current])
  })

  it('renames from the menu and from F2, and the focus comes back to the row', () => {
    render(sidebar(threadsStateFixture()))
    const current = row('Visual gate flake')
    act(() => current.focus())
    press('F10', { shiftKey: true })
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByRole('textbox', { name: 'Rename Visual gate flake' })).toHaveFocus()
    press('Escape')
    expect(row('Visual gate flake')).toHaveFocus()
    press('F2')
    expect(screen.getByRole('textbox', { name: 'Rename Visual gate flake' })).toHaveFocus()
    // Caret keys in the field are the field's, never the list's.
    expect(fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })).toBe(true)
    press('Escape')
    expect(row('Visual gate flake')).toHaveFocus()
  })

  it('leaves F2 and Shift+F10 to dictation when its shortcuts hold them; the menu key still opens the menu', () => {
    app({ hotkey: 'F2', pressShortcuts: ['Shift+F10'] })
    render(sidebar(threadsStateFixture()))
    const current = row('Visual gate flake')
    act(() => current.focus())
    expect(fireEvent.keyDown(current, { key: 'F2' })).toBe(true)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(fireEvent.keyDown(current, { key: 'F10', shiftKey: true })).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    press('ContextMenu')
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute('aria-keyshortcuts')
  })

  it('opens a folder\'s menu with New thread here and Settle project', () => {
    const onNewThread = vi.fn()
    render(sidebar(threadsStateFixture(), { onNewThread }))
    const workshop = toggle(/^workshop \d+ threads?$/)
    act(() => workshop.focus())
    press('F10', { shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Actions for workshop' })
    // The thread on screen is in this folder, so New thread's keys open a thread here.
    expect(within(menu).getByRole('menuitem', { name: 'New thread here' })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+N')
    expect(within(menu).getByRole('menuitem', { name: 'Settle project' })).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New thread here' }))
    expect(onNewThread).toHaveBeenCalledWith('workshop')
    expect(workshop).toHaveFocus()
  })

  it('hands the focus to the row in its place when the row it held goes, as a settled one does', async () => {
    const state = threadsStateFixture()
    const view = render(sidebar(state))
    const rows = workshopRows()
    const second = rows[1]!, third = rows[2]
    act(() => second.focus())
    const id = state.host.threads.find(thread => thread.title === second.getAttribute('aria-label'))!.id
    const without: AgentState = { ...state, host: { ...state.host, threads: state.host.threads.filter(thread => thread.id !== id) } }
    view.rerender(sidebar(without))
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).not.toBe(document.body)
    if (third !== undefined) expect(document.activeElement).toHaveAttribute('aria-label', third.getAttribute('aria-label'))
    expect(stops()).toEqual([document.activeElement])
  })
})

describe('the collapsed rail (ADR-0164)', () => {
  it('is one Tab stop walked with Up and Down', () => {
    render(sidebar(threadsStateFixture()))
    act(() => { screen.getByRole('button', { name: 'Collapse sidebar' }).click() })
    const rail = screen.getByRole('navigation', { name: 'Threads' })
    const tiles = within(rail).getAllByRole('button')
    expect(tiles.length).toBeGreaterThan(2)
    expect([...rail.querySelectorAll('[tabindex="0"]')]).toEqual([within(rail).getByRole('button', { name: 'Visual gate flake' })])
    act(() => tiles[0]!.focus())
    press('ArrowDown')
    expect(tiles[1]).toHaveFocus()
    press('End')
    expect(tiles.at(-1)).toHaveFocus()
    expect([...rail.querySelectorAll('[tabindex="0"]')]).toEqual([tiles.at(-1)])
  })
})
