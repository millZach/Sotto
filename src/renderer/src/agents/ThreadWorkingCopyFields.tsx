import React, { useEffect, useState, type ReactNode } from 'react'
import type { AgentWorkingCopyOptions } from '../../../shared/agents'
import { WorkingCopyFieldset, type WorkingCopyChoice } from './WorkingCopyFieldset'

export interface ThreadWorkingCopySelection {
  readonly workingCopy: WorkingCopyChoice
  readonly baseBranch?: string | undefined
  readonly startFromOrigin?: boolean | undefined
  readonly existingWorktreePath?: string | undefined
}

/** Git choices are read through main; changing a choice never creates a checkout. */
export function ThreadWorkingCopyFields({ projectId, value, disabled, onChange }: {
  readonly projectId?: string | undefined
  readonly value: ThreadWorkingCopySelection
  readonly disabled: boolean
  readonly onChange: (value: ThreadWorkingCopySelection) => void
}): ReactNode {
  const [options, setOptions] = useState<AgentWorkingCopyOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setOptions(null); setError(null)
    if (!projectId || !window.sotto?.agents?.workingCopyOptions) return
    void window.sotto.agents.workingCopyOptions(projectId).then(result => { if (current) setOptions(result) }, () => {
      if (current) setError('Could not read this project’s branches. Reopen these choices to try again.')
    })
    return () => { current = false }
  }, [projectId])
  return <div className="thread-working-copy-fields">
    <WorkingCopyFieldset value={value.workingCopy} disabled={disabled}
      sharedHint="Shares files and branch with other threads using this folder."
      worktreeHint={value.existingWorktreePath ? 'Shares files and branch with other threads using this worktree.' : 'Its own branch and folder, created on the first send.'}
      onChange={workingCopy => onChange({ ...value, workingCopy, startFromOrigin: value.startFromOrigin ?? true })} />
    {value.workingCopy === 'independent' ? <>
      {options?.isGit ? <>
        <label>Worktree<select className="tt-input" value={value.existingWorktreePath ?? ''} disabled={disabled}
          onChange={event => onChange({ ...value, existingWorktreePath: event.target.value || undefined })}>
          <option value="">Create a new worktree</option>
          {options.worktrees.map(worktree => <option key={worktree.path} value={worktree.path}>{worktree.branch ?? 'Detached HEAD'} — {worktree.path}</option>)}
        </select></label>
        {!value.existingWorktreePath ? <>
          <label>Base branch<select className="tt-input" value={value.baseBranch ?? ''} disabled={disabled}
            onChange={event => onChange({ ...value, baseBranch: event.target.value || undefined })}>
            <option value="">Current checkout{options.currentBranch ? ` (${options.currentBranch})` : ''}</option>
            {options.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
          </select></label>
          <label className="thread-working-copy-fields__check"><input type="checkbox" checked={value.startFromOrigin ?? false} disabled={disabled}
            onChange={event => onChange({ ...value, startFromOrigin: event.target.checked })} />Start from origin</label>
          {value.startFromOrigin ? <p>Fetches the selected branch from origin. If unavailable, setup stops without choosing another base.</p> : null}
        </> : null}
      </> : <p>{error ?? (options ? 'This folder has no Git repository. Use Project folder.' : projectId ? (window.sotto?.agents?.workingCopyOptions ? 'Reading branches…' : 'Branch choices are unavailable. Reopen Sotto to try again.') : 'Choose a base branch or existing worktree from the thread header before the first send.')}</p>}
    </> : null}
  </div>
}
