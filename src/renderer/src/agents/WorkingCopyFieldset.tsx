import React, { useId, type ReactNode } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'

export type WorkingCopyChoice = 'independent' | 'shared'

const CHOICES: ReadonlyArray<{ readonly value: WorkingCopyChoice; readonly label: string; readonly Icon: typeof Folder }> = [
  { value: 'shared', label: 'Project folder', Icon: Folder },
  { value: 'independent', label: 'New worktree', Icon: FolderGit2 },
]
const WORKTREE_HINT = 'Its own Git branch and folder, checked out when it opens. Folders without Git are used as they are.'

/** The New worktree / Project folder choice a New thread and a New terminal share. */
export function WorkingCopyFieldset({ value, disabled, sharedHint, worktreeHint = WORKTREE_HINT, onChange }: {
  readonly value: WorkingCopyChoice
  readonly disabled: boolean
  /** What "Project folder" means here: who else edits the same files. */
  readonly sharedHint: string
  readonly worktreeHint?: string
  readonly onChange: (value: WorkingCopyChoice) => void
}): ReactNode {
  const hintId = useId()
  const groupName = useId()
  return <fieldset className="new-thread-working-copy" disabled={disabled} aria-describedby={hintId}>
    <legend>Working copy</legend>
    <div className="new-thread-working-copy__choices">
      {CHOICES.map(choice => <label key={choice.value} className="new-thread-working-copy__choice">
        <input type="radio" name={groupName} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <choice.Icon size={16} aria-hidden="true" /><span>{choice.label}</span>
      </label>)}
    </div>
    <p id={hintId}>{value === 'independent' ? worktreeHint : sharedHint}</p>
  </fieldset>
}
