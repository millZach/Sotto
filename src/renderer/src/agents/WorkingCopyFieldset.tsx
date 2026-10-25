import React, { useId, type ReactNode } from 'react'
import { Folder, FolderGit2 } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'

export type WorkingCopyChoice = 'independent' | 'shared'

const CHOICES: ReadonlyArray<{ readonly value: WorkingCopyChoice; readonly label: MessageDescriptor; readonly Icon: typeof Folder }> = [
  { value: 'shared', label: msg({ message: 'Project folder', comment: 'A working copy choice: the thread works in the folder of the project.' }), Icon: Folder },
  { value: 'independent', label: msg({ message: 'New worktree', comment: 'A working copy choice: the thread gets its own Git worktree.' }), Icon: FolderGit2 },
]
const WORKTREE_HINT = msg`Its own Git branch and folder, checked out when it opens. Folders without Git are used as they are.`

/** The New worktree / Project folder choice in New thread. */
export function WorkingCopyFieldset({ value, disabled, sharedHint, worktreeHint, onChange }: {
  readonly value: WorkingCopyChoice
  readonly disabled: boolean
  /** What "Project folder" means here: who else edits the same files. */
  readonly sharedHint: string
  readonly worktreeHint?: string
  readonly onChange: (value: WorkingCopyChoice) => void
}): ReactNode {
  const { t } = useLingui()
  const hintId = useId()
  const groupName = useId()
  return <fieldset className="new-thread-working-copy" disabled={disabled} aria-describedby={hintId}>
    <legend>{t`Working copy`}</legend>
    <div className="new-thread-working-copy__choices">
      {CHOICES.map(choice => <label key={choice.value} className="new-thread-working-copy__choice">
        <input type="radio" name={groupName} value={choice.value} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <choice.Icon size={16} aria-hidden="true" /><span>{t(choice.label)}</span>
      </label>)}
    </div>
    <p className="tt-paragraph" id={hintId}>{value === 'independent' ? worktreeHint ?? t(WORKTREE_HINT) : sharedHint}</p>
  </fieldset>
}
