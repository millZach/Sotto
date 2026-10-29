import type { ReducedMotion, Theme } from './settings'
import type { WidgetPalette } from './themeBranding'

export type DictationState =
  | { status: 'idle' }
  | { status: 'requesting-permission'; sessionId: string }
  | { status: 'listening'; sessionId: string; startedAt: number; level: number }
  | { status: 'processing'; sessionId: string; startedAt: number }
  | { status: 'success'; sessionId: string; text: string; output: 'pasted' | 'copied' }
  | { status: 'cancelled'; sessionId: string }
  | {
      status: 'error'
      sessionId?: string | undefined
      code: string
      message: string
      /** The recording is kept in memory and can be sent again (a kept recording). */
      kept?: boolean | undefined
      /** The kept recording was tried again and failed again. */
      retried?: boolean | undefined
    }

export type WidgetProcessingStage =
  | 'preparing-audio'
  | 'loading-model'
  | 'transcribing'
  | 'delivering-output'

/**
 * Every error the widget can show. The widget snapshot schema is built from
 * this list, so a code the controller can raise is always one main accepts.
 */
export const WIDGET_ERROR_CODES = [
  'MIC_PERMISSION_DENIED',
  'MIC_DEVICE_NOT_FOUND',
  'MIC_START_FAILED',
  'MIC_NOT_SET_UP',
  'SPEECH_MODEL_NOT_READY',
  'OPENROUTER_KEY_MISSING',
  'RECORDING_FAILED',
  'NO_SPEECH',
  'TRANSCRIPTION_MODEL_NOT_READY',
  'TRANSCRIPTION_FAILED',
  'TRANSCRIPTION_NO_KEY',
  'TRANSCRIPTION_KEY_REJECTED',
  'TRANSCRIPTION_NO_CREDIT',
  'TRANSCRIPTION_RATE_LIMITED',
  'TRANSCRIPTION_OFFLINE',
  'TRANSCRIPTION_MODEL_GONE',
  'OUTPUT_UNAVAILABLE',
  'OUTPUT_FAILED',
  'DESKTOP_CLIPBOARD_UNAVAILABLE',
  'HISTORY_FAILED',
  'SETTINGS_UNAVAILABLE',
] as const

export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number]

export type TranscriptionErrorCode = Extract<WidgetErrorCode, `TRANSCRIPTION_${string}`>

