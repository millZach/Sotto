import React from 'react'
import { useLingui } from '@lingui/react/macro'
import { Archive, ArchiveRestore, Columns2, MessageSquare, Pencil, Sparkles } from 'lucide-react'
import { providerWritesShortText } from '../../../shared/agents'
import { isThreadArchived } from '../../../shared/threadActivity'
import { WatcherOwl } from '../watcher/WatcherOwl'
import type { PaneMenuItem } from './PaneMenu'
import type { ThreadRow } from './threadFacts'
import type { ThreadChordLabel } from './threadShortcuts'
import type { PaneActions } from './ThreadSidebar'

/** A menu row's keys, from a chord's label. */
export const menuKeys = (label: ThreadChordLabel | undefined): PaneMenuItem['shortcut'] => label === undefined ? undefined : { plain: label.plain, keys: label.keys }

/**
 * What a thread offers beyond opening it, the same from its sidebar row and from its tile on the collapsed rail
 * (ADR-0164), so the row's hover icons, its menu and the tile's menu cannot drift apart.
 */
export interface ThreadOffers {
  /** A pane stands focused on another thread, so this one can open beside it. */
  readonly beside: boolean
  readonly rename: boolean
  readonly regenerate: boolean
  readonly watch: boolean
  /** Settle's and Restore's keys act on the focused thread, so only that thread's row and tile say them. */
  readonly shelfKeys: boolean
  /** F2 renames, unless one of dictation's shortcuts holds it. */
  readonly renameKey: boolean
}

export function threadOffers(row: ThreadRow, panes: PaneActions): ThreadOffers {
  const id = row.thread.id
  const archived = isThreadArchived(row.thread)
  return {
    // Beside the focused pane's own thread, which a row marked current only for a delegated thread in the pane is not.
    beside: panes.currentThreadId !== null && panes.currentThreadId !== id,
    rename: !archived,
    // A name the user typed is never written over, so this thread's own name is the one offered for rewriting.
    regenerate: !archived && row.thread.titleSource !== 'user' && providerWritesShortText(row.thread.providerId),
    watch: row.thread.kind !== 'watcher' && row.thread.kind !== 'watcher-history',
    shelfKeys: panes.currentThreadId === id,
    renameKey: panes.rowKeys?.rename ?? true,
  }
}

/** Each of a thread's actions once, for its menu and its row's hover icons alike. */
export interface ThreadActions {
  readonly open: () => void
  readonly openBeside: () => void
  readonly rename: () => void
  readonly regenerate: () => void
  /** Watch, or stop watching; absent without Watcher's bridge. */
  readonly watch?: (() => void) | undefined
  readonly settle: () => void
  readonly restore: () => void
}

/** Where the thread stands as its menu opens. */
export interface ThreadMenuState {
  readonly offers: ThreadOffers
  /** Open in a pane already, so it is not offered beside. */
  readonly open: boolean
  /** Its own lane is running a command. */
  readonly busy: boolean
  /** Watcher watches it: Watch is ticked. */
  readonly watched: boolean
  /** Enter opens the thread from where the menu was opened. A rail tile whose press pops a Needs you card says no keys for Open. */
  readonly enterOpens: boolean
}

/**
 * A thread's row menu (ADR-0164): Open, Open beside, Rename, Regenerate title, Watch and Settle or Restore, each where
 * the thread offers it and with the keys that do the same from its row or its rail tile. A sidebar row and a rail tile
 * build it here, so the two say the same words with the same keys. The builder is called only while a menu is open.
 */
export function useThreadMenu(): (row: ThreadRow, panes: PaneActions, state: ThreadMenuState, actions: ThreadActions) => PaneMenuItem[][] {
  const { t } = useLingui()
  return (row, panes, { offers, open, busy, watched, enterOpens }, actions) => [
    [{ id: 'open', label: t({ message: 'Open', comment: 'A sidebar row\'s menu: open the thread in the focused pane.' }), icon: <MessageSquare size={15} aria-hidden="true" />, shortcut: enterOpens ? { plain: 'Enter', keys: 'Enter' } : undefined, run: actions.open },
      ...offers.beside && !open ? [{ id: 'beside', label: t`Open beside`, icon: <Columns2 size={15} aria-hidden="true" />, shortcut: menuKeys(panes.openBesideChord?.label), run: actions.openBeside }] : []],
    [...offers.rename ? [{ id: 'rename', label: t({ message: 'Rename', comment: 'Rename the thread.' }), icon: <Pencil size={15} aria-hidden="true" />, shortcut: offers.renameKey ? { plain: 'F2', keys: 'F2' } : undefined, run: actions.rename }] : [],
      ...offers.regenerate ? [{ id: 'regenerate', label: t`Regenerate title`, icon: <Sparkles size={15} aria-hidden="true" />, disabled: busy, run: actions.regenerate }] : [],
      ...offers.watch && actions.watch !== undefined ? [{ id: 'watch', label: t({ message: 'Watch', context: 'Put a thread under Watcher\'s watch' }), icon: <WatcherOwl size={15} />, shown: watched, run: actions.watch }] : []],
    row.settledBy === null
      ? [{ id: 'settle', label: t({ message: 'Settle', comment: 'Settle the thread: put it away on the Settled shelf.' }), icon: <Archive size={15} aria-hidden="true" />, disabled: busy, shortcut: offers.shelfKeys ? menuKeys(panes.settleShortcut) : undefined, run: actions.settle }]
      : row.settledBy === 'thread'
        ? [{ id: 'restore', label: t({ message: 'Restore', comment: 'Restore a settled thread to open work.' }), icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: busy, shortcut: offers.shelfKeys ? menuKeys(panes.restoreShortcut) : undefined, run: actions.restore }] : [],
  ]
}
