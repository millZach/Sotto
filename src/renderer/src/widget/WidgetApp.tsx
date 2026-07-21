import {
  AlertCircle,
  Check,
  CircleEllipsis,
  Mic,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react'
import {
  default as React,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type { TalkTypeWidgetBridge, WidgetDragPayload } from '../../../shared/contracts'
import { formatWindowsAccelerator } from '../../../shared/accelerator'
import type {
  WidgetErrorCode,
  WidgetProcessingStage,
  WidgetSnapshot,
} from '../../../shared/dictation'

const BAR_SHAPE = [0.28, 0.48, 0.72, 0.92, 0.62, 0.42, 0.78, 1, 0.68, 0.5, 0.82, 0.34]
const PREVIEW_NOW = 13_340

const processingLabels: Record<WidgetProcessingStage, string> = {
  'preparing-audio': 'Preparing audio',
  'loading-model': 'Loading local model',
  transcribing: 'Transcribing locally',
  'delivering-output': 'Delivering text',
}

const errorCopy: Record<WidgetErrorCode, { readonly title: string; readonly detail: string }> = {
  MIC_PERMISSION_DENIED: {
    title: 'Microphone blocked',
    detail: 'Allow microphone access in Windows Settings.',
  },
  MIC_DEVICE_NOT_FOUND: {
    title: 'No microphone found',
    detail: 'Connect a microphone and try again.',
  },
  MIC_START_FAILED: {
    title: 'Microphone unavailable',
    detail: 'Check the selected microphone and try again.',
  },
  RECORDING_FAILED: {
    title: 'Recording stopped',
    detail: 'Check your microphone and try again.',
  },
  NO_SPEECH: {
    title: 'No speech detected',
    detail: 'Speak closer to the microphone and try again.',
  },
  TRANSCRIPTION_FAILED: {
    title: 'Couldn’t transcribe',
    detail: 'Try again or choose the Balanced model.',
  },
  OUTPUT_UNAVAILABLE: {
    title: 'Output unavailable',
    detail: 'Open TalkType and try again.',
  },
  OUTPUT_FAILED: {
    title: 'Couldn’t copy text',
    detail: 'Try again from the TalkType app.',
  },
  HISTORY_FAILED: {
    title: 'Saved to clipboard',
    detail: 'Local history was not updated.',
  },
  SETTINGS_UNAVAILABLE: {
    title: 'Settings unavailable',
    detail: 'Open TalkType to restore settings.',
  },
}

interface WidgetCopy {
  readonly tone: 'idle' | 'permission' | 'listening' | 'processing' | 'success' | 'cancelled' | 'error'
  readonly title: string
  readonly detail: string
  readonly icon: ReactNode
}

function WidgetAnnouncements({ snapshot }: { readonly snapshot: WidgetSnapshot | null }): ReactNode {
  const copy = snapshot === null || snapshot.status === 'idle' ? null : getCopy(snapshot)
  const assertiveCopy = snapshot?.status === 'error' ? copy : null
  const politeCopy = snapshot?.status === 'error' ? null : copy

  return (
    <>
      <div
        className="widget-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-announcement-channel="polite"
      >
        {politeCopy === null ? null : <><span>{politeCopy.title}.</span>{' '}<span>{politeCopy.detail}</span></>}
      </div>
      <div
        className="widget-live-region"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-announcement-channel="assertive"
      >
        {assertiveCopy === null ? null : <><span>{assertiveCopy.title}.</span>{' '}<span>{assertiveCopy.detail}</span></>}
      </div>
    </>
  )
}

export interface WidgetAppProps {
  readonly snapshot: WidgetSnapshot
  readonly now: number
  readonly onToggle?: () => void
  readonly onStop?: () => void
  readonly onCancel?: () => void
  readonly onSliverHover?: (hovering: boolean) => void
  readonly onDrag?: (payload: WidgetDragPayload) => void
}

export function formatElapsedTime(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return '00:00'
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  const minutes = Math.min(99, Math.floor(totalSeconds / 60))
  const seconds = minutes === 99 ? Math.min(59, totalSeconds - minutes * 60) : totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
}

function getCopy(snapshot: WidgetSnapshot): WidgetCopy {
  switch (snapshot.status) {
    case 'idle':
      return {
        tone: 'idle', title: 'Ready', detail: formatWindowsAccelerator(snapshot.shortcut),
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'requesting-permission':
      return {
        tone: 'permission', title: 'Waiting for microphone', detail: 'Approve access in Windows',
        icon: <ShieldAlert aria-hidden="true" size={22} strokeWidth={2.1} />,
      }
    case 'listening':
      return {
        tone: 'listening', title: 'Listening', detail: `${formatWindowsAccelerator(snapshot.shortcut)} to finish`,
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'processing':
      return {
        tone: 'processing', title: processingLabels[snapshot.stage], detail: 'Audio stays on this PC',
        icon: <CircleEllipsis aria-hidden="true" size={23} strokeWidth={2.1} />,
      }
    case 'success':
      return {
        tone: 'success',
        title: snapshot.output === 'pasted' ? 'Pasted' : 'Copied — paste manually',
        detail: snapshot.output === 'pasted' ? 'Text delivered' : 'Clipboard is ready',
        icon: <Check aria-hidden="true" size={23} strokeWidth={2.4} />,
      }
    case 'cancelled':
      return {
        tone: 'cancelled', title: 'Cancelled', detail: 'Nothing was copied',
        icon: <X aria-hidden="true" size={23} strokeWidth={2.2} />,
      }
    case 'error': {
      const copy = errorCopy[snapshot.code]
      return {
        tone: 'error', title: copy.title, detail: copy.detail,
        icon: <AlertCircle aria-hidden="true" size={23} strokeWidth={2.2} />,
      }
    }
  }
}

function preventFocus(event: ReactMouseEvent<HTMLElement>): void {
  event.preventDefault()
}

export type WidgetOrientation = 'horizontal' | 'vertical'

function readWidgetOrientation(): WidgetOrientation {
  return window.innerHeight > window.innerWidth ? 'vertical' : 'horizontal'
}

/**
 * The widget window is 248x88 on horizontal edges and 88x248 on vertical
 * edges, so the canvas proportions alone identify the orientation; a resize
 * listener follows the main process swapping the window between them.
 */
function useWidgetOrientation(): WidgetOrientation {
  const [orientation, setOrientation] = useState<WidgetOrientation>(readWidgetOrientation)

  useEffect(() => {
    const update = (): void => setOrientation(readWidgetOrientation())
    window.addEventListener('resize', update)
    update()
    return () => window.removeEventListener('resize', update)
  }, [])

  return orientation
}

function stopPointerPropagation(event: ReactPointerEvent<HTMLElement>): void {
  // Button presses must never start a widget drag session.
  event.stopPropagation()
}

/** Movement past this many screen pixels turns a press into a drag. */
const DRAG_THRESHOLD_PX = 4

interface DragTracking {
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
}

interface DragOrClickSurface {
  readonly dragging: boolean
  readonly isDragActive: () => boolean
  readonly surfaceProps: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
    readonly onClick: () => void
  }
}

/**
 * Discriminates a press on a widget surface into a click or a drag by a small
 * movement threshold. Deltas are computed from screenX/screenY so the window
 * moving under the pointer cannot corrupt them. A completed drag swallows the
 * click the browser dispatches after pointerup.
 */
function useDragOrClick(
  onClick: (() => void) | undefined,
  onDrag: ((payload: WidgetDragPayload) => void) | undefined,
  onDragFinished?: (() => void) | undefined,
): DragOrClickSurface {
  const trackingRef = useRef<DragTracking | null>(null)
  const suppressClickRef = useRef(false)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || event.isPrimary === false) return
    suppressClickRef.current = false
    trackingRef.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Pointer capture is unavailable in some environments; tracking still works.
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const tracking = trackingRef.current
    if (tracking === null || event.pointerId !== tracking.pointerId) return
    const deltaX = event.screenX - tracking.startX
    const deltaY = event.screenY - tracking.startY
    if (!tracking.dragging) {
      if (Math.hypot(deltaX, deltaY) <= DRAG_THRESHOLD_PX) return
      tracking.dragging = true
      setDragging(true)
      onDrag?.({ phase: 'start' })
    }
    onDrag?.({ phase: 'move', deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) })
  }

  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean): void => {
    const tracking = trackingRef.current
    if (tracking === null || event.pointerId !== tracking.pointerId) return
    trackingRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // Releasing capture is best effort.
    }
    if (!tracking.dragging) return
    suppressClickRef.current = !cancelled
    setDragging(false)
    onDrag?.({ phase: 'end' })
    onDragFinished?.()
  }

  return {
    dragging,
    isDragActive: () => trackingRef.current?.dragging === true,
    surfaceProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event) => finish(event, false),
      onPointerCancel: (event) => finish(event, true),
      onClick: () => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onClick?.()
      },
    },
  }
}

