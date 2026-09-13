import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView, type ThreadToolsProps } from '../../../src/renderer/src/agents/ThreadsView'
import {
  MIN_PANE_WIDTH, SINGLE_VIEW, SplitLayoutStore, THREAD_DRAG_TYPE, clampShare, closePane, isNarrow, openBeside, prune, replacePane, resizeSplit, retarget, threadPromptId,
} from '../../../src/renderer/src/agents/splitLayout'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const WIDE = 1200

describe('split layout model', () => {
  it('splits evenly beside the focused thread on either side and never duplicates a thread', () => {
    expect(openBeside(SINGLE_VIEW, 'a', 'b')).toEqual({ panes: ['a', 'b'], sizes: [0.5, 0.5] })
    expect(openBeside(SINGLE_VIEW, 'a', 'b', 'start')).toEqual({ panes: ['b', 'a'], sizes: [0.5, 0.5] })
    expect(openBeside(SINGLE_VIEW, 'a', 'a')).toBe(SINGLE_VIEW)
    expect(openBeside(SINGLE_VIEW, null, 'b')).toBe(SINGLE_VIEW)
    const split = { panes: ['a', 'b'], sizes: [0.3, 0.7] }
    expect(openBeside(split, 'b', 'a')).toBe(split)
    // In a full split the other pane shows the new thread and the sizes stay.
    expect(openBeside(split, 'a', 'c')).toEqual({ panes: ['a', 'c'], sizes: [0.3, 0.7] })
    expect(openBeside(split, 'b', 'c')).toEqual({ panes: ['c', 'b'], sizes: [0.3, 0.7] })
    expect(replacePane(split, 0, 'b')).toBe(split)
  })

  it('closes to the single view, moves only the focused pane after an outside selection and drops missing threads', () => {
    const split = { panes: ['a', 'b'], sizes: [0.3, 0.7] }
    expect(closePane(split, 'a')).toBe(SINGLE_VIEW)
    expect(closePane(split, 'x')).toBe(split)
    expect(retarget(split, 'b', 'c')).toEqual({ panes: ['a', 'c'], sizes: [0.3, 0.7] })
    expect(retarget(split, 'b', 'a')).toBe(split)
    expect(retarget(split, 'b', null)).toBe(split)
    expect(prune(split, id => id !== 'b')).toBe(SINGLE_VIEW)
    expect(prune(split, () => true)).toBe(split)
  })

  it('keeps both panes usable while resizing and switches to one pane below two usable widths', () => {
    expect(clampShare(0, WIDE)).toBeCloseTo(MIN_PANE_WIDTH / (WIDE - 9))
    expect(clampShare(1, WIDE)).toBeCloseTo(1 - MIN_PANE_WIDTH / (WIDE - 9))
    expect(clampShare(0.9, 700)).toBe(0.5)
    expect(resizeSplit({ panes: ['a', 'b'], sizes: [0.5, 0.5] }, 0.6, WIDE).sizes).toEqual([0.6, 0.4])
    expect(isNarrow(2 * MIN_PANE_WIDTH + 9, 2)).toBe(false)
    expect(isNarrow(2 * MIN_PANE_WIDTH + 8, 2)).toBe(true)
    expect(isNarrow(300, 1)).toBe(false)
    expect(threadPromptId('a')).toBe('thread-workspace-prompt-a')
  })
})

/** Manual threads only, with a controller that moves the selection when asked. */
function mount(options: { readonly width?: number; readonly store?: SplitLayoutStore; readonly tools?: (props: ThreadToolsProps) => React.ReactNode; readonly activeThreadId?: string } = {}) {
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
  const view = (width: number) => <ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={store} paneAreaWidth={width} tools={options.tools} />
  const rendered = render(view(options.width ?? WIDE))
  const pane = (title: string) => screen.getByRole('region', { name: title })
  const prompt = (title: string) => within(pane(title)).getByRole('textbox', { name: 'Prompt', exact: true })
  const selections = () => command.mock.calls.filter(([request]) => request.type === 'select-thread').map(([request]) => (request as { threadId: string }).threadId)
  return {
    live, command, store, pane, prompt, selections, held, rendered,
    hold: (value: boolean) => { holdSelection = value },
    resize: (width: number) => rendered.rerender(view(width)),
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
})
