import React, { useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  MICROPHONE_NOT_SET_UP_DETAIL,
  TRANSCRIPTION_ERROR_DETAIL,
  TRANSCRIPTION_KEPT_DETAIL,
  isTranscriptionErrorCode,
  type DictationState,
} from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ShortcutKey } from '../../components/ShortcutKey'
import { VoiceWave, type VoiceWaveStage } from '../../components/VoiceWave'
import { platformCopy, type PlatformCopy } from '../../platformCopy'
import type { HistoryStatus } from '../../state/AppContext'

export interface DictateRoomProps {
  readonly settings: AppSettings
  readonly platform: SottoPlatform
  readonly dictation: DictationState
  readonly entries: readonly HistoryEntry[]
  readonly recovery?: readonly HistoryEntry[]
  readonly onDismissRecovery?: (id: string) => void
  readonly historyStatus: HistoryStatus
  readonly onStart: () => Promise<void>
  readonly onStop: () => Promise<void>
  /** Sends a kept recording again. */
  readonly onRetry?: () => Promise<void>
  /** Clears an error, letting go of a kept recording. */
  readonly onDismiss?: () => Promise<void>
  readonly onOpenSettings: () => void
  readonly onCopy: (text: string) => Promise<boolean>
}

const TIMER_TICK_MS = 250
/** How long after an error appears an Escape is still taken as meant for the work before it. */
const ESCAPE_GRACE_MS = 500

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1_000)) : 0
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

