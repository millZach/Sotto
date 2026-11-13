import React from 'react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import { clockLabel, describeThreads, groupByStatus, organizeWorkspace, settledAtOf, settledShelfRows, settledWords, type ThreadRow } from '../../../src/renderer/src/agents/threadFacts'
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
/** The fixture with each named thread settled by the user at the given time, in ms. */
function settledAt(times: Readonly<Record<string, number>>): AgentState {
  const state = threadsStateFixture()
  state.host.threads = state.host.threads.map(thread => times[thread.id] === undefined ? thread : { ...thread, workspaceSettledAt: new Date(times[thread.id]!).toISOString() })
  return state
}
function openSettled(): HTMLElement {
  const shelf = document.querySelector<HTMLElement>('section[aria-label="Settled"]')!
  fireEvent.click(within(shelf).getByRole('button', { name: /^Settled/ }))
  return shelf
}
/** When a thread last did anything, as its row has it. */
const activity = (state: AgentState, id: string): number => describeThreads(state, NOW).find(row => row.thread.id === id)!.activityAt
/** The shelf's thread rows by name, in the order they are drawn. */
const shelfTitles = (shelf: HTMLElement): string[] => [...shelf.querySelectorAll<HTMLElement>('.thread-nav__row > .thread-nav__item')].map(item => item.getAttribute('aria-label') ?? '')

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

describe('the Settled shelf\'s order by status (ADR-0201, November 13, 2026)', () => {
  const shelf = (state: AgentState): string[] => settledShelfRows(organizeWorkspace(state, describeThreads(state, NOW), '', null, false, NOW).settled).map(({ row }) => row.thread.id)

  it('puts the thread settled last first, whenever it last moved, as the iPhone\'s shelf does', () => {
    const state = settledAt({ benchmark: NOW - 60_000, 'grok-previews': NOW - 30 * 60_000 })
    expect(shelf(state)).toEqual(['benchmark', 'grok-previews', 'release-notes', 'thread-routing', 'notes-cleanup'])
    // By last activity the benchmark, quiet for four days, would be last.
    expect([...shelf(state)].sort((first, second) => activity(state, second) - activity(state, first)).at(-1)).toBe('benchmark')
  })

  it('reads a thread\'s latest settlement: its own Settle, its project\'s, an archive or its provider\'s', () => {
    const state = threadsStateFixture()
    const row = (id: string): ThreadRow => describeThreads(state, NOW).find(item => item.thread.id === id)!
    const provider = Date.parse(state.host.threads.find(thread => thread.id === 'benchmark')!.settledAt!)
    expect(settledAtOf(row('benchmark'))).toBe(provider)
    expect(settledAtOf(row('visual-gate'))).toBeNaN()
    state.host.threads = state.host.threads.map(thread => thread.id === 'benchmark' ? { ...thread, workspaceSettledAt: new Date(NOW - 5_000).toISOString() } : thread)
    expect(settledAtOf(row('benchmark'))).toBe(NOW - 5_000)
    state.host.projects = state.host.projects.map(project => project.id === 'workshop' ? { ...project, workspaceSettledAt: new Date(NOW - 1_000).toISOString() } : project)
    expect(settledAtOf(row('benchmark'))).toBe(NOW - 1_000)
    expect(settledAtOf(row('visual-gate'))).toBe(NOW - 1_000)
  })

  it('words a settle time by how far back it is: the clock today, the day this week, then the date', () => {
    const at = (month: number, day: number, year = 2026): number => new Date(year, month, day, 9, 10).getTime()
    const now = new Date(2026, 10, 13, 15, 10).getTime()
    const words = (options: Intl.DateTimeFormatOptions, time: number): string => new Intl.DateTimeFormat(undefined, options).format(new Date(time))
    expect(settledWords(at(10, 13), now)).toBe(clockLabel(at(10, 13)))
    expect(settledWords(at(10, 11), now)).toBe(words({ weekday: 'short' }, at(10, 11)))
    expect(settledWords(at(10, 2), now)).toBe(words({ month: 'short', day: 'numeric' }, at(10, 2)))
    expect(settledWords(at(11, 30, 2025), now)).toBe(words({ month: 'short', day: 'numeric', year: 'numeric' }, at(11, 30, 2025)))
    expect(settledWords(Number.NaN, now)).toBe('')
  })

  it('keeps threads settled at the same time in the order they last moved, and one with no time last', () => {
    const state = threadsStateFixture()
    state.host.projects = state.host.projects.map(project => project.id === 'workshop' ? { ...project, workspaceSettledAt: new Date(NOW - 1_000).toISOString() } : project)
    // The provider settled this one without saying when.
    state.host.threads = state.host.threads.map(thread => thread.id === 'notes-cleanup' ? { ...thread, settledAt: undefined } : thread)
    const order = shelf(state)
    const workshop = order.filter(id => state.host.threads.find(thread => thread.id === id)!.projectId === 'workshop')
    expect(order.slice(0, workshop.length)).toEqual(workshop)
    expect(workshop).toEqual([...workshop].sort((first, second) => activity(state, second) - activity(state, first)))
    expect(order.at(-1)).toBe('notes-cleanup')
  })
})

