import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView, type ThreadToolsProps, type ThreadsViewProps } from '../../../src/renderer/src/agents/ThreadsView'
import {
  LAYOUT_STORAGE_KEY, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, SINGLE_VIEW, SplitLayoutStore, THREAD_DRAG_TYPE, threadPromptId,
} from '../../../src/renderer/src/agents/splitLayout'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const WIDE = 1200

/** Manual threads only, with a controller that moves the selection when asked. */
function mount(options: { readonly width?: number; readonly height?: number; readonly store?: SplitLayoutStore; readonly tools?: (props: ThreadToolsProps) => React.ReactNode; readonly activeThreadId?: string; readonly slots?: Partial<ThreadsViewProps> } = {}) {
  const initial = threadsStateFixture()
  initial.assignments = []
  initial.queue = []
  initial.activeThreadId = options.activeThreadId ?? 'grok-previews'
  const live = liveAgentState(initial)
  const held: { threadId: string; release: () => void }[] = []
  let holdSelection = false
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => {
    if (request.type !== 'select-thread') return live.command(request)
    const apply = (): AgentState => {
      const thread = live.state.host.threads.find(item => item.id === request.threadId)!
      return live.publish({ activeThreadId: thread.id, activeProjectId: thread.projectId })
    }
    if (!holdSelection) return apply()
    return new Promise(resolve => { held.push({ threadId: request.threadId, release: () => resolve(apply()) }) })
  })
  vi.mocked(useAgents).mockImplementation(() => ({ ...live.useLive(), command }))
  const store = options.store ?? new SplitLayoutStore()
  const view = (width: number, height?: number) => <ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={store} paneAreaWidth={width} paneAreaHeight={height} tools={options.tools} {...options.slots} />
  const rendered = render(view(options.width ?? WIDE, options.height))
  const pane = (title: string) => screen.getByRole('region', { name: title })
  const prompt = (title: string) => within(pane(title)).getByRole('textbox', { name: 'Prompt', exact: true })
  const selections = () => command.mock.calls.filter(([request]) => request.type === 'select-thread').map(([request]) => (request as { threadId: string }).threadId)
  return {
    live, command, store, pane, prompt, selections, held, rendered,
    hold: (value: boolean) => { holdSelection = value },
    resize: (width: number, height?: number) => rendered.rerender(view(width, height ?? options.height)),
  }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const sidebar = () => screen.getByRole('complementary', { name: 'Thread sidebar' })
const openBesideButton = (title: string) => within(sidebar()).getByRole('button', { name: `Open ${title} beside`, exact: true })

