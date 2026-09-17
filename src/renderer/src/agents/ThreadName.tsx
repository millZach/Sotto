import React, { useState, type ReactNode } from 'react'

/**
 * The inline editor for a thread's name, shared by the sidebar row and the pane header.
 * Enter confirms, Escape cancels, and a blank or whitespace-only name is refused: the editor stays
 * open and the thread keeps the name it had. Moving focus away leaves the name alone, as Escape does.
 */
export function ThreadNameField({ title, label, className, onRename, onDone }: {
  readonly title: string
  /** What the field is called for a screen reader, such as "Rename Weekly note". */
  readonly label: string
  readonly className?: string | undefined
  /** The new name, already trimmed; not called when the name is unchanged. */
  readonly onRename: (title: string) => void
  /** The editor is finished, whether the name changed or not. */
  readonly onDone: () => void
}): ReactNode {
  const [value, setValue] = useState(title)
  const [refused, setRefused] = useState(false)
  const confirm = (): void => {
    const next = value.trim()
    if (next === '') { setRefused(true); return }
    if (next !== title) onRename(next)
    onDone()
  }
  return <input type="text" className={className} aria-label={label} aria-invalid={refused || undefined}
    // The editor only ever appears from an explicit Rename action, so it takes the caret with it.
    autoFocus value={value} spellCheck={false}
    onChange={event => { setValue(event.target.value); setRefused(false) }}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirm() }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone() }
    }}
    onBlur={onDone} />
}
