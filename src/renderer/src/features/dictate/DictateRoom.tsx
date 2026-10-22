import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  MICROPHONE_NOT_SET_UP_DETAIL,
  SPEECH_MODEL_NOT_READY_DETAIL,
  TRANSCRIPTION_ERROR_DETAIL,
  TRANSCRIPTION_KEPT_DETAIL,
  isTranscriptionErrorCode,
  type DictationState,
} from '../../../../shared/dictation'
import { speechModelSummary } from '../../components/SpeechModelStatus'
import type { SpeechModelStatus } from '../../../../shared/speechModel'
import type { HistoryEntry } from '../../../../shared/history'
import type { DictationRecord } from '../../../../shared/dictationRecord'
import type { SottoPlatform } from '../../../../shared/platform'
import type { AppSettings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ShortcutKey } from '../../components/ShortcutKey'
import { VoiceWave, type VoiceWaveStage } from '../../components/VoiceWave'
import { platformCopy, type PlatformCopy } from '../../platformCopy'
import { linuxKeyWords } from '../omarchy/linuxKeys'
import type { HistoryStatus } from '../../state/AppContext'
import { Journal } from './Journal'
import { JournalStats } from './JournalStats'
import { journalStats, startOfDay } from './journalFacts'

export { countWords } from '../../../../shared/dictationRecord'

export interface DictateRoomProps {
  readonly settings: AppSettings
  /** Where the speech model stands (ADR-0071); null until main answers, which counts as ready. */
  readonly speechModel: SpeechModelStatus | null
  /** The chosen model's name, for the line that says it is ready. */
  readonly speechModelName?: string
  readonly platform: SottoPlatform
  readonly dictation: DictationState
  /** Saved transcripts, for the Journal. */
  readonly entries: readonly HistoryEntry[]
  /** Every dictation record (ADR-0100), for the stats column and each row's app. */
  readonly records?: readonly DictationRecord[]
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
  /** Deletes a transcript and its record. */
  readonly onDelete?: (id: string) => Promise<boolean>
  /** Clear history: every transcript and every record. */
  readonly onClear?: () => Promise<boolean>
  /** Controlled Journal search text, so it survives leaving the room. */
  readonly query?: string | undefined
  readonly onQueryChange?: ((query: string) => void) | undefined
  /** The instant the Journal counts days from; captures pin it. */
  readonly now?: number | undefined
}

