import {
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
} from 'react'

import type { WidgetDragPayload } from '../../../shared/contracts'

const DRAG_THRESHOLD_PX = 4

interface ActiveGesture {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly captureTarget: HTMLElement
  dragging: boolean
  movePending: boolean
  frameId: number | null
}

interface TemporaryListeners {
  readonly move: (event: PointerEvent) => void
  readonly up: (event: PointerEvent) => void
  readonly cancel: (event: PointerEvent) => void
}

export interface WidgetDragGesture {
  readonly dragging: boolean
  readonly isDragActive: () => boolean
  readonly surfaceProps: {
    readonly onPointerDown: PointerEventHandler<HTMLElement>
    readonly onPointerMove: PointerEventHandler<HTMLElement>
    readonly onPointerUp: PointerEventHandler<HTMLElement>
    readonly onPointerCancel: PointerEventHandler<HTMLElement>
    readonly onLostPointerCapture: PointerEventHandler<HTMLElement>
    readonly onClick: MouseEventHandler<HTMLElement>
  }
}

export function useWidgetDragGesture(
  onClick: (() => void) | undefined,
  onDrag: ((payload: WidgetDragPayload) => void) | undefined,
  onDragFinished?: (() => void) | undefined,
): WidgetDragGesture {
  const activeRef = useRef<ActiveGesture | null>(null)
  const listenersRef = useRef<TemporaryListeners | null>(null)
  const suppressClickRef = useRef(false)
  const onClickRef = useRef(onClick)
  const onDragRef = useRef(onDrag)
  const onDragFinishedRef = useRef(onDragFinished)
  const [dragging, setDragging] = useState(false)

  onClickRef.current = onClick
  onDragRef.current = onDrag
  onDragFinishedRef.current = onDragFinished

  const removeTemporaryListeners = (): void => {
    const listeners = listenersRef.current
    if (listeners === null) return
    listenersRef.current = null
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.cancel)
  }

  const queueMove = (): void => {
    const active = activeRef.current
    if (active === null || active.movePending) return
    active.movePending = true
    active.frameId = window.requestAnimationFrame(() => {
      const current = activeRef.current
      if (current === null || !current.movePending) return
      current.movePending = false
      current.frameId = null
      onDragRef.current?.({ phase: 'move' })
    })
  }

  const finish = (pointerId?: number): void => {
    const active = activeRef.current
    if (active === null || (pointerId !== undefined && pointerId !== active.pointerId)) return

    activeRef.current = null
    if (active.frameId !== null) window.cancelAnimationFrame(active.frameId)
    let firstError: unknown
    let hasError = false
    const dispatch = (callback: () => void): void => {
      try {
        callback()
      } catch (error) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
      }
    }
    try {
      if (active.movePending) dispatch(() => onDragRef.current?.({ phase: 'move' }))
      if (active.dragging) {
        dispatch(() => onDragRef.current?.({ phase: 'end' }))
        dispatch(() => onDragFinishedRef.current?.())
      }
    } finally {
      removeTemporaryListeners()
      try {
        active.captureTarget.releasePointerCapture?.(active.pointerId)
      } catch {
        // Releasing capture is best effort after every terminal path.
      }
      if (active.dragging) setDragging(false)
    }
    if (hasError) throw firstError
  }

  const finishCompletedPointer = (pointerId: number): void => {
    const active = activeRef.current
    if (active !== null && active.pointerId === pointerId && active.dragging) {
      suppressClickRef.current = true
    }
    finish(pointerId)
  }

  const handlePointerMove = (event: Pick<PointerEvent, 'pointerId' | 'screenX' | 'screenY'>): void => {
    const active = activeRef.current
    if (active === null || event.pointerId !== active.pointerId) return
    if (!active.dragging) {
      const movementX = event.screenX - active.startX
      const movementY = event.screenY - active.startY
      if (Math.hypot(movementX, movementY) <= DRAG_THRESHOLD_PX) return
      active.dragging = true
      setDragging(true)
      onDragRef.current?.({ phase: 'start' })
    }
    queueMove()
  }

  const installTemporaryListeners = (): void => {
    const listeners: TemporaryListeners = {
      move: (event) => handlePointerMove(event),
      up: (event) => finishCompletedPointer(event.pointerId),
      cancel: (event) => finish(event.pointerId),
    }
    listenersRef.current = listeners
    window.addEventListener('pointermove', listeners.move)
    window.addEventListener('pointerup', listeners.up)
    window.addEventListener('pointercancel', listeners.cancel)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || activeRef.current !== null) return
    suppressClickRef.current = false
    activeRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      captureTarget: event.currentTarget,
      dragging: false,
      movePending: false,
      frameId: null,
    }
    installTemporaryListeners()
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Window listeners keep the gesture recoverable when capture is unavailable.
    }
  }

  useEffect(() => {
    const onBlur = (): void => finish()
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') finish()
    }
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      finish()
    }
  }, [])

  return {
    dragging,
    isDragActive: () => activeRef.current?.dragging === true,
    surfaceProps: {
      onPointerDown,
      onPointerMove: (event) => handlePointerMove(event),
      onPointerUp: (event) => finishCompletedPointer(event.pointerId),
      onPointerCancel: (event) => finish(event.pointerId),
      onLostPointerCapture: (event) => finish(event.pointerId),
      onClick: () => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onClickRef.current?.()
      },
    },
  }
}
