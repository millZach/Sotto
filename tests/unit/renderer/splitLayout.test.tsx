import { describe, expect, it } from 'vitest'

import {
  DIVIDER_WIDTH, LAYOUT_STORAGE_KEY, MIN_PANE_HEIGHT, MIN_PANE_WIDTH, SINGLE_VIEW, SplitLayoutStore,
  closePane, dividerRange, fitsArea, gridShape, movePane, openBeside, parseStoredLayout, paneShape, prune, replacePane,
  resizeDivider, retarget, setArrangement, setFocused, setZoomed, snapBoundary, type SplitLayout,
} from '../../../src/renderer/src/agents/splitLayout'

const layoutOf = (panes: string[], patch: Partial<SplitLayout> = {}): SplitLayout => {
  let layout: SplitLayout = SINGLE_VIEW
  for (const id of panes.slice(1)) layout = openBeside(layout, panes[0]!, id)
  return { ...layout, ...patch }
}

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  setItem(key: string, value: string): void { this.items.set(key, value) }
}

describe('pane arrangement snapping', () => {
  it('fills with one, splits two side by side, spans a third below the first two and makes a 2-by-2 grid of four', () => {
    expect(gridShape(1)).toEqual([1])
    expect(gridShape(2)).toEqual([2])
    expect(gridShape(3)).toEqual([2, 1])
    expect(gridShape(4)).toEqual([2, 2])
  })

  it('keeps extending past four instead of capping, and a single row holds every pane', () => {
    expect(gridShape(5)).toEqual([3, 2])
    expect(gridShape(6)).toEqual([3, 3])
    expect(gridShape(7)).toEqual([3, 3, 1])
    expect(gridShape(10)).toEqual([4, 4, 2])
    const five = layoutOf(['a', 'b', 'c', 'd', 'e'])
    expect(five.panes).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(paneShape(five)).toEqual([3, 2])
    expect(paneShape(setArrangement(five, 'row'))).toEqual([5])
  })

  it('adds each new pane at the next slot with even sizes, on either side of a single view', () => {
    expect(openBeside(SINGLE_VIEW, 'a', 'b')).toMatchObject({ panes: ['a', 'b'], arrangement: 'grid', grid: { rows: [1], columns: [[0.5, 0.5]] } })
    expect(openBeside(SINGLE_VIEW, 'a', 'b', 'start').panes).toEqual(['b', 'a'])
    expect(openBeside(SINGLE_VIEW, 'a', 'a')).toBe(SINGLE_VIEW)
    expect(openBeside(SINGLE_VIEW, null, 'b')).toBe(SINGLE_VIEW)
    const three = layoutOf(['a', 'b', 'c'])
    expect(three.grid).toEqual({ rows: [0.5, 0.5], columns: [[0.5, 0.5], [1]] })
    // A thread already on screen keeps its place; opening it again changes nothing.
    expect(openBeside(three, 'c', 'a')).toBe(three)
    expect(replacePane(three, 0, 'b')).toBe(three)
    expect(replacePane(three, 2, 'x').panes).toEqual(['a', 'b', 'x'])
  })

  it('keeps sizing of rows whose pane count did not change when adding or closing', () => {
    let layout = layoutOf(['a', 'b', 'c'])
    layout = resizeDivider(layout, { axis: 'columns', row: 0, index: 0 }, 0.6, 1200)
    layout = resizeDivider(layout, { axis: 'rows', index: 0 }, 0.4, 900)
    const four = openBeside(layout, 'a', 'd')
    expect(four.grid.columns[0]).toEqual([0.6, 0.4])
    expect(four.grid.columns[1]).toEqual([0.5, 0.5])
    expect(four.grid.rows).toEqual([0.4, 0.6])
    const back = closePane(four, 'd')
    expect(back.panes).toEqual(['a', 'b', 'c'])
    expect(back.grid.columns).toEqual([[0.6, 0.4], [1]])
    expect(closePane(closePane(back, 'c'), 'b')).toBe(SINGLE_VIEW)
    expect(closePane(back, 'x')).toBe(back)
  })

  it('moves a pane by swapping slots, keeping every thread and the slot sizes', () => {
    const four = resizeDivider(layoutOf(['a', 'b', 'c', 'd']), { axis: 'columns', row: 0, index: 0 }, 0.3, 1200)
    const moved = movePane(four, 0, 3)
    expect(moved.panes).toEqual(['d', 'b', 'c', 'a'])
    expect(moved.grid).toEqual(four.grid)
    expect(movePane(four, 1, 1)).toBe(four)
    expect(movePane(four, 1, 9)).toBe(four)
  })

  it('switches between grid and single row, each keeping its own sizes, and zoom keeps the arrangement', () => {
    const grid = resizeDivider(layoutOf(['a', 'b', 'c']), { axis: 'columns', row: 0, index: 0 }, 0.6, 1400)
    const row = resizeDivider(setArrangement(grid, 'row'), { axis: 'columns', row: 0, index: 1 }, 0.72, 1800)
    expect(row.sizes).toHaveLength(3)
    expect(row.sizes[0]! + row.sizes[1]!).toBeCloseTo(0.72)
    const again = setArrangement(row, 'grid')
    expect(again.grid.columns[0]).toEqual([0.6, 0.4])
    expect(setArrangement(again, 'row').sizes).toEqual(row.sizes)
    const zoomed = setZoomed(again, true)
    expect(zoomed.zoomed).toBe(true)
    expect(setZoomed(zoomed, false)).toEqual(again)
    expect(setZoomed(SINGLE_VIEW, true)).toBe(SINGLE_VIEW)
    expect(closePane(closePane(zoomed, 'c'), 'b')).toBe(SINGLE_VIEW)
  })

  it('moves only the focused pane after an outside selection, remembers focus and drops missing threads', () => {
    const split = layoutOf(['a', 'b'])
    expect(retarget(split, 'b', 'c').panes).toEqual(['a', 'c'])
    expect(retarget(split, 'b', 'c').focused).toBe('c')
    expect(retarget(split, 'b', 'a')).toBe(split)
    expect(retarget(split, 'b', null)).toBe(split)
    expect(setFocused(split, 'b').focused).toBe('b')
    const focused = setFocused(split, 'b')
    expect(setFocused(focused, 'b')).toBe(focused)
    expect(setFocused(split, 'x')).toBe(split)
    expect(prune(split, id => id !== 'b')).toBe(SINGLE_VIEW)
    expect(prune(split, () => true)).toBe(split)
  })
})

