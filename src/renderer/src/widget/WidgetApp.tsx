import {
  AlertCircle,
  Check,
  CircleEllipsis,
  Mic,
  RotateCcw,
  ShieldAlert,
  Square,
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
import type { I18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'

import type {
  SottoWidgetBridge,
  WidgetDragPayload,
  WidgetDragPhase,
  WidgetPresentation,
} from '../../../shared/contracts'
import { formatAccelerator } from '../../../shared/accelerator'
import {
  isTranscriptionErrorCode,
  MICROPHONE_NOT_SET_UP_DETAIL,
  SPEECH_MODEL_NOT_READY_DETAIL,
  OPENROUTER_KEY_MISSING_DETAIL,
  TRANSCRIPTION_ERROR_DETAIL,
  TRANSCRIPTION_KEPT_DETAIL,
  type WidgetErrorCode,
  type WidgetProcessingStage,
  type WidgetSnapshot,
} from '../../../shared/dictation'
import type { SottoPlatform } from '../../../shared/platform'
import { APP_ICON_BRAND_ATTRIBUTE, DEFAULT_WIDGET_PALETTE, WIDGET_THEME_ROLES, type WidgetThemeRole } from '../../../shared/themeBranding'
import { isCanonicalThemeColor } from '../../../shared/themes/color'
import type { ThemeAppearance } from '../../../shared/themes/palettes'
import { ListeningBars } from '../components/ListeningBars'
import { SottoMark } from '../components/SottoMark'
import { platformCopy, type PlatformCopy } from '../platformCopy'
import { useWidgetDragGesture } from './useWidgetDragGesture'

const IDLE_HOVER_SETTLE_MS = 220
/** How long after an error appears a click on its × is still taken as aimed at the esc before it. */
const DISMISS_GRACE_MS = 500
const PREVIEW_NOW = 13_340

const processingLabels: Record<WidgetProcessingStage, MessageDescriptor> = {
  'preparing-audio': msg`Preparing audio`,
  'loading-model': msg`Starting the speech model`,
  transcribing: msg`Transcribing`,
  'delivering-output': msg`Delivering text`,
}

function errorCopyFor(
  copy: PlatformCopy,
  i18n: I18n,
): Record<WidgetErrorCode, { readonly title: string; readonly detail: string }> {
  const modelNotReady = i18n._(msg({ message: 'Model not ready', comment: 'The speech model that turns dictation into text has not finished loading.' }))
  const noKey = i18n._(msg({ message: 'No OpenRouter key', comment: 'Dictation is set to transcribe with OpenRouter, and no OpenRouter key is saved.' }))
  return {
    MIC_PERMISSION_DENIED: {
      title: i18n._(msg`Microphone blocked`),
      detail: copy.widgetMicrophoneBlockedDetail,
    },
    MIC_DEVICE_NOT_FOUND: {
      title: i18n._(msg`No microphone found`),
      detail: i18n._(msg`Connect a microphone and try again.`),
    },
    MIC_NOT_SET_UP: {
      title: i18n._(msg`No microphone set up`),
      detail: MICROPHONE_NOT_SET_UP_DETAIL,
    },
    SPEECH_MODEL_NOT_READY: {
      title: modelNotReady,
      detail: SPEECH_MODEL_NOT_READY_DETAIL,
    },
    MIC_START_FAILED: {
      title: i18n._(msg`Microphone unavailable`),
      detail: i18n._(msg`Check the selected microphone and try again.`),
    },
    RECORDING_FAILED: {
      title: i18n._(msg`Recording stopped`),
      detail: i18n._(msg`Check your microphone and try again.`),
    },
    NO_SPEECH: {
      title: i18n._(msg`No speech detected`),
      detail: i18n._(msg`Speak closer to the microphone and try again.`),
    },
    TRANSCRIPTION_MODEL_NOT_READY: {
      title: modelNotReady,
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_MODEL_NOT_READY,
    },
    TRANSCRIPTION_FAILED: {
      title: i18n._(msg`Couldn’t transcribe`),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_FAILED,
    },
    OPENROUTER_KEY_MISSING: {
      title: noKey,
      detail: OPENROUTER_KEY_MISSING_DETAIL,
    },
    TRANSCRIPTION_NO_KEY: {
      title: noKey,
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_NO_KEY,
    },
    TRANSCRIPTION_KEY_REJECTED: {
      title: i18n._(msg({ message: 'Key not accepted', comment: 'OpenRouter refused the saved OpenRouter key.' })),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_KEY_REJECTED,
    },
    TRANSCRIPTION_NO_CREDIT: {
      title: i18n._(msg({ message: 'Out of credit', comment: 'The OpenRouter account has no credit left to pay for transcription.' })),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_NO_CREDIT,
    },
    TRANSCRIPTION_RATE_LIMITED: {
      title: i18n._(msg({ message: 'OpenRouter busy', comment: 'OpenRouter turned the request away because too many were sent at once.' })),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_RATE_LIMITED,
    },
    TRANSCRIPTION_OFFLINE: {
      title: i18n._(msg({ message: 'Can’t reach OpenRouter', comment: 'Sotto could not connect to OpenRouter to transcribe dictation.' })),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_OFFLINE,
    },
    TRANSCRIPTION_MODEL_GONE: {
      title: i18n._(msg({ message: 'Model unavailable', comment: 'OpenRouter no longer offers the speech model chosen for dictation.' })),
      detail: TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_MODEL_GONE,
    },
    OUTPUT_UNAVAILABLE: {
      title: i18n._(msg`Output unavailable`),
      detail: i18n._(msg`Open Sotto and try again.`),
    },
    OUTPUT_FAILED: {
      title: i18n._(msg`Couldn’t copy text`),
      detail: i18n._(msg`Try again from the Sotto app.`),
    },
    DESKTOP_CLIPBOARD_UNAVAILABLE: {
      title: i18n._(msg`Text kept in Sotto`),
      detail: i18n._(msg`The desktop clipboard could not be updated. Open Sotto, then Dictate. Use Copy text or select the text there.`),
    },
    HISTORY_FAILED: {
      title: i18n._(msg`Saved to clipboard`),
      detail: i18n._(msg`Local history was not updated.`),
    },
    SETTINGS_UNAVAILABLE: {
      title: i18n._(msg`Settings unavailable`),
      detail: i18n._(msg`Open Sotto to restore settings.`),
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
  const { i18n } = useLingui()
  const copy = snapshot === null || snapshot.status === 'idle' ? null : getCopy(snapshot, platform, i18n)
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
  readonly onRetry?: () => void
  readonly onDismiss?: () => void
  readonly onPresentationChange?: (presentation: WidgetPresentation) => void
  readonly onDrag?: (payload: WidgetDragPayload) => void
  readonly dragCancellationVersion?: number
  readonly visibilityGeneration?: number
}

export function formatElapsedTime(startedAt: number, now: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return '00:00'
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000))
  const minutes = Math.min(99, Math.floor(totalSeconds / 60))
  const seconds = minutes === 99 ? Math.min(59, totalSeconds - minutes * 60) : totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getCopy(snapshot: WidgetSnapshot, platform: SottoPlatform, i18n: I18n): WidgetCopy {
  const copy = platformCopy(platform)
  switch (snapshot.status) {
    case 'idle':
      return {
        tone: 'idle', title: i18n._(msg({ message: 'Ready', comment: 'The floating widget is waiting for dictation to start.' })), detail: platform === 'linux' ? i18n._(msg`F9 to talk`) : formatAccelerator(snapshot.shortcut, platform, 'display'),
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    case 'requesting-permission':
      return {
        tone: 'permission', title: i18n._(msg`Waiting for microphone`), detail: copy.widgetPermissionPromptDetail,
        icon: <ShieldAlert aria-hidden="true" size={22} strokeWidth={2.1} />,
      }
    case 'listening': {
      const shortcut = formatAccelerator(snapshot.shortcut, platform, 'display')
      return {
        tone: 'listening', title: i18n._(msg`Listening`), detail: platform === 'linux' ? i18n._(msg`Release F9 or press Super+Ctrl+X to finish`) : i18n._(msg({ message: `${shortcut} to finish`, comment: '{shortcut} is the dictation keyboard shortcut, as in "Ctrl+Shift+Space".' })),
        icon: <Mic aria-hidden="true" size={22} strokeWidth={2.2} />,
      }
    }
    case 'processing':
      return {
        tone: 'processing', title: i18n._(processingLabels[snapshot.stage]),
        // While OpenRouter transcribes (ADR-0160) the audio does leave this computer, so only the half that holds is said.
        detail: snapshot.cloud === true ? i18n._(msg`Audio is never saved`) : copy.widgetProcessingDetail,
        icon: <CircleEllipsis aria-hidden="true" size={23} strokeWidth={2.1} />,
      }
    case 'success':
      return {
        tone: 'success',
        title: snapshot.output === 'pasted' ? i18n._(msg`Pasted`) : i18n._(msg`Copied — paste manually`),
        detail: snapshot.output === 'pasted' ? i18n._(msg`Text delivered`) : platform === 'linux' ? i18n._(msg`Super+V to paste in apps and terminals`) : i18n._(msg`Clipboard is ready`),
        icon: <Check aria-hidden="true" size={23} strokeWidth={2.4} />,
      }
    case 'cancelled':
      return {
        tone: 'cancelled', title: i18n._(msg({ message: 'Cancelled', comment: 'Dictation was cancelled.' })), detail: i18n._(msg`Nothing was copied`),
        icon: <X aria-hidden="true" size={23} strokeWidth={2.2} />,
      }
    case 'error': {
      const entry = errorCopyFor(copy, i18n)[snapshot.code]
      // A kept recording makes the whole pill Try again; what went wrong rides
      // in the tooltip and the announcement.
      if (snapshot.kept === true && isTranscriptionErrorCode(snapshot.code)) {
        // After a Try again that failed too, the pill says so rather than
        // looking as though nothing happened.
        const again = snapshot.retried === true
        const problem = entry.title
        const kept = TRANSCRIPTION_KEPT_DETAIL[snapshot.code]
        return {
          tone: 'error',
          title: again ? i18n._(msg`Failed again · retry`) : i18n._(msg`Click to try again`),
          detail: again
            ? i18n._(msg({ message: `Try again failed too. ${problem}. ${kept}`, comment: '{problem} is a short title such as "Couldn’t transcribe"; {kept} says the recording was kept.' }))
            : i18n._(msg({ message: `${problem}. ${kept}`, comment: '{problem} is a short title such as "Couldn’t transcribe"; {kept} says the recording was kept.' })),
          icon: <RotateCcw aria-hidden="true" size={23} strokeWidth={2.2} />,
        }
      }
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
      title={label}
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
  onRetry,
  onDismiss,
  onPresentationChange,
  onDrag,
  dragCancellationVersion,
  visibilityGeneration = 0,
}: WidgetAppProps): ReactNode {
  const { t, i18n } = useLingui()
  const isIdle = snapshot.status === 'idle'
  const kept = snapshot.status === 'error' && snapshot.kept === true
  // The × takes the place esc held while the work ran. A click in its first
  // half second was aimed at esc, so it does not discard what was just kept.
  const errorKey = snapshot.status === 'error' ? `${snapshot.sessionId ?? ''}:${snapshot.code}:${String(snapshot.retried)}` : ''
  const errorShownAt = useRef(0)
  // A layout effect runs before the browser can deliver a click on the new ×.
  useLayoutEffect(() => { if (errorKey !== '') errorShownAt.current = Date.now() }, [errorKey])
  const orientation = useWidgetOrientation()
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
  // An error capsule's click tries a kept recording again, or dismisses an
  // error that keeps nothing. Either surface becomes a drag once movement
  // passes the threshold. When an
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
    isIdle ? onToggle : snapshot.status === 'error' ? (kept ? onRetry : onDismiss) : onStop,
    reportDragPhase,
    isIdle ? () => setExpanded(false) : undefined,
    dragCancellationVersion,
  )
  const presentation: WidgetPresentation = !isIdle
    ? 'active'
    : expanded || surface.dragging
      ? 'idle-hovered'
      : 'idle-resting'

  useEffect(() => {
    onPresentationChange?.(presentation)
  }, [onPresentationChange, presentation, visibilityGeneration])

  if (snapshot.status === 'idle') {
    return (
      <aside
        className="widget-shell"
        aria-label={t`Sotto dictation status`}
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
            <span className="widget-sliver__prompt-action">{t`Click to dictate`}</span>
            <span className="widget-sliver__prompt-keys">
              {platform === 'linux' ? t`F9 to talk` : formatAccelerator(snapshot.shortcut, platform, 'display')}
            </span>
          </span>
        </div>
      </aside>
    )
  }

  const copy = getCopy(snapshot, platform, i18n)
  const isListening = snapshot.status === 'listening'
  const isProcessing = snapshot.status === 'processing'
  const progress = isProcessing ? Math.round(Math.max(0, Math.min(1, snapshot.progress)) * 100) : 0

  const progressOf = copy.title
  const progressBar = isProcessing && (
    <span
      className="widget-progress"
      role="progressbar"
      aria-label={t({ message: `${progressOf} progress`, comment: '{progressOf} is what the widget is doing, as in "Transcribing".' })}
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
    <WidgetAction label={t`Stop dictation`} tone="stop" onClick={onStop}>
      <Square aria-hidden="true" size={10} fill="currentColor" />
    </WidgetAction>
  )
  const escAction = snapshot.cancellable && (
    <button
      type="button"
      className="widget-esc"
      aria-label={t`Cancel dictation`}
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
  // An error stays until it is dismissed. Escape is not claimed for it, since
  // holding the key system-wide while an error waits would take it from every app.
  const dismissAction = snapshot.status === 'error' && (
    <WidgetAction
      label={kept ? t`Discard recording` : t`Dismiss`}
      onClick={() => { if (Date.now() - errorShownAt.current >= DISMISS_GRACE_MS) onDismiss?.() }}
    >
      <X aria-hidden="true" size={11} strokeWidth={2.6} />
    </WidgetAction>
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
      aria-label={t`Sotto dictation status`}
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
        {/* Every active state leads with the app mark, so the capsule is
            recognisably Sotto before any status content is read. */}
        <span className="widget-glyph" data-testid="widget-glyph" aria-hidden="true">
          <SottoMark className="widget-glyph__mark" />
        </span>
        {isListening && <ListeningBars speaking={snapshot.speaking} />}
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
        {dismissAction}
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
 * an unchanged role is not rewritten, so frequent snapshots cause no style
 * churn.
 */
export function applyRootPresentation(
  presentation: Pick<WidgetSnapshot, 'theme' | 'palette' | 'reducedMotion'>,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): () => void {
  const scheme = resolveWidgetScheme(presentation.theme, systemDark)
  root.setAttribute('data-theme', scheme)
  const colors = presentation.palette[scheme]
  if (presentation.palette.appIcon[scheme]) root.dataset.brand = APP_ICON_BRAND_ATTRIBUTE
  else delete root.dataset.brand
  for (const role of WIDGET_THEME_ROLES) {
    const value = colors[role]
    const variable = themeRoleVariable(role)
    if (isCanonicalThemeColor(value) && root.style.getPropertyValue(variable) !== value) root.style.setProperty(variable, value)
  }
  if (presentation.reducedMotion === 'on') root.setAttribute('data-reduced-motion', 'on')
  else root.removeAttribute('data-reduced-motion')

  return () => {
    root.removeAttribute('data-theme')
    root.removeAttribute('data-brand')
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
      onRetry: () => { void bridge.requestRetry().catch(() => undefined) },
      onDismiss: () => { void bridge.requestDismiss().catch(() => undefined) },
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

const previewNames = ['idle', 'listening', 'processing', 'pasted', 'copied', 'error', 'kept'] as const
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
      return { ...common, status: 'listening', startedAt: 1_000, speaking: true, cancellable: true }
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
    case 'kept':
      return { ...common, status: 'error', code: 'TRANSCRIPTION_FAILED', kept: true, cancellable: false }
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