describe('split thread workspace', () => {
  it('opens a second thread beside the first, evenly, and gives the new pane the selection once', async () => {
    const view = mount()
    expect(screen.queryByRole('separator')).toBeNull()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    const panes = within(screen.getByRole('group', { name: 'Thread panes' })).getAllByRole('region')
    expect(panes.map(item => item.getAttribute('aria-label'))).toEqual(['Grok voice previews', 'Streaming WAV stall'])
    expect(screen.getByRole('separator', { name: 'Resize panes' })).toHaveAttribute('aria-valuenow', '50')
    expect(view.pane('Streaming WAV stall')).toHaveAttribute('data-focused')
    expect(view.pane('Grok voice previews')).not.toHaveAttribute('data-focused')
    expect(view.selections()).toEqual(['wav-stall'])
    expect(view.prompt('Grok voice previews').id).toBe(threadPromptId('grok-previews'))
    expect(view.prompt('Streaming WAV stall').id).toBe(threadPromptId('wav-stall'))
    // Only the focused thread is current in the sidebar; the other open pane is marked as on screen.
    expect(within(sidebar()).getByRole('button', { name: 'Streaming WAV stall', exact: true })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar()).getByRole('button', { name: 'Grok voice previews', exact: true }).closest('li')).toHaveAttribute('data-open')
  })

  it('keeps each pane\'s draft, send and pending message with its own thread, across projects', async () => {
    const view = mount()
    fireEvent.click(within(sidebar()).getByRole('button', { name: /^Settled/ }))
    await act(async () => { fireEvent.click(openBesideButton('Notes cleanup')) })
    expect(within(view.pane('Notes cleanup')).getByText('notes')).toBeInTheDocument()
    expect(within(view.pane('Grok voice previews')).getByText('workshop')).toBeInTheDocument()
    fireEvent.change(view.prompt('Grok voice previews'), { target: { value: 'Draft for the previews thread' } })
    fireEvent.change(view.prompt('Notes cleanup'), { target: { value: 'Send this to notes' } })
    const drafts = vi.mocked(useAgents).mock.results.at(-1)!.value.threadDrafts
    expect(drafts.draft('grok-previews').text).toBe('Draft for the previews thread')
    expect(drafts.draft('notes-cleanup').text).toBe('Send this to notes')
    await act(async () => { fireEvent.keyDown(view.prompt('Notes cleanup'), { key: 'Enter', code: 'Enter', keyCode: 13 }) })
    const sends = view.command.mock.calls.map(([request]) => request).filter(request => request.type === 'manual-send')
    expect(sends).toEqual([expect.objectContaining({ type: 'manual-send', threadId: 'notes-cleanup', text: 'Send this to notes' })])
    expect(within(view.pane('Notes cleanup')).getByLabelText('Pending message')).toHaveTextContent('Send this to notes')
    expect(within(view.pane('Grok voice previews')).queryByLabelText('Pending message')).toBeNull()
    expect(view.prompt('Grok voice previews')).toHaveValue('Draft for the previews thread')
    // Typing in the other pane never moved its text anywhere else.
    expect(drafts.draft('grok-previews').text).toBe('Draft for the previews thread')
  })

  it('closes only the view: no thread command, the thread stays in the sidebar and focus moves to the other pane', async () => {
    const view = mount()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    const before = view.command.mock.calls.length
    await act(async () => { fireEvent.click(within(view.pane('Streaming WAV stall')).getByRole('button', { name: 'Close Streaming WAV stall pane' })) })
    const after = view.command.mock.calls.slice(before).map(([request]) => request.type)
    expect(after).toEqual(['select-thread'])
    expect(view.selections().at(-1)).toBe('grok-previews')
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Streaming WAV stall' })).toBeNull()
    expect(within(sidebar()).getByRole('button', { name: 'Streaming WAV stall', exact: true })).toBeInTheDocument()
    expect(view.store.get()).toBe(SINGLE_VIEW)
    // Closing the unfocused pane sends nothing at all.
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    await act(async () => { fireEvent.pointerDown(view.pane('Grok voice previews')); fireEvent.focus(view.prompt('Grok voice previews')) })
    const beforeUnfocused = view.command.mock.calls.length
    await act(async () => { fireEvent.click(within(view.pane('Streaming WAV stall')).getByRole('button', { name: 'Close Streaming WAV stall pane' })) })
    expect(view.command.mock.calls.slice(beforeUnfocused)).toEqual([])
  })

  it('moves only the focused pane when the selection changes elsewhere and never selects on a state echo', async () => {
    const view = mount()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    const selections = view.selections().length
    // Voice or attention selects another thread: the focused pane shows it, the other pane stays.
    await act(async () => { view.live.publish({ activeThreadId: 'benchmark', activeProjectId: 'workshop' }) })
    const titles = within(screen.getByRole('group', { name: 'Thread panes' })).getAllByRole('region').map(item => item.getAttribute('aria-label'))
    expect(titles).toEqual(['Grok voice previews', 'Benchmark rerun'])
    // Selecting the thread already in the other pane moves focus there instead of duplicating it.
    await act(async () => { view.live.publish({ activeThreadId: 'grok-previews' }) })
    expect(view.pane('Grok voice previews')).toHaveAttribute('data-focused')
    expect(view.pane('Benchmark rerun')).not.toHaveAttribute('data-focused')
    expect(view.selections()).toHaveLength(selections)
  })

  it('shows a focused pane at once and an older published state cannot pull focus back', async () => {
    const view = mount()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    view.hold(true)
    await act(async () => { fireEvent.pointerDown(within(view.pane('Grok voice previews')).getByRole('log')) })
    expect(view.pane('Grok voice previews')).toHaveAttribute('data-focused')
    await act(async () => { view.live.publish({ notice: 'unrelated echo' }) })
    expect(view.live.state.activeThreadId).toBe('wav-stall')
    expect(view.pane('Grok voice previews')).toHaveAttribute('data-focused')
    expect(view.pane('Streaming WAV stall')).not.toHaveAttribute('data-focused')
    await act(async () => { view.held[0]!.release() })
    expect(view.pane('Grok voice previews')).toHaveAttribute('data-focused')
    expect(view.selections()).toEqual(['wav-stall', 'grok-previews'])
  })

  it('resizes from the keyboard within usable widths and evens the split with Enter', async () => {
    const view = mount()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    const divider = screen.getByRole('separator', { name: 'Resize panes' })
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '55')
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(divider).toHaveAttribute('aria-valuenow', divider.getAttribute('aria-valuemin'))
    expect(Number(divider.getAttribute('aria-valuemin'))).toBe(Math.round(MIN_PANE_WIDTH / (WIDE - 9) * 100))
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    expect(view.selections()).toEqual(['wav-stall'])
  })

  it('shows one pane with tabs when narrow, keeps the hidden pane and its draft, and restores the same split when wide again', async () => {
    const view = mount()
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize panes' }), { key: 'ArrowRight' })
    fireEvent.change(view.prompt('Grok voice previews'), { target: { value: 'Kept while hidden' } })
    view.resize(700)
    expect(screen.queryByRole('separator')).toBeNull()
    const tabs = screen.getByRole('tablist', { name: 'Open panes' })
    expect(within(tabs).getAllByRole('tab').map(tab => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Grok voice previews', 'false'], ['Streaming WAV stall', 'true']])
    const hidden = document.getElementById('thread-pane-grok-previews')!
    expect(hidden).toHaveAttribute('inert')
    expect(within(hidden).getByDisplayValue('Kept while hidden')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(within(tabs).getByRole('tab', { name: 'Streaming WAV stall' }), { key: 'ArrowLeft' }) })
    expect(view.selections().at(-1)).toBe('grok-previews')
    expect(document.getElementById('thread-pane-wav-stall')).toHaveAttribute('inert')
    expect(document.getElementById('thread-pane-grok-previews')).not.toHaveAttribute('inert')
    view.resize(WIDE)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('separator', { name: 'Resize panes' })).toHaveAttribute('aria-valuenow', '55')
    expect(view.prompt('Grok voice previews')).toHaveValue('Kept while hidden')
  })

  it('opens a dragged sidebar thread on the side it is dropped, and replaces a pane when dropped on it', async () => {
    const view = mount()
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', get types() { return [...data.keys()] }, effectAllowed: 'all', dropEffect: 'none' }
    const row = within(sidebar()).getByRole('button', { name: 'Streaming WAV stall', exact: true })
    expect(row).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(data.get(THREAD_DRAG_TYPE)).toBe('wav-stall')
    const left = screen.getByText('Open on the left').parentElement!
    fireEvent.dragOver(left, { dataTransfer })
    expect(left).toHaveAttribute('data-over')
    await act(async () => { fireEvent.drop(left, { dataTransfer }) })
    fireEvent.dragEnd(row, { dataTransfer })
    const titles = () => within(screen.getByRole('group', { name: 'Thread panes' })).getAllByRole('region').map(item => item.getAttribute('aria-label'))
    expect(titles()).toEqual(['Streaming WAV stall', 'Grok voice previews'])
    expect(screen.queryByText('Open on the left')).toBeNull()

    data.clear()
    fireEvent.dragStart(within(sidebar()).getByRole('button', { name: 'Footer links', exact: true }), { dataTransfer })
    const targets = screen.getAllByText('Show here')
    expect(targets).toHaveLength(2)
    await act(async () => { fireEvent.drop(targets[1]!.parentElement!, { dataTransfer }) })
    expect(titles()).toEqual(['Streaming WAV stall', 'Footer links'])
    expect(view.pane('Footer links')).toHaveAttribute('data-focused')
    expect(view.selections()).toEqual(['wav-stall', 'footer-links'])
  })

  it('opens beside with Ctrl+Enter from the sidebar and moves between panes with F6', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const view = mount()
    const row = within(sidebar()).getByRole('button', { name: 'Streaming WAV stall', exact: true })
    row.focus()
    await act(async () => { fireEvent.keyDown(row, { key: 'Enter', ctrlKey: true }) })
    expect(view.selections()).toEqual(['wav-stall'])
    expect(view.pane('Streaming WAV stall')).toHaveAttribute('data-focused')
    // Like opening a row, the keyboard stays in the sidebar; F6 enters the focused pane.
    expect(row).toHaveFocus()
    await act(async () => { fireEvent.keyDown(row, { key: 'F6' }) })
    await act(async () => { vi.runAllTimers() })
    expect(view.prompt('Streaming WAV stall')).toHaveFocus()
    await act(async () => { fireEvent.keyDown(view.prompt('Streaming WAV stall'), { key: 'F6' }) })
    await act(async () => { vi.runAllTimers() })
    expect(view.prompt('Grok voice previews')).toHaveFocus()
    expect(view.pane('Grok voice previews')).toHaveAttribute('data-focused')
    expect(view.selections()).toEqual(['wav-stall', 'grok-previews'])
  })

  it('gives one shared tools slot the focused thread and keeps the arrangement when the page is left and reopened', async () => {
    const seen: (string | null)[] = []
    const store = new SplitLayoutStore()
    const view = mount({ store, tools: props => { seen.push(props.focusedThreadId); return <aside aria-label="Tools">{props.focusedThreadId}</aside> } })
    expect(screen.getAllByRole('complementary', { name: 'Tools' })).toHaveLength(1)
    expect(screen.getByRole('complementary', { name: 'Tools' })).toHaveTextContent('grok-previews')
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    expect(screen.getByRole('complementary', { name: 'Tools' })).toHaveTextContent('wav-stall')
    view.rendered.unmount()
    render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={store} paneAreaWidth={WIDE} />)
    expect(within(screen.getByRole('group', { name: 'Thread panes' })).getAllByRole('region')).toHaveLength(2)
    expect(seen).toContain('wav-stall')
  })

  it('mounts per-pane slots on their own thread and reports the threads on screen without selecting', async () => {
    const reported: (readonly string[])[] = []
    const view = mount({ slots: {
      onPaneThreadsChange: ids => reported.push(ids),
      paneCrumb: pane => <span data-testid="crumb">{pane.row.thread.id}</span>,
      paneNotice: pane => <button type="button" onClick={pane.focusPrompt}>Notice for {pane.row.thread.id}</button>,
      focusedPaneActions: <button type="button">Files</button>,
    } })
    expect(reported).toEqual([['grok-previews']])
    await act(async () => { fireEvent.click(openBesideButton('Streaming WAV stall')) })
    expect(reported.at(-1)).toEqual(['grok-previews', 'wav-stall'])
    for (const [title, id] of [['Grok voice previews', 'grok-previews'], ['Streaming WAV stall', 'wav-stall']] as const) {
      expect(within(view.pane(title)).getByTestId('crumb')).toHaveTextContent(id)
    }
    expect(within(view.pane('Streaming WAV stall')).getByRole('button', { name: 'Files' })).toBeInTheDocument()
    expect(within(view.pane('Grok voice previews')).queryByRole('button', { name: 'Files' })).toBeNull()
    fireEvent.click(within(view.pane('Grok voice previews')).getByRole('button', { name: 'Notice for grok-previews' }))
    expect(view.prompt('Grok voice previews')).toHaveFocus()
    // Narrow focus hides a pane but it is still on screen for this purpose; the list is unchanged and nothing is selected.
    const [count, selections] = [reported.length, view.selections()]
    view.resize(700)
    view.resize(WIDE)
    expect(reported).toHaveLength(count)
    expect(view.selections()).toEqual(selections)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close Grok voice previews pane' })) })
    expect(reported.at(-1)).toEqual(['wav-stall'])
    view.rendered.unmount()
    expect(reported.at(-1)).toEqual([])
    expect(view.command.mock.calls.filter(([request]) => request.type !== 'select-thread')).toEqual([])
  })
})

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  setItem(key: string, value: string): void { this.items.set(key, value) }
}

