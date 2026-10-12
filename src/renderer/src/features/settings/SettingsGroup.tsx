import React, { useId, type ComponentType, type ReactNode } from 'react'

type GroupIcon = ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>

/**
 * A run of settings rows under a small heading with its icon and an optional note, as Git and Cloud iPhone group
 * theirs. The rows inside are the page's usual ones, so a grouped page reads like every other Settings page.
 */
export function SettingsGroup({ title, icon: Icon, note, children }: { readonly title: string; readonly icon: GroupIcon; readonly note?: string; readonly children: ReactNode }): ReactNode {
  const id = useId()
  const noteId = useId()
  return <section className="settings-group" aria-labelledby={id} {...(note ? { 'aria-describedby': noteId } : {})}>
    <h3 id={id}><Icon size={16} strokeWidth={1.7} aria-hidden="true" />{title}</h3>
    {note ? <p className="settings-group__note" id={noteId}>{note}</p> : null}
    <div className="settings-rows">{children}</div>
  </section>
}
