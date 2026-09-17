import { useSyncExternalStore } from 'react'
import { THREAD_PROMPT_ID } from './ThreadComposer'

/** Narrower than this, a pane's header, transcript and composer stop being usable; the workspace shows one pane at a time instead. */
export const MIN_PANE_WIDTH = 400
/** Shorter than this, a pane in a stacked arrangement leaves too little transcript beside its header and composer. */
export const MIN_PANE_HEIGHT = 300
export const DIVIDER_WIDTH = 9
/** Keyboard resizing moves a divider by this fraction of its row or column. */
export const RESIZE_STEP = 0.05
/** A dragged divider this close to an even boundary settles on it. */
const SNAP_DISTANCE = 12
/** The drag data type a sidebar row carries: a Sotto thread ID. */
export const THREAD_DRAG_TYPE = 'application/x-sotto-thread'
/** The drag data type a pane's move handle carries: the pane's thread ID. */
export const PANE_DRAG_TYPE = 'application/x-sotto-pane'
export const LAYOUT_STORAGE_KEY = 'sotto.threadWorkspace.layout'
const LAYOUT_VERSION = 1
const MAX_STORED_PANES = 32
const MAX_THREAD_ID_LENGTH = 256

/** `grid` is the snapping arrangement (one, two side by side, a third across the row below, a 2-by-2 grid, and on); `row` keeps every pane in one row. */
export type PaneArrangement = 'grid' | 'row'

export interface GridSizes {
  /** Row heights as fractions of the pane area's height. */
  readonly rows: readonly number[]
  /** Each row's pane widths as fractions of the row. */
  readonly columns: readonly (readonly number[])[]
}

/**
 * The thread views open in the workspace. With fewer than two panes the workspace is the single view that
 * follows `state.activeThreadId`, and the layout holds nothing. Sizes are fractions of the space left after
 * dividers and each set sums to one; the grid and the single row keep their own, so switching back returns
 * the earlier sizing. The layout is only a view: closing, moving or replacing a pane never touches the
 * thread, its draft or its running work.
 */
export interface SplitLayout {
  /** Sotto thread IDs in reading order. */
  readonly panes: readonly string[]
  readonly arrangement: PaneArrangement
  /** Pane widths in the single row. */
  readonly sizes: readonly number[]
  readonly grid: GridSizes
  /** One pane at a time by choice; the arrangement returns when zoom ends. */
  readonly zoomed: boolean
  /** The pane that last held focus, so a selection made while the workspace was closed moves that pane. */
  readonly focused: string | null
}

export const SINGLE_VIEW: SplitLayout = { panes: [], arrangement: 'grid', sizes: [], grid: { rows: [], columns: [] }, zoomed: false, focused: null }

export type DividerTarget = { readonly axis: 'columns'; readonly row: number; readonly index: number } | { readonly axis: 'rows'; readonly index: number }

export const isSplit = (layout: SplitLayout): boolean => layout.panes.length >= 2
const even = (count: number): number[] => Array.from({ length: count }, () => 1 / count)
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

/** Each pane's composer needs its own element ID once two are on screen; the single view keeps the established one. */
export function threadPromptId(threadId: string): string {
  return `${THREAD_PROMPT_ID}-${threadId}`
}

/** How many panes each grid row holds: 1; 2; 2 over 1; 2 over 2; then ceil(√n) columns with a shorter last row. */
export function gridShape(count: number): number[] {
  if (count <= 0) return []
  const columns = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / columns)
  return Array.from({ length: rows }, (_, row) => row < rows - 1 ? columns : count - columns * (rows - 1))
}

export function paneShape(layout: SplitLayout): number[] {
  const count = layout.panes.length
  if (count === 0) return []
  return layout.arrangement === 'row' ? [count] : gridShape(count)
}

/** Row and column of the pane at a reading-order index. */
export function slotOf(shape: readonly number[], index: number): { readonly row: number; readonly column: number } {
  let start = 0
  for (let row = 0; row < shape.length; row++) {
    if (index < start + shape[row]!) return { row, column: index - start }
    start += shape[row]!
  }
  return { row: shape.length - 1, column: 0 }
}

/** The same threads in a new order or count; rows whose pane count is unchanged keep their sizes. */
function withPanes(layout: SplitLayout, panes: readonly string[]): SplitLayout {
  if (panes.length < 2) return SINGLE_VIEW
  const before = gridShape(layout.panes.length)
  const after = gridShape(panes.length)
  const rows = before.length === after.length && layout.grid.rows.length === after.length ? layout.grid.rows : even(after.length)
  const columns = after.map((count, row) => before[row] === count && layout.grid.columns[row]?.length === count ? layout.grid.columns[row]! : even(count))
  const sizes = layout.sizes.length === panes.length ? layout.sizes : even(panes.length)
  const focused = layout.focused !== null && panes.includes(layout.focused) ? layout.focused : null
  return { panes, arrangement: layout.arrangement, sizes, grid: { rows, columns }, zoomed: layout.zoomed, focused }
}

