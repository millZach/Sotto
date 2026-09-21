import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeWorkingCopy, ThreadWorkingCopy, ThreadWorkingCopyNotice, type WorkingCopyThread } from '../../../src/renderer/src/agents/ThreadWorkingCopy'
import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'

const project = { path: 'C:\\Users\\zache\\Projects\\sotto-app' }
const worktreePath = 'C:\\Users\\zache\\AppData\\Roaming\\Sotto\\agents\\thread-worktrees\\7f1c'
const branch = 'sotto/thread-7f1c'
const ready: WorkingCopyThread = { id: 'thread-1', nativeSessionStarted: false, workingDirectory: worktreePath,
  worktree: { mode: 'independent', status: 'ready', path: worktreePath, repositoryRoot: project.path, branch, dirty: false } }
const failed: WorkingCopyThread = { id: 'thread-1', nativeSessionStarted: false,
  worktree: { mode: 'independent', status: 'error', path: worktreePath, repositoryRoot: project.path, branch, error: 'This Git repository has no commit to branch from.' } }
function snapshot(error: string | null = null): AgentState {
  return { configuration: defaultAgentConfiguration(), connection: 'connected', error } as unknown as AgentState
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('describeWorkingCopy', () => {
  it('names the actual branch or folder a ready thread works in', () => {
    expect(describeWorkingCopy(ready, project)).toMatchObject({ status: 'ready', mode: 'independent', directory: worktreePath, label: branch })
    // Realpath spelling differences still name the project's own folder.
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: false, worktree: { mode: 'shared', status: 'ready', path: 'c:/users/zache/projects/sotto-app/' } }, project))
      .toMatchObject({ status: 'ready', mode: 'shared', directory: 'c:/users/zache/projects/sotto-app/', label: 'Project folder' })
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: false, worktree: { mode: 'shared', status: 'ready', path: 'D:/elsewhere/notes' } }, project))
      .toMatchObject({ label: 'notes' })
  })

  it('shows the actual shared branch and distinguishes detached HEAD', () => {
    expect(describeWorkingCopy({ ...ready, worktree: { ...ready.worktree!, mode: 'shared', branch: 'fix/current' } }, project).label).toBe('fix/current')
    expect(describeWorkingCopy({ ...ready, worktree: { ...ready.worktree!, mode: 'shared', branch: undefined } }, project).label).toBe('Detached HEAD')
  })

  it('reports a subfolder project inside its checkout rather than the checkout root', () => {
    const checkout = { mode: 'independent' as const, status: 'ready' as const, path: 'C:/data/thread-worktrees/7f1c', repositoryRoot: 'C:/repo', branch, projectRelativePath: 'packages/app' }
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: false, worktree: checkout }, project).directory).toBe('C:/data/thread-worktrees/7f1c/packages/app')
    const actual = 'C:\\data\\thread-worktrees\\7f1c\\packages\\app'
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: false, workingDirectory: actual, worktree: checkout }, project)).toMatchObject({ directory: actual, label: branch })
  })

  it('keeps an existing thread in its own folder before the project folder', () => {
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: true, workingDirectory: 'D:/work/legacy/' }, project)).toMatchObject({ status: 'legacy', directory: 'D:/work/legacy/', label: 'legacy' })
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: true }, project)).toMatchObject({ status: 'legacy', directory: project.path, label: 'Project folder' })
  })

  it('never answers pending or failed setup with the project or reserved folder', () => {
    expect(describeWorkingCopy({ id: 't', nativeSessionStarted: false, worktree: { mode: 'independent', status: 'pending' } }, project)).toMatchObject({ status: 'pending', directory: undefined })
    expect(describeWorkingCopy({ ...failed, workingDirectory: project.path }, project)).toMatchObject({ status: 'error', directory: undefined, error: failed.worktree!.error })
  })
})

