import type { ReducedMotion, Theme } from './settings'
import type { WidgetPalette } from './themeBranding'

export type DictationState =
  | { status: 'idle' }
  | { status: 'requesting-permission'; sessionId: string }
  | { status: 'listening'; sessionId: string; startedAt: number; level: number }
  | { status: 'processing'; sessionId: string; startedAt: number }
  | { status: 'success'; sessionId: string; text: string; output: 'pasted' | 'copied' }
  | { status: 'cancelled'; sessionId: string }
  | { status: 'error'; sessionId?: string | undefined; code: string; message: string }

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
  'RECORDING_FAILED',
  'NO_SPEECH',
  'TRANSCRIPTION_UNCONFIGURED',
  'TRANSCRIPTION_UNAUTHORIZED',
  'TRANSCRIPTION_OFFLINE',
  'TRANSCRIPTION_BILLING',
  'TRANSCRIPTION_RATE_LIMITED',
  'TRANSCRIPTION_SERVICE_ERROR',
  'TRANSCRIPTION_FAILED',
  'OUTPUT_UNAVAILABLE',
  'OUTPUT_FAILED',
  'HISTORY_FAILED',
  'SETTINGS_UNAVAILABLE',
] as const

export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number]

export type TranscriptionErrorCode = Extract<WidgetErrorCode, `TRANSCRIPTION_${string}`>

export function isTranscriptionErrorCode(code: string): code is TranscriptionErrorCode {
  return code.startsWith('TRANSCRIPTION_') && (WIDGET_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * What went wrong reaching OpenRouter, in the one wording every surface uses.
 * The dictate room, the widget and the controller's error state all say the
 * same sentence, so a failure reads the same wherever the user happens to see
 * it, and the recovery it names is only ever changed in one place. Each one
 * says the recording is gone, because dictation audio is never kept.
 */
export const TRANSCRIPTION_ERROR_DETAIL: Readonly<Record<TranscriptionErrorCode, string>> =
  Object.freeze({
    TRANSCRIPTION_UNCONFIGURED: 'Sotto has no OpenRouter API key yet. The recording was not kept. Add your key in Settings, then dictate again.',
    TRANSCRIPTION_UNAUTHORIZED: 'OpenRouter rejected the API key. The recording was not kept. Check the key in Settings.',
    TRANSCRIPTION_OFFLINE: 'Sotto could not reach OpenRouter. The recording was not kept. Check your connection and try again.',
    TRANSCRIPTION_BILLING: 'OpenRouter has no credit left for this key. The recording was not kept. Add credit at openrouter.ai, then dictate again.',
    TRANSCRIPTION_RATE_LIMITED: 'OpenRouter is limiting requests on this key. The recording was not kept. Wait a minute, then dictate again.',
    TRANSCRIPTION_SERVICE_ERROR: 'OpenRouter’s transcription service returned an error. The recording was not kept. Dictate again in a moment.',
    TRANSCRIPTION_FAILED: 'Sotto did not get usable text back. The recording was not kept. Dictate again.',
  })

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
  /**
   * Whether the voice coordinator is shown at all. The widget runs in its own
   * renderer and never reads settings, so the snapshot has to carry the answer;
   * an absent field means off, which is the beta's default.
   */
  readonly voiceCoordinator?: boolean | undefined
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
  | { type: 'FAILED'; sessionId: string; code: string; message: string }
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
      }

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
