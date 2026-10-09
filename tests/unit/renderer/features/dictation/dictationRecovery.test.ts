// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { TranscriptionError } from '../../../../../src/renderer/src/transcription/openRouterTranscriber'

import type { TranscriptionResult } from '../../../../../src/renderer/src/transcription/openRouterTranscriber'
import { widgetSnapshotSchema } from '../../../../../src/shared/contracts'
import { TRANSCRIPTION_KEPT_DETAIL } from '../../../../../src/shared/dictation'
import { createHarness, deferred, recorderOptions, settings, snapshots } from '../../../../fixtures/renderer/dictationControllerHarness'

describe('hosted transcription failures', () => {
  it.each([
    ['unconfigured', 'TRANSCRIPTION_UNCONFIGURED'],
    ['unauthorized', 'TRANSCRIPTION_UNAUTHORIZED'],
    ['network', 'TRANSCRIPTION_OFFLINE'],
    ['timeout', 'TRANSCRIPTION_OFFLINE'],
    ['billing', 'TRANSCRIPTION_BILLING'],
    ['rate-limited', 'TRANSCRIPTION_RATE_LIMITED'],
    ['http', 'TRANSCRIPTION_SERVICE_ERROR'],
    ['malformed', 'TRANSCRIPTION_FAILED'],
  ] as const)('surfaces %s as %s', async (reason, code) => {
    const harness = createHarness({ transcribe: async () => { throw new TranscriptionError(reason) } })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.publishWidgetState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', code }))
    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
  })
})
describe('kept recordings', () => {
  // A dictation of two streamed segments and a tail, where the second segment is turned away once.
  function turnedAway(failures: Array<'rate-limited' | null> = ['rate-limited']) {
    const calls: number[] = []
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: true }),
      transcribe: async (options) => {
        const part = options.audio[0]!
        calls.push(part)
        if (part === 2 && failures.length > 0) {
          const failure = failures.shift()
          if (failure !== null && failure !== undefined) throw new TranscriptionError(failure)
        }
        return { text: `part-${part}`, language: 'en' }
      },
      recorder: {
        stop: vi.fn(async () => ({ samples: new Float32Array([3]), sourceSampleRate: 16_000, durationMs: 18_000 })),
      },
    })
    const record = async () => {
      await harness.controller.start()
      const options = recorderOptions(harness)
      options.onSegment?.({ samples: new Float32Array([1]), sourceSampleRate: 16_000, durationMs: 6_000 })
      options.onSegment?.({ samples: new Float32Array([2]), sourceSampleRate: 16_000, durationMs: 6_000 })
      await harness.controller.stop()
    }
    return { harness, calls, record }
  }

  it('keeps the recording when one part is turned away, and says so without saying it was lost', async () => {
    const { harness, record } = turnedAway()
    await record()
    expect(harness.controller.getState()).toMatchObject({
      status: 'error', code: 'TRANSCRIPTION_RATE_LIMITED', kept: true,
      message: TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_RATE_LIMITED,
    })
    const last = snapshots(harness).at(-1)!
    expect(last).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_RATE_LIMITED', kept: true, cancellable: false })
    expect(widgetSnapshotSchema.safeParse(last).success).toBe(true)
    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
  })

  it('keeps the error on screen until it is dismissed', async () => {
    const { harness, record } = turnedAway()
    await record()
    expect(harness.setTimer).not.toHaveBeenCalled()
    harness.fireTimers()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true })
  })

  it('sends only the part that was turned away on Try again, then delivers every part in order', async () => {
    const { harness, calls, record } = turnedAway()
    await record()
    expect(calls).toEqual([1, 2, 3])

    await harness.controller.retry()
    expect(calls).toEqual([1, 2, 3, 2])
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3' }))
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3', durationMs: 18_000 }))
    expect(harness.controller.getState()).toMatchObject({ status: 'success' })
    expect(snapshots(harness).map((snapshot) => snapshot.status)).toContain('processing')
  })

  it('keeps the recording again when Try again is turned away too', async () => {
    const { harness, calls, record } = turnedAway(['rate-limited', 'rate-limited'])
    await record()
    expect(harness.controller.getState()).not.toHaveProperty('retried')
    await harness.controller.retry()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true, retried: true })
    const again = snapshots(harness).at(-1)!
    expect(again).toMatchObject({ status: 'error', kept: true, retried: true })
    expect(widgetSnapshotSchema.safeParse(again).success).toBe(true)
    await harness.controller.retry()
    expect(calls).toEqual([1, 2, 3, 2, 2])
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3' }))
  })

  it('lets go of a kept recording when the error is dismissed', async () => {
    const { harness, calls, record } = turnedAway()
    await record()
    await harness.controller.dismiss()
    expect(harness.controller.getState()).toEqual({ status: 'idle' })
    expect(snapshots(harness).at(-1)).toMatchObject({ status: 'idle' })
    await harness.controller.retry()
    expect(calls).toEqual([1, 2, 3])
    expect(harness.deliverOutput).not.toHaveBeenCalled()
  })

  it('lets go of a kept recording when a new dictation starts', async () => {
    const { harness, calls, record } = turnedAway()
    await record()
    await harness.controller.toggle()
    expect(harness.controller.getState()).toMatchObject({ status: 'listening' })
    await harness.controller.retry()
    expect(calls).toEqual([1, 2, 3])
  })

  it('returns to the kept recording when a Try again still transcribing is cancelled', async () => {
    const pending = deferred<TranscriptionResult>()
    let call = 0
    const harness = createHarness({
      transcribe: async () => {
        call += 1
        if (call === 1) throw new TranscriptionError('network')
        if (call === 2) return pending.promise
        return { text: 'kept words', language: 'en' }
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_OFFLINE', kept: true })
    const retry = harness.controller.retry()
    expect(harness.controller.getState()).toMatchObject({ status: 'processing' })

    await harness.controller.cancel()
    expect(harness.transcriber.cancel).toHaveBeenCalledWith('session')
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_OFFLINE', kept: true })
    expect(harness.controller.getState()).not.toHaveProperty('retried')

    // The cancelled attempt's late answer decides nothing.
    pending.resolve({ text: 'too late', language: 'en' })
    await retry
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true })
    expect(harness.deliverOutput).not.toHaveBeenCalled()

    await harness.controller.retry()
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'kept words' }))
  })

  it('returns to the kept recording when a Try again is cancelled during cleanup, and delivers nothing late', async () => {
    const cleanup = deferred<{ text: string; applied: boolean }>()
    let polishes = 0
    let call = 0
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => {
        call += 1
        if (call === 1) throw new TranscriptionError('rate-limited')
        return { text: 'kept words', language: 'en' }
      },
      polishTranscript: async (text) => {
        polishes += 1
        return polishes === 1 ? cleanup.promise : { text, applied: false }
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    const retry = harness.controller.retry()
    await vi.waitFor(() => expect(polishes).toBe(1))

    await harness.controller.cancel()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'TRANSCRIPTION_RATE_LIMITED', kept: true })
    // The cancelled attempt stops waiting at once, though the cleanup call runs on.
    await retry
    cleanup.resolve({ text: 'Cleaned words.', applied: true })
    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true })

    // The text that came back is kept, so the next Try again sends nothing to
    // transcription, and it reuses the cleanup call the cancel left running.
    await harness.controller.retry()
    expect(call).toBe(2)
    expect(polishes).toBe(1)
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cleaned words.' }))
  })

  it('tries cleanup afresh when the one a cancelled Try again left running failed', async () => {
    const cleanup = deferred<{ text: string; applied: boolean }>()
    let polishes = 0
    let call = 0
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => {
        call += 1
        if (call === 1) throw new TranscriptionError('rate-limited')
        return { text: 'kept words', language: 'en' }
      },
      polishTranscript: async () => {
        polishes += 1
        return polishes === 1 ? cleanup.promise : { text: 'Cleaned the second time.', applied: true }
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    const retry = harness.controller.retry()
    await vi.waitFor(() => expect(polishes).toBe(1))
    await harness.controller.cancel()
    await retry
    cleanup.resolve({ text: 'kept words', applied: false })
    await Promise.resolve()

    await harness.controller.retry()
    expect(polishes).toBe(2)
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cleaned the second time.' }))
  })

  it('keeps the parts a cancelled Try again had already got back', async () => {
    const lastPart = deferred<TranscriptionResult>()
    const sent: number[] = []
    let retrying = false
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: true }),
      transcribe: async (options) => {
        const part = options.audio[0]!
        sent.push(part)
        if (!retrying && part !== 1) throw new TranscriptionError('rate-limited')
        if (retrying && part === 3 && sent.filter((value) => value === 3).length === 2) return lastPart.promise
        return { text: `part-${part}`, language: 'en' }
      },
      recorder: {
        stop: vi.fn(async () => ({ samples: new Float32Array([3]), sourceSampleRate: 16_000, durationMs: 18_000 })),
      },
    })
    await harness.controller.start()
    const options = recorderOptions(harness)
    options.onSegment?.({ samples: new Float32Array([1]), sourceSampleRate: 16_000, durationMs: 6_000 })
    options.onSegment?.({ samples: new Float32Array([2]), sourceSampleRate: 16_000, durationMs: 6_000 })
    await harness.controller.stop()
    expect(sent).toEqual([1, 2, 3])

    retrying = true
    void harness.controller.retry()
    await vi.waitFor(() => expect(sent).toEqual([1, 2, 3, 2, 3]))
    await Promise.resolve()
    await harness.controller.cancel()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true })

    // Part 2 came back before the cancel, so only part 3 goes again.
    await harness.controller.retry()
    expect(sent).toEqual([1, 2, 3, 2, 3, 3])
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3' }))
  })

  it('still says Try again failed when a later Try again is cancelled', async () => {
    const pending = deferred<TranscriptionResult>()
    let call = 0
    const harness = createHarness({
      transcribe: async () => {
        call += 1
        if (call <= 2) throw new TranscriptionError('rate-limited')
        return pending.promise
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    await harness.controller.retry()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true, retried: true })
    void harness.controller.retry()
    await harness.controller.cancel()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true, retried: true })
  })

  it('keeps nothing for an error that is not a transcription failure', async () => {
    const harness = createHarness({ transcribe: async () => ({ text: '   ', language: 'en' }) })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'NO_SPEECH' })
    expect(harness.controller.getState()).not.toHaveProperty('kept')
    await harness.controller.retry()
    expect(harness.transcriber.transcribe).toHaveBeenCalledOnce()
    await harness.controller.dismiss()
    expect(harness.controller.getState()).toEqual({ status: 'idle' })
  })

  it('ignores a cancel that lands after the failure, so an Escape meant for the work cannot discard what was kept', async () => {
    const { harness, record } = turnedAway()
    await record()
    await harness.controller.cancel()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', kept: true })
    await harness.controller.retry()
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'part-1 part-2 part-3' }))
  })
})
