import {
  AlertCircle,
  Check,
  CircleEllipsis,
  ChevronDown,
  ChevronUp,
  Mic,
  MicOff,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  default as React,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import type {
  SottoWidgetBridge,
  WidgetDragPayload,
  WidgetDragPhase,
  WidgetPresentation,
} from '../../../shared/contracts'
import { formatAccelerator } from '../../../shared/accelerator'
import {
  MICROPHONE_NOT_SET_UP_DETAIL,
  TRANSCRIPTION_ERROR_DETAIL,
  type WidgetErrorCode,
  type WidgetProcessingStage,
  type WidgetSnapshot,
} from '../../../shared/dictation'
import type { SottoPlatform } from '../../../shared/platform'
import { DEFAULT_WIDGET_PALETTE, WIDGET_THEME_ROLES, type WidgetThemeRole } from '../../../shared/themeBranding'
import { isCanonicalThemeColor } from '../../../shared/themes/color'
import type { ThemeAppearance } from '../../../shared/themes/palettes'
import { ListeningBars } from '../components/ListeningBars'
import { SottoMark } from '../components/SottoMark'
import { platformCopy, type PlatformCopy } from '../platformCopy'
import { useWidgetDragGesture } from './useWidgetDragGesture'
import { useAgentConnection, type AgentConnection } from '../agents/AgentContext'
import { WidgetThreads } from './WidgetThreads'

const IDLE_HOVER_SETTLE_MS = 220
const PREVIEW_NOW = 13_340

const processingLabels: Record<WidgetProcessingStage, string> = {
  'preparing-audio': 'Preparing audio',
  'loading-model': 'Preparing transcription',
  transcribing: 'Transcribing',
  'delivering-output': 'Delivering text',
}

function errorCopyFor(
  copy: PlatformCopy,
): Record<WidgetErrorCode, { readonly title: string; readonly detail: string }> {
  return {
    MIC_PERMISSION_DENIED: {
      title: 'Microphone blocked',
      detail: copy.widgetMicrophoneBlockedDetail,
    },
    MIC_DEVICE_NOT_FOUND: {
      title: 'No microphone found',
      detail: 'Connect a microphone and try again.',
    },
    MIC_NOT_SET_UP: {
      title: 'No microphone set up',
      detail: MICROPHONE_NOT_SET_UP_DETAIL,
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
    TRANSCRIPTION_UNCONFIGURED: {
      title: 'API key needed',
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_UNCONFIGURED,
    },
    TRANSCRIPTION_UNAUTHORIZED: {
      title: 'API key rejected',
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_UNAUTHORIZED,
    },
    TRANSCRIPTION_OFFLINE: {
      title: 'Connection unavailable',
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_OFFLINE,
    },
    TRANSCRIPTION_FAILED: {
      title: 'Couldn’t transcribe',
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_FAILED,
    },
    OUTPUT_UNAVAILABLE: {
      title: 'Output unavailable',
      detail: 'Open Sotto and try again.',
    },
    OUTPUT_FAILED: {
      title: 'Couldn’t copy text',
      detail: 'Try again from the Sotto app.',
    },
    HISTORY_FAILED: {
      title: 'Saved to clipboard',
      detail: 'Local history was not updated.',
    },
    SETTINGS_UNAVAILABLE: {
      title: 'Settings unavailable',
      detail: 'Open Sotto to restore settings.',
    },
  }
}

interface WidgetCopy {
  readonly tone: 'idle' | 'permission' | 'listening' | 'processing' | 'success' | 'cancelled' | 'error'
  readonly title: string
  readonly detail: string
  readonly icon: ReactNode
}

function WidgetAnnouncements({
  snapshot,
  platform,
}: {
  readonly snapshot: WidgetSnapshot | null
  readonly platform: SottoPlatform
}): ReactNode {
  const copy = snapshot === null || snapshot.status === 'idle' ? null : getCopy(snapshot, platform)
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
  readonly platform: SottoPlatform
  readonly now: number
  readonly onToggle?: () => void
  readonly onStop?: () => void
  readonly onCancel?: () => void
  readonly onPresentationChange?: (presentation: WidgetPresentation) => void
  readonly onDrag?: (payload: WidgetDragPayload) => void
  readonly dragCancellationVersion?: number
  readonly visibilityGeneration?: number
  readonly agents?: AgentConnection | undefined
}

export function formatElapsedTime(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return '00:00'
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  const minutes = Math.min(99, Math.floor(totalSeconds / 60))
  const seconds = minutes === 99 ? Math.min(59, totalSeconds - minutes * 60) : totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getCopy(snapshot: WidgetSnapshot, platform: SottoPlatform): WidgetCopy {
  const copy = platformCopy(platform)
  switch (snapshot.status) {
    case 'idle':
      return {
        tone: 'idle', title: 'Ready', detail: formatAccelerator(snapshot.shortcut, platform, 'display'),
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'requesting-permission':
      return {
        tone: 'permission', title: 'Waiting for microphone', detail: copy.widgetPermissionPromptDetail,
        icon: <ShieldAlert aria-hidden="true" size={22} strokeWidth={2.1} />,
      }
    case 'listening':
      return {
        tone: 'listening', title: 'Listening', detail: `${formatAccelerator(snapshot.shortcut, platform, 'display')} to finish`,
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'processing':
      return {
        tone: 'processing', title: processingLabels[snapshot.stage], detail: copy.widgetProcessingDetail,
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
      const entry = errorCopyFor(copy)[snapshot.code]
      return {
        tone: 'error', title: entry.title, detail: entry.detail,
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
 * Every native presentation footprint is landscape on horizontal edges and
 * portrait on vertical edges. A resize listener follows presentation and edge
 * changes applied by the main-process placement coordinator.
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

function WidgetAction({
  children,
  label,
  onClick,
  tone = 'neutral',
  pressed,
  expanded,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick?: (() => void) | undefined
  readonly tone?: 'neutral' | 'stop'
  readonly pressed?: boolean | undefined
  readonly expanded?: boolean | undefined
}): ReactNode {
  return (
    <button
      type="button"
      className="widget-action"
      data-tone={tone}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
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
  platform,
  now,
  onToggle,
  onStop,
  onCancel,
  onPresentationChange,
  onDrag,
  dragCancellationVersion,
  visibilityGeneration = 0,
  agents,
}: WidgetAppProps): ReactNode {
  const isIdle = snapshot.status === 'idle'
  const orientation = useWidgetOrientation()
  const agentState = agents?.state?.configuration.enabled ? agents.state : null
  const dictationUsesMicrophone = snapshot.status === 'listening' || snapshot.status === 'requesting-permission'
  const microphoneMuted = agentState?.voice.status === 'muted' && !dictationUsesMicrophone
  const [threadsExpanded, setThreadsExpanded] = useState(false)
  const showThreads = threadsExpanded && agentState !== null
  useEffect(() => { setThreadsExpanded(false) }, [dragCancellationVersion])
  useEffect(() => { if (agentState === null) setThreadsExpanded(false) }, [agentState])
  // Hovering the idle sliver expands it in place into a small pill carrying
  // the click-to-dictate affordance. Native resize/re-centering can briefly
  // synthesize leave/enter events, so collapse waits beyond the CSS transition.
  const [expanded, setExpanded] = useState(false)
  const hoverInsideRef = useRef(false)
  const hoverCollapseTimerRef = useRef<number | null>(null)
  const clearHoverCollapse = (): void => {
    if (hoverCollapseTimerRef.current === null) return
    window.clearTimeout(hoverCollapseTimerRef.current)
    hoverCollapseTimerRef.current = null
  }
  useEffect(() => {
    // Native hiding invalidates both drag and idle-hover interaction state.
    hoverInsideRef.current = false
    clearHoverCollapse()
    setExpanded(false)
  }, [dragCancellationVersion])
  useEffect(() => {
    if (!isIdle) {
      hoverInsideRef.current = false
      clearHoverCollapse()
      setExpanded(false)
    }
  }, [isIdle])
  useEffect(() => () => clearHoverCollapse(), [])
  // The idle sliver click starts dictation; the active capsule click stops it.
  // Either surface becomes a drag once movement passes the threshold. When an
  // idle drag ends the window has snapped away from the pointer, so it returns
  // to the resting presentation.
  const dragGenerationRef = useRef<number | null>(null)
  const reportDragPhase = (phase: WidgetDragPhase): void => {
    if (phase.phase === 'start') {
      dragGenerationRef.current = visibilityGeneration
    }
    const generation = dragGenerationRef.current
    if (generation === null) return
    try {
      onDrag?.({ ...phase, generation })
    } finally {
      if (phase.phase === 'end') {
        dragGenerationRef.current = null
      }
    }
  }
  const surface = useWidgetDragGesture(
    isIdle ? onToggle : onStop,
    reportDragPhase,
    isIdle ? () => setExpanded(false) : undefined,
    dragCancellationVersion,
  )
  const presentation: WidgetPresentation = showThreads ? 'threads-expanded' : !isIdle
    ? agentState !== null ? 'pill-controls' : 'active'
    : expanded || surface.dragging
      ? 'idle-hovered'
      : 'idle-resting'

  useEffect(() => {
    onPresentationChange?.(presentation)
  }, [onPresentationChange, presentation, visibilityGeneration])

  const agentActions = agentState !== null && agents !== undefined ? (
    <span className="widget-agent-actions">
      <WidgetAction label={microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}
        pressed={microphoneMuted}
        onClick={() => {
          if (dictationUsesMicrophone) onCancel?.()
          void agents.command({ type: 'voice', action: microphoneMuted ? 'unmute' : 'mute' })
        }}>
        {microphoneMuted ? <MicOff size={13} /> : <Mic size={13} />}
      </WidgetAction>
      <WidgetAction label={agentState.configuration.speak ? 'Mute voice' : 'Unmute voice'}
        pressed={!agentState.configuration.speak}
        onClick={() => {
          void agents.command({ type: 'voice', action: 'stop-speaking' })
          void agents.command({ type: 'configure', patch: { speak: !agentState.configuration.speak } })
        }}>
        {agentState.configuration.speak ? <Volume2 size={13} /> : <VolumeX size={13} />}
      </WidgetAction>
      <WidgetAction label={showThreads ? 'Collapse threads' : 'Expand threads'} expanded={showThreads}
        onClick={() => setThreadsExpanded(!showThreads)}>
        {showThreads ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </WidgetAction>
    </span>
  ) : null
  const threadPanel = showThreads && agents !== undefined && agentState !== null
    ? <WidgetThreads state={agentState} command={agents.command} /> : null

  if (snapshot.status === 'idle') {
    return (
      <aside
        className="widget-shell"
        aria-label="Sotto dictation status"
        data-status="idle"
        data-tone="idle"
        data-orientation={showThreads ? 'horizontal' : orientation}
        data-threads-expanded={showThreads || undefined}
        data-agent-controls={agentState !== null || undefined}
        data-dragging={surface.dragging || undefined}
      >
        {threadPanel}
        <div
          className="widget-sliver"
          data-testid="widget-sliver"
          data-expanded={expanded || showThreads || undefined}
          tabIndex={-1}
          onMouseEnter={() => {
            hoverInsideRef.current = true
            clearHoverCollapse()
            setExpanded(true)
          }}
          onMouseLeave={() => {
            hoverInsideRef.current = false
            if (surface.isDragActive()) return
            clearHoverCollapse()
            hoverCollapseTimerRef.current = window.setTimeout(() => {
              hoverCollapseTimerRef.current = null
              if (!hoverInsideRef.current && !surface.isDragActive()) {
                setExpanded(false)
              }
            }, IDLE_HOVER_SETTLE_MS)
          }}
          onMouseDown={preventFocus}
          {...surface.surfaceProps}
        >
          {/* The resting sliver is a bare bar; hovering expands it in place
              and reveals the click-to-dictate prompt overlaid on it. */}
          <span className="widget-sliver__prompt">
            <span className="widget-sliver__prompt-action">Click to dictate</span>
            {agentState === null && <span className="widget-sliver__prompt-keys">
              {formatAccelerator(snapshot.shortcut, platform, 'display')}
            </span>}
            {agentActions}
          </span>
        </div>
      </aside>
    )
  }

  const copy = getCopy(snapshot, platform)
  const isListening = snapshot.status === 'listening'
  const isProcessing = snapshot.status === 'processing'
  const progress = isProcessing ? Math.round(Math.max(0, Math.min(1, snapshot.progress)) * 100) : 0

  const progressBar = isProcessing && (
    <span
      className="widget-progress"
      role="progressbar"
      aria-label={`${copy.title} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      {/* The custom property lets CSS map progress onto width in the
          horizontal panel and height in the vertical one. */}
      <span style={{ '--widget-progress': `${progress}%` } as React.CSSProperties} />
    </span>
  )
  const stopAction = isListening && (
    <WidgetAction label="Stop dictation" tone="stop" onClick={onStop}>
      <Square aria-hidden="true" size={10} fill="currentColor" />
    </WidgetAction>
  )
  const escAction = snapshot.cancellable && (
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
  )
  const elapsed = isListening && (
    <time
      className="widget-time"
      dateTime={`PT${Math.max(0, Math.floor((now - snapshot.startedAt) / 1_000))}S`}
      aria-live="off"
    >
      {formatElapsedTime(snapshot.startedAt, now)}
    </time>
  )

  return (
    <aside
      className="widget-shell"
      aria-label="Sotto dictation status"
      data-status={snapshot.status}
      data-tone={copy.tone}
      data-orientation={showThreads ? 'horizontal' : orientation}
      data-threads-expanded={showThreads || undefined}
      data-agent-controls={agentState !== null || undefined}
      data-dragging={surface.dragging || undefined}
    >
      {threadPanel}
      <div
        className="widget-capsule"
        tabIndex={-1}
        onMouseDown={preventFocus}
        {...surface.surfaceProps}
      >
        {/* Every active state leads with the app mark, so the capsule is
            recognisably Sotto before any status content is read. */}
        <span className="widget-glyph" data-testid="widget-glyph" aria-hidden="true">
          <SottoMark className="widget-glyph__mark" />
        </span>
        {isListening && <ListeningBars level={snapshot.level} />}
        {elapsed}
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
        {progressBar}
        {stopAction}
        {escAction}
        {agentActions}
      </div>
    </aside>
  )
}

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK_QUERY).matches
}

/** The widget keeps its own scheme: `system` follows the operating system, live. */
function useWidgetSystemDark(): boolean {
  const [dark, setDark] = useState(systemPrefersDark)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(SYSTEM_DARK_QUERY)
    const update = (): void => setDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark
}

export function resolveWidgetScheme(theme: WidgetSnapshot['theme'], systemDark: boolean): ThemeAppearance {
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return theme
}

/** `surfaceRaised` → `--theme-surface-raised`, the property name the main window paints too. */
function themeRoleVariable(role: WidgetThemeRole): string {
  return `--theme-${role.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`
}

/**
 * Put the resolved scheme, the theme half that paints it and the motion
 * preference on the widget root. Only canonical colours reach the style, and
 * an unchanged role is not rewritten, so frequent level snapshots cause no
 * style churn.
 */
export function applyRootPresentation(
  presentation: Pick<WidgetSnapshot, 'theme' | 'palette' | 'reducedMotion'>,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): () => void {
  const scheme = resolveWidgetScheme(presentation.theme, systemDark)
  root.setAttribute('data-theme', scheme)
  const colors = presentation.palette[scheme]
  for (const role of WIDGET_THEME_ROLES) {
    const value = colors[role]
    const variable = themeRoleVariable(role)
    if (isCanonicalThemeColor(value) && root.style.getPropertyValue(variable) !== value) root.style.setProperty(variable, value)
  }
  if (presentation.reducedMotion === 'on') root.setAttribute('data-reduced-motion', 'on')
  else root.removeAttribute('data-reduced-motion')

  return () => {
    root.removeAttribute('data-theme')
    root.removeAttribute('data-reduced-motion')
    for (const role of WIDGET_THEME_ROLES) root.style.removeProperty(themeRoleVariable(role))
  }
}

export interface WidgetEntryProps {
  readonly bridge: SottoWidgetBridge | undefined
  readonly preview: WidgetSnapshot | null
  readonly platform: SottoPlatform
}

export function WidgetEntry({ bridge, preview, platform }: WidgetEntryProps): ReactNode {
  const agents = useAgentConnection(preview === null ? bridge?.agents : undefined)
  const [liveSnapshot, setLiveSnapshot] = useState<WidgetSnapshot | null>(null)
  const snapshot = preview ?? liveSnapshot
  const [now, setNow] = useState(() => (preview === null ? Date.now() : PREVIEW_NOW))
  const [dragCancellationVersion, setDragCancellationVersion] = useState(0)
  const [visibilityGeneration, setVisibilityGeneration] = useState(0)

  useEffect(() => {
    if (preview !== null || bridge === undefined) return undefined
    return bridge.onWidgetState(setLiveSnapshot)
  }, [bridge, preview])

  useEffect(() => {
    if (preview !== null || bridge === undefined) return undefined
    return bridge.onWidgetVisibilityChange((visibility) => {
      setVisibilityGeneration(visibility.generation)
      if (!visibility.visible) setDragCancellationVersion((version) => version + 1)
    })
  }, [bridge, preview])

  const systemDark = useWidgetSystemDark()
  const scheme = snapshot === null ? null : resolveWidgetScheme(snapshot.theme, systemDark)
  // Level snapshots arrive many times a second with an equal palette, so the
  // root is repainted only when the painted half's colours actually change.
  const paintedColors = snapshot === null || scheme === null ? null : JSON.stringify(snapshot.palette[scheme])
  const presentationRef = useRef(snapshot)
  presentationRef.current = snapshot
  // Before paint, so a new snapshot never shows a frame of the previous palette.
  useLayoutEffect(() => {
    const current = presentationRef.current
    if (current === null) return undefined
    return applyRootPresentation(current, systemDark)
  }, [snapshot === null, snapshot?.theme, snapshot?.reducedMotion, paintedColors, systemDark])

  useEffect(() => {
    if (preview !== null || snapshot?.status !== 'listening') return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [preview, snapshot?.status, snapshot?.status === 'listening' ? snapshot.sessionId : null])

  const actions = useMemo(() => {
    if (bridge === undefined || preview !== null) return {}
    return {
      onToggle: () => { void bridge.requestToggle().catch(() => undefined) },
      onStop: () => { void bridge.requestStop().catch(() => undefined) },
      onCancel: () => { void bridge.requestCancel().catch(() => undefined) },
      onPresentationChange: (presentation: WidgetPresentation) => {
        void bridge.setPresentation({
          presentation,
          generation: visibilityGeneration,
        }).catch(() => undefined)
      },
      onDrag: (payload: WidgetDragPayload) => {
        void bridge.reportDrag(payload).catch(() => undefined)
      },
    }
  }, [bridge, preview, visibilityGeneration])

  return (
    <>
      <WidgetAnnouncements snapshot={snapshot} platform={platform} />
      {snapshot === null ? null : (
        <WidgetApp
          agents={agents}
          snapshot={snapshot}
          platform={platform}
          now={now}
          dragCancellationVersion={dragCancellationVersion}
          visibilityGeneration={visibilityGeneration}
          {...actions}
        />
      )}
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

  // A preview has no settings to read, so it wears the default themes.
  const common = {
    theme,
    palette: DEFAULT_WIDGET_PALETTE,
    reducedMotion: 'on' as const,
    shortcut: 'Ctrl+Shift+Space',
    sessionId: 'visual-preview',
  } as const
  switch (name) {
    case 'idle':
      return {
        status: 'idle',
        theme,
        palette: DEFAULT_WIDGET_PALETTE,
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
  const descriptor = Object.getOwnPropertyDescriptor(target, '__SOTTO_VISUAL_PREVIEW__')
  return descriptor?.value === true && descriptor.writable === false && descriptor.configurable === false
}
