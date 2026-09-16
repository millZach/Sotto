import React, { useId, type ReactNode } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'

export type WorkingCopyChoice = 'independent' | 'shared'

const CHOICES: ReadonlyArray<{ readonly value: WorkingCopyChoice; readonly label: string; readonly Icon: typeof Folder }> = [
  { value: 'independent', label: 'New worktree', Icon: FolderGit2 },
  { value: 'shared', label: 'Project folder', Icon: Folder },
]
const WORKTREE_HINT = 'Its own Git branch and folder. Folders without Git are used as they are.'

/** The New worktree / Project folder choice a New thread and a New terminal share. */
export function WorkingCopyFieldset({ value, disabled, sharedHint, onChange }: {
  readonly value: WorkingCopyChoice
  readonly disabled: boolean
  /** What "Project folder" means here: who else edits the same files. */
  readonly sharedHint: string
  readonly onChange: (value: WorkingCopyChoice) => void
}): ReactNode {
  const hintId = useId()
  return <fieldset className="new-thread-working-copy" disabled={disabled} aria-describedby={hintId}>
    <legend>Working copy</legend>
    <div className="new-thread-working-copy__choices">
      {CHOICES.map(choice => <label key={choice.value} className="new-thread-working-copy__choice">
        <input type="radio" name="working-copy" value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <choice.Icon size={16} aria-hidden="true" /><span>{choice.label}</span>
      </label>)}
    </div>
    <p id={hintId}>{value === 'independent' ? WORKTREE_HINT : sharedHint}</p>
  </fieldset>
}