/**
 * Open `threadId` as another pane. From the single view it splits beside the focused thread on the chosen side;
 * with panes open it takes the next slot, which the arrangement snaps into place. A thread already on screen keeps its place.
 */
export function openBeside(layout: SplitLayout, focusedId: string | null, threadId: string, side: 'start' | 'end' = 'end'): SplitLayout {
  if (focusedId === null || focusedId === threadId || layout.panes.includes(threadId)) return layout
  if (!isSplit(layout)) return withPanes(layout, side === 'end' ? [focusedId, threadId] : [threadId, focusedId])
  return withPanes(layout, side === 'end' ? [...layout.panes, threadId] : [threadId, ...layout.panes])
}

/** Show a different thread in one pane. A thread already on screen is not duplicated. */
export function replacePane(layout: SplitLayout, index: number, threadId: string): SplitLayout {
  if (index < 0 || index >= layout.panes.length || layout.panes.includes(threadId)) return layout
  const replaced = layout.panes[index]
  return { ...layout, panes: layout.panes.map((id, at) => at === index ? threadId : id), focused: layout.focused === replaced ? threadId : layout.focused }
}

/** Close one view. The last remaining pane becomes the single view. */
export function closePane(layout: SplitLayout, threadId: string): SplitLayout {
  if (!layout.panes.includes(threadId)) return layout
  return withPanes(layout, layout.panes.filter(id => id !== threadId))
}

/** Swap two panes' places. Each slot keeps its size. */
export function movePane(layout: SplitLayout, from: number, to: number): SplitLayout {
  const count = layout.panes.length
  if (from === to || from < 0 || to < 0 || from >= count || to >= count) return layout
  const panes = [...layout.panes]
  ;[panes[from], panes[to]] = [panes[to]!, panes[from]!]
  return { ...layout, panes }
}

export function setArrangement(layout: SplitLayout, arrangement: PaneArrangement): SplitLayout {
  return layout.arrangement === arrangement ? layout : { ...layout, arrangement }
}

export function setZoomed(layout: SplitLayout, zoomed: boolean): SplitLayout {
  return !isSplit(layout) || layout.zoomed === zoomed ? layout : { ...layout, zoomed }
}

export function setFocused(layout: SplitLayout, threadId: string): SplitLayout {
  return layout.focused === threadId || !layout.panes.includes(threadId) ? layout : { ...layout, focused: threadId }
}

/** The focused pane follows a selection made elsewhere (voice, attention, a new thread). Other panes never move. */
export function retarget(layout: SplitLayout, focusedId: string | null, activeId: string | null): SplitLayout {
  if (!isSplit(layout) || activeId === null || focusedId === null || layout.panes.includes(activeId)) return layout
  const index = layout.panes.indexOf(focusedId)
  return index < 0 ? layout : { ...replacePane(layout, index, activeId), focused: activeId }
}

/** Drop panes whose thread no longer exists. */
export function prune(layout: SplitLayout, exists: (threadId: string) => boolean): SplitLayout {
  let next = layout
  for (const id of layout.panes) if (!exists(id)) next = closePane(next, id)
  return next
}

/** Every pane gets at least the minimum size in this area, so the arrangement can show. An unmeasured dimension is not judged. */
export function fitsArea(layout: SplitLayout, width: number, height: number): boolean {
  if (!isSplit(layout)) return true
  const shape = paneShape(layout)
  const widest = Math.max(...shape)
  return (width <= 0 || width >= widest * MIN_PANE_WIDTH + (widest - 1) * DIVIDER_WIDTH)
    && (height <= 0 || height >= shape.length * MIN_PANE_HEIGHT + (shape.length - 1) * DIVIDER_WIDTH)
}

/** The size set a divider edits. */
function dividerFractions(layout: SplitLayout, target: DividerTarget): readonly number[] {
  if (target.axis === 'rows') return layout.arrangement === 'row' ? [1] : layout.grid.rows
  return layout.arrangement === 'row' ? layout.sizes : layout.grid.columns[target.row] ?? []
}

const minimumFor = (target: DividerTarget): number => target.axis === 'rows' ? MIN_PANE_HEIGHT : MIN_PANE_WIDTH

