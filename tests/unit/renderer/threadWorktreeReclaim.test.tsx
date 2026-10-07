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
const ok = (): AgentState => ({ configuration: defaultAgentConfiguration(), connection: 'connected', error: null,
  host: { threads: [thread] }, worktreeReclaimPreview: { path: worktreePath, branch: own.branch, dirty: false, ignored: [], items: [], repositories: [], untracked: [] },
} as unknown as AgentState)
const refused = (error: string): AgentState => ({ ...ok(), error } as AgentState)
afterEach(() => cleanup())

function SettleButton({ command, target }: { readonly command: (request: AgentCommand) => Promise<AgentState>; readonly target: WorkingCopyThread }) {
  const { settle, dialog } = useSettleThread(command)
  return <><button type="button" onClick={() => void settle(target, project)}>Settle</button>{dialog}</>
}

describe('reclaiming a thread worktree', () => {
  it('lists ignored items and requires a separate acknowledgement before removal', async () => {
    const result = ok()
    result.worktreeReclaimPreview!.ignored = ['.env', 'out/capture.png']
    result.worktreeReclaimPreview!.items = [{ path: '.env', bytes: 20, fileCount: 1 }, { path: 'out/capture.png', bytes: 100, fileCount: 1 }]
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => result)
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: /Working copy:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    expect(await screen.findByText('.env')).toBeVisible()
    expect(screen.getByText('out/capture.png')).toBeVisible()
    const remove = screen.getByRole('button', { name: 'Remove with these files' })
    expect(remove).toBeDisabled()
    fireEvent.click(remove)
    expect(command).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete these 2 ignored items with the folder' }))
    expect(remove).toBeEnabled()
    fireEvent.click(remove)
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'reclaim-thread-worktree', threadId: thread.id, withUncommittedChanges: false, confirmedIgnored: ['.env', 'out/capture.png'], confirmedItems: [{ path: '.env', fileCount: 1 }, { path: 'out/capture.png', fileCount: 1 }], confirmedRepositories: [] }))
  })
  it.each([['worktree', 1, 'worktree’s'], ['repository', 1, 'repository’s'], ['worktree', 2, 'worktrees’'], ['repository', 2, 'repositories’'], ['mixed', 2, 'repositories and worktrees’']] as const)('names nested work in plain words (%s, %s)', async (kind, count, suffix) => {
    const result = ok()
    const preview = result.worktreeReclaimPreview!
    preview.ignored = ['.worktrees/n/']
    preview.repositories = Array.from({ length: count }, (_, index) => ({ path: `.worktrees/${index}/`, changeCount: 3, kind: kind === 'mixed' ? (index === 0 ? 'repository' : 'worktree') : kind, ...(kind === 'repository' || (kind === 'mixed' && index === 0) ? { unpushedCommitCount: 2 } : {}) }))
    preview.ignored = preview.repositories.map(item => item.path)
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => result)
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: /Working copy:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    const row = kind === 'worktree' ? 'Nested worktree · 3 uncommitted changes' : 'Nested repository · 3 uncommitted changes · 2 commits not on any remote'
    expect((await screen.findAllByText(row))[0]).toBeVisible()
    expect(screen.queryByText('?? unsaved.txt')).toBeNull()
    const remove = screen.getByRole('button', { name: 'Remove with these files' })
    expect(remove).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: `${count === 1 ? 'Delete this 1 ignored item' : `Delete these ${count} ignored items`} with the folder, including the nested ${suffix} uncommitted work` }))
    expect(remove).toBeEnabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledTimes(1)
  })
  it.each(['pane', 'settle'])('shows the folder-change refusal inside the %s question', async surface => {
    const message = 'The folder changed. Nothing was removed. Choose Remove worktree again to see the new list.'
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async request => request.type === 'reclaim-thread-worktree' ? refused(message) : ok())
    if (surface === 'pane') {
      render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
      fireEvent.click(screen.getByRole('button', { name: /Working copy:/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    } else {
      render(<SettleButton target={thread} command={command} />)
      fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    }
    const button = await screen.findByRole('button', { name: 'Remove worktree' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })
  it('hides the tick when an outside link blocks removal', async () => {
    const result = ok()
    result.worktreeReclaimPreview!.ignored = ['.env']
    result.worktreeReclaimPreview!.outsideLink = 'node_modules'
    const command = vi.fn(async () => result)
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: /Working copy:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    expect(await screen.findByText(/Remove the link/)).toBeVisible()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove with these files' })).toBeDisabled()
  })
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
    expect(command).toHaveBeenCalledWith({ type: 'preview-reclaim-thread-worktree', threadId: 'thread-1' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: false, confirmedIgnored: [], confirmedItems: [], confirmedRepositories: [] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('names uncommitted work before it goes, and asks again when main knows of work the record did not', async () => {
    let reclaims = 0
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async request => request.type === 'reclaim-thread-worktree' && reclaims++ === 0 ? refused(RECLAIM_WORKTREE_NEEDS_CONFIRMATION) : ok())
    render(<ThreadWorkingCopy thread={thread} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: feat/finished' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree folder, keeping its branch' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('This folder has uncommitted changes.'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove and lose changes' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: true, confirmedIgnored: [], confirmedItems: [], confirmedRepositories: [] }))
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
    expect(command).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Settle' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'reclaim-thread-worktree', threadId: 'thread-1', withUncommittedChanges: false, confirmedIgnored: [], confirmedItems: [], confirmedRepositories: [] }))
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
