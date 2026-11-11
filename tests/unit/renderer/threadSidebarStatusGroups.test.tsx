import React from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { describeThreads, groupByStatus, organizeWorkspace, type ThreadRow } from '../../../src/renderer/src/agents/threadFacts'
import { FOLDER_TOGGLES_KEY, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { threadsStateFixture } from '../../fixtures/agentState'

/**
 * The sidebar grouped by status (ADR-0201, Zach's picks of November 10, 2026): the Needs you card as it stands, then
 * Working now and Recent with each row naming its project, then the Snoozed and Settled shelves as before. Status groups
 * are the default; By project in Settings keeps the folders.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

function app(settings: Partial<AppSettings> = {}): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', settings: { ...DEFAULT_SETTINGS, ...settings },
    actions: { navigate: vi.fn() }, update: { currentVersion: '0.1.40', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { 'needs-you-queue': true } } } as unknown as AppContextValue)
}
beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); sessionStorage.removeItem(FOLDER_TOGGLES_KEY) })
afterEach(() => { cleanup(); sessionStorage.removeItem(FOLDER_TOGGLES_KEY) })

function mount(state: AgentState = threadsStateFixture(), query = '') {
  const view = <ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), query, state.activeProjectId, false, NOW)}
    command={vi.fn(async () => state)} query={query} onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} shortcutsLive
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />
  return render(view)
}
const group = (name: string): HTMLElement => document.querySelector<HTMLElement>(`.thread-group[data-group="${name}"]`)!
const rowIn = (scope: HTMLElement, title: string): HTMLElement => within(scope).getByRole('button', { name: title }).closest('li')!

describe('grouping open threads by status (ADR-0201)', () => {
  const rows = (state: AgentState = threadsStateFixture()): readonly ThreadRow[] => describeThreads(state, NOW)

  it('puts working threads on a reachable provider in Working now and every other open thread in Recent', () => {
    const groups = groupByStatus(organizeWorkspace(threadsStateFixture(), rows(), '', null, false, NOW).open)
    expect(groups.working.length).toBeGreaterThan(0)
    expect(groups.working.every(row => row.state === 'working' && row.connected)).toBe(true)
    expect(groups.recent.every(row => row.state !== 'working' || !row.connected)).toBe(true)
    // A thread waiting on the user stays a row, in Recent, under the card that says what it needs.
    expect(groups.recent.some(row => row.state === 'needs')).toBe(true)
    expect(groups.working.concat(groups.recent).every(row => row.settledBy === null)).toBe(true)
  })

  it('says a working thread out of reach in Recent, below the reachable ones, as the iPhone does', () => {
    const working = rows().find(row => row.state === 'working')!
    const away: ThreadRow = { ...working, connected: false, activityAt: NOW + 60_000 }
    const groups = groupByStatus([{ id: 'p', project: undefined, title: 'p', settled: false, rows: [away, ...rows().filter(row => row.state === 'done' && row.settledBy === null)], working: 0, needs: 0, activityAt: NOW }])
    expect(groups.working).not.toContain(away)
    expect(groups.recent.at(-1)).toBe(away)
  })
})

describe('the sidebar by status (ADR-0201)', () => {
  it('is the default: Working now and Recent under Needs you, with no project folders among open work', () => {
    app()
    mount()
    expect(document.querySelector('.needs-you')).not.toBeNull()
    expect(within(document.querySelector<HTMLElement>('.thread-nav__list')!).queryByRole('region', { name: 'Projects' })).toBeNull()
    expect(document.querySelector('.thread-folder:not(.thread-group)')).toBeNull()
    expect(within(group('working')).getByRole('button', { name: /^Working now \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
    expect(within(group('recent')).getByRole('button', { name: /^Recent \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
    // The groups follow the iPhone's order: Working now above Recent.
    expect(group('working').compareDocumentPosition(group('recent')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('names each row\'s project on its second line and in its description', () => {
    app()
    mount()
    const footer = rowIn(group('working'), 'Footer links')
    expect(footer.querySelector('.thread-nav__place')).toHaveTextContent('sotto-site')
    const button = within(footer).getByRole('button', { name: 'Footer links' })
    const described = button.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(described).toContain('sotto-site')
  })

  it('keeps a waiting thread\'s row in Recent, reading In Needs you', () => {
    app()
    mount()
    const waiting = rowIn(group('recent'), 'Visual gate flake')
    expect(waiting).toHaveAttribute('data-in-queue', 'visual-gate')
    expect(waiting.querySelector('.thread-nav__status')).toHaveTextContent('In Needs you')
  })

  it('folds a group from its head and keeps it folded across a remount, and a search opens it again', () => {
    app()
    const first = mount()
    fireEvent.click(within(group('working')).getByRole('button', { name: /^Working now/ }))
    expect(within(group('working')).getByRole('button', { name: /^Working now/ })).toHaveAttribute('aria-expanded', 'false')
    expect(within(group('working')).queryByRole('button', { name: 'Footer links' })).toBeNull()
    first.unmount()
    mount()
    expect(within(group('working')).getByRole('button', { name: /^Working now/ })).toHaveAttribute('aria-expanded', 'false')
    cleanup()
    mount(threadsStateFixture(), 'footer')
    expect(within(group('working')).getByRole('button', { name: /^Working now/ })).toHaveAttribute('aria-expanded', 'true')
    expect(within(group('working')).getByRole('button', { name: 'Footer links' })).toBeInTheDocument()
  })

  it('badges a row on a remote computer with its name, and says nothing for this computer\'s', () => {
    app()
    const state = threadsStateFixture()
    const remote: AgentState = { ...state, connections: [{ hostId: 'here', name: 'This computer', kind: 'local', connected: true }, { hostId: 'forge', name: 'forge', kind: 'remote', connected: true }],
      host: { ...state.host, threads: state.host.threads.map(thread => thread.id === 'footer-links' ? { ...thread, hostId: 'forge' } : { ...thread, hostId: 'here' }) } }
    mount(remote)
    expect(rowIn(group('working'), 'Footer links').querySelector('.host-badge')).toHaveTextContent('forge')
    expect(rowIn(group('working'), 'Weekly note').querySelector('.host-badge')).toBeNull()
  })

  it('leaves the Settled shelf\'s folders as they were', () => {
    app()
    mount()
    fireEvent.click(within(document.querySelector<HTMLElement>('section[aria-label="Settled"]')!).getByRole('button', { name: /^Settled/ }))
    expect(document.querySelector('.thread-folder[data-section="settled"]')).not.toBeNull()
  })

  it('walks the groups as the thread list walks folders: Left folds a group from its rows, Right opens it (ADR-0164)', () => {
    app()
    mount()
    const press = (key: string): void => { fireEvent.keyDown(document.activeElement as HTMLElement, { key }) }
    const head = (): HTMLElement => within(group('working')).getByRole('button', { name: /^Working now/ })
    act(() => within(group('working')).getByRole('button', { name: 'Footer links' }).focus())
    press('ArrowLeft')
    expect(head()).toHaveFocus()
    press('ArrowLeft')
    expect(head()).toHaveAttribute('aria-expanded', 'false')
    press('ArrowRight')
    expect(head()).toHaveAttribute('aria-expanded', 'true')
    press('Home')
    expect(head()).toHaveFocus()
  })

  it('says nothing of its own with no thread at all, where the room says it once (#1834), and All caught up once only settled ones stand', () => {
    app()
    const state = threadsStateFixture()
    const empty = mount({ ...state, host: { ...state.host, threads: [] } })
    expect(document.querySelector('.thread-group')).toBeNull()
    expect(document.querySelector('.thread-nav__list')).not.toHaveTextContent('All caught up.')
    empty.unmount()
    const settledAt = new Date(NOW).toISOString()
    mount({ ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, status: 'idle' as const, requests: [], workspaceSettledAt: settledAt })) } })
    expect(document.querySelector('.thread-group')).toBeNull()
    expect(document.querySelector('.thread-nav__list')).toHaveTextContent('All caught up.')
  })

  it('keeps the project folders when Settings says By project', () => {
    app({ threadListGrouping: 'project' })
    mount()
    expect(document.querySelector('.thread-group')).toBeNull()
    expect(document.querySelector('.thread-folder[data-section="open"]')).not.toBeNull()
  })
})
