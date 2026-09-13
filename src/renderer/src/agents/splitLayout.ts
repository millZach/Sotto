import { useSyncExternalStore } from 'react'
import { THREAD_PROMPT_ID } from './ThreadComposer'

/** Two thread views side by side. Three and four panes, and restoring the arrangement after restart, come later. */
export const MAX_SPLIT_PANES = 2
/** Narrower than this, a pane's header, transcript and composer stop being usable; the workspace shows one pane at a time instead. */
export const MIN_PANE_WIDTH = 400
export const DIVIDER_WIDTH = 9
/** Keyboard resizing moves the divider by this fraction of the pane area. */
export const RESIZE_STEP = 0.05
/** The drag data type a sidebar row carries: a Sotto thread ID. */
export const THREAD_DRAG_TYPE = 'application/x-sotto-thread'

/**
 * The thread views open in the workspace. With fewer than two panes the workspace is the single
 * view that follows `state.activeThreadId`; the layout then holds nothing. Pane sizes are fractions
 * of the pane area and always sum to one. The layout is only a view: closing or replacing a pane never
 * touches the thread, its draft or its running work.
 */
export interface SplitLayout {
  readonly panes: readonly string[]
  readonly sizes: readonly number[]
}

export const SINGLE_VIEW: SplitLayout = { panes: [], sizes: [] }

export const isSplit = (layout: SplitLayout): boolean => layout.panes.length >= 2
const even = (count: number): number[] => Array.from({ length: count }, () => 1 / count)

/** Each pane's composer needs its own element ID once two are on screen; the single view keeps the established one. */
export function threadPromptId(threadId: string): string {
  return `${THREAD_PROMPT_ID}-${threadId}`
}

/**
 * Open `threadId` beside the focused thread. From the single view this splits the space evenly;
 * in a full split it replaces the other pane. A thread already on screen keeps its place.
 */
export function openBeside(layout: SplitLayout, focusedId: string | null, threadId: string, side: 'start' | 'end' = 'end'): SplitLayout {
  if (focusedId === null || focusedId === threadId || layout.panes.includes(threadId)) return layout
  if (!isSplit(layout)) return { panes: side === 'end' ? [focusedId, threadId] : [threadId, focusedId], sizes: even(2) }
  const focusIndex = layout.panes.indexOf(focusedId)
  const target = focusIndex < 0 ? layout.panes.length - 1 : focusIndex === 0 ? 1 : focusIndex - 1
  return replacePane(layout, target, threadId)
}

/** Show a different thread in one pane. A thread already on screen is not duplicated. */
export function replacePane(layout: SplitLayout, index: number, threadId: string): SplitLayout {
  if (index < 0 || index >= layout.panes.length || layout.panes.includes(threadId)) return layout
  return { panes: layout.panes.map((id, at) => at === index ? threadId : id), sizes: layout.sizes }
}

/** Close one view. The last remaining pane becomes the single view. */
export function closePane(layout: SplitLayout, threadId: string): SplitLayout {
  const index = layout.panes.indexOf(threadId)
  if (index < 0) return layout
  const panes = layout.panes.filter(id => id !== threadId)
  if (panes.length < 2) return SINGLE_VIEW
  const freed = layout.sizes[index] ?? 0
  const sizes = layout.sizes.filter((_, at) => at !== index)
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1
  return { panes, sizes: sizes.map(size => size + freed * (size / total)) }
}

/** The focused pane follows a selection made elsewhere (voice, attention, a new thread). Other panes never move. */
export function retarget(layout: SplitLayout, focusedId: string | null, activeId: string | null): SplitLayout {
  if (!isSplit(layout) || activeId === null || focusedId === null || layout.panes.includes(activeId)) return layout
  const index = layout.panes.indexOf(focusedId)
  return index < 0 ? layout : replacePane(layout, index, activeId)
}

/** Drop panes whose thread no longer exists. */
export function prune(layout: SplitLayout, exists: (threadId: string) => boolean): SplitLayout {
  let next = layout
  for (const id of layout.panes) if (!exists(id)) next = closePane(next, id)
  return next
}

/** The pane area cannot hold every pane at a usable width, so one pane is shown at a time. */
export function isNarrow(width: number, count: number): boolean {
  return count >= 2 && width > 0 && width < count * MIN_PANE_WIDTH + (count - 1) * DIVIDER_WIDTH
}

/** The left pane's share, kept so that both panes stay at least MIN_PANE_WIDTH where the area allows it. */
export function clampShare(share: number, width: number): number {
  const usable = width - DIVIDER_WIDTH
  const min = usable > 2 * MIN_PANE_WIDTH ? MIN_PANE_WIDTH / usable : 0.5
  return Math.min(1 - min, Math.max(min, share))
}

/** Move the divider between the first two panes. */
export function resizeSplit(layout: SplitLayout, share: number, width: number): SplitLayout {
  if (!isSplit(layout)) return layout
  const first = clampShare(share, width)
  return { panes: layout.panes, sizes: [first, 1 - first] }
}

export function evenSplit(layout: SplitLayout): SplitLayout {
  return isSplit(layout) ? { panes: layout.panes, sizes: even(layout.panes.length) } : layout
}

/**
 * The arrangement for this app session. It outlives the Threads page, so leaving for History and
 * coming back (or narrowing the window) returns to the same panes and sizes.
 */
export class SplitLayoutStore {
  private layout: SplitLayout = SINGLE_VIEW
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly get = (): SplitLayout => this.layout
  set(next: SplitLayout): void {
    if (next === this.layout) return
    this.layout = next
    for (const listener of this.listeners) listener()
  }
}

export const splitLayoutStore = new SplitLayoutStore()

export function useSplitLayout(store: SplitLayoutStore): SplitLayout {
  return useSyncExternalStore(store.subscribe, store.get)
}
