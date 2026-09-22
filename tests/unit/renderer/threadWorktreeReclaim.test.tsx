import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentWorktree } from '../../../src/shared/agents'
import { defaultAgentConfiguration, RECLAIM_WORKTREE_NEEDS_CONFIRMATION } from '../../../src/shared/agents'
import { ThreadWorkingCopy, useSettleThread, type WorkingCopyThread } from '../../../src/renderer/src/agents/ThreadWorkingCopy'

const project = { path: 'C:\\Users\\zache\\Projects\\sotto-app' }
const worktreePath = 'C:\\Users\\zache\\AppData\\Roaming\\Sotto\\thread-worktrees\\7f1c0000-0000-4000-8000-000000000000'
const own: AgentWorktree = { mode: 'independent', status: 'ready', path: worktreePath, repositoryRoot: project.path, branch: 'feat/finished', dirty: false }
const thread: WorkingCopyThread = { id: 'thread-1', nativeSessionStarted: true, workingDirectory: worktreePath, worktree: own }
const ok = (): AgentState => ({ configuration: defaultAgentConfiguration(), connection: 'connected', error: null } as unknown as AgentState)
const refused = (error: string): AgentState => ({ ...ok(), error } as AgentState)
afterEach(() => cleanup())

function SettleButton({ command, target }: { readonly command: (request: AgentCommand) => Promise<AgentState>; readonly target: WorkingCopyThread }) {
  const { settle, dialog } = useSettleThread(command)
  return <><button type="button" onClick={() => void settle(target, project)}>Settle</button>{dialog}</>
}

describe('reclaiming a thread worktree', () => {
  it('offers Remove worktree for the thread’s own folder, asks once, and says what stays', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ok())
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: feat/finished' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('The branch feat/finished keeps its commits')
    expect(dialog).not.toHaveTextContent('uncommitted changes')
    // Escape from inside the question closes the question, not the panel behind it.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep folder' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('group', { name: 'Working copy details' })).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: false }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('names uncommitted work before it goes, and asks again when main knows of work the record did not', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>()
      .mockResolvedValueOnce(refused(RECLAIM_WORKTREE_NEEDS_CONFIRMATION))
      .mockResolvedValue(ok())
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: feat/finished' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('This folder has uncommitted changes.'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove and lose changes' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: true }))
  })

  it('does not offer removal for a shared, reused or already reclaimed folder, and says a reclaimed folder comes back on send', () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ok())
    for (const worktree of [{ ...own, mode: 'shared' as const }, { ...own, reused: true }]) {
      render(<ThreadWorkingCopy thread={{ ...thread, worktree }} project={project} command={command} />)
      fireEvent.click(screen.getByRole('button', { name: /Working copy/ }))
      expect(screen.queryByRole('button', { name: 'Remove worktree folder, keeping its branch' })).toBeNull()
      cleanup()
    }
    render(<ThreadWorkingCopy thread={{ ...thread, worktree: { ...own, reclaimedAt: '2026-09-22T00:00:00.000Z' } }} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: feat/finished' }))
    expect(screen.queryByRole('button', { name: 'Remove worktree folder, keeping its branch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open folder' })).toBeNull()
    expect(screen.getByRole('group')).toHaveTextContent('Folder removed. Sending to this thread puts it back on feat/finished.')
  })

  it('settles first, then asks whether the worktree goes too; Keep folder and Escape leave it', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ok())
    render(<SettleButton command={command} target={thread} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'thread-1' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove its worktree too?')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: false }))
  })

  it('asks nothing on settle for a shared folder, or when the settle itself was refused', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ok())
    render(<SettleButton command={command} target={{ ...thread, worktree: { ...own, mode: 'shared' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    const refusing = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => refused('This thread is still working.'))
    render(<SettleButton command={refusing} target={thread} />)
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    await waitFor(() => expect(refusing).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
