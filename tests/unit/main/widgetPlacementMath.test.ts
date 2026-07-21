import { describe, expect, it } from 'vitest'

import type { WidgetPresentation } from '../../../src/shared/contracts'
import {
  DEFAULT_WIDGET_PLACEMENT,
  placementToBounds,
  snapToEdge,
  widgetSizeForPresentation,
  type WidgetEdge,
  type WidgetPlacement,
} from '../../../src/main/windows/widgetPlacementMath'

const WORK_AREA = { x: 1_000, y: 100, width: 1_200, height: 900 } as const
const INSET = 16

const EXPECTED_SIZES = {
  'idle-resting': {
    horizontal: { width: 124, height: 54 },
    vertical: { width: 54, height: 124 },
  },
  'idle-hovered': {
    horizontal: { width: 248, height: 76 },
    vertical: { width: 88, height: 124 },
  },
  active: {
    horizontal: { width: 248, height: 88 },
    vertical: { width: 88, height: 248 },
  },
} as const

const EDGES: readonly WidgetEdge[] = ['top', 'bottom', 'left', 'right']
const PRESENTATIONS: readonly WidgetPresentation[] = [
  'idle-resting',
  'idle-hovered',
  'active',
]

describe('widget presentation geometry', () => {
  it('returns the approved native footprint for every edge and presentation', () => {
    for (const presentation of PRESENTATIONS) {
      for (const edge of EDGES) {
        const orientation = edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal'
        expect(widgetSizeForPresentation(edge, presentation)).toEqual(
          EXPECTED_SIZES[presentation][orientation],
        )
      }
    }
  })

  it('centers every presentation 16 DIPs inside all four work-area edges', () => {
    const expectedBounds: Record<WidgetPresentation, Record<WidgetEdge, object>> = {
      'idle-resting': {
        top: { x: 1_538, y: 116, width: 124, height: 54 },
        bottom: { x: 1_538, y: 930, width: 124, height: 54 },
        left: { x: 1_016, y: 488, width: 54, height: 124 },
        right: { x: 2_130, y: 488, width: 54, height: 124 },
      },
      'idle-hovered': {
        top: { x: 1_476, y: 116, width: 248, height: 76 },
        bottom: { x: 1_476, y: 908, width: 248, height: 76 },
        left: { x: 1_016, y: 488, width: 88, height: 124 },
        right: { x: 2_096, y: 488, width: 88, height: 124 },
      },
      active: {
        top: { x: 1_476, y: 116, width: 248, height: 88 },
        bottom: { x: 1_476, y: 896, width: 248, height: 88 },
        left: { x: 1_016, y: 426, width: 88, height: 248 },
        right: { x: 2_096, y: 426, width: 88, height: 248 },
      },
    }

    for (const presentation of PRESENTATIONS) {
      for (const edge of EDGES) {
        expect(placementToBounds({ edge }, WORK_AREA, presentation, INSET)).toEqual(
          expectedBounds[presentation][edge],
        )
      }
    }
  })

  it('centers correctly in negative-coordinate work areas', () => {
    const negativeArea = { x: -1_920, y: -1_080, width: 1_920, height: 1_040 } as const

    expect(
      placementToBounds({ edge: 'top' }, negativeArea, 'idle-hovered', INSET),
    ).toEqual({ x: -1_084, y: -1_064, width: 248, height: 76 })
    expect(placementToBounds({ edge: 'right' }, negativeArea, 'active', INSET)).toEqual({
      x: -104,
      y: -684,
      width: 88,
      height: 248,
    })
  })

  it('clamps when the work area is smaller than the presentation', () => {
    const tinyArea = { x: -2_000, y: -1_000, width: 40, height: 30 } as const

    for (const presentation of PRESENTATIONS) {
      for (const edge of EDGES) {
        expect(placementToBounds({ edge }, tinyArea, presentation, INSET)).toEqual({
          x: tinyArea.x,
          y: tinyArea.y,
          ...widgetSizeForPresentation(edge, presentation),
        })
      }
    }
  })

  it('chooses the nearest edge with bottom top left right tie priority', () => {
    const square = { x: 0, y: 0, width: 1_000, height: 1_000 } as const
    expect(snapToEdge({ x: 456, y: 456 }, square)).toEqual({ edge: 'bottom' })
    expect(snapToEdge({ x: 100, y: 100 }, square)).toEqual({ edge: 'top' })

    const tall = { x: 0, y: 0, width: 500, height: 1_000 } as const
    expect(snapToEdge({ x: 206, y: 400 }, tall)).toEqual({ edge: 'left' })
    expect(snapToEdge({ x: 400, y: 400 }, tall)).toEqual({ edge: 'right' })
  })

  it('returns only an edge and never an offset', () => {
    const placement: WidgetPlacement = snapToEdge({ x: 1_100, y: 300 }, WORK_AREA)

    expect(placement).toEqual({ edge: 'left' })
    expect(Object.keys(placement)).toEqual(['edge'])
    expect(DEFAULT_WIDGET_PLACEMENT).toEqual({ edge: 'bottom' })
  })
})