describe('a held row keeps its group (ADR-0167)', () => {
  it('stays where it was pinned while its thread finishes, so the gap does not move', () => {
    const rows = describeThreads(threadsStateFixture(), NOW)
    const working = rows.find(row => row.state === 'working')!
    const finished: ThreadRow = { ...working, state: 'done' }
    const folder = { id: 'p', project: undefined, title: 'p', settled: false, rows: [finished], working: 0, needs: 0, activityAt: NOW }
    expect(groupByStatus([folder]).recent).toContain(finished)
    expect(groupByStatus([folder], new Map([[finished.thread.id, 'working' as const]])).working).toContain(finished)
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

  it('lists the Snoozed shelf flat, each row naming its project, with no project folder (Zach, November 10, 2026)', () => {
    app()
    const state = threadsStateFixture()
    const snoozes = new Map([['grok-previews', NOW + 3_600_000]])
    render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW, false, snoozes)}
      command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} shortcutsLive
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    const shelf = document.querySelector<HTMLElement>('section[aria-label="Snoozed"]')!
    fireEvent.click(within(shelf).getByRole('button', { name: /^Snoozed/ }))
    expect(shelf.querySelector('.thread-folder')).toBeNull()
    const row = within(shelf).getByRole('button', { name: 'Grok voice previews' }).closest('li')!
    const described = within(row).getByRole('button', { name: 'Grok voice previews' }).getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(described).toContain('workshop')
    expect(within(group('recent')).queryByRole('button', { name: 'Grok voice previews' })).toBeNull()
  })

  it('lists the Settled shelf as one list, newest settled first, with no project folder (Zach, November 13, 2026)', () => {
    app()
    // Settled out of the order they last moved in: the benchmark, quiet for four days, was put away a minute ago.
    const state = settledAt({ benchmark: NOW - 60_000, 'grok-previews': NOW - 30 * 60_000 })
    mount(state)
    const shelf = openSettled()
    expect(shelf.querySelector('.thread-folder')).toBeNull()
    expect(shelfTitles(shelf)).toEqual(['Benchmark rerun', 'Grok voice previews', 'Release notes 1.4', 'Thread routing', 'Notes cleanup'])
    // The row's time says when it was settled, not when it last did anything.
    const time = rowIn(shelf, 'Benchmark rerun').querySelector('time')!
    expect(time).toHaveAttribute('datetime', new Date(NOW - 60_000).toISOString())
    expect(time.getAttribute('title')).toMatch(/^Settled /)
    // A finished row is one line here as in Recent, and its project is in what a screen reader hears.
    const button = within(shelf).getByRole('button', { name: 'Benchmark rerun' })
    expect(button.getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('workshop')
  })

  it('offers Restore project on a row settled with its project, and Restore on one settled by itself', () => {
    app()
    const state = settledAt({ benchmark: NOW - 60_000 })
    state.host.projects = state.host.projects.map(project => project.id === 'notes' ? { ...project, workspaceSettledAt: new Date(NOW - 120_000).toISOString() } : project)
    const notes = state.host.projects.find(project => project.id === 'notes')!.title
    const command = vi.fn(async () => state)
    render(<ThreadSidebar state={state} organization={organizeWorkspace(state, describeThreads(state, NOW), '', state.activeProjectId, false, NOW)}
      command={command} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} shortcutsLive
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    const shelf = openSettled()
    // The project's threads were settled together, so they stand together, the one that last moved first.
    expect(shelfTitles(shelf).slice(0, 3)).toEqual(['Benchmark rerun', 'Weekly note', 'Notes cleanup'])
    const row = rowIn(shelf, 'Notes cleanup')
    expect(within(row).queryByRole('button', { name: 'Restore Notes cleanup' })).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: `Restore project ${notes}` }))
    expect(command).toHaveBeenCalledWith({ type: 'restore-project', projectId: 'notes' })
    expect(within(rowIn(shelf, 'Benchmark rerun')).getByRole('button', { name: 'Restore Benchmark rerun' })).toBeInTheDocument()
    expect(within(rowIn(shelf, 'Benchmark rerun')).queryByRole('button', { name: /^Restore project/ })).toBeNull()
    // The row's menu says it in words, for the keyboard and a right-click.
    fireEvent.contextMenu(row)
    fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Restore project' }))
    expect(command).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenLastCalledWith({ type: 'restore-project', projectId: 'notes' })
  })

  it('shows thirty settled threads, then thirty more on each Show more, and every match in a search', () => {
    app()
    const state = threadsStateFixture()
    const sample = state.host.threads.find(thread => thread.id === 'benchmark')!
    state.host.threads = [...state.host.threads, ...Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(sample), id: `put-away-${index}`, title: `Put away ${index}`,
      settledOverride: undefined, settledAt: undefined, workspaceSettledAt: new Date(NOW - index * 60_000).toISOString() }))] as AgentState['host']['threads']
    const view = mount(state)
    const shelf = openSettled()
    expect(shelfTitles(shelf)).toHaveLength(30)
    expect(shelfTitles(shelf).slice(0, 2)).toEqual(['Put away 0', 'Put away 1'])
    fireEvent.click(within(shelf).getByRole('button', { name: 'Show 30 more settled threads' }))
    expect(shelfTitles(shelf)).toHaveLength(60)
    fireEvent.click(within(shelf).getByRole('button', { name: 'Show 9 more settled threads' }))
    expect(shelfTitles(shelf)).toHaveLength(69)
    expect(within(shelf).queryByRole('button', { name: /^Show / })).toBeNull()
    view.unmount()
    mount(state, 'Put away')
    const found = document.querySelector<HTMLElement>('section[aria-label="Settled"]')!
    expect(shelfTitles(found)).toHaveLength(65)
    expect(within(found).queryByRole('button', { name: /^Show / })).toBeNull()
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

  it('keeps a row being renamed in its group while its turn finishes, with the typed name', () => {
    app()
    const state = threadsStateFixture()
    const view = (current: AgentState) => <ThreadSidebar state={current} organization={organizeWorkspace(current, describeThreads(current, NOW), '', current.activeProjectId, false, NOW)}
      command={vi.fn(async () => current)} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} shortcutsLive
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />
    const { rerender } = render(view(state))
    act(() => within(group('working')).getByRole('button', { name: 'Footer links' }).focus())
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'F2' })
    const field = within(group('working')).getByRole('textbox', { name: 'Rename Footer links' })
    fireEvent.change(field, { target: { value: 'Footer links, fixed' } })
    const finished: AgentState = { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === 'footer-links' ? { ...thread, status: 'idle' as const } : thread) } }
    rerender(view(finished))
    expect(within(group('working')).getByRole('textbox', { name: 'Rename Footer links' })).toHaveValue('Footer links, fixed')
    // Once the rename ends, the row goes where its state puts it.
    fireEvent.keyDown(within(group('working')).getByRole('textbox', { name: 'Rename Footer links' }), { key: 'Escape' })
    rerender(view(finished))
    expect(within(group('recent')).getByRole('button', { name: 'Footer links' })).toBeInTheDocument()
  })

  it('keeps the project folders when Settings says By project', () => {
    app({ threadListGrouping: 'project' })
    mount()
    expect(document.querySelector('.thread-group')).toBeNull()
    expect(document.querySelector('.thread-folder[data-section="open"]')).not.toBeNull()
    // Settled keeps its project folders there too, and a folder's rows their last activity's time.
    const shelf = openSettled()
    expect(shelf.querySelector('.thread-folder[data-section="settled"]')).not.toBeNull()
    expect(shelf.querySelector('.thread-nav__more')).toBeNull()
  })
})
