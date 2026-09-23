import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsSurface, nestedSubagents, SubagentElapsed } from '../../../src/renderer/src/tools/AgentsSurface'
import { SubagentsStore } from '../../../src/renderer/src/tools/subagentsStore'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentChange, type SubagentRow, type SubagentsBridge } from '../../../src/shared/subagents'

const row = (id: string, sequence = 1, patch: Partial<SubagentRow> = {}): SubagentRow => ({ id, sequence, revision: 1, assignmentId: `${id}-run`, assignmentCount: 1, title: `Task ${id}`, description: `Work on ${id}`, status: 'running', startedAt: '2026-09-20T10:00:00Z', lastObservedAt: '2026-09-20T10:00:15Z', ...patch })
const summary = { ...EMPTY_SUBAGENT_SUMMARY, total: 20, working: 20 }
function fixture(rows: SubagentRow[] = [row('first')]) {
  const listeners = new Set<(change: SubagentChange) => void>()
  const bridge: SubagentsBridge = {
    page: vi.fn(async ({ threadId, before }) => ({ threadId, revision: 1, rows: before ? [row('older', 1, { status: 'completed' })] : rows, summary, ...(before ? {} : { before: 2 }) })),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [{ id: `${agentId}-run`, sequence: 2, title: 'Current task', prompt: 'Full task instructions', result: 'Returned findings', status: 'completed' }, { id: `${agentId}-old`, sequence: 1, title: 'Earlier task', result: 'Earlier result', status: 'completed' }] })),
    onChanged: vi.fn(listener => { listeners.add(listener); return () => listeners.delete(listener) }),
  }
  return { bridge, emit: (change: SubagentChange) => { for (const listener of listeners) listener(change) } }
}
const stores: SubagentsStore[] = []
function store(): SubagentsStore { const result = new SubagentsStore(); stores.push(result); return result }
afterEach(() => { cleanup(); for (const item of stores) item.dispose(); stores.length = 0; vi.useRealTimers() })

