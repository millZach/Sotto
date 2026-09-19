import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentThread, AgentWorktree } from '../../../src/shared/agents'
import { defaultAgentConfiguration, RESTORE_BRANCH_NEEDS_CONFIRMATION } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadBranchNotice, resetBranchNoticeDismissals, type WorkingCopyThread } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const project = { path: 'C:\\Users\\zache\\Projects\\sotto-app' }
const worktreePath = 'C:\\Users\\zache\\AppData\\Roaming\\Sotto\\agents\\thread-worktrees\\7f1c'
const moved: AgentWorktree = { mode: 'shared', status: 'ready', path: worktreePath, repositoryRoot: project.path,
  branch: 'feat/agent-chose', sentBranch: 'sotto/thread-7f1c', dirty: false }
const thread: WorkingCopyThread = { id: 'thread-1', nativeSessionStarted: true, workingDirectory: worktreePath, worktree: moved }
function snapshot(): AgentState {
  return { configuration: defaultAgentConfiguration(), connection: 'connected', error: null } as unknown as AgentState
}
afterEach(() => { cleanup(); resetBranchNoticeDismissals() })

describe('the branch-changed notice', () => {
  it('says nothing until the composer has something to send, and dismisses by button or Escape', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot())
    const view = render(<ThreadBranchNotice thread={thread} project={project} command={command} composing={false} />)
    expect(screen.queryByRole('status')).toBeNull()
    view.rerender(<ThreadBranchNotice thread={thread} project={project} command={command} composing />)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('Branch changed, was sotto/thread-7f1c.')
    expect(notice).toHaveTextContent('Sending will continue on feat/agent-chose.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the branch notice' }))
    expect(screen.queryByRole('status')).toBeNull()
    view.unmount()
    const remount = render(<ThreadBranchNotice thread={thread} project={project} command={command} composing />)
    expect(screen.queryByRole('status')).toBeNull()
    // A later switch is a new thing to say, so the dismissal does not silence it.
    const again = { ...thread, worktree: { ...moved, branch: 'prototype/second' } }
    remount.rerender(<ThreadBranchNotice thread={again} project={project} command={command} composing />)
    expect(screen.getByRole('status')).toHaveTextContent('Sending will continue on prototype/second.')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }), { key: 'Escape' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('stays quiet while the branch is the one the last send went to, or before any send', () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot())
    const same = { ...thread, worktree: { ...moved, branch: moved.sentBranch } }
    render(<ThreadBranchNotice thread={same} project={project} command={command} composing />)
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    const unsent = { ...thread, worktree: { ...moved, sentBranch: undefined } }
    render(<ThreadBranchNotice thread={unsent} project={project} command={command} composing />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['independent', 'detached'] as const)('stays quiet for %s', kind => {
    const worktree = kind === 'independent' ? { ...moved, mode: 'independent' as const } : { ...moved, branch: undefined }
    render(<ThreadBranchNotice thread={{ ...thread, worktree }} project={project} command={vi.fn()} composing />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('restores a clean worktree at once and asks first when the folder has uncommitted changes', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot())
    render(<ThreadBranchNotice thread={thread} project={project} command={command} composing />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'restore-thread-branch', threadId: 'thread-1', withUncommittedChanges: undefined }))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    command.mockClear()
    const dirty = { ...thread, worktree: { ...moved, dirty: true } }
    render(<ThreadBranchNotice thread={dirty} project={project} command={command} composing />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }))
    const dialog = screen.getByRole('dialog', { name: 'Switch back to sotto/thread-7f1c?' })
    expect(dialog).toHaveTextContent('uncommitted changes')
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep this branch' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'restore-thread-branch', threadId: 'thread-1', withUncommittedChanges: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks the same question when the record said clean but main finds uncommitted changes', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async request =>
      request.type === 'restore-thread-branch' && !request.withUncommittedChanges ? { ...snapshot(), error: RESTORE_BRANCH_NEEDS_CONFIRMATION } : snapshot())
    render(<ThreadBranchNotice thread={thread} project={project} command={command as never} composing />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }))
    const dialog = await screen.findByRole('dialog', { name: 'Switch back to sotto/thread-7f1c?' })
    expect(dialog).toHaveTextContent('uncommitted changes')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'restore-thread-branch', threadId: 'thread-1', withUncommittedChanges: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the notice and says what happened when the switch is refused', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => ({ ...snapshot(), error: 'The branch no longer exists in this repository.' }))
    render(<ThreadBranchNotice thread={thread} project={project} command={command as never} composing />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch sotto/thread-7f1c' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The branch no longer exists in this repository.'))
    expect(screen.getByRole('status')).toHaveTextContent('Branch changed, was sotto/thread-7f1c.')
  })
})

describe('a thread pane whose worktree moved', () => {
  const THREAD = 'grok-previews'
  function stateWith(worktree: AgentWorktree): AgentState {
    const state = threadsStateFixture()
    state.assignments = []
    state.activeThreadId = THREAD
    state.host.connected = true
    Object.assign(state.host.threads.find(item => item.id === THREAD) as AgentThread, { worktree, workingDirectory: worktreePath })
    return state
  }
  beforeEach(() => { vi.mocked(useAgents).mockReset() })
  afterEach(cleanup)

  it('refreshes an established legacy thread on returning from a terminal without moving its folder', async () => {
    const state = stateWith(moved)
    const legacy = state.host.threads.find(item => item.id === THREAD)!
    delete legacy.worktree
    legacy.nativeSessionStarted = true
    const live = liveAgentState(state)
    vi.mocked(useAgents).mockImplementation(live.useLive)
    render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(live.command).toHaveBeenCalledWith({ type: 'refresh-thread-worktree', threadId: THREAD }))
    expect(legacy.workingDirectory).toBe(worktreePath)
  })

  it('waits for text in the pane composer, then re-reads the folder and says the branch changed', async () => {
    const live = liveAgentState(stateWith(moved))
    vi.mocked(useAgents).mockImplementation(live.useLive)
    render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
    expect(screen.queryByText(/Branch changed/u)).toBeNull()
    const reads = (): AgentCommand[] => live.command.mock.calls.map(([request]) => request).filter(request => request.type === 'refresh-thread-worktree')
    expect(reads()).toEqual([])
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'Carry on with the migration' } })
    await waitFor(() => expect(screen.getByText(/Branch changed, was sotto\/thread-7f1c\./u)).toBeInTheDocument())
    // A switch made in a terminal leaves no activity behind, so the draft itself asks for a fresh read.
    expect(reads()).toEqual([{ type: 'refresh-thread-worktree', threadId: THREAD }])
  })
})
