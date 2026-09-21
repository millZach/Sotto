import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { Folder, FolderGit2, GitBranch } from 'lucide-react'
import type { AgentWorkingCopyOptions } from '../../../shared/agents'
import type { WorkingCopyChoice } from './WorkingCopyFieldset'

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
  const groupName = useId()
  const hintId = useId()
  useEffect(() => {
    let current = true
    setOptions(null); setError(null)
    if (!projectId || !window.sotto?.agents?.workingCopyOptions) return
    void window.sotto.agents.workingCopyOptions(projectId).then(result => { if (current) setOptions(result) }, () => {
      if (current) setError('Could not read this project’s branches. Reopen these choices to try again.')
    })
    return () => { current = false }
  }, [projectId])
  const mode = value.workingCopy === 'shared' ? 'shared' : value.existingWorktreePath ? 'existing' : 'new'
  const hint = mode === 'shared' ? 'Shares files and branch with other threads using this folder, including uncommitted edits.'
    : mode === 'existing' ? 'Shares files and branch with other threads using this worktree.'
      : 'Its own branch and folder. Uncommitted edits stay in the project folder.'
  const branches = [...new Set([...(options?.branches ?? []), ...(value.baseBranch ? [value.baseBranch] : [])])]
  return <div className="thread-working-copy-fields">
    <fieldset className="new-thread-working-copy" disabled={disabled} aria-describedby={hintId}>
      <legend>Working copy</legend>
      <div className="new-thread-working-copy__choices new-thread-working-copy__choices--three">
        {([{ id: 'shared', label: 'Project folder', Icon: Folder }, { id: 'new', label: 'New worktree', Icon: FolderGit2 }, { id: 'existing', label: 'Existing worktree', Icon: GitBranch }] as const).map(choice => <label key={choice.id} className="new-thread-working-copy__choice">
          <input type="radio" name={groupName} value={choice.id} checked={mode === choice.id}
            disabled={choice.id === 'existing' && !value.existingWorktreePath && !options?.worktrees.length}
            onChange={() => onChange({ ...value, workingCopy: choice.id === 'shared' ? 'shared' : 'independent',
              startFromOrigin: value.startFromOrigin ?? true,
              existingWorktreePath: choice.id === 'existing' ? value.existingWorktreePath ?? options?.worktrees[0]?.path : undefined })} />
          <choice.Icon size={16} aria-hidden="true" /><span>{choice.label}</span>
        </label>)}
      </div>
      <p id={hintId}>{hint}</p>
    </fieldset>
    {mode !== 'shared' ? <>
      {options?.isGit ? <>
        {mode === 'existing' ? <label>Existing worktree<select className="tt-input" value={value.existingWorktreePath} disabled={disabled}
          onChange={event => onChange({ ...value, existingWorktreePath: event.target.value })}>
          {!options.worktrees.some(worktree => worktree.path === value.existingWorktreePath) ? <option value={value.existingWorktreePath}>{value.existingWorktreePath}</option> : null}
          {options.worktrees.map(worktree => <option key={worktree.path} value={worktree.path}>{worktree.branch ?? 'Detached HEAD'} — {worktree.path}</option>)}
        </select></label> : <>
          <label>Start from<select className="tt-input" value={(value.startFromOrigin ? 'origin:' : 'local:') + (value.baseBranch ?? '')} disabled={disabled}
            onChange={event => {
              const separator = event.target.value.indexOf(':')
              onChange({ ...value, baseBranch: event.target.value.slice(separator + 1) || undefined, startFromOrigin: event.target.value.startsWith('origin:') })
            }}>
            <optgroup label="Fetch from origin">
              <option value="origin:">{options.currentBranch ? 'origin/' + options.currentBranch + ' (current branch)' : 'Origin of current branch (unavailable)'}</option>
              {branches.map(branch => <option key={branch} value={'origin:' + branch}>origin/{branch}</option>)}
            </optgroup>
            <optgroup label="Local branches">
              <option value="local:">{options.currentBranch ? 'Local · ' + options.currentBranch + ' (current branch)' : 'Local · Current commit'}</option>
              {branches.map(branch => <option key={branch} value={'local:' + branch}>Local · {branch}</option>)}
            </optgroup>
          </select></label>
          <p>{value.startFromOrigin ? 'Fetches this branch on first send. If unavailable, setup stops so you can choose another source.' : 'Uses the local committed files on first send.'}</p>
        </>}
      </> : <p>{error ?? (options ? 'This folder has no Git repository. Use Project folder.' : projectId ? (window.sotto?.agents?.workingCopyOptions ? 'Reading branches…' : 'Branch choices are unavailable. Reopen Sotto to try again.') : 'Choose a starting branch or existing worktree from the thread header before the first send.')}</p>}
    </> : null}
  </div>
}
