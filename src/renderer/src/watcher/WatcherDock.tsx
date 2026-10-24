import React, { type ReactNode } from 'react'
import { PageLinks, RoomSwitch } from '../agents/SidebarFrame'
import { updateIconState } from '../features/updates/updateControlLogic'
import { useOptionalApp } from '../state/AppContext'

/**
 * Watcher's room has no sidebar, so its way off the page floats in a pill centred along the bottom (Zach's pick on
 * October 11, 2026): History, Settings and Help, the room switch, and the update control, in the order the eye reads
 * them. Every other page keeps its sidebar and its switch where they are. At rest it shrinks to a small tab with an up arrow
 * and grows back on hover or focus.
 */
export function WatcherDock({ updateControl }: { readonly updateControl?: ReactNode }): ReactNode {
  // The pill wears the update control's state, and stays open while an update is in hand.
  const update = useOptionalApp()?.update
  const updateState = updateControl ? update?.phase ? updateIconState(update) : 'idle' : undefined
  return <div className="watcher-dock">
    <div className="watcher-dock__pill" data-update={updateState}>
      <span className="watcher-dock__tab" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7.5 6 4.5l3 3" /></svg></span>
      <PageLinks className="thread-nav__pages" linkClassName="thread-nav__page" />
      <span className="watcher-dock__sep" aria-hidden="true" />
      <RoomSwitch className="thread-nav__seg watcher-dock__switch" />
      {updateControl ? <><span className="watcher-dock__sep" aria-hidden="true" />{updateControl}</> : null}
    </div>
  </div>
}
