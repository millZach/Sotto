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
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'

import type { TalkTypeWidgetBridge } from '../../../shared/contracts'
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
  readonly onStop?: () => void
  readonly onCancel?: () => void
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
        tone: 'idle', title: 'Ready', detail: snapshot.shortcut,
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'requesting-permission':
      return {
        tone: 'permission', title: 'Waiting for microphone', detail: 'Approve access in Windows',
        icon: <ShieldAlert aria-hidden="true" size={22} strokeWidth={2.1} />,
      }
    case 'listening':
      return {
        tone: 'listening', title: 'Listening', detail: `${snapshot.shortcut} to finish`,
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

function preventFocus(event: ReactMouseEvent<HTMLButtonElement>): void {
  event.preventDefault()
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
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function WidgetApp({ snapshot, now, onStop, onCancel }: WidgetAppProps): ReactNode {
  if (snapshot.status === 'idle') return null
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
    >
      <div className="widget-pill">
        <span className="widget-state-icon">{copy.icon}</span>
        {isListening && <LevelBars level={snapshot.level} active />}
        {isProcessing && <span className="widget-orbit" data-testid="processing-orbit" aria-hidden="true"><span /></span>}
        <div className="widget-copy">
          <strong>{copy.title}</strong>
          <span title={copy.detail}>{copy.detail}</span>
        </div>
        <div className="widget-metric">
          {isListening && (
            <time
              dateTime={`PT${Math.max(0, Math.floor((now - snapshot.startedAt) / 1_000))}S`}
              aria-live="off"
            >
              {formatElapsedTime(snapshot.startedAt, now)}
            </time>
          )}
          {isProcessing && (
            <>
              <span aria-live="off">{progress}%</span>
              <span
                className="widget-progress"
                role="progressbar"
                aria-label={`${copy.title} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <span style={{ width: `${progress}%` }} />
              </span>
            </>
          )}
        </div>
        <div className="widget-actions">
          {isListening && (
            <WidgetAction label="Stop dictation" tone="stop" onClick={onStop}>
              <Square aria-hidden="true" size={13} fill="currentColor" />
              <span>Stop</span>
            </WidgetAction>
          )}
          {snapshot.cancellable && (
            <WidgetAction label="Cancel dictation" onClick={onCancel}>
              <X aria-hidden="true" size={16} />
              <span className="widget-action__cancel-label">Cancel</span>
            </WidgetAction>
          )}
        </div>
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

  const actions = useMemo(() => {
    if (bridge === undefined || preview !== null) return {}
    return {
      onStop: () => { void bridge.requestStop().catch(() => undefined) },
      onCancel: () => { void bridge.requestCancel().catch(() => undefined) },
    }
  }, [bridge, preview])

  return (
    <>
      <WidgetAnnouncements snapshot={snapshot} />
      {snapshot === null ? null : <WidgetApp snapshot={snapshot} now={now} {...actions} />}
    </>
  )
}

const previewNames = ['listening', 'processing', 'pasted', 'copied', 'error'] as const
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