function LevelBars({ level, active }: { readonly level: number; readonly active: boolean }): ReactNode {
  const boundedLevel = safeLevel(level)
  return (
    <div
      className="widget-levels"
      role={active ? 'meter' : undefined}
      aria-label={active ? 'Microphone level' : undefined}
      aria-valuemin={active ? 0 : undefined}
      aria-valuemax={active ? 100 : undefined}
      aria-valuenow={active ? Math.round(boundedLevel * 100) : undefined}
      aria-live="off"
      aria-hidden={active ? undefined : true}
      data-active={active}
    >
      {BAR_SHAPE.map((shape, index) => {
        const height = Math.round(7 + shape * (7 + boundedLevel * 24))
        return (
          <span
            // The stable index represents one fixed visualizer column.
            key={index}
            className="widget-levels__bar"
            data-testid="level-bar"
            aria-hidden="true"
            style={{ height: `${height}px` }}
          />
        )
      })}
    </div>
  )
}

function WidgetAction({
  children,
  label,
  onClick,
  tone = 'neutral',
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick?: (() => void) | undefined
  readonly tone?: 'neutral' | 'stop'
}): ReactNode {
  return (
    <button
      type="button"
      className="widget-action"
      data-tone={tone}
      aria-label={label}
      tabIndex={-1}
      onMouseDown={preventFocus}
      onPointerDown={stopPointerPropagation}
      onClick={(event) => {
        // Keep the capsule's click-to-stop surface from double-handling.
        event.stopPropagation()
        onClick?.()
      }}
    >
      {children}
    </button>
  )
}

