import { describe, expect, it } from 'vitest'

import {
  initialDictationState,
  reduceDictation,
  type DictationEvent,
  type DictationState,
} from '../../../src/shared/dictation'
import {
  outputDeliveryRequestSchema,
  widgetSnapshotSchema,
} from '../../../src/shared/contracts'

function requestSession(sessionId = 'current'): DictationState {
  return reduceDictation(initialDictationState, { type: 'REQUESTED', sessionId })
}

function startListening(sessionId = 'current', startedAt = 100): DictationState {
  return reduceDictation(requestSession(sessionId), { type: 'STARTED', sessionId, startedAt })
}

describe('dictation reducer', () => {
  it('starts idle and requests permission for a new session', () => {
    expect(initialDictationState).toEqual({ status: 'idle' })

    const requested = reduceDictation(initialDictationState, {
      type: 'REQUESTED',
      sessionId: 'session-1',
    })

    expect(requested).toEqual({ status: 'requesting-permission', sessionId: 'session-1' })
    expect(
      reduceDictation(requested, { type: 'REQUESTED', sessionId: 'session-2' }),
    ).toBe(requested)
  })

  it('ignores STARTED while idle with the exact idle reference', () => {
    expect(
      reduceDictation(initialDictationState, {
        type: 'STARTED',
        sessionId: 'unrequested',
        startedAt: 100,
      }),
    ).toBe(initialDictationState)
  })

  it('starts listening only for the matching permission request', () => {
    const requested = reduceDictation(initialDictationState, {
      type: 'REQUESTED',
      sessionId: 'current',
    })

    expect(
      reduceDictation(requested, { type: 'STARTED', sessionId: 'current', startedAt: 250 }),
    ).toEqual({ status: 'listening', sessionId: 'current', startedAt: 250, level: 0 })
    expect(
      reduceDictation(requested, { type: 'STARTED', sessionId: 'stale', startedAt: 250 }),
    ).toBe(requested)
  })

  it('changes only a matching listening level and clamps finite values', () => {
    const listening = startListening()
    const middle = reduceDictation(listening, {
      type: 'LEVEL_CHANGED',
      sessionId: 'current',
      level: 0.4,
    })

    expect(middle).toEqual({ ...listening, level: 0.4 })
    expect(
      reduceDictation(middle, { type: 'LEVEL_CHANGED', sessionId: 'current', level: -5 }),
    ).toEqual({ ...listening, level: 0 })
    expect(
      reduceDictation(middle, { type: 'LEVEL_CHANGED', sessionId: 'current', level: 12 }),
    ).toEqual({ ...listening, level: 1 })
    expect(
      reduceDictation(middle, { type: 'LEVEL_CHANGED', sessionId: 'stale', level: 0.8 }),
    ).toBe(middle)
    expect(
      reduceDictation(middle, { type: 'LEVEL_CHANGED', sessionId: 'current', level: 0.4 }),
    ).toBe(middle)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores the non-finite listening level %s',
    (level) => {
      const listening = startListening()

      expect(
        reduceDictation(listening, { type: 'LEVEL_CHANGED', sessionId: 'current', level }),
      ).toBe(listening)
    },
  )

  it('stops only a matching listening session and preserves startedAt', () => {
    const listening = startListening('current', 123)

    expect(reduceDictation(listening, { type: 'STOPPED', sessionId: 'stale' })).toBe(listening)

    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    expect(processing).toEqual({ status: 'processing', sessionId: 'current', startedAt: 123 })
    expect(reduceDictation(processing, { type: 'STOPPED', sessionId: 'current' })).toBe(processing)
  })

  it('rejects a stale transcription result', () => {
    const listening = startListening()
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })

    expect(
      reduceDictation(processing, { type: 'TRANSCRIBED', sessionId: 'stale', text: 'wrong' }),
    ).toBe(processing)
  })

  it('succeeds with copied output by default or the supplied output', () => {
    const processing: DictationState = {
      status: 'processing',
      sessionId: 'current',
      startedAt: 100,
    }

    expect(
      reduceDictation(processing, {
        type: 'TRANSCRIBED',
        sessionId: 'current',
        text: 'Copied text',
      }),
    ).toEqual({
      status: 'success',
      sessionId: 'current',
      text: 'Copied text',
      output: 'copied',
    })
    expect(
      reduceDictation(processing, {
        type: 'TRANSCRIBED',
        sessionId: 'current',
        text: 'Pasted text',
        output: 'pasted',
      }),
    ).toEqual({
      status: 'success',
      sessionId: 'current',
      text: 'Pasted text',
      output: 'pasted',
    })
  })

  it('cancels matching requesting, listening, and processing sessions idempotently', () => {
    const listening = startListening()
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    const activeStates = [
      requestSession(),
      listening,
      processing,
    ] satisfies DictationState[]

    for (const active of activeStates) {
      const cancelled = reduceDictation(active, { type: 'CANCELLED', sessionId: 'current' })
      expect(cancelled).toEqual({ status: 'cancelled', sessionId: 'current' })
      expect(reduceDictation(cancelled, { type: 'CANCELLED', sessionId: 'current' })).toBe(
        cancelled,
      )
    }
  })

  it('moves matching active sessions to a safe error state', () => {
    const listening = startListening()
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    const activeStates = [
      requestSession(),
      listening,
      processing,
    ] satisfies DictationState[]

    for (const active of activeStates) {
      expect(
        reduceDictation(active, {
          type: 'FAILED',
          sessionId: 'current',
          code: 'model-unavailable',
          message: 'The local model is unavailable.',
        }),
      ).toEqual({
        status: 'error',
        sessionId: 'current',
        code: 'model-unavailable',
        message: 'The local model is unavailable.',
      })
    }
  })

  it('ignores mismatched session events with the exact state reference', () => {
    const listening = startListening()
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    const cases: Array<{ state: DictationState; event: DictationEvent }> = [
      {
        state: { status: 'requesting-permission', sessionId: 'current' },
        event: { type: 'STARTED', sessionId: 'stale', startedAt: 100 },
      },
      {
        state: { status: 'requesting-permission', sessionId: 'current' },
        event: { type: 'CANCELLED', sessionId: 'stale' },
      },
      {
        state: listening,
        event: { type: 'FAILED', sessionId: 'stale', code: 'failure', message: 'Safe message' },
      },
      {
        state: processing,
        event: { type: 'TRANSCRIBED', sessionId: 'stale', text: 'wrong' },
      },
      {
        state: { status: 'cancelled', sessionId: 'current' },
        event: { type: 'CANCELLED', sessionId: 'stale' },
      },
    ]

    for (const { state, event } of cases) {
      expect(reduceDictation(state, event)).toBe(state)
    }
  })

  it('ignores invalid transitions with the exact state reference', () => {
    const listening = startListening()
    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    const cases: Array<{ state: DictationState; event: DictationEvent }> = [
      {
        state: initialDictationState,
        event: { type: 'STOPPED', sessionId: 'current' },
      },
      {
        state: { status: 'requesting-permission', sessionId: 'current' },
        event: { type: 'STOPPED', sessionId: 'current' },
      },
      {
        state: listening,
        event: { type: 'TRANSCRIBED', sessionId: 'current', text: 'too soon' },
      },
      {
        state: processing,
        event: { type: 'LEVEL_CHANGED', sessionId: 'current', level: 0.2 },
      },
      {
        state: { status: 'success', sessionId: 'current', text: 'done', output: 'copied' },
        event: { type: 'CANCELLED', sessionId: 'current' },
      },
      {
        state: { status: 'cancelled', sessionId: 'current' },
        event: { type: 'FAILED', sessionId: 'current', code: 'late', message: 'Too late' },
      },
      {
        state: { status: 'error', code: 'global', message: 'Safe message' },
        event: { type: 'REQUESTED', sessionId: 'new' },
      },
    ]

    for (const { state, event } of cases) {
      expect(reduceDictation(state, event)).toBe(state)
    }
  })

  it('ignores a runtime-unknown event with the exact state reference', () => {
    const requested = requestSession()
    const unknownEvent = { type: 'RUNTIME_UNKNOWN' } as unknown as DictationEvent

    expect(reduceDictation(requested, unknownEvent)).toBe(requested)
  })

  it('resets only terminal states to the shared idle state', () => {
    const terminalStates: DictationState[] = [
      { status: 'success', sessionId: 'current', text: 'done', output: 'copied' },
      { status: 'cancelled', sessionId: 'current' },
      { status: 'error', sessionId: 'current', code: 'failure', message: 'Safe message' },
      { status: 'error', code: 'global-failure', message: 'Safe global message' },
    ]

    for (const terminal of terminalStates) {
      expect(reduceDictation(terminal, { type: 'RESET' })).toBe(initialDictationState)
    }

    const listening = startListening()
    expect(reduceDictation(listening, { type: 'RESET' })).toBe(listening)
    expect(reduceDictation(initialDictationState, { type: 'RESET' })).toBe(initialDictationState)
  })

  it('does not let a stale STARTED event revive a reset terminal session', () => {
    const terminal: DictationState = {
      status: 'success',
      sessionId: 'completed',
      text: 'done',
      output: 'copied',
    }
    const idle = reduceDictation(terminal, { type: 'RESET' })

    expect(idle).toBe(initialDictationState)
    expect(
      reduceDictation(idle, { type: 'STARTED', sessionId: 'completed', startedAt: 100 }),
    ).toBe(idle)
  })
})

