import React, { type ReactNode } from 'react'
import { PageLinks, RoomSwitch } from '../agents/SidebarFrame'

/**
 * Watcher's room has no sidebar, so its way off the page floats in a pill centred along the bottom (Zach's pick on
 * October 11, 2026): History, Settings and Help, the room switch, and the update control, in the order the eye reads
 * them. Every other page keeps its sidebar and its switch where they are. The room keeps a band clear for the pill, so
 * it never covers a composer or a pane's controls.
 */
export function WatcherDock({ updateControl }: { readonly updateControl?: ReactNode }): ReactNode {
  return <div className="watcher-dock">
    <div className="watcher-dock__pill">
      <PageLinks className="thread-nav__pages" linkClassName="thread-nav__page" />
      <span className="watcher-dock__sep" aria-hidden="true" />
      <RoomSwitch className="thread-nav__seg watcher-dock__switch" />
      {updateControl ? <><span className="watcher-dock__sep" aria-hidden="true" />{updateControl}</> : null}
    </div>
  </div>
}