const NO_RECORDS: readonly DictationRecord[] = []
const TIMER_TICK_MS = 250
/** How long after an error appears an Escape is still taken as meant for the work before it. */
const ESCAPE_GRACE_MS = 500

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1_000)) : 0
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function errorDetail(code: string, copy: PlatformCopy, kept = false, retried = false): string {
  if (kept && isTranscriptionErrorCode(code)) {
    return retried ? `Try again failed too. ${TRANSCRIPTION_KEPT_DETAIL[code]}` : TRANSCRIPTION_KEPT_DETAIL[code]
  }
  switch (code) {
    case 'MIC_PERMISSION_DENIED': return copy.homeMicrophonePermissionDenied
    case 'MIC_DEVICE_NOT_FOUND': return 'The selected microphone is unavailable. Choose another microphone in Settings.'
    case 'MIC_NOT_SET_UP': return MICROPHONE_NOT_SET_UP_DETAIL
    case 'SPEECH_MODEL_NOT_READY': return SPEECH_MODEL_NOT_READY_DETAIL
    case 'NO_SPEECH': return 'No speech was detected. Try again a little closer to the microphone.'
    case 'OUTPUT_FAILED':
    case 'OUTPUT_UNAVAILABLE': return 'Your completed text is below. Copy it again, or select and copy it yourself.'
    case 'DESKTOP_CLIPBOARD_UNAVAILABLE': return 'The desktop clipboard could not be updated. Your text is kept below. Use Copy text to try again, or select and copy it yourself.'
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
  speechModelReady = true,
  speechModelChosen = true,
  /** The delivered app of the dictation that just finished, when its record has one. */
  deliveredApp?: string,
): { sentence: string; detail?: string; tone: 'normal' | 'error' } {
  // Setup was finished without a microphone, so the resting room says so
  // rather than offering a start that could only fail.
  if (microphoneSkipped && state.status === 'idle') {
    return { sentence: 'No microphone is set up.', detail: MICROPHONE_NOT_SET_UP_DETAIL, tone: 'normal' }
  }
  // The same for a speech model still downloading, starting or stopped; the pill
  // and the line beside it say which (ADR-0071).
  // Nothing downloads by itself, so with no model chosen the room says where to choose one.
  if (!speechModelChosen && state.status === 'idle') {
    return { sentence: 'No speech model is chosen.', detail: 'Choose one in Settings → Transcription.', tone: 'normal' }
  }
  if (!speechModelReady && state.status === 'idle') {
    return { sentence: 'The speech model is not ready yet.', tone: 'normal' }
  }
  switch (state.status) {
    case 'requesting-permission': return { sentence: 'Connecting to your microphone.', detail: copy.homeRequestingPermissionDetail, tone: 'normal' }
    case 'listening': return { sentence: 'Listening.', tone: 'normal' }
    case 'processing': return { sentence: 'Turning speech into text.', tone: 'normal' }
    case 'success': return { sentence: state.output === 'pasted' ? deliveredApp === undefined ? 'Pasted.' : `Pasted into ${deliveredApp}.` : 'Copied.', tone: 'normal' }
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
 * The Dictate room as a Journal (#1293): a compact dictate bar (the small wave, one sentence saying what the machine
 * is doing, the button and the shortcut), then every transcript by day, with the stats column beside it. Errors, a
 * kept recording and text to recover keep the bar's sentence and buttons, and the recovered text sits under the bar.
 */
export function DictateRoom({
  settings,
  speechModel,
  speechModelName,
  platform,
  dictation,
  entries,
  records = NO_RECORDS,
  recovery = [],
  onDismissRecovery,
  historyStatus,
  onStart,
  onStop,
  onRetry,
  onDismiss,
  onOpenSettings,
  onCopy,
  onDelete,
  onClear,
  query,
  onQueryChange,
  now: pinnedNow,
}: DictateRoomProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const copy = platformCopy(platform)
  const configured = speechModel === null || speechModel.state === 'ready'
  const modelLabel = speechModel?.state === 'downloading' ? 'Downloading speech model' : speechModel?.state === 'loading' ? 'Starting speech model' : 'Speech model needed'
  const stage = waveStage(dictation)
  const listening = dictation.status === 'listening'
  const sessionId = 'sessionId' in dictation ? dictation.sessionId : undefined
  const microphoneSkipped = settings.microphoneSkipped
  // Linux's keys are Hyprland bindings Sotto writes from Settings › Dictation; F9 and Super+Ctrl+X until changed.
  const linuxKeys = linuxKeyWords(settings)
  const linuxStop = linuxKeys.hold === undefined ? `Press ${linuxKeys.press} to stop.` : `Release ${linuxKeys.hold}, or press ${linuxKeys.press} to stop.`
  const linuxStart = linuxKeys.hold === undefined ? `press ${linuxKeys.press} to talk` : `hold ${linuxKeys.hold} to talk, or press ${linuxKeys.press}`
  // The dictation that just finished shares its id with its record, which says where it went and how it went.
  const finished = dictation.status === 'success' ? records.find((record) => record.id === dictation.sessionId) : undefined
  const said = dictateSentence(dictation, copy, microphoneSkipped, configured, speechModel?.state !== 'missing', finished?.app)

  useEffect(() => {
    if (!listening) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TIMER_TICK_MS)
    return () => clearInterval(timer)
  }, [listening, sessionId])

  // The Journal's days move on with the clock: once a minute is close enough for Today and Yesterday.
  useEffect(() => {
    if (pinnedNow !== undefined) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [pinnedNow])
  // To the minute for the feed's labels, and to the day for the stats, so neither the recording timer's ticks nor the
  // minute count the year of records again; only a dictation, a delete or a new day does.
  const journalNow = pinnedNow ?? Math.floor(now / 60_000) * 60_000
  const statsDay = startOfDay(journalNow)
  const typingWpm = settings.typingSpeedWpm
  const stats = useMemo(() => journalStats(records, statsDay, typingWpm), [records, statsDay, typingWpm])
  // The microphone level arrives many times a second and the app hands down new handlers with it. The Journal and
  // its stats are memoised, so they take handlers that never change and call whatever the room was last given:
  // a level, a timer tick or a new sentence then redraws the bar alone, never a long feed.
  const latest = useRef({ onCopy, onDelete, onClear, onQueryChange, onOpenSettings })
  useLayoutEffect(() => { latest.current = { onCopy, onDelete, onClear, onQueryChange, onOpenSettings } })
  const journalHandlers = useMemo(() => ({
    onCopy: (text: string) => latest.current.onCopy(text),
    onDelete: (id: string) => latest.current.onDelete?.(id) ?? Promise.resolve(false),
    onClear: () => latest.current.onClear?.() ?? Promise.resolve(false),
    onQueryChange: (value: string) => latest.current.onQueryChange?.(value),
    onOpenSettings: () => latest.current.onOpenSettings(),
  }), [])

  const invoke = async (operation: () => Promise<void>): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try { await operation() } finally { setSubmitting(false) }
  }

  let actionLabel = microphoneSkipped ? 'Microphone needed' : configured ? 'Start dictation' : modelLabel
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
      // An open dialog, ARIA or native (the folder browser is a <dialog>), owns
      // Escape; a non-modal panel such as the theme editor only does while it has focus.
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], dialog[open]') !== null) return
      // Decide once every other handler has had the press: one that claimed it,
      // such as the client-update card or an open Journal row closing, keeps it.
      setTimeout(() => {
        if (!event.defaultPrevented) void dismiss()
      }, 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss, errorKey])
  const modelProblem = !configured || (dictation.status === 'error' && dictation.code === 'TRANSCRIPTION_MODEL_NOT_READY')

  const liveProps = said.tone === 'error'
    ? { role: 'alert' as const, 'aria-live': 'assertive' as const }
    : { 'aria-live': 'polite' as const }

  const elapsedMs = listening ? now - dictation.startedAt : 0

  // Under the sentence: the shortcut. It starts a new dictation, which lets a kept recording go, so it is not offered
  // as another way to press Try again; a kept recording that failed because the speech model was not ready still
  // points at Settings.
  let hint: ReactNode = null
  let settingsButton = false
  if (dictation.status === 'error' && dictation.code === 'DESKTOP_CLIPBOARD_UNAVAILABLE') {
    hint = null
  } else if (kept) {
    settingsButton = modelProblem
  } else if (configured && !microphoneSkipped) {
    if (platform === 'linux') {
      hint = listening
        ? settings.autoPaste
          ? `${linuxStop} Sotto copies, then pastes into the focused window on Hyprland.`
          : `${linuxStop} Sotto copies your text. Paste with Super+V, Omarchy’s universal paste.`
        : `With Sotto’s compositor bindings: ${linuxStart}. Automatic paste works on Hyprland, terminals included. If needed, use Super+V, Omarchy’s universal paste.`
    } else {
      hint = <>or press <ShortcutKey accelerator={settings.hotkey} platform={platform} /> {listening ? 'again' : 'in any app'}</>
    }
  } else {
    hint = microphoneSkipped ? null : speechModelSummary(speechModel, speechModelName)
    settingsButton = true
  }

  return (
    <section className="dictate" aria-label="Dictation" data-status={dictation.status} data-stage={stage}>
      <div className="dictate__layout">
        <div className="dictate__bar">
          <VoiceWave
            stage={stage}
            value={listening ? dictation.level : 0}
            label="Microphone activity"
            size="deck"
          />
          <div className="dictate__words">
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
            {hint === null ? null : <p className="dictate__hint">{hint}</p>}
          </div>
          <div className="dictate__actions">
            <Button disabled={actionDisabled} onClick={() => void invoke(action)}>{actionLabel}</Button>
            {dismiss === undefined ? null : (
              <Button variant="secondary" disabled={submitting} onClick={() => void invoke(dismiss)}>
                {kept ? 'Discard recording' : 'Dismiss'}
              </Button>
            )}
            {settingsButton ? <Button variant="secondary" onClick={onOpenSettings}>Open Settings</Button> : null}
          </div>
        </div>
        {recovery.length > 0 ? (
          <section className="dictate__recovery" aria-label="Completed text to recover">
            <h2>Your text is still here</h2>
            <p>Copy it when you are ready. It stays here until you dismiss it or close Sotto.</p>
            {recovery.map(entry => <RecoveredTranscript key={entry.id} entry={entry} onCopy={onCopy} onDismiss={() => onDismissRecovery?.(entry.id)} />)}
          </section>
        ) : null}
        <div className="dictate__stats">
          <JournalStats stats={stats} typingWpm={typingWpm} />
        </div>
        <div className="dictate__journal">
          <Journal
            entries={entries}
            records={records}
            historyEnabled={settings.historyEnabled}
            status={historyStatus}
            now={journalNow}
            chips={stats.chips}
            query={query}
            onQueryChange={journalHandlers.onQueryChange}
            onCopy={journalHandlers.onCopy}
            onDelete={journalHandlers.onDelete}
            onClear={journalHandlers.onClear}
            onOpenSettings={journalHandlers.onOpenSettings}
          />
        </div>
      </div>
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
