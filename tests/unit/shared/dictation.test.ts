import { describe, expect, it } from 'vitest'

import {
  initialDictationState,
  reduceDictation,
  type DictationEvent,
  type DictationState,
} from '../../../src/shared/dictation'

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

  it('starts listening from idle as a test seam', () => {
    expect(
      reduceDictation(initialDictationState, {
        type: 'STARTED',
        sessionId: 'direct',
        startedAt: 100,
      }),
    ).toEqual({ status: 'listening', sessionId: 'direct', startedAt: 100, level: 0 })
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
    const listening = reduceDictation(initialDictationState, {
      type: 'STARTED',
      sessionId: 'current',
      startedAt: 100,
    })
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
      const listening = reduceDictation(initialDictationState, {
        type: 'STARTED',
        sessionId: 'current',
        startedAt: 100,
      })

      expect(
        reduceDictation(listening, { type: 'LEVEL_CHANGED', sessionId: 'current', level }),
      ).toBe(listening)
    },
  )

  it('stops only a matching listening session and preserves startedAt', () => {
    const listening = reduceDictation(initialDictationState, {
      type: 'STARTED',
      sessionId: 'current',
      startedAt: 123,
    })

    expect(reduceDictation(listening, { type: 'STOPPED', sessionId: 'stale' })).toBe(listening)

    const processing = reduceDictation(listening, { type: 'STOPPED', sessionId: 'current' })
    expect(processing).toEqual({ status: 'processing', sessionId: 'current', startedAt: 123 })
    expect(reduceDictation(processing, { type: 'STOPPED', sessionId: 'current' })).toBe(processing)
  })

  it('rejects a stale transcription result', () => {
    const listening = reduceDictation(initialDictationState, {
      type: 'STARTED',
      sessionId: 'current',
      startedAt: 100,
    })
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
    const activeStates = [
      { status: 'requesting-permission', sessionId: 'current' },
      { status: 'listening', sessionId: 'current', startedAt: 100, level: 0.5 },
      { status: 'processing', sessionId: 'current', startedAt: 100 },
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
    const activeStates = [
      { status: 'requesting-permission', sessionId: 'current' },
      { status: 'listening', sessionId: 'current', startedAt: 100, level: 0.5 },
      { status: 'processing', sessionId: 'current', startedAt: 100 },
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
        state: { status: 'listening', sessionId: 'current', startedAt: 100, level: 0 },
        event: { type: 'FAILED', sessionId: 'stale', code: 'failure', message: 'Safe message' },
      },
      {
        state: { status: 'processing', sessionId: 'current', startedAt: 100 },
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
        state: { status: 'listening', sessionId: 'current', startedAt: 100, level: 0 },
        event: { type: 'TRANSCRIBED', sessionId: 'current', text: 'too soon' },
      },
      {
        state: { status: 'processing', sessionId: 'current', startedAt: 100 },
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

    const listening: DictationState = {
      status: 'listening',
      sessionId: 'current',
      startedAt: 100,
      level: 0,
    }
    expect(reduceDictation(listening, { type: 'RESET' })).toBe(listening)
    expect(reduceDictation(initialDictationState, { type: 'RESET' })).toBe(initialDictationState)
  })
})