describe('Agents roster', () => {
  it('keeps nested spawn order and tolerates missing parents and cycles', () => {
    const rows = [row('one'), row('two', 2), row('child', 3, { parentId: 'one' }), row('orphan', 4, { parentId: 'missing' }), row('loop-a', 5, { parentId: 'loop-b' }), row('loop-b', 6, { parentId: 'loop-a' })]
    expect(nestedSubagents(rows).map(({ row: item, depth }) => [item.id, depth])).toEqual([['one', 0], ['child', 1], ['two', 0], ['orphan', 0], ['loop-a', 0], ['loop-b', 1]])
  })

  it('loads full assignments only when opened, retains reused identity, and collapses with Escape', async () => {
    const { bridge, emit } = fixture([row('first', 2, { assignmentCount: 2 })])
    const cache = store()
    render(<AgentsSurface threadId="thread" store={cache} bridge={bridge} />)
    const button = await screen.findByRole('button', { name: /Task first/ })
    expect(screen.getByText('Model not reported')).toBeInTheDocument()
    expect(bridge.assignments).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByText('Full task instructions')).toBeInTheDocument()
    expect(screen.getByText('Returned findings')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Previous assignment/))
    expect(screen.getByText('Earlier result')).toBeVisible()
    act(() => emit({ threadId: 'thread', revision: 2, rows: [row('first', 2, { revision: 2, model: 'Reported model', status: 'completed', assignmentCount: 2 })], summary: { ...summary, working: 0, completed: 20 } }))
    expect(screen.getByRole('button', { name: /Task first/ })).toBe(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('discards expanded assignment words across a batched privacy reset that retains the same live row', async () => {
    const live = row('first', 2, { assignmentCount: 2 })
    const { bridge, emit } = fixture([live])
    const cache = store()
    render(<AgentsSurface threadId="thread" store={cache} bridge={bridge} />)
    fireEvent.click(await screen.findByRole('button', { name: /Task first/ }))
    expect(await screen.findByText('Full task instructions')).toBeVisible()
    fireEvent.click(screen.getByText(/Previous assignment/))
    expect(screen.getByText('Earlier result')).toBeVisible()
    vi.mocked(bridge.assignments).mockResolvedValue({ threadId: 'thread', agentId: 'first', assignments: [{ id: live.assignmentId, sequence: 2, title: 'Live task', status: 'running' }] })
    // Main can retain the running identity and its metadata revision after deleting saved text.
    // A following live publication can land in the same React batch as the reset.
    act(() => {
      emit({ threadId: 'thread', revision: 1, rows: [], summary, reset: true })
      emit({ threadId: 'thread', revision: 1, rows: [live], summary })
    })
    expect(cache.thread('thread').rows[0]).toMatchObject({ id: live.id, revision: live.revision })
    expect(screen.queryByText('Full task instructions')).not.toBeInTheDocument()
    expect(screen.queryByText('Returned findings')).not.toBeInTheDocument()
    expect(screen.queryByText('Earlier result')).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: /Task first/ })
    if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
    expect(await screen.findByText('Live task')).toBeVisible()
    expect(screen.queryByText(/Previous assignment/)).not.toBeInTheDocument()
  })

  it('requests earlier roster pages on demand without asking for results', async () => {
    const { bridge } = fixture([row('newer', 2)])
    render(<AgentsSurface threadId="thread" store={store()} bridge={bridge} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier agents' }))
    await screen.findByRole('button', { name: /Task older/ })
    expect(bridge.page).toHaveBeenLastCalledWith({ threadId: 'thread', before: 2 })
    expect(bridge.assignments).not.toHaveBeenCalled()
  })

  it('preserves 19 untouched row references across 600 updates without archive reads or unrelated notifications', async () => {
    const original = Array.from({ length: 20 }, (_, index) => row(`agent-${index}`, index + 1))
    const { bridge, emit } = fixture(original)
    const cache = store()
    cache.activate(bridge, 'one')
    await waitFor(() => expect(cache.thread('one').loading).toBe(false))
    const untouched = cache.thread('one').rows.slice(1)
    const unrelated = vi.fn()
    cache.subscribe('two', unrelated)
    cache.subscribe('three', unrelated)
    for (let revision = 2; revision <= 601; revision++) emit({ threadId: 'one', revision, rows: [row('agent-0', 1, { revision })], summary })
    expect(cache.thread('one').rows.slice(1).every((item, index) => item === untouched[index])).toBe(true)
    expect(unrelated).not.toHaveBeenCalled()
    expect(bridge.page).toHaveBeenCalledTimes(1)
    expect(bridge.assignments).not.toHaveBeenCalled()
    expect(cache.thread('one').rows).toHaveLength(20)
    cache.deactivate()
    emit({ threadId: 'one', revision: 602, rows: [], summary: EMPTY_SUBAGENT_SUMMARY, reset: true })
    expect(cache.thread('one').rows).toHaveLength(0)
  })

  it('bounds a continuously open roster as new agents spawn and keeps an older-page cursor', async () => {
    const { bridge, emit } = fixture(Array.from({ length: 50 }, (_, index) => row(`agent-${index + 1}`, index + 1)))
    const cache = store()
    cache.activate(bridge, 'one')
    await waitFor(() => expect(cache.thread('one').loading).toBe(false))
    for (let sequence = 51; sequence <= 650; sequence++) emit({ threadId: 'one', revision: sequence, rows: [row(`agent-${sequence}`, sequence)], summary: { ...summary, total: sequence } })
    expect(cache.thread('one').rows).toHaveLength(50)
    expect(cache.thread('one').rows[0].sequence).toBe(601)
    expect(cache.thread('one').before).toBe(601)
    expect(bridge.page).toHaveBeenCalledTimes(1)
    expect(bridge.assignments).not.toHaveBeenCalled()
  })

  it('does not let a stale initial page overwrite a newer live row', async () => {
    const { bridge, emit } = fixture()
    let resolve!: (value: Awaited<ReturnType<SubagentsBridge['page']>>) => void
    vi.mocked(bridge.page).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const cache = store()
    cache.activate(bridge, 'one')
    emit({ threadId: 'one', revision: 3, rows: [row('first', 1, { revision: 3, status: 'completed' })], summary })
    resolve({ threadId: 'one', revision: 1, rows: [row('first')], summary })
    await waitFor(() => expect(cache.thread('one').loading).toBe(false))
    expect(cache.thread('one').rows[0].status).toBe('completed')
  })

  it('never shows an old thread’s delayed roster after switching to an empty selected thread', async () => {
    const { bridge } = fixture()
    let resolveOld!: (value: Awaited<ReturnType<SubagentsBridge['page']>>) => void
    vi.mocked(bridge.page).mockImplementation(({ threadId }) => threadId === 'old'
      ? new Promise(done => { resolveOld = done })
      : Promise.resolve({ threadId, revision: 1, rows: [], summary: EMPTY_SUBAGENT_SUMMARY }))
    const cache = store()
    const view = render(<AgentsSurface threadId="old" store={cache} bridge={bridge} />)
    await waitFor(() => expect(bridge.page).toHaveBeenCalledWith({ threadId: 'old' }))
    view.rerender(<AgentsSurface threadId="new" store={cache} bridge={bridge} />)
    expect(await screen.findByText('No agents spawned in this thread yet.')).toBeVisible()
    await act(async () => resolveOld({ threadId: 'old', revision: 1, rows: [row('old-child')], summary }))
    expect(screen.queryByRole('button', { name: /Task old-child/ })).toBeNull()
    expect(cache.thread('new').rows).toEqual([])
  })

  it('stops display timers for unknown states, hidden documents, and unmounted surfaces', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T10:00:20Z'))
    const { rerender, unmount } = render(<SubagentElapsed row={row('timer')} />)
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('21s')).toBeInTheDocument()
    rerender(<SubagentElapsed row={row('timer', 1, { status: 'unknown' })} />)
    expect(screen.getByText('15s')).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
    rerender(<SubagentElapsed row={row('timer')} />)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    visibility.mockRestore()
    fireEvent(document, new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
