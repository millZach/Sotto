import type { ReducedMotion, Theme } from './settings'

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

export type WidgetErrorCode =
  | 'MIC_PERMISSION_DENIED'
  | 'MIC_DEVICE_NOT_FOUND'
  | 'MIC_START_FAILED'
  | 'RECORDING_FAILED'
  | 'NO_SPEECH'
  | 'TRANSCRIPTION_FAILED'
  | 'OUTPUT_UNAVAILABLE'
  | 'OUTPUT_FAILED'
  | 'HISTORY_FAILED'
  | 'SETTINGS_UNAVAILABLE'

interface WidgetSnapshotMetadata {
  readonly theme: Theme
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