export function WidgetApp({
  snapshot,
  now,
  onToggle,
  onStop,
  onCancel,
  onSliverHover,
  onDrag,
}: WidgetAppProps): ReactNode {
  const isIdle = snapshot.status === 'idle'
  const orientation = useWidgetOrientation()
  // Hovering the idle sliver expands it in place into a small pill carrying
  // the click-to-dictate affordance; hover-out collapses it back.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!isIdle) setExpanded(false)
  }, [isIdle])
  // The idle sliver click starts dictation; the active capsule click stops it.
  // Either surface becomes a drag once movement passes the threshold. When an
  // idle drag ends the window has snapped away from the pointer, so hover-off
  // restores the click-through baseline; re-hovering re-arms interactivity.
  const surface = useDragOrClick(
    isIdle ? onToggle : onStop,
    onDrag,
    isIdle
      ? () => {
          setExpanded(false)
          onSliverHover?.(false)
        }
      : undefined,
  )

  if (snapshot.status === 'idle') {
    return (
      <aside
        className="widget-shell"
        aria-label="TalkType dictation status"
        data-status="idle"
        data-tone="idle"
        data-orientation={orientation}
        data-dragging={surface.dragging || undefined}
      >
        <div
          className="widget-sliver"
          data-testid="widget-sliver"
          data-expanded={expanded || undefined}
          tabIndex={-1}
          onMouseEnter={() => {
            setExpanded(true)
            onSliverHover?.(true)
          }}
          onMouseLeave={() => {
            if (!surface.isDragActive()) {
              setExpanded(false)
              onSliverHover?.(false)
            }
          }}
          onMouseDown={preventFocus}
          {...surface.surfaceProps}
        >
          <span className="widget-sliver__prompt">
            <span className="widget-sliver__prompt-action">Click to dictate</span>
            <span className="widget-sliver__prompt-keys">
              {formatWindowsAccelerator(snapshot.shortcut)}
            </span>
          </span>
        </div>
      </aside>
    )
  }

  const copy = getCopy(snapshot)
  const isListening = snapshot.status === 'listening'
  const isProcessing = snapshot.status === 'processing'
  const progress = isProcessing ? Math.round(Math.max(0, Math.min(1, snapshot.progress)) * 100) : 0

  return (
    <aside
      className="widget-shell"
      aria-label="TalkType dictation status"
      data-status={snapshot.status}
      data-tone={copy.tone}
      data-orientation={orientation}
      data-dragging={surface.dragging || undefined}
    >
      <div
        className="widget-capsule"
        tabIndex={-1}
        onMouseDown={preventFocus}
        {...surface.surfaceProps}
      >
        {isListening && <span className="widget-dot" aria-hidden="true" />}
        {isListening && <LevelBars level={snapshot.level} active />}
        {isListening && (
          <time
            className="widget-time"
            dateTime={`PT${Math.max(0, Math.floor((now - snapshot.startedAt) / 1_000))}S`}
            aria-live="off"
          >
            {formatElapsedTime(snapshot.startedAt, now)}
          </time>
        )}
        {isProcessing && (
          <span className="widget-spinner" data-testid="processing-orbit" aria-hidden="true" />
        )}
        {!isListening && !isProcessing && (
          <span className="widget-state-icon">{copy.icon}</span>
        )}
        {!isListening && (
          <span className="widget-copy" title={copy.detail}>
            {copy.title}
          </span>
        )}
        {isProcessing && (
          <span
            className="widget-progress"
            role="progressbar"
            aria-label={`${copy.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            {/* The custom property lets CSS map progress onto width in the
                horizontal capsule and height in the vertical one. */}
            <span style={{ '--widget-progress': `${progress}%` } as React.CSSProperties} />
          </span>
        )}
        {isListening && (
          <WidgetAction label="Stop dictation" tone="stop" onClick={onStop}>
            <Square aria-hidden="true" size={10} fill="currentColor" />
          </WidgetAction>
        )}
        {snapshot.cancellable && (
          <button
            type="button"
            className="widget-esc"
            aria-label="Cancel dictation"
            tabIndex={-1}
            onMouseDown={preventFocus}
            onPointerDown={stopPointerPropagation}
            onClick={(event) => {
              event.stopPropagation()
              onCancel?.()
            }}
          >
            esc
          </button>
        )}
      </div>
    </aside>
  )
}

function applyRootPresentation(snapshot: WidgetSnapshot): () => void {
  const root = document.documentElement
  if (snapshot.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', snapshot.theme)
  if (snapshot.reducedMotion === 'on') root.setAttribute('data-reduced-motion', 'on')
  else root.removeAttribute('data-reduced-motion')

  return () => {
    root.removeAttribute('data-theme')
    root.removeAttribute('data-reduced-motion')
  }
}

export interface WidgetEntryProps {
  readonly bridge: TalkTypeWidgetBridge | undefined
  readonly preview: WidgetSnapshot | null
}

export function WidgetEntry({ bridge, preview }: WidgetEntryProps): ReactNode {
  const [liveSnapshot, setLiveSnapshot] = useState<WidgetSnapshot | null>(null)
  const snapshot = preview ?? liveSnapshot
  const [now, setNow] = useState(() => (preview === null ? Date.now() : PREVIEW_NOW))

  useEffect(() => {
    if (preview !== null || bridge === undefined) return undefined
    return bridge.onWidgetState(setLiveSnapshot)
  }, [bridge, preview])

  useEffect(() => {
    if (snapshot === null) return undefined
    return applyRootPresentation(snapshot)
  }, [snapshot])

  useEffect(() => {
    if (preview !== null || snapshot?.status !== 'listening') return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [preview, snapshot?.status, snapshot?.status === 'listening' ? snapshot.sessionId : null])

  const interactive = snapshot !== null && snapshot.status !== 'idle'
  useEffect(() => {
    if (preview !== null || bridge === undefined || snapshot === null) return
    void bridge.setMouseInteractive(interactive).catch(() => undefined)
  }, [bridge, preview, snapshot === null, interactive])

  const actions = useMemo(() => {
    if (bridge === undefined || preview !== null) return {}
    return {
      onToggle: () => { void bridge.requestToggle().catch(() => undefined) },
      onStop: () => { void bridge.requestStop().catch(() => undefined) },
      onCancel: () => { void bridge.requestCancel().catch(() => undefined) },
      onSliverHover: (hovering: boolean) => {
        void bridge.setMouseInteractive(hovering).catch(() => undefined)
      },
      onDrag: (payload: WidgetDragPayload) => {
        void bridge.reportDrag(payload).catch(() => undefined)
      },
    }
  }, [bridge, preview])

  return (
    <>
      <WidgetAnnouncements snapshot={snapshot} />
      {snapshot === null ? null : <WidgetApp snapshot={snapshot} now={now} {...actions} />}
    </>
  )
}

const previewNames = ['idle', 'listening', 'processing', 'pasted', 'copied', 'error'] as const
type PreviewName = (typeof previewNames)[number]

function isPreviewName(value: string | null): value is PreviewName {
  return value !== null && previewNames.includes(value as PreviewName)
}

export function parseVisualPreview(
  parameters: URLSearchParams,
  enabled: boolean,
): WidgetSnapshot | null {
  if (!enabled) return null
  const keys = [...parameters.keys()]
  if (
    keys.length !== 2 ||
    parameters.getAll('preview').length !== 1 ||
    parameters.getAll('theme').length !== 1 ||
    keys.some((key) => key !== 'preview' && key !== 'theme')
  ) return null

  const name = parameters.get('preview')
  const theme = parameters.get('theme')
  if (!isPreviewName(name) || (theme !== 'light' && theme !== 'dark')) return null

  const common = {
    theme,
    reducedMotion: 'on' as const,
    shortcut: 'Ctrl+Shift+Space',
    sessionId: 'visual-preview',
  } as const
  switch (name) {
    case 'idle':
      return {
        status: 'idle',
        theme,
        reducedMotion: 'on',
        shortcut: 'Ctrl+Shift+Space',
        cancellable: false,
      }
    case 'listening':
      return { ...common, status: 'listening', startedAt: 1_000, level: 0.64, cancellable: true }
    case 'processing':
      return {
        ...common, status: 'processing', startedAt: 1_000, stage: 'transcribing',
        progress: 0.58, cancellable: true,
      }
    case 'pasted':
      return { ...common, status: 'success', output: 'pasted', cancellable: false }
    case 'copied':
      return { ...common, status: 'success', output: 'copied', cancellable: false }
    case 'error':
      return { ...common, status: 'error', code: 'MIC_PERMISSION_DENIED', cancellable: false }
  }
}

export function isVisualPreviewEnabled(
  target: Window,
  environmentValue: string | undefined,
): boolean {
  if (environmentValue !== '1') return false
  const descriptor = Object.getOwnPropertyDescriptor(target, '__TALKTYPE_VISUAL_PREVIEW__')
  return descriptor?.value === true && descriptor.writable === false && descriptor.configurable === false
}
