import { describe, expect, it, vi } from 'vitest'

import { type DictationOutputResult } from '../../../../../src/renderer/src/features/dictation/dictationController'
import type { TranscriptionProgress } from '../../../../../src/renderer/src/transcription/openRouterTranscriber'
import { widgetSnapshotSchema } from '../../../../../src/shared/contracts'
import { createHarness, deferred, recorderOptions, settings, snapshots } from '../../../../fixtures/renderer/dictationControllerHarness'

describe('DictationController', () => {
  it('keeps text and publishes clipboard unavailability without history or transcript on the widget', async () => {
    const harness = createHarness({
      platform: 'linux', currentSettings: settings({ historyEnabled: false }),
      deliverOutput: async () => 'clipboard-unavailable' as const,
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.retainOutput).toHaveBeenCalledOnce()
    expect(harness.retainOutput.mock.calls[0]![0].text).toBeTruthy()
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'DESKTOP_CLIPBOARD_UNAVAILABLE' })
    const widget = snapshots(harness).at(-1)!
    expect(widget).toMatchObject({ status: 'error', code: 'DESKTOP_CLIPBOARD_UNAVAILABLE' })
    expect(widgetSnapshotSchema.safeParse(widget).success).toBe(true)
    expect(widget).not.toHaveProperty('text')
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.setTimer).not.toHaveBeenCalled()
  })

  it('copies a successful result and records returned metadata', async () => {
    const harness = createHarness()

    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.deliverOutput).toHaveBeenCalledWith({
      text: 'hello world',
      autoPaste: true,
      pasteDelayMs: 150,
    })
    expect(harness.addHistory).toHaveBeenCalledWith({
      id: 'session',
      text: 'hello world',
      createdAt: 1_000,
      durationMs: 500,
      language: 'en',
      modelPreset: 'mai',
    })
    expect(harness.controller.getState()).toEqual({
      status: 'success',
      sessionId: 'session',
      text: 'hello world',
      output: 'pasted',
    })
  })

  it('delivers output before it records history', async () => {
    const order: string[] = []
    const harness = createHarness({
      deliverOutput: async () => {
        order.push('output')
        return 'copied' as const
      },
      addHistory: async () => {
        order.push('history')
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(order).toEqual(['output', 'history'])
  })

  it('processes the duration-limit result directly without calling stop again', async () => {
    const harness = createHarness()
    await harness.controller.start()

    recorderOptions(harness).onDurationLimit?.({
      samples: new Float32Array([0.3]),
      sourceSampleRate: 16_000,
      durationMs: 60_000,
    })
    await vi.waitFor(() => expect(harness.controller.getState().status).toBe('success'))

    expect(harness.recorder.stop).not.toHaveBeenCalled()
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
    await harness.controller.stop()
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('treats empty samples and whitespace-only transcripts as no speech', async () => {
    const emptyAudio = createHarness({
      recorder: {
        stop: vi.fn(async () => ({
          samples: new Float32Array(),
          sourceSampleRate: 16_000,
          durationMs: 0,
        })),
      },
    })
    await emptyAudio.controller.start()
    await emptyAudio.controller.stop()
    expect(emptyAudio.transcriber.transcribe).not.toHaveBeenCalled()
    expect(emptyAudio.controller.getState()).toMatchObject({ status: 'error', code: 'NO_SPEECH' })

    const emptyText = createHarness({
      transcribe: async () => ({ text: ' \n\t ', language: 'en' }),
    })
    await emptyText.controller.start()
    await emptyText.controller.stop()
    expect(emptyText.deliverOutput).not.toHaveBeenCalled()
    expect(emptyText.addHistory).not.toHaveBeenCalled()
    expect(emptyText.controller.getState()).toMatchObject({ status: 'error', code: 'NO_SPEECH' })
  })

  it('formats whitespace only when the captured setting enables it', async () => {
    const formatted = createHarness()
    await formatted.controller.start()
    await formatted.controller.stop()
    expect(formatted.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello world',
    }))

    const verbatim = createHarness({ currentSettings: settings({ formatWhitespace: false }) })
    await verbatim.controller.start()
    await verbatim.controller.stop()
    expect(verbatim.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({
      text: '  hello   world  ',
    }))
  })

  it.each(['pasted', 'copied'] as const)(
    'publishes and stores the %s output distinction',
    async (outcome) => {
      const harness = createHarness({ deliverOutput: async () => outcome })
      await harness.controller.start()
      await harness.controller.stop()

      expect(harness.controller.getState()).toMatchObject({ status: 'success', output: outcome })
      expect(snapshots(harness).at(-1)).toMatchObject({ status: 'success', output: outcome })
      expect(harness.addHistory).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['unavailable', async () => ({ ok: false, reason: 'unavailable' }) as const, 'OUTPUT_UNAVAILABLE'],
    ['empty', async () => 'empty' as const, 'OUTPUT_FAILED'],
    ['throwing', async () => { throw new Error('raw clipboard internals') }, 'OUTPUT_FAILED'],
  ])('turns %s output into a finite privacy-safe error', async (_name, delivery, code) => {
    const harness = createHarness({ deliverOutput: delivery })
    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.controller.getState()).toMatchObject({ status: 'error', code })
    expect(JSON.stringify(harness.controller.getState())).not.toContain('raw clipboard internals')
    expect(harness.retainOutput).toHaveBeenCalledWith(expect.objectContaining({ id: 'session', text: 'hello world' }))
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ id: 'session', text: 'hello world' }))
  })

  it('retains each failed completed transcript in memory when history is off', async () => {
    const harness = createHarness({
      currentSettings: settings({ historyEnabled: false }),
      ids: ['first', 'second'],
      deliverOutput: async () => { throw new Error('clipboard unavailable') },
    })
    await harness.controller.start()
    await harness.controller.stop()
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.retainOutput.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ id: 'first', text: 'hello world' }),
      expect.objectContaining({ id: 'second', text: 'hello world' }),
    ])
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(snapshots(harness))).not.toContain('hello world')
  })

  it('retains text despite both output and history failure without masking the output error', async () => {
    const harness = createHarness({
      deliverOutput: async () => { throw new Error('clipboard unavailable') },
      addHistory: async () => { throw new Error('history unavailable') },
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.retainOutput).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }))
    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'OUTPUT_FAILED' })
  })

  it('reports history failure without exposing transcript or thrown details to the widget', async () => {
    const harness = createHarness({
      transcribe: async () => ({ text: 'private transcript', language: 'en' }),
      addHistory: async () => { throw new Error('C:/secret/history.json') },
    })
    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'HISTORY_FAILED' })
    const widget = JSON.stringify(snapshots(harness).at(-1))
    expect(widget).not.toContain('private transcript')
    expect(widget).not.toContain('C:/secret')
  })

  it('skips history when disabled but still delivers output', async () => {
    const harness = createHarness({ currentSettings: settings({ historyEnabled: false }) })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.deliverOutput).toHaveBeenCalledTimes(1)
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.controller.getState().status).toBe('success')
  })

  it('contains optional cue failures and obeys the session cue setting', async () => {
    const cuePlayer = {
      playStart: vi.fn(() => { throw new Error('audio unavailable') }),
      playStop: vi.fn(async () => { throw new Error('audio unavailable') }),
    }
    const enabled = createHarness({ cuePlayer })
    await enabled.controller.start()
    await enabled.controller.stop()
    expect(cuePlayer.playStart).toHaveBeenCalledTimes(1)
    expect(cuePlayer.playStop).toHaveBeenCalledTimes(1)
    expect(enabled.controller.getState().status).toBe('success')

    const disabledCue = { playStart: vi.fn(), playStop: vi.fn() }
    const disabled = createHarness({
      currentSettings: settings({ soundCues: false }),
      cuePlayer: disabledCue,
    })
    await disabled.controller.start()
    await disabled.controller.stop()
    expect(disabledCue.playStart).not.toHaveBeenCalled()
    expect(disabledCue.playStop).not.toHaveBeenCalled()
  })

  it('publishes bounded progress with processing stage metadata', async () => {
    const harness = createHarness({
      transcribe: async (options) => {
        const progress = options.onProgress as (value: TranscriptionProgress) => void
        progress({ stage: 'loading-model', progress: -2 })
        progress({ stage: 'transcribing', progress: 3 })
        return { text: 'done', language: 'en' }
      },
    })
    await harness.controller.start()
    await harness.controller.stop()

    const processing = snapshots(harness).filter((snapshot) => snapshot.status === 'processing')
    expect(processing).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'preparing-audio', progress: 0, cancellable: true }),
      expect.objectContaining({ stage: 'loading-model', progress: 0, cancellable: true }),
      expect.objectContaining({ stage: 'transcribing', progress: 1, cancellable: true }),
      expect.objectContaining({ stage: 'delivering-output', progress: 1, cancellable: false }),
    ]))
  })

  it('suppresses late progress once output delivery has begun', async () => {
    const output = deferred<DictationOutputResult>()
    let reportProgress: ((progress: TranscriptionProgress) => void) | undefined
    const harness = createHarness({
      deliverOutput: () => output.promise,
      transcribe: async (options) => {
        reportProgress = options.onProgress
        return { text: 'done', language: 'en' }
      },
    })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await vi.waitFor(() => expect(harness.deliverOutput).toHaveBeenCalled())
    const publications = harness.publishWidgetState.mock.calls.length

    reportProgress?.({ stage: 'loading-model', progress: 0.1 })
    expect(harness.publishWidgetState).toHaveBeenCalledTimes(publications)
    output.resolve('pasted')
    await stop
  })

  it.each([
    [-18.7, 0],
    [500.6, 501],
    [Number.NaN, 0],
  ])('stores duration %s as the nonnegative integer %s', async (durationMs, expected) => {
    const harness = createHarness({
      recorder: {
        stop: vi.fn(async () => ({
          samples: new Float32Array([0.1]),
          sourceSampleRate: 16_000,
          durationMs,
        })),
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ durationMs: expected }))
  })

  it('contains synchronous and asynchronous publisher failures', async () => {
    let publication = 0
    const harness = createHarness({
      publishWidgetState: () => {
        publication += 1
        if (publication === 1) throw new Error('sync')
        return Promise.reject(new Error('async'))
      },
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.controller.getState().status).toBe('success')
  })
})