/** The transcript stamp: clock time today, "Yesterday" before that, then a short date. */
export function transcriptStamp(createdAt: number, now: number): { dateTime?: string; label: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { label: 'Saved' }
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dateTime = date.toISOString()
  if (createdAt >= startOfToday.valueOf()) {
    return { dateTime, label: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  }
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  if (createdAt >= startOfYesterday.valueOf()) return { dateTime, label: 'Yesterday' }
  return { dateTime, label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
}

function errorDetail(code: string, copy: PlatformCopy, kept = false, retried = false): string {
  if (kept && isTranscriptionErrorCode(code)) {
    return retried ? `Try again did not get through. ${TRANSCRIPTION_KEPT_DETAIL[code]}` : TRANSCRIPTION_KEPT_DETAIL[code]
  }
  switch (code) {
    case 'MIC_PERMISSION_DENIED': return copy.homeMicrophonePermissionDenied
    case 'MIC_DEVICE_NOT_FOUND': return 'The selected microphone is unavailable. Choose another microphone in Settings.'
    case 'MIC_NOT_SET_UP': return MICROPHONE_NOT_SET_UP_DETAIL
    case 'NO_SPEECH': return 'No speech was detected. Try again a little closer to the microphone.'
    case 'OUTPUT_FAILED':
    case 'OUTPUT_UNAVAILABLE': return 'Your completed text is below. Copy it again, or select and copy it yourself.'
    default: return isTranscriptionErrorCode(code)
      ? TRANSCRIPTION_ERROR_DETAIL[code]
      : TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_FAILED
  }
}

/** The one sentence the room says, plus an optional second line under it. */
export function dictateSentence(
  state: DictationState,
  copy: PlatformCopy,
  microphoneSkipped = false,
): { sentence: string; detail?: string; tone: 'normal' | 'error' } {
  // Setup was finished without a microphone, so the resting room says so
  // rather than offering a start that could only fail.
  if (microphoneSkipped && state.status === 'idle') {
    return { sentence: 'No microphone is set up.', detail: MICROPHONE_NOT_SET_UP_DETAIL, tone: 'normal' }
  }
  switch (state.status) {
    case 'requesting-permission': return { sentence: 'Connecting to your microphone.', detail: copy.homeRequestingPermissionDetail, tone: 'normal' }
    case 'listening': return { sentence: 'Listening.', tone: 'normal' }
    case 'processing': return { sentence: 'Turning speech into text.', tone: 'normal' }
    case 'success': return { sentence: state.output === 'pasted' ? 'Pasted.' : 'Copied.', tone: 'normal' }
    case 'cancelled': return { sentence: 'Cancelled.', tone: 'normal' }
    case 'error': return { sentence: 'Dictation needs attention.', detail: errorDetail(state.code, copy, state.kept === true, state.retried === true), tone: 'error' }
    default: return { sentence: 'Ready when you are.', tone: 'normal' }
  }
}

function waveStage(state: DictationState): VoiceWaveStage {
  if (state.status === 'listening') return 'listening'
  if (state.status === 'processing' || state.status === 'requesting-permission') return 'processing'
  return 'idle'
}

/**
 * The Dictate room: the wave at hero size, one sentence saying what the
 * machine is doing, one pill, and the last transcript on a hairline. There is
 * nothing else on the page on purpose; History holds the rest.
 */
export function DictateRoom({
  settings,
  platform,
  dictation,
  entries,
  recovery = [],
  onDismissRecovery,
  historyStatus,
  onStart,
  onStop,
  onRetry,
  onDismiss,
  onOpenSettings,
  onCopy,
}: DictateRoomProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const [copying, setCopying] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const copy = platformCopy(platform)
  const configured = settings.llmApiKey.trim().length > 0
  const stage = waveStage(dictation)
  const listening = dictation.status === 'listening'
  const sessionId = 'sessionId' in dictation ? dictation.sessionId : undefined
  const microphoneSkipped = settings.microphoneSkipped
  const said = dictateSentence(dictation, copy, microphoneSkipped)

  useEffect(() => {
    if (!listening) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TIMER_TICK_MS)
    return () => clearInterval(timer)
  }, [listening, sessionId])

  const latest = useMemo(
    () => entries.reduce<HistoryEntry | null>((best, entry) => (best === null || entry.createdAt > best.createdAt ? entry : best), null),
    [entries],
  )
  const showLatest = settings.historyEnabled && historyStatus === 'ready' && latest !== null

  const invoke = async (operation: () => Promise<void>): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try { await operation() } finally { setSubmitting(false) }
  }

  const copyLatest = async (): Promise<void> => {
    if (copying || latest === null) return
    setCopying(true)
    try { await onCopy(latest.text) } catch { /* the notice belongs to the caller */ } finally { setCopying(false) }
  }

  let actionLabel = microphoneSkipped ? 'Microphone needed' : configured ? 'Start dictation' : 'API key required'
  let actionDisabled = submitting || !configured || microphoneSkipped
  let action = onStart
  if (dictation.status === 'requesting-permission') {
    actionLabel = 'Connecting...'
    actionDisabled = true
  } else if (listening) {
    actionLabel = 'Stop'
    actionDisabled = submitting
    action = onStop
  } else if (dictation.status === 'processing') {
    actionLabel = 'Transcribing...'
    actionDisabled = true
  }
  // A kept recording is sent again from here as well as from the widget.
  const kept = dictation.status === 'error' && dictation.kept === true && onRetry !== undefined
  if (kept) {
    actionLabel = 'Try again'
    actionDisabled = submitting
    action = onRetry
  }
  const dismiss = dictation.status === 'error' && onDismiss !== undefined ? onDismiss : undefined
  // Escape dismisses an error, and lets go of a kept recording, inside this
  // window. Sotto does not claim the key system-wide for it, so other apps keep
  // their Escape while an error waits. An Escape in the first half second is
  // taken as one meant for the work the error replaced, which Sotto held the
  // key for, so it cannot discard a recording that was just kept.
  const errorKey = dictation.status === 'error'
    ? `${dictation.sessionId ?? ''}:${dictation.code}:${String(dictation.kept)}:${String(dictation.retried)}`
    : ''
  useEffect(() => {
    if (dismiss === undefined) return undefined
    const shownAt = Date.now()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return
      if (Date.now() - shownAt < ESCAPE_GRACE_MS) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return
      event.preventDefault()
      void dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss, errorKey])
  const keyProblem = !configured || (dictation.status === 'error'
    && (dictation.code === 'TRANSCRIPTION_UNCONFIGURED' || dictation.code === 'TRANSCRIPTION_UNAUTHORIZED'))

  const liveProps = said.tone === 'error'
    ? { role: 'alert' as const, 'aria-live': 'assertive' as const }
    : { 'aria-live': 'polite' as const }

  const elapsedMs = listening ? now - dictation.startedAt : 0
  const stamp = latest === null ? null : transcriptStamp(latest.createdAt, now)
  const words = latest === null ? 0 : countWords(latest.text)

  return (
    <section className="dictate" aria-label="Dictation" data-status={dictation.status} data-stage={stage}>
      <div className="dictate__hero">
        <VoiceWave
          stage={stage}
          value={listening ? dictation.level : 0}
          label="Microphone activity"
          size="hero"
        />
        <div className="dictate__state" aria-atomic="true" {...liveProps}>
          <h1 className="dictate__sentence">
            {said.sentence}
            {listening ? (
              <time dateTime={`PT${Math.floor(Math.max(0, elapsedMs) / 1_000)}S`} aria-label={`Recording time ${formatElapsed(elapsedMs)}`}>
                {formatElapsed(elapsedMs)}
              </time>
            ) : null}
          </h1>
          {said.detail === undefined ? null : <p className="dictate__detail">{said.detail}</p>}
        </div>
        <div className="dictate__actions">
          <Button disabled={actionDisabled} onClick={() => void invoke(action)}>{actionLabel}</Button>
          {dismiss === undefined ? null : (
            <Button variant="secondary" disabled={submitting} onClick={() => void invoke(dismiss)}>
              {kept ? 'Discard recording' : 'Dismiss'}
            </Button>
          )}
          {/* The shortcut starts a new dictation, which lets a kept recording go,
              so it is not offered as another way to press Try again. A kept
              recording that failed on the key still points at Settings. */}
          {kept ? (keyProblem ? <Button variant="secondary" onClick={onOpenSettings}>Open Settings</Button> : null) : configured && !microphoneSkipped ? (
            <span className="dictate__hint">
              or press <ShortcutKey accelerator={settings.hotkey} platform={platform} /> {listening ? 'again' : 'in any app'}
            </span>
          ) : (
            <Button variant="secondary" onClick={onOpenSettings}>Open Settings</Button>
          )}
        </div>
      </div>
      {recovery.length > 0 ? (
        <section className="dictate__recovery" aria-label="Completed text to recover">
          <h2>Your text is still here</h2>
          <p>Copy it when you are ready. It stays here until you dismiss it or close Sotto.</p>
          {recovery.map(entry => <RecoveredTranscript key={entry.id} entry={entry} onCopy={onCopy} onDismiss={() => onDismissRecovery?.(entry.id)} />)}
        </section>
      ) : null}
      {showLatest && latest !== null && stamp !== null ? (
        <div className="dictate__last" data-testid="dictate-last">
          <div className="dictate__when">
            <b>{stamp.dateTime === undefined ? stamp.label : <time dateTime={stamp.dateTime}>{stamp.label}</time>}</b>
            {words} {words === 1 ? 'word' : 'words'}
          </div>
          <p className="dictate__text">{latest.text}</p>
          <Button variant="secondary" aria-label="Copy transcript" disabled={copying} onClick={() => void copyLatest()}>Copy</Button>
        </div>
      ) : null}
    </section>
  )
}

function RecoveredTranscript({ entry, onCopy, onDismiss }: {
  readonly entry: HistoryEntry
  readonly onCopy: (text: string) => Promise<boolean>
  readonly onDismiss: () => void
}): ReactNode {
  const [state, setState] = useState<'ready' | 'copying' | 'copied' | 'failed'>('ready')
  const copy = async (): Promise<void> => {
    if (state === 'copying') return
    setState('copying')
    try { setState(await onCopy(entry.text) ? 'copied' : 'failed') }
    catch { setState('failed') }
  }
  return <article className="dictate__recovered" aria-label="Recovered transcript">
    <textarea readOnly aria-label="Completed dictation text" value={entry.text} rows={3} />
    <div className="dictate__recovery-actions">
      <Button variant="secondary" disabled={state === 'copying'} onClick={() => void copy()}>Copy text</Button>
      <Button variant="secondary" onClick={onDismiss}>Dismiss text</Button>
      <span role="status">{state === 'copied' ? 'Copied.' : state === 'failed' ? 'Copy failed. Your text is still here. Try again or select and copy it.' : ''}</span>
    </div>
  </article>
}
