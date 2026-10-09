import { deferred } from '../../fixtures/deferred'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsSurface, nestedSubagents, SubagentElapsed, workflowCount } from '../../../src/renderer/src/tools/AgentsSurface'
import { newestRows, SubagentsStore } from '../../../src/renderer/src/tools/subagentsStore'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentChange, type SubagentRow, type SubagentsBridge } from '../../../src/shared/subagents'

const row = (id: string, sequence = 1, patch: Partial<SubagentRow> = {}): SubagentRow => ({ id, sequence, revision: 1, assignmentId: `${id}-run`, assignmentCount: 1, title: `Task ${id}`, description: `Work on ${id}`, status: 'running', startedAt: '2026-09-20T10:00:00Z', lastObservedAt: '2026-09-20T10:00:15Z', ...patch })
const summary = { ...EMPTY_SUBAGENT_SUMMARY, total: 20, working: 20 }
function fixture(rows: SubagentRow[] = [row('first')]) {
  const listeners = new Set<(change: SubagentChange) => void>()
  const bridge: SubagentsBridge = {
    page: vi.fn(async ({ threadId, before }) => ({ threadId, revision: 1, rows: before ? [row('older', 1, { status: 'completed' })] : rows, summary, ...(before ? {} : { before: 2 }) })),
    assignments: vi.fn<SubagentsBridge['assignments']>(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [{ id: `${agentId}-run`, sequence: 2, title: 'Current task', prompt: 'Full task instructions', result: 'Returned findings', status: 'completed' }, { id: `${agentId}-old`, sequence: 1, title: 'Earlier task', result: 'Earlier result', status: 'completed' }] })),
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
    expect(cache.thread('one').rows[0]?.sequence).toBe(601)
    expect(cache.thread('one').before).toBe(601)
    expect(bridge.page).toHaveBeenCalledTimes(1)
    expect(bridge.assignments).not.toHaveBeenCalled()
  })

  it('does not let a stale initial page overwrite a newer live row', async () => {
    const { bridge, emit } = fixture()
    let resolve!: (value: Awaited<ReturnType<SubagentsBridge['page']>>) => void
    vi.mocked(bridge.page).mockImplementationOnce(() => { const pending = deferred<SubagentChange>(); resolve = pending.resolve; return pending.promise })
    const cache = store()
    cache.activate(bridge, 'one')
    emit({ threadId: 'one', revision: 3, rows: [row('first', 1, { revision: 3, status: 'completed' })], summary })
    resolve({ threadId: 'one', revision: 1, rows: [row('first')], summary })
    await waitFor(() => expect(cache.thread('one').loading).toBe(false))
    expect(cache.thread('one').rows[0]?.status).toBe('completed')
  })

  it('never shows an old thread’s delayed roster after switching to an empty selected thread', async () => {
    const { bridge } = fixture()
    let resolveOld!: (value: Awaited<ReturnType<SubagentsBridge['page']>>) => void
    vi.mocked(bridge.page).mockImplementation(({ threadId }) => threadId === 'old'
      ? (() => { const pending = deferred<SubagentChange>(); resolveOld = pending.resolve; return pending.promise })()
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

describe('a workflow in the roster', () => {
  const progress = { total: 3, working: 1, completed: 1, failed: 1, interrupted: 0 }
  const rows = () => [row('solo'), row('flow', 2, { kind: 'workflow', title: 'Implement the phase 1 perf issues', description: 'phase-1-perf', progress }),
    row('flow:agent-1', 3, { parentId: 'flow', title: '#311 311-thread-command-lanes', status: 'failed', model: 'claude-opus-5-5[1m]' }),
    row('flow:agent-2', 4, { parentId: 'flow', title: '#312 312-history-recency-on-view', status: 'completed', model: 'claude-sonnet-5' }),
    row('flow:agent-3', 5, { parentId: 'flow', title: '#313 313-command-reply-shell', model: 'opus' })]

  it('says what a workflow has done in plain words', () => {
    expect(workflowCount(undefined)).toBe('No agents reported yet')
    expect(workflowCount(progress)).toBe('1 of 3 finished · 1 failed')
    expect(workflowCount({ ...progress, working: 0, completed: 5, total: 6 })).toBe('5 of 6 finished · 1 failed')
  })

  it('shows the workflow as one row with a strip, and opens its page with its agents under "All agents"', async () => {
    const { bridge } = fixture(rows())
    const loadAssignments = vi.mocked(bridge.assignments).getMockImplementation()!
    let resolveAssignments!: (value: Awaited<ReturnType<SubagentsBridge['assignments']>>) => void
    vi.mocked(bridge.assignments).mockImplementationOnce(() => { const pending = deferred<Parameters<typeof resolveAssignments>[0]>(); resolveAssignments = pending.resolve; return pending.promise })
    render(<AgentsSurface threadId="thread" store={store()} bridge={bridge} />)
    const open = await screen.findByRole('button', { name: 'Open the workflow Implement the phase 1 perf issues: 1 of 3 finished, 1 failed, Working' })
    const roster = screen.getByRole('list', { name: 'Spawned agents' })
    expect(roster.querySelectorAll(':scope > li')).toHaveLength(2)
    expect(screen.queryByText('#311 311-thread-command-lanes')).not.toBeInTheDocument()
    const strip = screen.getByRole('img', { name: '1 of 3 finished, 1 failed, 1 working' })
    expect([...strip.querySelectorAll('i')].map(segment => segment.getAttribute('data-status'))).toEqual(['failed', 'completed', 'running'])
    fireEvent.click(open)
    const back = screen.getByRole('button', { name: 'Back to all agents' })
    await waitFor(() => expect(back).toHaveFocus())
    expect(screen.getByText('Implement the phase 1 perf issues', { selector: '.tools-chrome__title' })).toBeInTheDocument()
    // The summary and pending detail both retain the description until assignments arrive.
    expect(screen.getByText('phase-1-perf', { selector: '.subagent-workflow__facts > span' })).toBeVisible()
    expect(screen.getByText('phase-1-perf', { selector: '.subagent-workflow__details p' })).toBeVisible()
    expect(await screen.findByText('Loading assignments…')).toHaveAttribute('role', 'status')
    expect(bridge.assignments).toHaveBeenCalledWith({ threadId: 'thread', agentId: 'flow' })
    expect(screen.queryByText('Full task instructions')).not.toBeInTheDocument()
    // One model, named once: the alias goes once a resolved name of the same family is there.
    expect(screen.getByText('claude-opus-5-5[1m], claude-sonnet-5')).toBeInTheDocument()
    await act(async () => resolveAssignments(await loadAssignments({ threadId: 'thread', agentId: 'flow' })))
    expect(await screen.findByText('Full task instructions')).toBeInTheDocument()
    expect(screen.getByText('phase-1-perf')).toBeInTheDocument()
    expect(screen.queryByText('Loading assignments…')).not.toBeInTheDocument()
    expect(back).toHaveFocus()
    const agents = screen.getByRole('list', { name: 'Agents' })
    expect([...agents.querySelectorAll('.subagent-title')].map(title => [title.textContent, title.getAttribute('title')])).toEqual([
      ['#311 311-thread-command-lanes', '#311 311-thread-command-lanes'], ['#312 312-history-recency-on-view', '#312 312-history-recency-on-view'], ['#313 313-command-reply-shell', '#313 313-command-reply-shell']])
    // Escape closes an open agent first, then leaves the page and returns to the workflow's row.
    const agent = screen.getByRole('button', { name: /#312 312-history-recency-on-view/ })
    fireEvent.click(agent)
    expect(agent).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(agent, { key: 'Escape' })
    expect(agent).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Back to all agents' })).toBeInTheDocument()
    fireEvent.keyDown(agent, { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: /Open the workflow/ })).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Back to all agents' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open the workflow/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to all agents' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Open the workflow/ })).toHaveFocus())
  })

  it('joins neighbouring segments in the same state for a large workflow, so the strip keeps to its row', async () => {
    const { bridge } = fixture([row('flow', 1, { kind: 'workflow', title: 'Big run', progress: { total: 120, working: 30, completed: 80, failed: 10, interrupted: 0 } })])
    render(<AgentsSurface threadId="thread" store={store()} bridge={bridge} />)
    const strip = await screen.findByRole('img', { name: '80 of 120 finished, 10 failed, 30 working' })
    expect([...strip.querySelectorAll('i')].map(segment => [segment.getAttribute('data-status'), (segment as HTMLElement).style.flexGrow])).toEqual([['completed', '80'], ['failed', '10'], ['running', '30']])
  })

  it('draws the agents waiting to start at the end of the strip', async () => {
    const { bridge } = fixture([row('flow', 1, { kind: 'workflow', title: 'Run', progress: { total: 3, working: 1, completed: 0, failed: 0, interrupted: 0, queued: 2 } }),
      row('flow:agent-1', 2, { parentId: 'flow', title: 'First' })])
    render(<AgentsSurface threadId="thread" store={store()} bridge={bridge} />)
    const strip = await screen.findByRole('img', { name: '0 of 3 finished, 1 working, 2 waiting to start' })
    expect([...strip.querySelectorAll('i')].map(segment => segment.getAttribute('data-status'))).toEqual(['running', 'queued', 'queued'])
  })

  it('keeps a parent older than the cut with the rows under it', () => {
    const parent = row('flow', 1, { kind: 'workflow' })
    const agents = Array.from({ length: 4 }, (_, index) => row(`flow:agent-${index}`, index + 2, { parentId: 'flow' }))
    expect(newestRows([parent, ...agents], 3)).toEqual({ rows: [parent, ...agents.slice(1)], before: 3 })
    expect(newestRows([parent, ...agents], 10)).toEqual({ rows: [parent, ...agents], before: undefined })
  })

  it('draws the strip from the workflow\'s counts until every agent has loaded', async () => {
    const { bridge } = fixture(rows().slice(0, 3))
    render(<AgentsSurface threadId="thread" store={store()} bridge={bridge} />)
    const strip = await screen.findByRole('img', { name: '1 of 3 finished, 1 failed, 1 working' })
    expect([...strip.querySelectorAll('i')].map(segment => segment.getAttribute('data-status'))).toEqual(['completed', 'failed', 'running'])
  })
})
