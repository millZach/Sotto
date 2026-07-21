import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WIDGET_PLACEMENT,
  HORIZONTAL_WIDGET_SIZE,
  VERTICAL_WIDGET_SIZE,
  placementToPosition,
  snapToEdge,
  widgetSizeForEdge,
  type WidgetEdge,
} from '../../../src/main/windows/widgetPlacementMath'

const WORK_AREA = { x: 1_000, y: 100, width: 1_200, height: 900 } as const
const GAP = 16

describe('widgetSizeForEdge', () => {
  it('keeps the horizontal canvas on the top and bottom edges', () => {
    expect(widgetSizeForEdge('bottom')).toEqual({ width: 248, height: 88 })
    expect(widgetSizeForEdge('top')).toEqual({ width: 248, height: 88 })
    expect(widgetSizeForEdge('bottom')).toBe(HORIZONTAL_WIDGET_SIZE)
  })

  it('swaps to the vertical canvas on the left and right edges', () => {
    expect(widgetSizeForEdge('left')).toEqual({ width: 88, height: 248 })
    expect(widgetSizeForEdge('right')).toEqual({ width: 88, height: 248 })
    expect(widgetSizeForEdge('right')).toBe(VERTICAL_WIDGET_SIZE)
  })
})

describe('placementToPosition', () => {
  it('centers the default bottom placement above the bottom gap', () => {
    expect(placementToPosition(DEFAULT_WIDGET_PLACEMENT, WORK_AREA, GAP)).toEqual({
      x: 1_476,
      y: 896,
    })
  })

  it('anchors each edge a gap away using that edge orientation size', () => {
    expect(placementToPosition({ edge: 'bottom', offset: 0 }, WORK_AREA, GAP)).toEqual({
      x: 1_000,
      y: 896,
    })
    expect(placementToPosition({ edge: 'top', offset: 1 }, WORK_AREA, GAP)).toEqual({
      x: 1_952,
      y: 116,
    })
    // Side edges use the 88x248 vertical canvas: the offset travels the
    // 900 - 248 = 652px vertical range.
    expect(placementToPosition({ edge: 'left', offset: 0.5 }, WORK_AREA, GAP)).toEqual({
      x: 1_016,
      y: 426,
    })
    expect(placementToPosition({ edge: 'right', offset: 1 }, WORK_AREA, GAP)).toEqual({
      x: 2_096,
      y: 752,
    })
  })

  it('clamps out-of-range and non-finite offsets so the widget stays fully on screen', () => {
    expect(placementToPosition({ edge: 'bottom', offset: 4.2 }, WORK_AREA, GAP)).toEqual({
      x: 1_952,
      y: 896,
    })
    expect(placementToPosition({ edge: 'bottom', offset: -1 }, WORK_AREA, GAP)).toEqual({
      x: 1_000,
      y: 896,
    })
    expect(
      placementToPosition({ edge: 'left', offset: Number.NaN }, WORK_AREA, GAP),
    ).toEqual({ x: 1_016, y: 426 })
  })

  it('keeps the widget inside a work area smaller than the widget plus its gap', () => {
    const tiny = { x: -2_000, y: -1_000, width: 200, height: 90 } as const

    expect(placementToPosition({ edge: 'bottom', offset: 0.5 }, tiny, GAP)).toEqual({
      x: -2_000,
      y: -1_000,
    })
    // The 88-wide vertical canvas fits the 200-wide area a gap from the
    // right edge; the 248-tall height cannot fit and clamps to the top.
    expect(placementToPosition({ edge: 'right', offset: 0 }, tiny, GAP)).toEqual({
      x: -1_904,
      y: -1_000,
    })
  })
})

describe('snapToEdge', () => {
  it('snaps to the nearest edge measured with that edge orientation size', () => {
    expect(snapToEdge({ x: 1_100, y: 300 }, WORK_AREA).edge).toBe('left')
    expect(snapToEdge({ x: 2_000, y: 300 }, WORK_AREA).edge).toBe('right')
    expect(snapToEdge({ x: 1_400, y: 150 }, WORK_AREA).edge).toBe('top')
    expect(snapToEdge({ x: 1_400, y: 850 }, WORK_AREA).edge).toBe('bottom')
  })

  it('measures each candidate edge with the size the widget would have there', () => {
    // In a 1000x1000 area at (700, 100) the naive horizontal 248-wide widget
    // would be 52px from the right edge and snap right; the widget is 88 wide
    // on that edge, so the true distance is 212px and the top edge (100px)
    // wins instead.
    const area = { x: 0, y: 0, width: 1_000, height: 1_000 } as const

    expect(snapToEdge({ x: 700, y: 100 }, area).edge).toBe('top')
    expect(snapToEdge({ x: 700, y: 480 }, area).edge).toBe('right')
  })

  it('preserves the fractional position along the snapped edge', () => {
    const placement = snapToEdge({ x: 1_100, y: 300 }, WORK_AREA)

    expect(placement.edge).toBe('left')
    expect(placement.offset).toBeCloseTo((300 - 100) / (900 - 248), 6)

    const horizontal = snapToEdge({ x: 1_476, y: 850 }, WORK_AREA)
    expect(horizontal.edge).toBe('bottom')
    expect(horizontal.offset).toBeCloseTo(0.5, 6)
  })

  it('clamps offsets for drag positions outside the work area', () => {
    const low = snapToEdge({ x: 700, y: 1_500 }, WORK_AREA)
    expect(low.edge).toBe('bottom')
    expect(low.offset).toBe(0)

    const high = snapToEdge({ x: 2_500, y: 1_500 }, WORK_AREA)
    expect(high.edge).toBe('bottom')
    expect(high.offset).toBe(1)
  })

  it('prefers the bottom edge when distances tie', () => {
    // Centered exactly for the horizontal canvas: top and bottom tie.
    const centered = {
      x: WORK_AREA.x + (WORK_AREA.width - 248) / 2,
      y: WORK_AREA.y + (WORK_AREA.height - 88) / 2,
    }

    expect(snapToEdge(centered, WORK_AREA).edge).toBe('bottom')
  })

  it('is a fixed point once a position has been snapped, for every edge', () => {
    const starts: Record<WidgetEdge, { x: number; y: number }> = {
      top: { x: 1_400, y: 150 },
      bottom: { x: 1_555, y: 930 },
      left: { x: 1_030, y: 400 },
      right: { x: 2_050, y: 400 },
    }

    for (const [edge, start] of Object.entries(starts) as ReadonlyArray<
      [WidgetEdge, { x: number; y: number }]
    >) {
      const placement = snapToEdge(start, WORK_AREA)
      expect(placement.edge).toBe(edge)

      const snapped = placementToPosition(placement, WORK_AREA, GAP)
      const again = snapToEdge(snapped, WORK_AREA)

      expect(again.edge).toBe(placement.edge)
      expect(placementToPosition(again, WORK_AREA, GAP)).toEqual(snapped)
    }
  })

  it('centers the offset when the work area cannot fit the widget', () => {
    const tiny = { x: 0, y: 0, width: 100, height: 40 } as const
    const placement = snapToEdge({ x: 10, y: 30 }, tiny)

    expect(placement.offset).toBe(0.5)
  })
})