describe('widget snapshot contract', () => {
  const metadata = {
    theme: 'dark',
    reducedMotion: 'on',
    shortcut: 'Control+Shift+Space',
    cancellable: false,
  } as const

  it('accepts bounded processing metadata without transcript or audio', () => {
    expect(widgetSnapshotSchema.parse({
      status: 'processing',
      sessionId: 'session',
      startedAt: 100,
      stage: 'transcribing',
      progress: 0.5,
      ...metadata,
      cancellable: true,
    })).toEqual({
      status: 'processing',
      sessionId: 'session',
      startedAt: 100,
      stage: 'transcribing',
      progress: 0.5,
      ...metadata,
      cancellable: true,
    })
  })

  it.each([
    { status: 'success', sessionId: 'session', output: 'copied', text: 'private', ...metadata },
    {
      status: 'processing',
      sessionId: 'session',
      startedAt: 100,
      stage: 'transcribing',
      progress: 0.5,
      samples: [0.2],
      ...metadata,
    },
  ])('rejects transcript or audio fields', (snapshot) => {
    expect(widgetSnapshotSchema.safeParse(snapshot).success).toBe(false)
  })

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unbounded progress %s',
    (progress) => {
      expect(widgetSnapshotSchema.safeParse({
        status: 'processing',
        sessionId: 'session',
        startedAt: 100,
        stage: 'transcribing',
        progress,
        ...metadata,
      }).success).toBe(false)
    },
  )
})

describe('output delivery request contract', () => {
  it.each([50, 1_000])('accepts bounded paste delay %s', (pasteDelayMs) => {
    expect(outputDeliveryRequestSchema.parse({
      text: 'local words',
      autoPaste: true,
      pasteDelayMs,
    })).toEqual({ text: 'local words', autoPaste: true, pasteDelayMs })
  })

  it.each([
    { text: 'local words', autoPaste: true, pasteDelayMs: 49 },
    { text: 'local words', autoPaste: true, pasteDelayMs: 1_001 },
    { text: 'local words', autoPaste: true, pasteDelayMs: 50.5 },
    { text: 'x'.repeat(200_001), autoPaste: true, pasteDelayMs: 150 },
    { text: 'local words', autoPaste: 'yes', pasteDelayMs: 150 },
    { text: 'local words', autoPaste: true, pasteDelayMs: 150, injected: true },
  ])('rejects an invalid or non-strict request', (request) => {
    expect(outputDeliveryRequestSchema.safeParse(request).success).toBe(false)
  })
})