describe('ThreadWorkingCopy', () => {
  it('keeps the editor within its pane when the anchor is near the right edge and the pane narrows', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(820)
    vi.stubGlobal('innerHeight', 560)
    const view = render(<div className="thread-pane"><ThreadWorkingCopy thread={ready} project={project} command={vi.fn()} /></div>)
    const pane = view.container.querySelector('.thread-pane')!
    const root = view.container.querySelector('.working-copy')!
    const paneBounds = vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(318, 0, 502, 560))
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(650, 15, 120, 20))
    fireEvent.click(screen.getByRole('button', { name: `Working copy: ${branch}` }))
    const panel = screen.getByRole('group', { name: 'Working copy details' })
    expect(panel).toHaveStyle({ left: '-258px', width: '420px', maxHeight: '511px' })
    paneBounds.mockReturnValue(new DOMRect(500, 0, 320, 560))
    fireEvent(window, new Event('resize'))
    expect(panel).toHaveStyle({ left: '-142px', width: '304px', maxHeight: '511px' })
  })

  it('changes an unsent worktree choice without creating a checkout, including a selected base', async () => {
    vi.stubGlobal('sotto', { agents: { workingCopyOptions: vi.fn(async () => ({ isGit: true, currentBranch: 'main', branches: ['main', 'develop'], worktrees: [{ path: 'C:/existing', branch: 'fix/work' }] })) } })
    const command = vi.fn(async () => snapshot())
    render(<ThreadWorkingCopy thread={{ id: 'empty', projectId: 'project', nativeSessionStarted: false, worktree: { mode: 'shared', status: 'ready', path: project.path } }} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: Project folder' }))
    fireEvent.click(screen.getByRole('radio', { name: 'New worktree' }))
    fireEvent.change(await screen.findByLabelText('Start from'), { target: { value: 'origin:develop' } })
    expect(screen.getByLabelText('Start from')).toHaveValue('origin:develop')
    expect(command).not.toHaveBeenCalled()
    const apply = screen.getByRole('button', { name: 'Apply working copy' })
    apply.focus()
    fireEvent.click(apply)
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure-thread-working-copy', threadId: 'empty', workingCopy: 'independent', baseBranch: 'develop', startFromOrigin: true })))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply working copy' })).toBeNull())
    expect(screen.getByRole('radio', { name: 'New worktree' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Working copy details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Working copy: Project folder' })).toHaveFocus()
  })

  it('does not offer a new folder once an independent checkout is allocated', () => {
    render(<ThreadWorkingCopy thread={{ ...ready, projectId: 'project' }} project={project} command={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: `Working copy: ${branch}` }))
    expect(screen.queryByRole('radio', { name: 'Project folder' })).toBeNull()
  })

  it('keeps the apply button focused when changing an unsent working copy is refused', async () => {
    const command = vi.fn(async () => snapshot('The thread has already started.'))
    render(<ThreadWorkingCopy thread={{ id: 'empty', projectId: 'project', nativeSessionStarted: false, worktree: { mode: 'shared', status: 'ready', path: project.path } }} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: 'Working copy: Project folder' }))
    fireEvent.click(screen.getByRole('radio', { name: 'New worktree' }))
    const apply = screen.getByRole('button', { name: 'Apply working copy' })
    apply.focus()
    fireEvent.click(apply)
    expect(await screen.findByRole('alert')).toHaveTextContent('The thread has already started.')
    expect(screen.getByRole('button', { name: 'Apply working copy' })).toHaveFocus()
  })

  it('shows the branch, opens details by keyboard, and closes on Escape back to the chip', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot())
    render(<ThreadWorkingCopy thread={{ ...ready, worktree: { ...ready.worktree!, dirty: true } }} project={project} command={command} />)
    const chip = screen.getByRole('button', { name: `Working copy: ${branch}` })
    chip.focus()
    fireEvent.click(chip)
    const details = screen.getByRole('group', { name: 'Working copy details' })
    expect(details).toHaveTextContent(worktreePath)
    expect(details).toHaveTextContent('Uncommitted changes')
    expect(details).toHaveTextContent(project.path)
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'open-thread-folder', threadId: 'thread-1' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-disabled', 'true'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'refresh-thread-worktree', threadId: 'thread-1' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-disabled', 'true'))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Refresh' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Working copy details' })).not.toBeInTheDocument()
    expect(chip).toHaveFocus()
    expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  it('reports a folder that could not be opened and offers no open action without a real folder', async () => {
    const command = vi.fn(async () => snapshot('The working folder is unavailable.'))
    const { rerender } = render(<ThreadWorkingCopy thread={ready} project={project} command={command} />)
    fireEvent.click(screen.getByRole('button', { name: /Working copy/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The working folder is unavailable.')
    rerender(<ThreadWorkingCopy thread={failed} project={project} command={command} />)
    expect(screen.getByRole('button', { name: 'Working copy: Worktree not ready' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Working copy details' })).toHaveTextContent('This Git repository has no commit to branch from.')
    expect(screen.getByRole('group', { name: 'Working copy details' })).not.toHaveTextContent(worktreePath)
  })
})

describe('ThreadWorkingCopyNotice', () => {
  it('stays out of the way unless setup failed', () => {
    const { container } = render(<ThreadWorkingCopyNotice thread={ready} project={project} command={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('retries setup for an unstarted thread and reports recovery only once the thread is ready', async () => {
    const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => snapshot())
    const onRecovered = vi.fn()
    const view = render(<ThreadWorkingCopyNotice thread={failed} project={project} command={command} onRecovered={onRecovered} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Worktree not ready. This Git repository has no commit to branch from.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'retry-thread-worktree', threadId: 'thread-1' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry setup' })).not.toHaveAttribute('aria-disabled', 'true'))
    // Accepted, but the host still reports failure: no recovery claimed, the action stays available.
    expect(onRecovered).not.toHaveBeenCalled()
    act(() => { view.rerender(<ThreadWorkingCopyNotice thread={ready} project={project} command={command} onRecovered={onRecovered} />) })
    expect(onRecovered).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('only re-checks the bound folder once native work has started, and shows a command failure', async () => {
    const command = vi.fn(async () => snapshot('Git is unavailable.'))
    render(<ThreadWorkingCopyNotice thread={{ ...failed, nativeSessionStarted: true, worktree: { ...failed.worktree!, error: 'The working folder is no longer this thread’s Git worktree.' } }} project={project} command={command} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Working folder unavailable.')
    expect(screen.queryByRole('button', { name: 'Retry setup' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'refresh-thread-worktree', threadId: 'thread-1' }))
    expect(await screen.findByText('Git is unavailable.')).toBeInTheDocument()
  })
})
