import React, { useCallback, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useWatchActions } from '../watcher/watcherRoom'
import type { AgentConnection } from './AgentContext'
import { followRow, RowMenu, rowMenuPlace, rowMenuPressed, type RowMenuPlace } from './RowMenu'
import type { ThreadRow } from './threadFacts'
import { threadOffers, useThreadMenu } from './threadMenu'
import { ThreadNameField } from './ThreadName'
import type { PaneActions } from './ThreadSidebar'
import { openBesidePressed } from './threadShortcuts'
import type { useSettleThread } from './ThreadWorkingCopy'

export interface RailTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onContextMenu'> {
  readonly row: ThreadRow
  readonly panes: PaneActions
  /** Open in a pane already, so the menu offers no Open beside. */
  readonly open: boolean
  /** This thread's own lane is running a command. */
  readonly busy: boolean
  /** Watcher watches the thread: the menu's Watch is ticked. */
  readonly watched: boolean
  /** The tile's press opens the thread, so Enter is Open's key. On Owl a waiting tile's press pops its Needs you card instead. */
  readonly pressOpens: boolean
  readonly command: AgentConnection['command']
  /** The sidebar's own Settle, worktree question and all, so a Settle from the rail is the same Settle as from a row. */
  readonly settle: ReturnType<typeof useSettleThread>['settle']
  readonly onOpen: (threadId: string) => void
}

/**
 * A thread's tile on the collapsed rail, with its row's menu (ADR-0164): Shift+F10, the menu key or a right-click opens
 * the menu the thread's sidebar row opens, built by the same hook with the same words and keys, beside the tile for the
 * keys and at the pointer for a right-click. Escape hands the focus back to the tile. The tile answers the keys the menu
 * names: F2 renames, in a field beside the tile since a tile has no room for one, and Open beside's keys open it beside.
 * Everything else about the tile, its look and its press, is the caller's.
 */
export function RailTile({ row, panes, open, busy, watched, pressOpens, command, settle, onOpen, onKeyDown, children, ...button }: RailTileProps): ReactNode {
  const { t } = useLingui()
  const tile = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<RowMenuPlace | null>(null)
  const [renaming, setRenaming] = useState(false)
  // A finished rename hands the focus back to the tile, the rail's stop, as a row's does to the row.
  const restoreRenameFocus = useRef(false)
  useLayoutEffect(() => {
    if (!renaming && restoreRenameFocus.current) { restoreRenameFocus.current = false; tile.current?.focus() }
  }, [renaming])
  const watchActions = useWatchActions()
  const threadMenu = useThreadMenu()
  const offers = threadOffers(row, panes)
  const id = row.thread.id
  const title = row.thread.title
  const openBeside = (): void => panes.onOpenBeside(id)
  const menuGroups = (): ReturnType<typeof threadMenu> => threadMenu(row, panes, { offers, open, busy, watched, enterOpens: pressOpens }, {
    open: () => onOpen(id), openBeside, rename: () => setRenaming(true),
    regenerate: () => void command({ type: 'regenerate-thread-title', threadId: id }),
    settle: () => void settle(row.thread, row.project),
    restore: () => void command({ type: 'restore-thread', threadId: id }),
    watch: watchActions === null ? undefined : () => void watchActions.setThread(id, !watched),
  })
  return <>
    <button ref={tile} type="button" {...button} aria-keyshortcuts={offers.beside ? panes.openBesideChord?.label.keys : undefined}
      onKeyDown={event => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (offers.beside && panes.openBesideChord && openBesidePressed(event, panes.openBesideChord.chord, panes.openBesideChord.platform)) { event.preventDefault(); openBeside(); return }
        if (rowMenuPressed(event, panes.rowKeys?.menu ?? true)) { event.preventDefault(); setMenu('beside'); return }
        if (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && offers.rename && offers.renameKey) { event.preventDefault(); setRenaming(true) }
      }}
      onContextMenu={event => { event.preventDefault(); tile.current?.focus(); setMenu(rowMenuPlace(event)) }}>{children}</button>
    {menu !== null ? <RowMenu label={t`Actions for ${title}`} groups={menuGroups()} anchor={() => tile.current} place={menu} side="end"
      onClose={restore => { setMenu(null); if (restore) tile.current?.focus() }} /> : null}
    {renaming ? <RailRename title={title} anchor={() => tile.current} onRename={next => void command({ type: 'rename-thread', threadId: id, title: next })}
      onDone={restore => { restoreRenameFocus.current = restore; setRenaming(false) }} /> : null}
  </>
}

/**
 * Rename from the rail: the row's rename field, in the menu's frame beside the tile, where the menu opens. Enter keeps the
 * name and Escape the old one, and either hands the focus back to the tile; moving the focus away leaves the name alone.
 */
function RailRename({ title, anchor, onRename, onDone }: {
  readonly title: string
  readonly anchor: () => HTMLElement | null
  readonly onRename: (title: string) => void
  readonly onDone: (restoreFocus: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const frame = useRef<HTMLDivElement>(null)
  const latest = useRef({ anchor, onDone })
  latest.current = { anchor, onDone }
  // Done once: the field's blur as it goes, after Enter or Escape, is not a second answer that would drop the focus.
  const finished = useRef(false)
  const finish = useCallback((restore: boolean): void => { if (!finished.current) { finished.current = true; latest.current.onDone(restore) } }, [])
  useLayoutEffect(() => {
    const box = frame.current
    if (box === null) return
    box.showPopover?.()
    const stop = followRow(box, () => latest.current.anchor(), 'beside', 'end', () => finish(false))
    if (stop === null) { finish(false); return }
    box.querySelector('input')?.focus()
    return () => { stop(); box.hidePopover?.() }
  }, [finish])
  return <div ref={frame} className="pane-menu__list thread-row-menu thread-nav__rail-rename" popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}>
    <ThreadNameField title={title} label={t`Rename ${title}`} className="thread-nav__rename tt-focusable" onRename={onRename} onDone={finish} />
  </div>
}