export function isTranscriptionErrorCode(code: string): code is TranscriptionErrorCode {
  return code.startsWith('TRANSCRIPTION_') && (WIDGET_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * What went wrong transcribing when nothing was kept, in the one wording every
 * surface uses. The controller keeps the recording for every transcription
 * failure today, so TRANSCRIPTION_KEPT_DETAIL is what users read; these stay
 * for a failure that keeps nothing. The dictate room, the widget and the
 * controller's error state all say the same sentence, so a failure reads the
 * same wherever the user happens to see it. Each one says the recording is
 * gone, because dictation audio is never kept.
 */
export const TRANSCRIPTION_ERROR_DETAIL: Readonly<Record<TranscriptionErrorCode, string>> =
  Object.freeze({
    TRANSCRIPTION_MODEL_NOT_READY: 'The speech model stopped before it could transcribe. The recording was not kept. Check the speech model in Settings → Dictation, then dictate again.',
    TRANSCRIPTION_FAILED: 'The speech model could not transcribe this recording. The recording was not kept. Dictate again.',
    TRANSCRIPTION_NO_KEY: 'Transcribing with OpenRouter needs a key. The recording was not kept. Add a key in Settings → Dictation, then dictate again.',
    TRANSCRIPTION_KEY_REJECTED: 'OpenRouter did not accept your key. The recording was not kept. Check the key in Settings → Cleanup, then dictate again.',
    TRANSCRIPTION_NO_CREDIT: 'Your OpenRouter account is out of credit. The recording was not kept. Add credit at openrouter.ai, then dictate again.',
    TRANSCRIPTION_RATE_LIMITED: 'OpenRouter was too busy to take the recording. The recording was not kept. Wait a moment, then dictate again.',
    TRANSCRIPTION_OFFLINE: 'Sotto could not reach OpenRouter. The recording was not kept. Check your connection, then dictate again.',
    TRANSCRIPTION_MODEL_GONE: 'OpenRouter no longer offers the chosen speech model. The recording was not kept. Pick another in Settings → Dictation, then dictate again.',
  })

/**
 * What every surface says when a transcription failure leaves the recording
 * kept: the same failure, but the recording is still in memory and Try again
 * sends it, so none of these say it was lost.
 */
export const TRANSCRIPTION_KEPT_DETAIL: Readonly<Record<TranscriptionErrorCode, string>> =
  Object.freeze({
    TRANSCRIPTION_MODEL_NOT_READY: 'The speech model is not ready. Your recording is kept until you try again or discard it. Check the speech model in Settings → Dictation, then try again.',
    TRANSCRIPTION_FAILED: 'The speech model could not transcribe this recording. Your recording is kept until you try again or discard it.',
    TRANSCRIPTION_NO_KEY: 'Transcribing with OpenRouter needs a key. Your recording is kept until you try again or discard it. Add a key in Settings → Dictation, then try again.',
    TRANSCRIPTION_KEY_REJECTED: 'OpenRouter did not accept your key. Your recording is kept until you try again or discard it. Check the key in Settings → Cleanup, then try again.',
    TRANSCRIPTION_NO_CREDIT: 'Your OpenRouter account is out of credit. Your recording is kept until you try again or discard it. Add credit at openrouter.ai, then try again.',
    TRANSCRIPTION_RATE_LIMITED: 'OpenRouter was too busy to take the recording. Your recording is kept until you try again or discard it. Wait a moment, then try again.',
    TRANSCRIPTION_OFFLINE: 'Sotto could not reach OpenRouter. Your recording is kept until you try again or discard it. Check your connection, then try again.',
    TRANSCRIPTION_MODEL_GONE: 'OpenRouter no longer offers the chosen speech model. Your recording is kept until you try again or discard it. Pick another in Settings → Dictation, then try again.',
  })

/**
 * What every surface says when dictation starts before the speech model is
 * ready: nothing is recorded, and the one place to choose a model says where
 * the chosen one stands.
 */
/**
 * What every surface says when dictation starts while an OpenRouter speech model transcribes and no key is saved
 * (ADR-0160): nothing is recorded, and the key goes in beside the switch.
 */
export const OPENROUTER_KEY_MISSING_DETAIL = 'Transcribing with OpenRouter needs a key, so nothing was recorded. Add one in Settings → Dictation.'

export const SPEECH_MODEL_NOT_READY_DETAIL = 'The speech model is not ready yet, so nothing was recorded. Choose one, or see where it stands, in Settings → Dictation.'

/**
 * What every surface says when setup was finished without a microphone. The
 * dictate room, the widget and the hotkey all point at the one place that can
 * clear the state, so the recovery is worded once.
 */
export const MICROPHONE_NOT_SET_UP_DETAIL = 'Run the microphone test in Settings to set one up.'

interface WidgetSnapshotMetadata {
  readonly theme: Theme
  /** The selected themes' widget roles for both halves; the widget paints the half its scheme resolves to. */
  readonly palette: WidgetPalette
  readonly reducedMotion: ReducedMotion
  readonly shortcut: string
  readonly cancellable: boolean
}

/**
 * The only dictation representation permitted to cross the widget boundary.
 * Transcript text and captured audio are deliberately absent from every variant.
 */
export type WidgetSnapshot = WidgetSnapshotMetadata &
  (
    | { readonly status: 'idle' }
    | { readonly status: 'requesting-permission'; readonly sessionId: string }
    | {
        readonly status: 'listening'
        readonly sessionId: string
        readonly startedAt: number
        readonly level: number
      }
    | {
        readonly status: 'processing'
        readonly sessionId: string
        readonly startedAt: number
        readonly stage: WidgetProcessingStage
        readonly progress: number
        /** Set while an OpenRouter speech model transcribes (ADR-0160), so the widget does not say the audio stays here. */
        readonly cloud?: true | undefined
      }
    | {
        readonly status: 'success'
        readonly sessionId: string
        readonly output: 'pasted' | 'copied'
      }
    | { readonly status: 'cancelled'; readonly sessionId: string }
    | {
        readonly status: 'error'
        readonly sessionId?: string | undefined
        readonly code: WidgetErrorCode
        /** Linux shell copy distinguishes a missing microphone from one lost after capture began. */
        readonly captureStarted?: boolean | undefined
        /** Whether the recording is kept, so the widget offers Try again. */
        readonly kept?: boolean | undefined
        /** Whether Try again was pressed and failed too, so the pill says so. */
        readonly retried?: boolean | undefined
      }
  )

export type DictationEvent =
  | { type: 'REQUESTED'; sessionId: string }
  | { type: 'STARTED'; sessionId: string; startedAt: number }
  | { type: 'LEVEL_CHANGED'; sessionId: string; level: number }
  | { type: 'STOPPED'; sessionId: string }
  | {
      type: 'TRANSCRIBED'
      sessionId: string
      text: string
      output?: 'pasted' | 'copied'
    }
  | { type: 'CANCELLED'; sessionId: string }
  | { type: 'FAILED'; sessionId: string; code: string; message: string; kept?: boolean; retried?: boolean }
  /** Try again on a kept recording: back to processing for the same session. */
  | { type: 'RETRIED'; sessionId: string; startedAt: number }
  | { type: 'RESET' }

type ActiveDictationState = Extract<
  DictationState,
  { status: 'requesting-permission' | 'listening' | 'processing' }
>

export const initialDictationState: DictationState = { status: 'idle' }

function isActiveState(state: DictationState): state is ActiveDictationState {
  return (
    state.status === 'requesting-permission' ||
    state.status === 'listening' ||
    state.status === 'processing'
  )
}

export function reduceDictation(
  state: DictationState,
  event: DictationEvent,
): DictationState {
  switch (event.type) {
    case 'REQUESTED':
      return state.status === 'idle'
        ? { status: 'requesting-permission', sessionId: event.sessionId }
        : state

    case 'STARTED':
      if (state.status !== 'requesting-permission' || state.sessionId !== event.sessionId) {
        return state
      }

      return {
        status: 'listening',
        sessionId: event.sessionId,
        startedAt: event.startedAt,
        level: 0,
      }

    case 'LEVEL_CHANGED': {
      if (
        state.status !== 'listening' ||
        state.sessionId !== event.sessionId ||
        !Number.isFinite(event.level)
      ) {
        return state
      }

      const level = Math.min(1, Math.max(0, event.level))
      return level === state.level ? state : { ...state, level }
    }

    case 'STOPPED':
      if (state.status === 'processing' && state.sessionId === event.sessionId) {
        return state
      }
      if (state.status !== 'listening' || state.sessionId !== event.sessionId) {
        return state
      }
      return {
        status: 'processing',
        sessionId: state.sessionId,
        startedAt: state.startedAt,
      }

    case 'TRANSCRIBED':
      if (state.status !== 'processing' || state.sessionId !== event.sessionId) {
        return state
      }
      return {
        status: 'success',
        sessionId: state.sessionId,
        text: event.text,
        output: event.output ?? 'copied',
      }

    case 'CANCELLED':
      if (state.status === 'cancelled' && state.sessionId === event.sessionId) {
        return state
      }
      if (!isActiveState(state) || state.sessionId !== event.sessionId) {
        return state
      }
      return { status: 'cancelled', sessionId: state.sessionId }

    case 'FAILED':
      if (!isActiveState(state) || state.sessionId !== event.sessionId) {
        return state
      }
      return {
        status: 'error',
        sessionId: state.sessionId,
        code: event.code,
        message: event.message,
        ...(event.kept === true ? { kept: true } : {}),
        ...(event.kept === true && event.retried === true ? { retried: true } : {}),
      }

    case 'RETRIED':
      if (state.status !== 'error' || state.kept !== true || state.sessionId !== event.sessionId) {
        return state
      }
      return { status: 'processing', sessionId: event.sessionId, startedAt: event.startedAt }

    case 'RESET':
      return state.status === 'success' || state.status === 'cancelled' || state.status === 'error'
        ? initialDictationState
        : state

    default: {
      const exhaustiveEvent: never = event
      void exhaustiveEvent
      return state
    }
  }
}
