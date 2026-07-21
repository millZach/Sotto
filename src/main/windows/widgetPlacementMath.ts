import type { WidgetPresentation } from '../../shared/contracts'

/** Pure geometry for the floating widget's edge-centered presentation bounds. */

export type WidgetEdge = 'top' | 'bottom' | 'left' | 'right'

export interface WidgetPlacement {
  readonly edge: WidgetEdge
}

export interface WidgetPoint {
  readonly x: number
  readonly y: number
}

export interface WidgetSize {
  readonly width: number
  readonly height: number
}

export interface WidgetBounds extends WidgetPoint, WidgetSize {}

export interface WorkAreaRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const EXPECTED_WIDGET_SIZES = {
  'idle-resting': {
    horizontal: Object.freeze({ width: 124, height: 54 }),
    vertical: Object.freeze({ width: 54, height: 124 }),
  },
  'idle-hovered': {
    horizontal: Object.freeze({ width: 248, height: 76 }),
    vertical: Object.freeze({ width: 88, height: 124 }),
  },
  active: {
    horizontal: Object.freeze({ width: 248, height: 88 }),
    vertical: Object.freeze({ width: 88, height: 248 }),
  },
} as const

export const DEFAULT_WIDGET_PLACEMENT: WidgetPlacement = Object.freeze({
  edge: 'bottom',
})

function isVerticalEdge(edge: WidgetEdge): boolean {
  return edge === 'left' || edge === 'right'
}

export function widgetSizeForPresentation(
  edge: WidgetEdge,
  presentation: WidgetPresentation,
): WidgetSize {
  const orientation = isVerticalEdge(edge) ? 'vertical' : 'horizontal'
  return EXPECTED_WIDGET_SIZES[presentation][orientation]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

/** Chooses the nearest edge. Ties prefer bottom, top, left, then right. */
export function snapToEdge(
  position: WidgetPoint,
  workArea: WorkAreaRect,
): WidgetPlacement {
  const distances: Record<WidgetEdge, number> = {
    bottom:
      workArea.y +
      workArea.height -
      (position.y + widgetSizeForPresentation('bottom', 'active').height),
    top: position.y - workArea.y,
    left: position.x - workArea.x,
    right:
      workArea.x +
      workArea.width -
      (position.x + widgetSizeForPresentation('right', 'active').width),
  }

  const priority: readonly WidgetEdge[] = ['bottom', 'top', 'left', 'right']
  let edge: WidgetEdge = 'bottom'
  for (const candidate of priority) {
    if (distances[candidate] < distances[edge]) {
      edge = candidate
    }
  }

  return { edge }
}

export function placementToBounds(
  placement: WidgetPlacement,
  workArea: WorkAreaRect,
  presentation: WidgetPresentation,
  inset: number,
): WidgetBounds {
  const size = widgetSizeForPresentation(placement.edge, presentation)
  const centeredX = workArea.x + Math.round((workArea.width - size.width) / 2)
  const centeredY = workArea.y + Math.round((workArea.height - size.height) / 2)

  const point = (() => {
    switch (placement.edge) {
      case 'top':
        return { x: centeredX, y: workArea.y + inset }
      case 'bottom':
        return {
          x: centeredX,
          y: workArea.y + workArea.height - size.height - inset,
        }
      case 'left':
        return { x: workArea.x + inset, y: centeredY }
      case 'right':
        return {
          x: workArea.x + workArea.width - size.width - inset,
          y: centeredY,
        }
    }
  })()

  return {
    x: Math.round(clamp(point.x, workArea.x, workArea.x + workArea.width - size.width)),
    y: Math.round(clamp(point.y, workArea.y, workArea.y + workArea.height - size.height)),
    ...size,
  }
}
