import { deferred } from '../../fixtures/deferred'
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentCommand } from '../../../src/shared/agents'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { openSidebarFolders, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

afterEach(cleanup)

it('queues concurrent settle questions and asks for each folder acknowledgement separately', async () => {
  const state = threadsStateFixture()
  const first = { ...state.host.threads.find(thread => thread.id === 'grok-previews')!, title: 'First', nativeSessionStarted: true,
    worktree: { mode: 'independent' as const, status: 'ready' as const, path: 'C:/owned/first', branch: 'sotto/first', dirty: false } }
  const second = { ...first, id: 'second-thread', title: 'Second', worktree: { ...first.worktree, path: 'C:/owned/second', branch: 'sotto/second' } }
  state.host.threads = [first, second]
  const settles = new Map<string, (result: typeof state) => void>()
  let previewSecond: (result: typeof state) => void = () => undefined
  const preview = (thread: typeof first, name: string): typeof state => ({ ...state, worktreeReclaimPreview: {
    path: thread.worktree.path, branch: thread.worktree.branch, dirty: false, ignored: [name], items: [{ path: name, bytes: 12, fileCount: 1 }], repositories: [], untracked: [] } })
  const command = vi.fn((request: AgentCommand): Promise<typeof state> => {
    if (request.type === 'settle-thread') return (() => { const pending = deferred<ReturnType<typeof preview>>(); settles.set(request.threadId, pending.resolve); return pending.promise })()
    if (request.type === 'preview-reclaim-thread-worktree') return request.threadId === first.id
      ? Promise.resolve(preview(first, '.first-secret')) : (() => { const pending = deferred<Parameters<typeof previewSecond>[0]>(); previewSecond = pending.resolve; return pending.promise })()
    return Promise.resolve(state)
  })
  openSidebarFolders(state)
  render(<ThreadSidebar state={state} command={command} organization={organizeWorkspace(state, describeThreads(state, Date.now()), '', state.activeProjectId)}
    query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} currentThreadId={first.id} openThreadIds={[first.id]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Settle First' }))
  fireEvent.click(screen.getByRole('button', { name: 'Settle Second' }))
  await act(async () => { settles.get(first.id)!(state) })
  const tick = await screen.findByRole('checkbox')
  fireEvent.click(tick)
  expect(tick).toBeChecked()
  await act(async () => { settles.get(second.id)!(state) })
  expect(screen.getByText('.first-secret')).toBeVisible()
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(command).not.toHaveBeenCalledWith({ type: 'preview-reclaim-thread-worktree', threadId: second.id })
  fireEvent.click(screen.getByRole('button', { name: 'Keep folder' }))
  await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'preview-reclaim-thread-worktree', threadId: second.id }))
  expect(screen.queryByText('.first-secret')).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeDisabled()
  await act(async () => { previewSecond(preview(second, '.second-secret')) })
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Remove with these files' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove with these files' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(command.mock.calls.filter(([request]) => request.type === 'reclaim-thread-worktree')).toEqual([[expect.objectContaining({ threadId: second.id, confirmedIgnored: ['.second-secret'] })]])
})

it.each(['Keep folder', 'Escape', 'Remove worktree'])('keeps the settle question after its sidebar row disappears, then handles %s', async answer => {
  const initial = threadsStateFixture()
  const target = { ...initial.host.threads.find(thread => thread.id === 'grok-previews')!,
    worktree: { mode: 'independent' as const, status: 'ready' as const, path: 'C:/owned/worktree', branch: 'sotto/test', dirty: false },
    nativeSessionStarted: true }
  initial.host.threads = [target]
  const command = vi.fn<(request: AgentCommand) => Promise<typeof initial>>()
  function Sidebar() {
    const [state, setState] = useState(initial)
    command.mockImplementation(async request => {
      if (request.type === 'settle-thread') setState({ ...state, host: { ...state.host, threads: [{ ...target, workspaceSettledAt: new Date().toISOString() }] } })
      return { ...state, worktreeReclaimPreview: { path: target.worktree.path, branch: target.worktree.branch, dirty: false, ignored: [], items: [], repositories: [], untracked: [] } }
    })
    return <ThreadSidebar state={state} command={command} organization={organizeWorkspace(state, describeThreads(state, Date.now()), '', state.activeProjectId)}
      query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} currentThreadId={target.id} openThreadIds={[target.id]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />
  }
  openSidebarFolders(initial)
  render(<Sidebar />)
  const settle = screen.getByRole('button', { name: `Settle ${target.title}` })
  settle.focus()
  fireEvent.click(settle)
  const dialog = await screen.findByRole('dialog', { name: 'Remove its worktree too?' })
  expect(settle).not.toBeInTheDocument()
  expect(dialog).toBeVisible()
  expect(screen.getByRole('button', { name: 'Keep folder' })).toHaveFocus()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled())
  if (answer === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: answer }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole('button', { name: 'Settled 1 thread' })).toHaveFocus())
  expect(command.mock.calls.filter(([request]) => request.type === 'reclaim-thread-worktree')).toHaveLength(answer === 'Remove worktree' ? 1 : 0)
})
