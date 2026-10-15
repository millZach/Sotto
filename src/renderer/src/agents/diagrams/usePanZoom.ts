import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

export interface View { scale: number; x: number; y: number; fitted: boolean }

const STEP = 1.25
const MAX_SCALE = 4
const PAN_STEP = 48
const MARGIN = 32

/** The scale that fits the picture in the viewport, enlarging a small one no further than `largest`. */
export function fitScale(width: number, height: number, viewportWidth: number, viewportHeight: number, largest = 2): number {
  if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return 1
  return Math.min((viewportWidth - MARGIN * 2) / width, (viewportHeight - MARGIN * 2) / height, largest)
}

export function clampScale(scale: number, fit: number): number {
  return Math.min(Math.max(scale, Math.min(fit, 1) / 2), Math.max(MAX_SCALE, fit))
}

/** Keeps at least a margin of the picture inside the viewport, so panning never loses it. */
export function clampPan(view: View, width: number, height: number, viewportWidth: number, viewportHeight: number): View {
  const limitX = Math.max(0, (width * view.scale + viewportWidth) / 2 - MARGIN * 2)
  const limitY = Math.max(0, (height * view.scale + viewportHeight) / 2 - MARGIN * 2)
  return { ...view, x: Math.min(limitX, Math.max(-limitX, view.x)), y: Math.min(limitY, Math.max(-limitY, view.y)) }
}

export interface PanZoom {
  readonly viewport: RefObject<HTMLDivElement | null>
  readonly view: View
  readonly percent: string
  readonly atSmallest: boolean
  readonly atLargest: boolean
  readonly zoomIn: () => void
  readonly zoomOut: () => void
  readonly reset: () => void
  /** +, −, 0 anywhere in the viewer; the arrow keys move the picture while the viewport has focus. True when handled. */
  readonly onKeyDown: (event: React.KeyboardEvent) => boolean
  readonly viewportProps: {
    readonly 'data-dragging': true | undefined
    readonly 'data-settled': true | undefined
    readonly onPointerDown: (event: React.PointerEvent) => void
    readonly onPointerMove: (event: React.PointerEvent) => void
    readonly onPointerUp: () => void
    readonly onPointerCancel: () => void
    readonly onDoubleClick: (event: React.MouseEvent) => void
  }
  /** Size and offset of the picture, centred in the viewport. */
  readonly pictureStyle: { readonly width: number; readonly height: number; readonly style: CSSProperties }
}

/**
 * Zoom and pan for an expanded picture of `width` by `height`: by wheel about the pointer, by double-click, by
 * dragging and from the keyboard. While the user has not zoomed or moved it, the picture follows the viewport's size.
 */
export function usePanZoom(width: number, height: number, largestFit = 2): PanZoom {
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true })
  const [dragging, setDragging] = useState(false)
  const [settled, setSettled] = useState(false)
  const fit = fitScale(width, height, size.width, size.height, largestFit)

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = (): void => setSize(current => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => { setView(current => current.fitted ? { scale: fit, x: 0, y: 0, fitted: true } : clampPan(current, width, height, size.width, size.height)) }, [fit, width, height, size.width, size.height])

  const zoomTo = useCallback((next: (scale: number) => number, focus = { x: 0, y: 0 }) => {
    setView(current => {
      const scale = clampScale(next(current.scale), fit)
      const ratio = scale / current.scale
      // Zoom about the pointer (or the centre): the point under it stays put.
      const zoomed = { scale, x: focus.x - (focus.x - current.x) * ratio, y: focus.y - (focus.y - current.y) * ratio, fitted: false }
      return clampPan(zoomed, width, height, size.width, size.height)
    })
  }, [fit, width, height, size.width, size.height])
  const panBy = (dx: number, dy: number): void => setView(current => clampPan({ ...current, x: current.x + dx, y: current.y + dy, fitted: false }, width, height, size.width, size.height))
  const reset = useCallback((): void => setView({ scale: fit, x: 0, y: 0, fitted: true }), [fit])

  const onKeyDown = (event: React.KeyboardEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    const onViewport = event.target === viewport.current
    const step = event.shiftKey ? PAN_STEP * 4 : PAN_STEP
    const keys: Record<string, (() => void) | undefined> = {
      '+': () => zoomTo(scale => scale * STEP), '=': () => zoomTo(scale => scale * STEP),
      '-': () => zoomTo(scale => scale / STEP),
      '0': reset,
      ArrowLeft: onViewport ? () => panBy(step, 0) : undefined,
      ArrowRight: onViewport ? () => panBy(-step, 0) : undefined,
      ArrowUp: onViewport ? () => panBy(0, step) : undefined,
      ArrowDown: onViewport ? () => panBy(0, -step) : undefined,
    }
    const action = keys[event.key]
    if (!action) return false
    event.preventDefault()
    action()
    return true
  }

  const pointerFocus = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = viewport.current!.getBoundingClientRect()
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
  }

  // Size changes animate only after the first fitted frame has painted.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // React registers wheel listeners as passive; the viewer needs the wheel for itself.
  const wheelZoom = useRef(zoomTo)
  wheelZoom.current = zoomTo
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const focus = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
      wheelZoom.current(scale => scale * Math.exp(-event.deltaY * 0.0015), focus)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  return {
    viewport, view,
    percent: `${Math.round(view.scale * 100)}%`,
    atSmallest: view.scale <= clampScale(0, fit) + 1e-6,
    atLargest: view.scale >= clampScale(Infinity, fit) - 1e-6,
    zoomIn: () => zoomTo(scale => scale * STEP),
    zoomOut: () => zoomTo(scale => scale / STEP),
    reset,
    onKeyDown,
    viewportProps: {
      'data-dragging': dragging || undefined,
      'data-settled': settled || undefined,
      onPointerDown: event => {
        if (event.button !== 0) return
        drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      },
      onPointerMove: event => {
        const active = drag.current
        if (!active || active.pointer !== event.pointerId) return
        setView(current => clampPan({ ...current, x: active.x + event.clientX - active.startX, y: active.y + event.clientY - active.startY, fitted: false }, width, height, size.width, size.height))
      },
      onPointerUp: () => { drag.current = null; setDragging(false) },
      onPointerCancel: () => { drag.current = null; setDragging(false) },
      onDoubleClick: event => zoomTo(scale => scale * STEP * STEP, pointerFocus(event.clientX, event.clientY)),
    },
    pictureStyle: {
      width: Math.round(width * view.scale), height: Math.round(height * view.scale),
      style: { transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` },
    },
  }
}