/** A size set as shown in an area: every pane raised to its minimum where the area allows it. Stored sizes are untouched. */
export function displayFractions(fractions: readonly number[], extent: number, minimum: number): readonly number[] {
  const count = fractions.length
  const usable = extent - (count - 1) * DIVIDER_WIDTH
  if (count < 2 || extent <= 0) return fractions
  if (count * minimum > usable) return even(count)
  const floor = minimum / usable
  if (fractions.every(value => value >= floor - 1e-9)) return fractions
  const short = sum(fractions.map(value => Math.max(0, floor - value)))
  const spare = sum(fractions.map(value => Math.max(0, value - floor)))
  return fractions.map(value => value < floor ? floor : floor + (value - floor) * (1 - short / spare))
}

/** Where a divider may sit, as the fraction before it. Both neighbours keep their minimum; an area too small to allow that locks it. */
export function dividerRange(layout: SplitLayout, target: DividerTarget, extent: number): readonly [number, number] {
  const fractions = dividerFractions(layout, target)
  const { index } = target
  const before = sum(fractions.slice(0, index))
  const current = before + (fractions[index] ?? 0)
  const usable = extent - (fractions.length - 1) * DIVIDER_WIDTH
  const minimum = minimumFor(target)
  if (fractions.length < 2 || extent <= 0 || fractions.length * minimum > usable) return [current, current]
  const pair = (fractions[index] ?? 0) + (fractions[index + 1] ?? 0)
  const floor = minimum / usable
  return [before + floor, Math.max(before + floor, before + pair - floor)]
}

/** Move a divider to `boundary` (the fraction before it). Only its two neighbours trade space. */
export function resizeDivider(layout: SplitLayout, target: DividerTarget, boundary: number, extent: number): SplitLayout {
  const fractions = dividerFractions(layout, target)
  const { index } = target
  if (index < 0 || index + 1 >= fractions.length) return layout
  const [min, max] = dividerRange(layout, target, extent)
  const clamped = Math.min(max, Math.max(min, boundary))
  const before = sum(fractions.slice(0, index))
  const pair = fractions[index]! + fractions[index + 1]!
  const next = fractions.map((value, at) => at === index ? clamped - before : at === index + 1 ? pair - (clamped - before) : value)
  if (next.every((value, at) => Math.abs(value - fractions[at]!) < 1e-9)) return layout
  if (target.axis === 'rows') return { ...layout, grid: { ...layout.grid, rows: next } }
  if (layout.arrangement === 'row') return { ...layout, sizes: next }
  return { ...layout, grid: { ...layout.grid, columns: layout.grid.columns.map((row, at) => at === target.row ? next : row) } }
}

/** Even the sizes one divider edits. */
export function evenDivider(layout: SplitLayout, target: DividerTarget): SplitLayout {
  const count = dividerFractions(layout, target).length
  if (count < 2) return layout
  if (target.axis === 'rows') return { ...layout, grid: { ...layout.grid, rows: even(count) } }
  if (layout.arrangement === 'row') return { ...layout, sizes: even(count) }
  return { ...layout, grid: { ...layout.grid, columns: layout.grid.columns.map((row, at) => at === target.row ? even(count) : row) } }
}

/** A dragged boundary near an even position (across the set, or between its two neighbours) settles there. */
export function snapBoundary(layout: SplitLayout, target: DividerTarget, boundary: number, extent: number): number {
  const fractions = dividerFractions(layout, target)
  const count = fractions.length
  const usable = extent - (count - 1) * DIVIDER_WIDTH
  if (count < 2 || usable <= 0) return boundary
  const before = sum(fractions.slice(0, target.index))
  const candidates = [...Array.from({ length: count - 1 }, (_, at) => (at + 1) / count), before + ((fractions[target.index] ?? 0) + (fractions[target.index + 1] ?? 0)) / 2]
  const nearest = candidates.reduce((best, candidate) => Math.abs(candidate - boundary) < Math.abs(best - boundary) ? candidate : best)
  return Math.abs(nearest - boundary) * usable <= SNAP_DISTANCE ? nearest : boundary
}

/** One axis of a pane's box: it starts after `start` of the usable space and `dividers` dividers, and spans `size` of it. */
export interface AxisPlacement { readonly start: number; readonly size: number; readonly dividers: number; readonly total: number }
export interface PanePlacement { readonly index: number; readonly row: number; readonly column: number; readonly x: AxisPlacement; readonly y: AxisPlacement }
export interface DividerPlacement { readonly target: DividerTarget; readonly before: readonly number[]; readonly after: readonly number[]; readonly x: AxisPlacement; readonly y: AxisPlacement }

