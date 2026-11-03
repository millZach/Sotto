import { useEffect, useState } from 'react'
import { focusInPane, type DropTarget } from './ThreadPanes'
import { closePane, openBeside, replacePane, type SplitLayout, type SplitLayoutStore } from './splitLayout'

/** The page's clock: a fixed time where a capture holds it still, otherwise ticking every `intervalMs` while `active`. */
export function useClock(fixed: number | undefined, intervalMs = 30_000, active = true): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined || !active) return
    const timer = setInterval(() => setTick(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [fixed, intervalMs, active])
  return fixed ?? tick
}

/** Puts keyboard focus inside a pane once it has rendered. */
export const focusPaneLater = (id: string): void => { window.setTimeout(() => focusInPane(id), 0) }

/** What the grid's actions need from the workspace that owns it. */
export interface PaneGrid {
  readonly layout: SplitLayout
  readonly focusedId: string | null
  readonly layoutStore: SplitLayoutStore
  /** Whether this ID can be shown in a pane right now. */
  readonly exists: (id: string) => boolean
  /** Shows the ID in the single view, or in the focused pane of a split. */
  readonly open: (id: string) => void
  /** Gives an already visible pane the focus. */
  readonly focus: (id: string) => void
}

/**
 * The actions every pane grid offers: open beside the focused pane, drop a sidebar row on a target, close a pane
 * (the view only, never the work in it). The workspace decides what opening and focusing mean. F6 between the panes is the
 * window's own region cycle now (ADR-0164, `regionCycle.ts`).
 */
export function paneGridActions({ layout, focusedId, layoutStore, exists, open, focus }: PaneGrid) {
  const openBesideFocused = (id: string, side: 'start' | 'end' = 'end'): void => {
    if (focusedId === null) { open(id); return }
    if (id === focusedId) return
    layoutStore.set(openBeside(layout, focusedId, id, side))
    focus(id)
  }
  const onDrop = (id: string, target: DropTarget): void => {
    if (!exists(id)) return
    if (target.kind === 'open') open(id)
    else if (target.kind === 'side') openBesideFocused(id, target.side)
    else if (target.kind === 'add') openBesideFocused(id)
    else {
      if (!layout.panes.includes(id)) layoutStore.set(replacePane(layout, target.index, id))
      focus(id)
    }
    focusPaneLater(id)
  }
  const close = (id: string): void => {
    const others = layout.panes.filter(item => item !== id)
    layoutStore.set(closePane(layout, id))
    // Closing changes only the view. Focus goes to the neighbouring pane when the closed one had it.
    const keep = id === focusedId ? others[Math.max(0, layout.panes.indexOf(id) - 1)] : focusedId
    if (keep === undefined || keep === null) return
    if (id === focusedId) focus(keep)
    focusPaneLater(keep)
  }
  return { openBesideFocused, onDrop, close }
}
