import React, { useId, type ComponentType, type ReactNode } from 'react'

type GroupIcon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>

/**
 * A run of settings rows under a small heading with its icon and an optional note, as Git and Cloud iPhone group
 * theirs. The rows inside are the page's usual ones, so a grouped page reads like every other Settings page.
 */
export function SettingsGroup({ id: sectionId, title, icon: Icon, note, rows = true, children }: {
  /** A group that Settings can be opened at (settingsPages.ts) carries that section's id. */
  readonly id?: string
  readonly title: string; readonly icon: GroupIcon; readonly note?: string
  /** False for a panel that lays out its own cards, such as Phones: it goes under the heading as it is. */
  readonly rows?: boolean
  readonly children: ReactNode
}): ReactNode {
  const id = useId()
  const noteId = useId()
  return <section className="settings-group" {...(sectionId ? { id: sectionId } : {})} aria-labelledby={id} {...(note ? { 'aria-describedby': noteId } : {})}>
    <h3 id={id}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{title}</h3>
    {note ? <p className="settings-group__note" id={noteId}>{note}</p> : null}
    {rows ? <div className="settings-rows">{children}</div> : children}
  </section>
}
