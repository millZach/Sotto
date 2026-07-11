export type DictationState =
  | { status: 'idle' }
  | { status: 'requesting-permission'; sessionId: string }
  | { status: 'listening'; sessionId: string; startedAt: number; level: number }
  | { status: 'processing'; sessionId: string; startedAt: number }
  | { status: 'success'; sessionId: string; text: string; output: 'pasted' | 'copied' }
  | { status: 'cancelled'; sessionId: string }
  | { status: 'error'; sessionId?: string; code: string; message: string }

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