const TALL = 900
const regions = () => within(screen.getByRole('group', { name: 'Thread panes' })).queryAllByRole('region')
  .filter(item => item.matches('section.thread-pane')).map(item => item.getAttribute('aria-label'))

/** Opens beside from the sidebar, in order. */
async function openAll(...titles: string[]): Promise<void> {
  for (const title of titles) await act(async () => { fireEvent.click(openBesideButton(title)) })
}

describe('multi-pane workspace', () => {
  it('snaps a third pane across the row below, a fourth into a 2-by-2 grid and keeps adding past four', async () => {
    // Wide enough for three usable columns once a fifth pane arrives.
    const view = mount({ width: 1400, height: TALL })
    await openAll('Streaming WAV stall')
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    await openAll('Footer links')
    expect(regions()).toEqual(['Grok voice previews', 'Streaming WAV stall', 'Footer links'])
    expect(screen.getByRole('group', { name: 'Thread panes' })).toHaveAttribute('data-rows')
    // One divider between the top two, one between the rows; the third pane spans its row.
    expect(screen.getAllByRole('separator').map(item => [item.getAttribute('aria-label'), item.getAttribute('aria-orientation')])).toEqual([
      ['Resize Grok voice previews and Streaming WAV stall', 'vertical'], ['Resize rows 1 and 2', 'horizontal'],
    ])
    const area = view.pane('Footer links').parentElement!
    expect(view.pane('Footer links').style.width).toBe('var(--pane-2-w)')
    expect(area.style.getPropertyValue('--pane-2-w')).toBe('calc((100% - 0px) * 1)')
    expect(area.style.getPropertyValue('--pane-2-y')).toBe('calc((100% - 9px) * 0.5 + 9px)')
    await openAll('Weekly note')
    expect(screen.getAllByRole('separator')).toHaveLength(3)
    expect(area.style.getPropertyValue('--pane-3-x')).toBe('calc((100% - 9px) * 0.5 + 9px)')
    await openAll('Visual gate flake')
    expect(regions()).toHaveLength(5)
    // Five panes: three over two.
    expect(area.style.getPropertyValue('--pane-2-w')).toBe(`calc((100% - 18px) * ${1 / 3})`)
    expect(area.style.getPropertyValue('--pane-4-y')).toBe('calc((100% - 9px) * 0.5 + 9px)')
    expect(view.pane('Visual gate flake')).toHaveAttribute('data-focused')
    // Every pane still has its own composer, and only selections were sent.
    expect(new Set(regions().map(title => view.prompt(title!).id)).size).toBe(5)
    expect(view.command.mock.calls.map(([request]) => request.type)).toEqual(['select-thread', 'select-thread', 'select-thread', 'select-thread'])
  })

  it('switches to a single row with its own dividers and back to the grid with the grid sizes kept', async () => {
    const view = mount({ width: 1400, height: TALL })
    await openAll('Streaming WAV stall', 'Footer links')
    const top = screen.getByRole('separator', { name: 'Resize Grok voice previews and Streaming WAV stall' })
    fireEvent.keyDown(top, { key: 'ArrowRight' })
    expect(top).toHaveAttribute('aria-valuenow', '55')
    const toggle = within(view.pane('Footer links')).getByRole('button', { name: 'Single row' })
    expect(within(view.pane('Grok voice previews')).queryByRole('button', { name: 'Single row' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('group', { name: 'Thread panes' })).not.toHaveAttribute('data-rows')
    const dividers = screen.getAllByRole('separator')
    expect(dividers.map(item => item.getAttribute('aria-orientation'))).toEqual(['vertical', 'vertical'])
    expect(dividers.map(item => item.getAttribute('aria-valuenow'))).toEqual(['33', '67'])
    fireEvent.keyDown(dividers[1]!, { key: 'ArrowLeft' })
    expect(screen.getAllByRole('separator')[1]).toHaveAttribute('aria-valuenow', '62')
    fireEvent.click(within(view.pane('Footer links')).getByRole('button', { name: 'Single row' }))
    expect(screen.getByRole('separator', { name: 'Resize Grok voice previews and Streaming WAV stall' })).toHaveAttribute('aria-valuenow', '55')
    fireEvent.click(within(view.pane('Footer links')).getByRole('button', { name: 'Single row' }))
    expect(screen.getAllByRole('separator')[1]).toHaveAttribute('aria-valuenow', '62')
    expect(view.store.get().arrangement).toBe('row')
  })

  it('resizes rows from the keyboard and never lets a row fall below a usable height', async () => {
    mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    const rows = screen.getByRole('separator', { name: 'Resize rows 1 and 2' })
    fireEvent.keyDown(rows, { key: 'ArrowDown' })
    expect(rows).toHaveAttribute('aria-valuenow', '55')
    fireEvent.keyDown(rows, { key: 'End' })
    expect(rows).toHaveAttribute('aria-valuenow', String(Math.round((1 - MIN_PANE_HEIGHT / (TALL - 9)) * 100)))
    fireEvent.doubleClick(rows)
    expect(rows).toHaveAttribute('aria-valuenow', '50')
  })

  it('zooms one pane and returns to the same arrangement, from the button or Ctrl+Shift+M, without touching threads', async () => {
    const view = mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize rows 1 and 2' }), { key: 'ArrowUp' })
    fireEvent.change(view.prompt('Footer links'), { target: { value: 'Footer draft while zoomed' } })
    const before = view.command.mock.calls.length
    await act(async () => { fireEvent.click(within(view.pane('Grok voice previews')).getByRole('button', { name: 'Zoom Grok voice previews pane' })) })
    const tabs = screen.getByRole('tablist', { name: 'Open panes' })
    expect(within(tabs).getAllByRole('tab')).toHaveLength(4)
    expect(within(tabs).getByRole('tab', { name: 'Grok voice previews' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryAllByRole('separator')).toHaveLength(0)
    expect(document.getElementById('thread-pane-footer-links')).toHaveAttribute('inert')
    expect(screen.getByText('Grok voice previews zoomed')).toHaveAttribute('role', 'status')
    // Zoom focused the pane it was asked for; nothing else was sent.
    expect(view.command.mock.calls.slice(before).map(([request]) => request)).toEqual([{ type: 'select-thread', threadId: 'grok-previews' }])
    await act(async () => { fireEvent.keyDown(document.getElementById(threadPromptId('grok-previews'))!, { key: 'M', ctrlKey: true, shiftKey: true }) })
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('separator', { name: 'Resize rows 1 and 2' })).toHaveAttribute('aria-valuenow', '45')
    await act(async () => { fireEvent.pointerDown(view.pane('Footer links')); fireEvent.keyDown(view.prompt('Footer links'), { key: 'm', ctrlKey: true, shiftKey: true }) })
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Footer links' })).toHaveAttribute('aria-selected', 'true')
    await act(async () => { fireEvent.click(within(document.getElementById('thread-pane-footer-links')!).getByRole('button', { name: 'Show all panes' })) })
    expect(regions()).toEqual(['Grok voice previews', 'Streaming WAV stall', 'Footer links', 'Weekly note'])
    expect(view.prompt('Footer links')).toHaveValue('Footer draft while zoomed')
    expect(view.command.mock.calls.filter(([request]) => request.type !== 'select-thread')).toEqual([])
  })

  it('shows one pane with tabs when the area is too short for the grid and returns to the grid when it is tall again', async () => {
    const view = mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    view.resize(WIDE, 2 * MIN_PANE_HEIGHT + 8)
    expect(screen.getByRole('tablist', { name: 'Open panes' })).toBeInTheDocument()
    // No zoom control while the window alone decides; closing still works.
    const weekly = document.getElementById('thread-pane-weekly-note')!
    expect(within(weekly).queryByRole('button', { name: /Zoom/ })).toBeNull()
    expect(within(weekly).getByRole('button', { name: 'Close Weekly note pane' })).toBeInTheDocument()
    view.resize(WIDE, TALL)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getAllByRole('separator')).toHaveLength(3)
  })

  it('moves a pane from its handle with the arrow keys, keeping focus, drafts and the selection where they were', async () => {
    const view = mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    fireEvent.change(view.prompt('Grok voice previews'), { target: { value: 'Previews draft' } })
    const before = view.command.mock.calls.length
    const grip = within(view.pane('Grok voice previews')).getByRole('button', { name: 'Move Grok voice previews pane' })
    grip.focus()
    await act(async () => { fireEvent.keyDown(grip, { key: 'ArrowRight' }) })
    expect(regions()).toEqual(['Streaming WAV stall', 'Grok voice previews', 'Footer links', 'Weekly note'])
    await act(async () => { fireEvent.keyDown(grip, { key: 'ArrowDown' }) })
    expect(regions()).toEqual(['Streaming WAV stall', 'Weekly note', 'Footer links', 'Grok voice previews'])
    expect(grip).toHaveFocus()
    expect(screen.getByText('Grok voice previews moved to pane 4 of 4')).toHaveAttribute('role', 'status')
    expect(view.prompt('Grok voice previews')).toHaveValue('Previews draft')
    expect(view.command.mock.calls.slice(before)).toEqual([])
    expect(view.pane('Weekly note')).toHaveAttribute('data-focused')
  })

  it('previews the snapped slot while a thread is dragged, adds it there or replaces the pane it is dropped on', async () => {
    const view = mount({ height: TALL })
    await openAll('Streaming WAV stall')
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', get types() { return [...data.keys()] }, effectAllowed: 'all', dropEffect: 'none' }
    fireEvent.dragStart(within(sidebar()).getByRole('button', { name: 'Footer links', exact: true }), { dataTransfer })
    const add = screen.getByText('Add here').parentElement!
    // The new pane will span the row below the first two.
    const expected = document.createElement('div')
    expected.style.top = 'calc((100% - 9px) * 0.5 + 9px)'
    expected.style.width = 'calc((100% - 0px) * 1)'
    expect([add.style.top, add.style.width]).toEqual([expected.style.top, expected.style.width])
    expect(screen.getAllByText('Show here')).toHaveLength(2)
    await act(async () => { fireEvent.drop(add, { dataTransfer }) })
    expect(regions()).toEqual(['Grok voice previews', 'Streaming WAV stall', 'Footer links'])
    expect(view.pane('Footer links')).toHaveAttribute('data-focused')
    data.clear()
    fireEvent.dragStart(within(sidebar()).getByRole('button', { name: 'Weekly note', exact: true }), { dataTransfer })
    const targets = screen.getAllByText('Show here')
    expect(targets).toHaveLength(3)
    await act(async () => { fireEvent.drop(targets[1]!.parentElement!, { dataTransfer }) })
    expect(regions()).toEqual(['Grok voice previews', 'Weekly note', 'Footer links'])
  })

  it('keeps the page order pane, divider, pane, row by row, with each pane\'s layout controls before its content', async () => {
    mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    const group = screen.getByRole('group', { name: 'Thread panes' })
    expect([...group.querySelectorAll('section.thread-pane, [role="separator"]')].map(item => item.getAttribute('aria-label'))).toEqual([
      'Grok voice previews', 'Resize Grok voice previews and Streaming WAV stall', 'Streaming WAV stall', 'Resize rows 1 and 2',
      'Footer links', 'Resize Footer links and Weekly note', 'Weekly note',
    ])
    const tabbable = [...within(group).getByRole('region', { name: 'Footer links' }).querySelectorAll<HTMLElement>('button, textarea')].filter(item => !item.hasAttribute('disabled'))
    expect(tabbable[0]).toHaveAccessibleName('Move Footer links pane')
    expect(tabbable.at(-1)!.closest('.thread-pane__controls')).toBeNull()
  })

  it('shows move targets only after a pane drag has started, so they never cover the handle as it starts, and moves the pane where it is dropped', async () => {
    mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links')
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', get types() { return [...data.keys()] }, effectAllowed: 'all', dropEffect: 'none' }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Move Grok voice previews pane' }), { dataTransfer })
    expect(screen.queryByText('Move here')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const targets = screen.getAllByText('Move here')
    expect(targets).toHaveLength(3)
    await act(async () => { fireEvent.drop(targets[2]!.parentElement!, { dataTransfer }) })
    expect(regions()).toEqual(['Footer links', 'Streaming WAV stall', 'Grok voice previews'])
    expect(screen.queryByText('Move here')).toBeNull()
  })

  it('ends a divider drag when pointer capture is taken away and keeps the size the drag reached', async () => {
    const captured = new Set<number>()
    const element = HTMLElement.prototype as unknown as Record<string, unknown>
    const saved = ['setPointerCapture', 'hasPointerCapture', 'releasePointerCapture'].map(name => [name, element[name]] as const)
    element['setPointerCapture'] = (id: number) => { captured.add(id) }
    element['hasPointerCapture'] = (id: number) => captured.has(id)
    element['releasePointerCapture'] = (id: number) => { captured.delete(id) }
    try {
      mount()
      await openAll('Footer links')
      const divider = screen.getByRole('separator', { name: 'Resize panes' })
      fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 500 })
      expect(divider).toHaveAttribute('data-dragging')
      fireEvent.pointerMove(divider, { pointerId: 1, clientX: 500 + (WIDE - 9) * 0.1 })
      await act(async () => { captured.clear(); fireEvent.lostPointerCapture(divider, { pointerId: 1 }) })
      expect(divider).not.toHaveAttribute('data-dragging')
      expect(divider).toHaveAttribute('aria-valuenow', '60')
    } finally {
      for (const [name, value] of saved) element[name] = value
    }
  })

  it('closes a pane from a grid without losing the other drafts, and re-snaps the rest', async () => {
    const view = mount({ height: TALL })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    fireEvent.change(view.prompt('Weekly note'), { target: { value: 'Weekly draft' } })
    await act(async () => { fireEvent.click(within(view.pane('Streaming WAV stall')).getByRole('button', { name: 'Close Streaming WAV stall pane' })) })
    expect(regions()).toEqual(['Grok voice previews', 'Footer links', 'Weekly note'])
    expect(view.prompt('Weekly note')).toHaveValue('Weekly draft')
    expect(view.pane('Weekly note').parentElement!.style.getPropertyValue('--pane-2-w')).toBe('calc((100% - 0px) * 1)')
    expect(within(sidebar()).getByRole('button', { name: 'Streaming WAV stall', exact: true })).toBeInTheDocument()
  })

  it('restores the saved arrangement, threads, sizes and focus after a restart without sending any thread command', async () => {
    const storage = new MemoryStorage()
    const first = mount({ height: TALL, store: new SplitLayoutStore(storage) })
    await openAll('Streaming WAV stall', 'Footer links', 'Weekly note')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize rows 1 and 2' }), { key: 'ArrowDown' })
    await act(async () => { fireEvent.pointerDown(first.pane('Footer links')) })
    const saved = JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY)!)
    expect(saved).toMatchObject({ version: 1, panes: ['grok-previews', 'wav-stall', 'footer-links', 'weekly-note'], arrangement: 'grid', focused: 'footer-links' })
    // The saved view names threads and sizes only.
    expect(Object.keys(saved).sort()).toEqual(['arrangement', 'focused', 'grid', 'panes', 'sizes', 'version', 'zoomed'])
    first.rendered.unmount()
    cleanup()

    const restarted = mount({ height: TALL, store: new SplitLayoutStore(storage), activeThreadId: 'footer-links' })
    expect(regions()).toEqual(['Grok voice previews', 'Streaming WAV stall', 'Footer links', 'Weekly note'])
    expect(screen.getByRole('separator', { name: 'Resize rows 1 and 2' })).toHaveAttribute('aria-valuenow', '55')
    expect(restarted.pane('Footer links')).toHaveAttribute('data-focused')
    expect(restarted.command).not.toHaveBeenCalled()
  })

  it('keeps a saved pane whose thread is not available yet, and brings it back when the thread appears', async () => {
    const storage = new MemoryStorage()
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ version: 1, panes: ['grok-previews', 'later-thread', 'wav-stall'], arrangement: 'grid', sizes: [0.3, 0.3, 0.4], grid: { rows: [0.5, 0.5], columns: [[0.5, 0.5], [1]] }, zoomed: false, focused: 'grok-previews' }))
    const view = mount({ height: TALL, store: new SplitLayoutStore(storage) })
    expect(regions()).toEqual(['Grok voice previews', 'Streaming WAV stall'])
    expect(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY)!).panes).toEqual(['grok-previews', 'later-thread', 'wav-stall'])
    const benchmark = view.live.state.host.threads.find(thread => thread.id === 'benchmark')!
    await act(async () => { view.live.publish({ host: { ...view.live.state.host, threads: [...view.live.state.host.threads, { ...benchmark, id: 'later-thread', title: 'Later thread' }] } }) })
    expect(regions()).toEqual(['Grok voice previews', 'Later thread', 'Streaming WAV stall'])
    expect(view.command).not.toHaveBeenCalled()
  })
})
