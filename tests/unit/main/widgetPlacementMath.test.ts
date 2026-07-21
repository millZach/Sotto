import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WIDGET_PLACEMENT,
  placementToPosition,
  snapToEdge,
} from '../../../src/main/windows/widgetPlacementMath'

const WIDGET = { width: 248, height: 88 } as const
const WORK_AREA = { x: 1_000, y: 100, width: 1_200, height: 900 } as const
const GAP = 16

describe('placementToPosition', () => {
  it('centers the default bottom placement above the bottom gap', () => {
    expect(placementToPosition(DEFAULT_WIDGET_PLACEMENT, WIDGET, WORK_AREA, GAP)).toEqual({
      x: 1_476,
      y: 896,
    })
  })

  it('anchors each edge a gap away while the offset travels along that edge', () => {
    expect(
      placementToPosition({ edge: 'bottom', offset: 0 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_000, y: 896 })
    expect(
      placementToPosition({ edge: 'top', offset: 1 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_952, y: 116 })
    expect(
      placementToPosition({ edge: 'left', offset: 0.5 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_016, y: 506 })
    expect(
      placementToPosition({ edge: 'right', offset: 1 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_936, y: 912 })
  })

  it('clamps out-of-range and non-finite offsets so the widget stays fully on screen', () => {
    expect(
      placementToPosition({ edge: 'bottom', offset: 4.2 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_952, y: 896 })
    expect(
      placementToPosition({ edge: 'bottom', offset: -1 }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_000, y: 896 })
    expect(
      placementToPosition({ edge: 'left', offset: Number.NaN }, WIDGET, WORK_AREA, GAP),
    ).toEqual({ x: 1_016, y: 506 })
  })

  it('keeps the widget inside a work area smaller than the widget plus its gap', () => {
    const tiny = { x: -2_000, y: -1_000, width: 200, height: 90 } as const

    expect(
      placementToPosition({ edge: 'bottom', offset: 0.5 }, WIDGET, tiny, GAP),
    ).toEqual({ x: -2_000, y: -1_000 })
    expect(placementToPosition({ edge: 'right', offset: 0 }, WIDGET, tiny, GAP)).toEqual({
      x: -2_000,
      y: -1_000,
    })
  })
})

describe('snapToEdge', () => {
  it('snaps to the nearest edge measured from the widget bounds', () => {
    expect(snapToEdge({ x: 1_100, y: 300 }, WIDGET, WORK_AREA).edge).toBe('left')
    expect(snapToEdge({ x: 1_800, y: 300 }, WIDGET, WORK_AREA).edge).toBe('right')
    expect(snapToEdge({ x: 1_400, y: 150 }, WIDGET, WORK_AREA).edge).toBe('top')
    expect(snapToEdge({ x: 1_400, y: 850 }, WIDGET, WORK_AREA).edge).toBe('bottom')
  })

  it('preserves the fractional position along the snapped edge', () => {
    const placement = snapToEdge({ x: 1_100, y: 300 }, WIDGET, WORK_AREA)

    expect(placement.edge).toBe('left')
    expect(placement.offset).toBeCloseTo((300 - 100) / (900 - 88), 6)

    const horizontal = snapToEdge({ x: 1_476, y: 850 }, WIDGET, WORK_AREA)
    expect(horizontal.edge).toBe('bottom')
    expect(horizontal.offset).toBeCloseTo(0.5, 6)
  })

  it('clamps offsets for drag positions outside the work area', () => {
    const low = snapToEdge({ x: 700, y: 1_500 }, WIDGET, WORK_AREA)
    expect(low.edge).toBe('bottom')
    expect(low.offset).toBe(0)

    const high = snapToEdge({ x: 2_500, y: 1_500 }, WIDGET, WORK_AREA)
    expect(high.edge).toBe('bottom')
    expect(high.offset).toBe(1)
  })

  it('prefers the bottom edge when distances tie', () => {
    // Centered exactly: left/right tie and top/bottom tie.
    const centered = {
      x: WORK_AREA.x + (WORK_AREA.width - WIDGET.width) / 2,
      y: WORK_AREA.y + (WORK_AREA.height - WIDGET.height) / 2,
    }

    expect(snapToEdge(centered, WIDGET, WORK_AREA).edge).toBe('bottom')
  })

  it('is a fixed point once a position has been snapped', () => {
    for (const start of [
      { x: 1_030, y: 140 },
      { x: 1_900, y: 700 },
      { x: 1_555, y: 930 },
      { x: 1_002, y: 400 },
    ]) {
      const placement = snapToEdge(start, WIDGET, WORK_AREA)
      const snapped = placementToPosition(placement, WIDGET, WORK_AREA, GAP)
      const again = snapToEdge(snapped, WIDGET, WORK_AREA)

      expect(again.edge).toBe(placement.edge)
      expect(placementToPosition(again, WIDGET, WORK_AREA, GAP)).toEqual(snapped)
    }
  })

  it('centers the offset when the work area cannot fit the widget', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 40 } as const
    const placement = snapToEdge({ x: 10, y: 30 }, WIDGET, tiny)

    expect(placement.offset).toBe(0.5)
  })
})
