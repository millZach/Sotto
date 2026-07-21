/**
 * Pure geometry for the floating widget's edge-snapped placement. A placement
 * is an edge plus a fractional offset along that edge, so the same remembered
 * spot can be re-applied to whichever display a dictation session uses.
 */

export type WidgetEdge = 'top' | 'bottom' | 'left' | 'right'

export interface EdgePlacement {
  readonly edge: WidgetEdge
  readonly offset: number
}

export interface WidgetPoint {
  readonly x: number
  readonly y: number
}

export interface WidgetSize {
  readonly width: number
  readonly height: number
}

export interface WorkAreaRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const DEFAULT_WIDGET_PLACEMENT: EdgePlacement = Object.freeze({
  edge: 'bottom',
  offset: 0.5,
})

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function clampOffset(offset: number): number {
  return Number.isFinite(offset) ? clamp(offset, 0, 1) : 0.5
}

function alongEdgeOffset(position: number, origin: number, usable: number): number {
  if (usable <= 0) {
    return 0.5
  }
  return clampOffset((position - origin) / usable)
}

/**
 * Chooses the screen edge nearest to a drag-end position and the fractional
 * offset along that edge. Ties prefer the bottom edge, then top, left, right.
 */
export function snapToEdge(
  position: WidgetPoint,
  widgetSize: WidgetSize,
  workArea: WorkAreaRect,
): EdgePlacement {
  const distances: Record<WidgetEdge, number> = {
    bottom: workArea.y + workArea.height - (position.y + widgetSize.height),
    top: position.y - workArea.y,
    left: position.x - workArea.x,
    right: workArea.x + workArea.width - (position.x + widgetSize.width),
  }

  const priority: readonly WidgetEdge[] = ['bottom', 'top', 'left', 'right']
  let edge: WidgetEdge = 'bottom'
  for (const candidate of priority) {
    if (distances[candidate] < distances[edge]) {
      edge = candidate
    }
  }

  const offset =
    edge === 'top' || edge === 'bottom'
      ? alongEdgeOffset(position.x, workArea.x, workArea.width - widgetSize.width)
      : alongEdgeOffset(position.y, workArea.y, workArea.height - widgetSize.height)

  return { edge, offset }
}

/**
 * Resolves a placement to concrete window coordinates inside a work area,
 * keeping the widget a `gap` away from its snapped edge and fully on screen.
 */
export function placementToPosition(
  placement: EdgePlacement,
  widgetSize: WidgetSize,
  workArea: WorkAreaRect,
  gap: number,
): WidgetPoint {
  const offset = clampOffset(placement.offset)
  const usableX = workArea.width - widgetSize.width
  const usableY = workArea.height - widgetSize.height

  let x: number
  let y: number
  switch (placement.edge) {
    case 'bottom':
      x = workArea.x + Math.round(offset * Math.max(0, usableX))
      y = workArea.y + workArea.height - widgetSize.height - gap
      break
    case 'top':
      x = workArea.x + Math.round(offset * Math.max(0, usableX))
      y = workArea.y + gap
      break
    case 'left':
      x = workArea.x + gap
      y = workArea.y + Math.round(offset * Math.max(0, usableY))
      break
    case 'right':
      x = workArea.x + workArea.width - widgetSize.width - gap
      y = workArea.y + Math.round(offset * Math.max(0, usableY))
      break
  }

  return {
    x: Math.round(clamp(x, workArea.x, workArea.x + usableX)),
    y: Math.round(clamp(y, workArea.y, workArea.y + usableY)),
  }
}
