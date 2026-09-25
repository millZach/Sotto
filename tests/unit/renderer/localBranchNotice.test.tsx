import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState, AgentWorktree } from '../../../src/shared/agents'
import { defaultAgentConfiguration } from '../../../src/shared/agents'
import { ThreadWorkingCopyNotice, resetBranchNoticeDismissals, type WorkingCopyThread } from '../../../src/renderer/src/agents/ThreadWorkingCopy'

const project = { path: 'C:\\Users\\zache\\Projects\\sotto-app' }
const worktreePath = 'C:\\Users\\zache\\AppData\\Roaming\\Sotto\\agents\\thread-worktrees\\7f1c'
function thread(originBase: AgentWorktree['originBase'], id = 'thread-1'): WorkingCopyThread {
  const worktree: AgentWorktree = { mode: 'independent', status: 'ready', path: worktreePath, repositoryRoot: project.path,
    branch: 'sotto/7f1c', baseBranch: 'feat/local-only', startFromOrigin: true, ...(originBase ? { originBase } : {}), dirty: false }
  return { id, nativeSessionStarted: true, workingDirectory: worktreePath, worktree }
}
const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ configuration: defaultAgentConfiguration(), connection: 'connected', error: null } as unknown as AgentState))
afterEach(() => { cleanup(); resetBranchNoticeDismissals() })

describe('the local branch notice', () => {
  it('says that origin had no such branch, names the branch, and stays dismissed across a remount', () => {
    const view = render(<ThreadWorkingCopyNotice thread={thread('not-on-origin')} project={project} command={command} />)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('origin/feat/local-only was not found, so the worktree started from the local branch feat/local-only.')
    expect(notice).toHaveAttribute('data-tone', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the local branch notice' }))
    expect(screen.queryByRole('status')).toBeNull()
    view.unmount()
    render(<ThreadWorkingCopyNotice thread={thread('not-on-origin')} project={project} command={command} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('says the project has no origin when there was none to ask, and says nothing when origin was fetched', () => {
    const view = render(<ThreadWorkingCopyNotice thread={thread('no-origin', 'thread-2')} project={project} command={command} />)
    expect(screen.getByRole('status')).toHaveTextContent('This project has no origin, so the worktree started from the local branch feat/local-only.')
    view.rerender(<ThreadWorkingCopyNotice thread={thread('fetched', 'thread-3')} project={project} command={command} />)
    expect(screen.queryByRole('status')).toBeNull()
    view.rerender(<ThreadWorkingCopyNotice thread={thread(undefined, 'thread-4')} project={project} command={command} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