/** Where every pane and divider sits for a shape and its (displayed) sizes. */
export function placements(shape: readonly number[], rows: readonly number[], columns: readonly (readonly number[])[]): { readonly panes: PanePlacement[]; readonly dividers: DividerPlacement[] } {
  const panes: PanePlacement[] = []
  const dividers: DividerPlacement[] = []
  const rowCount = shape.length
  let index = 0
  let top = 0
  for (let row = 0; row < rowCount; row++) {
    const y: AxisPlacement = { start: top, size: rows[row] ?? 1 / rowCount, dividers: row, total: rowCount - 1 }
    const widths = columns[row] ?? even(shape[row]!)
    let left = 0
    const firstInRow = index
    for (let column = 0; column < shape[row]!; column++) {
      const width = widths[column] ?? 1 / shape[row]!
      panes.push({ index, row, column, x: { start: left, size: width, dividers: column, total: shape[row]! - 1 }, y })
      left += width
      if (column < shape[row]! - 1) {
        dividers.push({ target: { axis: 'columns', row, index: column }, before: [index], after: [index + 1],
          x: { start: left, size: 0, dividers: column, total: shape[row]! - 1 }, y })
      }
      index++
    }
    top += y.size
    if (row < rowCount - 1) {
      const above = Array.from({ length: shape[row]! }, (_, at) => firstInRow + at)
      const below = Array.from({ length: shape[row + 1]! }, (_, at) => index + at)
      dividers.push({ target: { axis: 'rows', index: row }, before: above, after: below,
        x: { start: 0, size: 1, dividers: 0, total: 0 }, y: { start: top, size: 0, dividers: row, total: rowCount - 1 } })
    }
  }
  return { panes, dividers }
}

// ---- Persistence ----

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

const validFractions = (value: unknown, count: number): number[] | null => {
  if (!Array.isArray(value) || value.length !== count || !value.every(item => typeof item === 'number' && Number.isFinite(item) && item > 0)) return null
  const total = sum(value as number[])
  return (value as number[]).map(item => item / total)
}

/** A stored layout, or the single view when it is missing, unreadable, from another version or names threads unsafely. Mismatched sizes are evened. */
export function parseStoredLayout(text: string | null): SplitLayout {
  if (text === null) return SINGLE_VIEW
  let value: unknown
  try { value = JSON.parse(text) } catch { return SINGLE_VIEW }
  if (typeof value !== 'object' || value === null) return SINGLE_VIEW
  const stored = value as Record<string, unknown>
  const panes = stored.panes
  if (stored.version !== LAYOUT_VERSION || !Array.isArray(panes) || panes.length < 2 || panes.length > MAX_STORED_PANES) return SINGLE_VIEW
  if (!panes.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_THREAD_ID_LENGTH) || new Set(panes).size !== panes.length) return SINGLE_VIEW
  const ids = panes as string[]
  const shape = gridShape(ids.length)
  const grid = typeof stored.grid === 'object' && stored.grid !== null ? stored.grid as Record<string, unknown> : {}
  const storedColumns = Array.isArray(grid.columns) && grid.columns.length === shape.length ? grid.columns as unknown[] : null
  return {
    panes: ids,
    arrangement: stored.arrangement === 'row' ? 'row' : 'grid',
    sizes: validFractions(stored.sizes, ids.length) ?? even(ids.length),
    grid: {
      rows: validFractions(grid.rows, shape.length) ?? even(shape.length),
      columns: shape.map((count, row) => (storedColumns && validFractions(storedColumns[row], count)) ?? even(count)),
    },
    zoomed: stored.zoomed === true,
    focused: typeof stored.focused === 'string' && ids.includes(stored.focused) ? stored.focused : null,
  }
}

function serialize(layout: SplitLayout): string {
  const { panes, arrangement, sizes, grid, zoomed, focused } = layout
  return JSON.stringify({ version: LAYOUT_VERSION, panes, arrangement, sizes, grid, zoomed, focused })
}

export function browserStorage(): LayoutStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The arrangement. It outlives the Threads page, so leaving for History and coming back (or narrowing the
 * window) returns to the same panes and sizes; with storage it also survives a restart. Storage holds only
 * view state: thread IDs, sizes and the arrangement, never drafts or thread content.
 */
export class SplitLayoutStore {
  private layout: SplitLayout | null = null
  private readonly listeners = new Set<() => void>()
  constructor(private readonly storage: LayoutStorage | null = null, private readonly key = LAYOUT_STORAGE_KEY) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly get = (): SplitLayout => {
    if (this.layout === null) {
      this.layout = parseStoredLayout(this.read())
    }
    return this.layout
  }
  private read(): string | null {
    try { return this.storage?.getItem(this.key) ?? null } catch { return null }
  }
  set(next: SplitLayout): void {
    if (next === this.get()) return
    this.layout = next
    try { this.storage?.setItem(this.key, serialize(next)) } catch { /* Storage can be unavailable; the arrangement still holds for this session. */ }
    for (const listener of [...this.listeners]) listener()
  }
}

export const splitLayoutStore = new SplitLayoutStore(browserStorage())

export function useSplitLayout(store: SplitLayoutStore): SplitLayout {
  return useSyncExternalStore(store.subscribe, store.get)
}
