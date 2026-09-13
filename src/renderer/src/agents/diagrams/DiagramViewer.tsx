import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'

export interface DiagramViewerProps {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  /** Accessible name of the drawing, e.g. "Sequence diagram: Login". */
  readonly name: string
  readonly description: string | null
  readonly copyFeedback: string | null
  readonly onCopy: () => void
  readonly onClose: () => void
}

interface View { scale: number; x: number; y: number; fitted: boolean }

const STEP = 1.25
const MAX_SCALE = 4
const PAN_STEP = 48
const MARGIN = 32

export function fitScale(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  if (!(width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0)) return 1
  // A small drawing is enlarged for inspection, but not so far that its strokes turn heavy.
  return Math.min((viewportWidth - MARGIN * 2) / width, (viewportHeight - MARGIN * 2) / height, 2)
}

export function clampScale(scale: number, fit: number): number {
  return Math.min(Math.max(scale, Math.min(fit, 1) / 2), Math.max(MAX_SCALE, fit))
}

/** Keeps at least a margin of the drawing inside the viewport, so panning never loses it. */
export function clampPan(view: View, width: number, height: number, viewportWidth: number, viewportHeight: number): View {
  const limitX = Math.max(0, (width * view.scale + viewportWidth) / 2 - MARGIN * 2)
  const limitY = Math.max(0, (height * view.scale + viewportHeight) / 2 - MARGIN * 2)
  return { ...view, x: Math.min(limitX, Math.max(-limitX, view.x)), y: Math.min(limitY, Math.max(-limitY, view.y)) }
}

/** The expanded drawing: zoom, pan, copy source and close, all from the keyboard or pointer. */
export function DiagramViewer({ dataUrl, width, height, name, description, copyFeedback, onCopy, onClose }: DiagramViewerProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number } | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fitted: true })
  const [dragging, setDragging] = useState(false)
  const [settled, setSettled] = useState(false)
  const titleId = useId()
  const hintId = useId()
  const descriptionId = useId()
  const fit = fitScale(width, height, size.width, size.height)

  // Opened before the viewport is measured, so the first painted frame is already fitted.
  useLayoutEffect(() => {
    const element = dialog.current
    if (element?.showModal && !element.open) element.showModal()
    else element?.setAttribute('open', '')
    viewport.current?.focus({ preventScroll: true })
    return () => { element?.close?.() }
  }, [])

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

  // While the user has not zoomed or moved it, the drawing follows the window size.
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
  const reset = (): void => setView({ scale: fit, x: 0, y: 0, fitted: true })

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
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
    if (!action) return
    event.preventDefault()
    action()
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

  const percent = `${Math.round(view.scale * 100)}%`
  return <dialog ref={dialog} className="rich-diagram-viewer" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={onKeyDown}>
    <header className="rich-diagram-viewer__bar">
      <h2 id={titleId} className="rich-diagram-viewer__title">{name}</h2>
      <span className="rich-code__status" role="status" aria-live="polite">{copyFeedback}</span>
      <div className="rich-diagram-viewer__controls">
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Zoom out" title="Zoom out (−)" aria-disabled={view.scale <= clampScale(0, fit) + 1e-6} onClick={() => zoomTo(scale => scale / STEP)}><ZoomOut size={16} aria-hidden="true" /></button>
        <output className="rich-diagram-viewer__zoom" aria-label="Zoom">{percent}</output>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Zoom in" title="Zoom in (+)" aria-disabled={view.scale >= clampScale(Infinity, fit) - 1e-6} onClick={() => zoomTo(scale => scale * STEP)}><ZoomIn size={16} aria-hidden="true" /></button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Fit to window" title="Fit (0)" aria-pressed={view.fitted} onClick={reset}><Scan size={16} aria-hidden="true" /></button>
        <span className="rich-diagram-viewer__divider" aria-hidden="true" />
        <button type="button" className="rich-code__copy tt-focusable" data-copied={copyFeedback === 'Copied' || undefined} aria-label="Copy diagram source" title="Copy source" onClick={onCopy}>
          {copyFeedback === 'Copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Close diagram" title="Close (Esc)" onClick={onClose}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div ref={viewport} className="rich-diagram-viewer__viewport" tabIndex={0} role="group" aria-label="Diagram view" aria-describedby={hintId}
      data-dragging={dragging || undefined} data-settled={settled || undefined}
      onPointerDown={event => {
        if (event.button !== 0) return
        drag.current = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={event => {
        const active = drag.current
        if (!active || active.pointer !== event.pointerId) return
        setView(current => clampPan({ ...current, x: active.x + event.clientX - active.startX, y: active.y + event.clientY - active.startY, fitted: false }, width, height, size.width, size.height))
      }}
      onPointerUp={() => { drag.current = null; setDragging(false) }}
      onPointerCancel={() => { drag.current = null; setDragging(false) }}
      onDoubleClick={event => zoomTo(scale => scale * STEP * STEP, pointerFocus(event.clientX, event.clientY))}>
      <img className="rich-diagram-viewer__image" src={dataUrl} alt={name} draggable={false}
        width={Math.round(width * view.scale)} height={Math.round(height * view.scale)}
        style={{ transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` }} />
      {description && <p id={descriptionId} className="tt-visually-hidden">{description}</p>}
    </div>
    <p id={hintId} className="rich-diagram-viewer__hint">Drag or use arrow keys to move · Scroll or +/− to zoom · 0 to fit</p>
  </dialog>
}