describe('pipeline prewarm', () => {

  it('applies the LLM polish pass when enabled and delivers the polished text', async () => {
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => ({ text: 'um hello world', language: 'en' }),
      polishTranscript: async () => ({ text: 'Hello, world.', applied: true }),
    })
    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.polishTranscript).toHaveBeenCalledWith('um hello world', {
      segmentWords: [3],
      segmentRms: [expect.any(Number)],
      durationMs: 500,
    })
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello, world.' }),
    )
  })

  it('collapses hallucinated repetition loops before polish and delivery', async () => {
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => ({
        text: 'wait, no, no, no, no, no, no, no, no groceries',
        language: 'en',
      }),
      polishTranscript: async (text) => ({ text, applied: false }),
    })
    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.polishTranscript).toHaveBeenCalledWith('wait, no, groceries', {
      segmentWords: [10],
      segmentRms: [expect.any(Number)],
      durationMs: 500,
    })
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'wait, no, groceries' }),
    )
  })

  it('delivers the raw transcript when the polish pass fails or is skipped', async () => {
    const failing = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => ({ text: 'hello world', language: 'en' }),
      polishTranscript: async () => {
        throw new Error('offline')
      },
    })
    await failing.controller.start()
    await failing.controller.stop()
    expect(failing.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello world' }),
    )

    const disabled = createHarness({
      currentSettings: settings({ llmFormatting: false }),
      polishTranscript: async () => ({ text: 'never used', applied: true }),
    })
    await disabled.controller.start()
    await disabled.controller.stop()
    expect(disabled.polishTranscript).not.toHaveBeenCalled()
  })

  it('ignores a polish result that was not applied', async () => {
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => ({ text: 'hello world', language: 'en' }),
      polishTranscript: async (text) => ({ text, applied: false }),
    })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello world' }),
    )
  })

  it('transcribes streamed segments in order and joins them with the tail', async () => {
    let call = 0
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: true }),
      transcribe: async (options) => {
        const index = call++
        return { text: options.audio.length === 1 ? 'tail' : `segment-${index}`, language: 'en' }
      },
    })
    await harness.controller.start()

    const options = recorderOptions(harness)
    expect(options.onSegment).toBeDefined()
    options.onSegment?.({
      samples: new Float32Array([0.1, 0.2]),
      sourceSampleRate: 16_000,
      durationMs: 6_000,
    })
    options.onSegment?.({
      samples: new Float32Array([0.3, 0.4]),
      sourceSampleRate: 16_000,
      durationMs: 6_000,
    })
    await harness.controller.stop()

    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(3)
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'segment-0 segment-1 tail' }),
    )
  })

  it('does not request segment transcription when streaming is disabled', async () => {
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: false }),
    })
    await harness.controller.start()
    expect(recorderOptions(harness).onSegment).toBeUndefined()
    await harness.controller.stop()
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
  })

  it('succeeds when segments exist but the tail recording is empty', async () => {
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: true }),
      recorder: {
        stop: vi.fn(async () => ({
          samples: new Float32Array(0),
          sourceSampleRate: 16_000,
          durationMs: 7_000,
        })),
      },
      transcribe: async () => ({ text: 'streamed words only', language: 'en' }),
    })
    await harness.controller.start()
    recorderOptions(harness).onSegment?.({
      samples: new Float32Array([0.5, 0.6]),
      sourceSampleRate: 16_000,
      durationMs: 6_500,
    })
    await harness.controller.stop()

    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'streamed words only' }),
    )
  })
})