describe('pane sizing', () => {
  it('keeps both neighbours of a divider at a usable width and locks an area too small to resize', () => {
    const split = layoutOf(['a', 'b'])
    const target = { axis: 'columns', row: 0, index: 0 } as const
    const [min, max] = dividerRange(split, target, 1200)
    expect(min).toBeCloseTo(MIN_PANE_WIDTH / (1200 - DIVIDER_WIDTH))
    expect(max).toBeCloseTo(1 - MIN_PANE_WIDTH / (1200 - DIVIDER_WIDTH))
    expect(resizeDivider(split, target, 0, 1200).grid.columns[0]![0]).toBeCloseTo(min)
    expect(resizeDivider(split, target, 0.6, 1200).grid.columns[0]).toEqual([0.6, 0.4])
    expect(dividerRange(split, target, 700)).toEqual([0.5, 0.5])
    // The middle divider of three only trades space between its own neighbours.
    const row = setArrangement(layoutOf(['a', 'b', 'c']), 'row')
    const moved = resizeDivider(row, { axis: 'columns', row: 0, index: 1 }, 0.75, 1800)
    expect(moved.sizes[0]).toBeCloseTo(1 / 3)
    expect(moved.sizes[1]! + moved.sizes[2]!).toBeCloseTo(2 / 3)
    expect(moved.sizes[0]! + moved.sizes[1]!).toBeCloseTo(0.75)
  })

  it('snaps a dragged divider to an even boundary when it is close', () => {
    const split = layoutOf(['a', 'b'])
    const target = { axis: 'columns', row: 0, index: 0 } as const
    expect(snapBoundary(split, target, 0.505, 1200)).toBe(0.5)
    expect(snapBoundary(split, target, 0.56, 1200)).toBe(0.56)
    const row = setArrangement(layoutOf(['a', 'b', 'c']), 'row')
    expect(snapBoundary(row, { axis: 'columns', row: 0, index: 0 }, 0.335, 1800)).toBeCloseTo(1 / 3)
  })

  it('fits an arrangement only when every pane keeps its minimum size', () => {
    const two = layoutOf(['a', 'b'])
    expect(fitsArea(two, 2 * MIN_PANE_WIDTH + DIVIDER_WIDTH, 500)).toBe(true)
    expect(fitsArea(two, 2 * MIN_PANE_WIDTH + DIVIDER_WIDTH - 1, 500)).toBe(false)
    const four = layoutOf(['a', 'b', 'c', 'd'])
    expect(fitsArea(four, 1000, 2 * MIN_PANE_HEIGHT + DIVIDER_WIDTH)).toBe(true)
    expect(fitsArea(four, 1000, 2 * MIN_PANE_HEIGHT + DIVIDER_WIDTH - 1)).toBe(false)
    expect(fitsArea(setArrangement(four, 'row'), 1000, 900)).toBe(false)
    expect(fitsArea(SINGLE_VIEW, 300, 200)).toBe(true)
    // Before the first measurement nothing is judged too small.
    expect(fitsArea(four, 0, 0)).toBe(true)
  })
})

describe('layout persistence', () => {
  it('restores the arrangement, threads, focus, zoom and sizes after a restart', () => {
    const storage = new MemoryStorage()
    const first = new SplitLayoutStore(storage)
    expect(first.get()).toBe(SINGLE_VIEW)
    let layout = resizeDivider(layoutOf(['a', 'b', 'c', 'd']), { axis: 'rows', index: 0 }, 0.4, 900)
    layout = setFocused(setArrangement(setArrangement(layout, 'row'), 'grid'), 'c')
    first.set(layout)
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).not.toBeNull()
    const restarted = new SplitLayoutStore(storage)
    expect(restarted.get()).toEqual(layout)
  })

  it('ignores unreadable or hostile stored layouts and repairs sizes that do not match the panes', () => {
    expect(parseStoredLayout(null)).toBe(SINGLE_VIEW)
    expect(parseStoredLayout('not json')).toBe(SINGLE_VIEW)
    expect(parseStoredLayout(JSON.stringify({ version: 99, panes: ['a', 'b'] }))).toBe(SINGLE_VIEW)
    expect(parseStoredLayout(JSON.stringify({ version: 1, panes: ['a', 'a'] }))).toBe(SINGLE_VIEW)
    expect(parseStoredLayout(JSON.stringify({ version: 1, panes: ['a', 7] }))).toBe(SINGLE_VIEW)
    const repaired = parseStoredLayout(JSON.stringify({ version: 1, panes: ['a', 'b', 'c'], arrangement: 'sideways', sizes: [-1, 'x'], grid: { rows: [1], columns: [[0.2, 0.8]] }, zoomed: 'yes', focused: 'zzz' }))
    expect(repaired).toEqual(layoutOf(['a', 'b', 'c']))
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    const store = new SplitLayoutStore(storage)
    expect(store.get()).toBe(SINGLE_VIEW)
    expect(() => store.set(layoutOf(['a', 'b']))).not.toThrow()
  })
})
