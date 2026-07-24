import { describe, expect, it, vi } from 'vitest'

import { widgetSnapshotSchema } from '../../../src/shared/contracts'
import type { WidgetSnapshot } from '../../../src/shared/dictation'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import {
  AudioRecorderError,
  type AudioRecorderOptions,
} from '../../../src/renderer/src/audio/audioRecorder'
import {
  DictationController,
  type DictationControllerDependencies,
  type DictationOutputResult,
  type DictationRecorder,
} from '../../../src/renderer/src/features/dictation/dictationController'
import type {
  TranscribeOptions,
  TranscriptionProgress,
  TranscriptionResult,
} from '../../../src/renderer/src/transcription/client'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

type HarnessOptions = {
  readonly currentSettings?: AppSettings
  readonly recorder?: Partial<DictationRecorder>
  readonly transcribe?: (options: TranscribeOptions) => Promise<TranscriptionResult>
  readonly deliverOutput?: DictationControllerDependencies['deliverOutput']
  readonly addHistory?: DictationControllerDependencies['addHistory']
  readonly publishWidgetState?: DictationControllerDependencies['publishWidgetState']
  readonly cuePlayer?: NonNullable<DictationControllerDependencies['cuePlayer']>
  readonly now?: () => number
  readonly ids?: string[]
  readonly getSettings?: () => AppSettings
  readonly polishTranscript?: NonNullable<DictationControllerDependencies['polishTranscript']>
}

function createHarness(options: HarnessOptions = {}) {
  const currentSettings = options.currentSettings ?? settings()
  const recorder: DictationRecorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      samples: new Float32Array([0.2]),
      sourceSampleRate: 16_000,
      durationMs: 500,
    })),
    cancel: vi.fn(async () => undefined),
    ...options.recorder,
  }
  const recorders: DictationRecorder[] = []
  const createRecorder = vi.fn((factoryOptions: AudioRecorderOptions) => {
    void factoryOptions
    recorders.push(recorder)
    return recorder
  })
  const transcriber = {
    transcribe: vi.fn(
      options.transcribe ??
        (async () => ({ text: '  hello   world  ', language: 'en' })),
    ),
    load: vi.fn(async () => undefined),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
  const deliverOutput = vi.fn(
    options.deliverOutput ?? (async () => 'pasted' as const),
  )
  const addHistory = vi.fn(options.addHistory ?? (async () => []))
  const publishWidgetState = vi.fn(options.publishWidgetState ?? (() => undefined))
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const setTimer = vi.fn((callback: () => void) => {
    const handle = nextTimer++
    timers.set(handle, callback)
    return handle
  })
  const clearTimer = vi.fn((handle: unknown) => timers.delete(handle as number))
  const ids = [...(options.ids ?? ['session'])]
  const polishTranscript =
    options.polishTranscript === undefined ? undefined : vi.fn(options.polishTranscript)
  const dependencies: DictationControllerDependencies = {
    createRecorder,
    transcriber,
    getSettings: options.getSettings ?? (() => currentSettings),
    deliverOutput,
    addHistory,
    publishWidgetState,
    ...(polishTranscript === undefined ? {} : { polishTranscript }),
    ...(options.cuePlayer === undefined ? {} : { cuePlayer: options.cuePlayer }),
    now: options.now ?? (() => 1_000),
    createId: () => ids.shift() ?? 'later-session',
    setTimer,
    clearTimer,
  }
  return {
    addHistory,
    clearTimer,
    controller: new DictationController(dependencies),
    createRecorder,
    currentSettings,
    deliverOutput,
    fireTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const callback of pending) callback()
    },
    polishTranscript,
    publishWidgetState,
    recorder,
    recorders,
    setTimer,
    transcriber,
  }
}

function recorderOptions(
  harness: ReturnType<typeof createHarness>,
  index = 0,
): AudioRecorderOptions {
  const call = harness.createRecorder.mock.calls[index]
  if (call === undefined) throw new Error('Recorder factory was not called')
  return call[0]
}

function snapshots(harness: ReturnType<typeof createHarness>): WidgetSnapshot[] {
  return harness.publishWidgetState.mock.calls.map(([snapshot]) => snapshot)
}

describe('DictationController', () => {
  it('fails closed when settings are unavailable', async () => {
    const harness = createHarness({
      getSettings: () => { throw new Error('private settings path') },
    })
    await harness.controller.start()
    expect(harness.controller.getState()).toMatchObject({
      status: 'error', code: 'SETTINGS_UNAVAILABLE',
    })
    expect(harness.createRecorder).not.toHaveBeenCalled()
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(snapshots(harness).at(-1)).toEqual(expect.objectContaining({
      status: 'error', code: 'SETTINGS_UNAVAILABLE',
    }))
    expect(snapshots(harness).at(-1)).not.toHaveProperty('message')
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
      modelPreset: 'balanced',
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

  it('claims requesting and processing synchronously before recorder promises settle', async () => {
    const starting = deferred<void>()
    const stopping = deferred<null>()
    const harness = createHarness({
      recorder: {
        start: vi.fn(() => starting.promise),
        stop: vi.fn(() => stopping.promise),
      },
    })

    const start = harness.controller.start()
    expect(harness.controller.getState().status).toBe('requesting-permission')
    starting.resolve()
    await start
    const stop = harness.controller.stop()
    expect(harness.controller.getState().status).toBe('processing')
    stopping.resolve(null)
    await stop
  })

  it('toggles from the shortcut and ignores start or toggle during permission and processing', async () => {
    const starting = deferred<void>()
    const stopping = deferred<null>()
    const harness = createHarness({
      recorder: {
        start: vi.fn(() => starting.promise),
        stop: vi.fn(() => stopping.promise),
      },
    })

    const start = harness.controller.toggle()
    await harness.controller.toggle()
    await harness.controller.start()
    expect(harness.createRecorder).toHaveBeenCalledTimes(1)
    starting.resolve()
    await start

    const stop = harness.controller.toggle()
    await harness.controller.toggle()
    await harness.controller.start()
    expect(harness.recorder.stop).toHaveBeenCalledTimes(1)
    expect(harness.createRecorder).toHaveBeenCalledTimes(1)
    stopping.resolve(null)
    await stop
  })

  it('does not stop, transcribe, or deliver twice after repeated stop requests', async () => {
    const stopping = deferred<NonNullable<Awaited<ReturnType<DictationRecorder['stop']>>>>()
    const harness = createHarness({ recorder: { stop: vi.fn(() => stopping.promise) } })
    await harness.controller.start()

    const first = harness.controller.stop()
    const second = harness.controller.stop()
    stopping.resolve({
      samples: new Float32Array([0.4]),
      sourceSampleRate: 16_000,
      durationMs: 250,
    })
    await Promise.all([first, second])

    expect(harness.recorder.stop).toHaveBeenCalledTimes(1)
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
    expect(harness.deliverOutput).toHaveBeenCalledTimes(1)
  })

  it('invalidates before cancelling while microphone permission is pending', async () => {
    const starting = deferred<void>()
    const harness = createHarness({ recorder: { start: vi.fn(() => starting.promise) } })
    const start = harness.controller.start()

    await harness.controller.cancel()
    expect(harness.controller.getState().status).toBe('cancelled')
    expect(harness.recorder.cancel).toHaveBeenCalledTimes(1)
    expect(harness.transcriber.cancel).toHaveBeenCalledWith('session')
    starting.resolve()
    await start

    expect(snapshots(harness).some((snapshot) => snapshot.status === 'listening')).toBe(false)
  })

  it('resets a cancelled session to idle only through its bound timer', async () => {
    const harness = createHarness()
    await harness.controller.start()
    await harness.controller.cancel()
    expect(harness.controller.getState().status).toBe('cancelled')
    harness.fireTimers()
    expect(harness.controller.getState()).toEqual({ status: 'idle' })
    expect(snapshots(harness).at(-1)).toMatchObject({ status: 'idle', cancellable: false })
  })

  it('continues cancellation when recorder cancellation throws synchronously', async () => {
    const harness = createHarness({
      recorder: {
        cancel: vi.fn(() => {
          throw new Error('recorder cleanup detail')
        }),
      },
    })
    await harness.controller.start()
    await expect(harness.controller.cancel()).resolves.toBeUndefined()
    expect(harness.transcriber.cancel).toHaveBeenCalledWith('session')
    expect(harness.controller.getState().status).toBe('cancelled')
  })

  it('cancels listening and suppresses later recorder level and duration callbacks', async () => {
    const harness = createHarness()
    await harness.controller.start()
    const options = recorderOptions(harness)

    await harness.controller.cancel()
    options.onLevel?.(0.9)
    options.onDurationLimit?.({
      samples: new Float32Array([0.5]),
      sourceSampleRate: 16_000,
      durationMs: 300,
    })

    expect(harness.controller.getState().status).toBe('cancelled')
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
  })

  it('cancels processing and suppresses stale transcription and output', async () => {
    const transcription = deferred<TranscriptionResult>()
    const harness = createHarness({ transcribe: () => transcription.promise })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await Promise.resolve()

    await harness.controller.cancel()
    transcription.resolve({ text: 'private stale words', language: 'en' })
    await stop

    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.controller.getState().status).toBe('cancelled')
  })

  it('suppresses a recorder stop result that settles after cancellation', async () => {
    const stopping = deferred<NonNullable<Awaited<ReturnType<DictationRecorder['stop']>>>>()
    const harness = createHarness({ recorder: { stop: vi.fn(() => stopping.promise) } })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await harness.controller.cancel()

    stopping.resolve({
      samples: new Float32Array([0.8]),
      sourceSampleRate: 16_000,
      durationMs: 500,
    })
    await stop
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(harness.deliverOutput).not.toHaveBeenCalled()
  })

  it('makes output delivery an explicit non-cancellable boundary', async () => {
    const output = deferred<DictationOutputResult>()
    const harness = createHarness({ deliverOutput: () => output.promise })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await vi.waitFor(() => expect(harness.deliverOutput).toHaveBeenCalledTimes(1))

    await harness.controller.cancel()
    expect(harness.transcriber.cancel).not.toHaveBeenCalled()
    expect(snapshots(harness).at(-1)).toMatchObject({
      status: 'processing',
      stage: 'delivering-output',
      cancellable: false,
    })
    output.resolve('copied')
    await stop
    expect(harness.controller.getState()).toMatchObject({ status: 'success', output: 'copied' })
  })

  it('suppresses a cancelled session after a new session starts', async () => {
    const firstTranscription = deferred<TranscriptionResult>()
    const transcribe = vi
      .fn<(options: TranscribeOptions) => Promise<TranscriptionResult>>()
      .mockImplementationOnce(() => firstTranscription.promise)
      .mockResolvedValueOnce({ text: 'new session', language: 'fr' })
    const harness = createHarness({ ids: ['old', 'new'], transcribe })

    await harness.controller.start()
    const oldStop = harness.controller.stop()
    await Promise.resolve()
    await harness.controller.cancel()
    await harness.controller.start()
    const newStop = harness.controller.stop()
    firstTranscription.resolve({ text: 'old private text', language: 'en' })
    await Promise.all([oldStop, newStop])

    expect(harness.deliverOutput).toHaveBeenCalledTimes(1)
    expect(harness.deliverOutput).toHaveBeenCalledWith(expect.objectContaining({
      text: 'new session',
    }))
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'new',
      language: 'fr',
    }))
    expect(snapshots(harness).map((snapshot) => snapshot.status)).toEqual(
      expect.arrayContaining(['cancelled', 'idle', 'requesting-permission', 'listening']),
    )
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
    expect(harness.addHistory).not.toHaveBeenCalled()
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

  it('uses one immutable settings snapshot for the whole session', async () => {
    const current = settings({
      microphoneId: 'mic-original',
      modelPreset: 'fast',
      language: 'es',
      inferencePreference: 'wasm',
      formatWhitespace: true,
      autoPaste: false,
      pasteDelayMs: 320,
    })
    const stopping = deferred<NonNullable<Awaited<ReturnType<DictationRecorder['stop']>>>>()
    const harness = createHarness({
      currentSettings: current,
      recorder: { stop: vi.fn(() => stopping.promise) },
    })
    await harness.controller.start()

    Object.assign(current, {
      microphoneId: 'mic-mutated',
      modelPreset: 'accurate',
      language: 'de',
      inferencePreference: 'webgpu',
      formatWhitespace: false,
      autoPaste: true,
      pasteDelayMs: 900,
    })
    const stop = harness.controller.stop()
    stopping.resolve({
      samples: new Float32Array([0.1]),
      sourceSampleRate: 16_000,
      durationMs: 10,
    })
    await stop

    expect(recorderOptions(harness)).toMatchObject({ selectedDeviceId: 'mic-original' })
    expect(harness.transcriber.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      preset: 'fast',
      language: 'es',
      inferencePreference: 'wasm',
    }))
    expect(harness.deliverOutput).toHaveBeenCalledWith({
      text: 'hello world',
      autoPaste: false,
      pasteDelayMs: 320,
    })
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'fast' }))
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

  it('resets only the terminal session whose timer is still current', async () => {
    const harness = createHarness({ ids: ['first', 'second'] })
    await harness.controller.start()
    await harness.controller.stop()
    expect(harness.setTimer).toHaveBeenCalledTimes(1)

    await harness.controller.start()
    expect(harness.clearTimer).toHaveBeenCalled()
    expect(harness.controller.getState()).toMatchObject({
      status: 'listening',
      sessionId: 'second',
    })
    harness.fireTimers()
    expect(harness.controller.getState()).toMatchObject({
      status: 'listening',
      sessionId: 'second',
    })
  })

  it('invalidates synchronously and suppresses every later emission on dispose', async () => {
    const transcription = deferred<TranscriptionResult>()
    const harness = createHarness({ transcribe: () => transcription.promise })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await Promise.resolve()
    const publicationsBeforeDispose = harness.publishWidgetState.mock.calls.length

    harness.controller.dispose()
    expect(harness.recorder.cancel).toHaveBeenCalledTimes(1)
    expect(harness.transcriber.cancel).toHaveBeenCalledWith('session')
    expect(harness.transcriber.dispose).toHaveBeenCalledTimes(1)
    transcription.resolve({ text: 'stale private text', language: 'en' })
    await stop
    harness.fireTimers()

    expect(harness.publishWidgetState).toHaveBeenCalledTimes(publicationsBeforeDispose)
    expect(harness.deliverOutput).not.toHaveBeenCalled()
  })

  it('suppresses history and success when disposed during output delivery', async () => {
    const output = deferred<DictationOutputResult>()
    const harness = createHarness({ deliverOutput: () => output.promise })
    await harness.controller.start()
    const stop = harness.controller.stop()
    await vi.waitFor(() => expect(harness.deliverOutput).toHaveBeenCalledTimes(1))
    const publicationsBeforeDispose = harness.publishWidgetState.mock.calls.length

    harness.controller.dispose()
    output.resolve('pasted')
    await stop

    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.publishWidgetState).toHaveBeenCalledTimes(publicationsBeforeDispose)
    expect(harness.controller.getState().status).toBe('processing')
  })

  it.each([
    ['NotAllowedError', 'MIC_PERMISSION_DENIED'],
    ['SecurityError', 'MIC_PERMISSION_DENIED'],
    ['NotFoundError', 'MIC_DEVICE_NOT_FOUND'],
    ['DevicesNotFoundError', 'MIC_DEVICE_NOT_FOUND'],
    ['OverconstrainedError', 'MIC_DEVICE_NOT_FOUND'],
    ['AbortError', 'MIC_START_FAILED'],
    [undefined, 'MIC_START_FAILED'],
  ])('maps recorder start name %s to %s without exposing its message', async (name, code) => {
    const harness = createHarness({
      recorder: {
        start: vi.fn(async () => {
          throw new AudioRecorderError('START_FAILED', 'safe recorder message', name)
        }),
      },
    })
    await harness.controller.start()

    expect(harness.controller.getState()).toMatchObject({ status: 'error', code })
    expect(JSON.stringify(harness.controller.getState())).not.toContain('safe recorder message')
  })

  it('leaves listening with a finite device-unavailable error when the recorder loses its microphone', async () => {
    const harness = createHarness()
    await harness.controller.start()

    recorderOptions(harness).onDeviceUnavailable?.()

    expect(harness.controller.getState()).toMatchObject({
      status: 'error',
      code: 'MIC_DEVICE_NOT_FOUND',
    })
    expect(harness.recorder.cancel).toHaveBeenCalledOnce()
    expect(snapshots(harness).at(-1)).toMatchObject({
      status: 'error',
      code: 'MIC_DEVICE_NOT_FOUND',
      cancellable: false,
    })
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(harness.deliverOutput).not.toHaveBeenCalled()
  })

  it('creates a fresh recorder per session', async () => {
    const first = createHarness({ ids: ['first', 'second'] })
    await first.controller.start()
    await first.controller.cancel()
    await first.controller.start()
    expect(first.createRecorder).toHaveBeenCalledTimes(2)
  })

  it('publishes strict transcript-free snapshots for every legal state', async () => {
    const harness = createHarness({
      currentSettings: settings({
        theme: 'dark',
        reducedMotion: 'on',
        hotkey: 'Control+Alt+D',
      }),
      transcribe: async (options) => {
        options.onProgress?.({ stage: 'transcribing', progress: 0.5 })
        return { text: 'never publish these private words', language: 'en' }
      },
    })
    await harness.controller.start()
    recorderOptions(harness).onLevel?.(0.4)
    await harness.controller.stop()

    for (const snapshot of snapshots(harness)) {
      expect(widgetSnapshotSchema.parse(snapshot)).toEqual(snapshot)
      const serialized = JSON.stringify(snapshot)
      expect(serialized).not.toContain('never publish these private words')
      expect(serialized).not.toContain('samples')
      expect(snapshot).toMatchObject({
        theme: 'dark',
        reducedMotion: 'on',
        shortcut: 'Control+Alt+D',
      })
    }
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
  it('warms the configured model and device without starting a dictation session', async () => {
    const harness = createHarness({
      currentSettings: settings({ modelPreset: 'accurate', inferencePreference: 'webgpu' }),
    })

    await harness.controller.prewarm()

    expect(harness.transcriber.load).toHaveBeenCalledWith({
      preset: 'accurate',
      inferencePreference: 'webgpu',
    })
    expect(harness.controller.getState().status).toBe('idle')
    expect(harness.createRecorder).not.toHaveBeenCalled()
  })

  it('resolves quietly when warm-up loading fails', async () => {
    const harness = createHarness()
    harness.transcriber.load.mockRejectedValueOnce(new Error('MODEL_MISSING'))

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.controller.getState().status).toBe('idle')
  })

  it('does not warm while a dictation session is active', async () => {
    const harness = createHarness()
    await harness.controller.start()

    await harness.controller.prewarm()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })

  it('does not warm after the controller is disposed', async () => {
    const harness = createHarness()
    harness.controller.dispose()

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })

  it('resolves quietly when settings are unavailable', async () => {
    const harness = createHarness({
      getSettings: () => {
        throw new Error('SETTINGS_UNAVAILABLE')
      },
    })

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.transcriber.load).not.toHaveBeenCalled()
  })

  it('supports transcribers without warm-up loading', async () => {
    const harness = createHarness()
    delete (harness.transcriber as { load?: unknown }).load

    await expect(harness.controller.prewarm()).resolves.toBeUndefined()

    expect(harness.controller.getState().status).toBe('idle')
  })

  it('applies the LLM polish pass when enabled and delivers the polished text', async () => {
    const harness = createHarness({
      currentSettings: settings({ llmFormatting: true }),
      transcribe: async () => ({ text: 'um hello world', language: 'en' }),
      polishTranscript: async () => ({ text: 'Hello, world.', applied: true }),
    })
    await harness.controller.start()
    await harness.controller.stop()

    expect(harness.polishTranscript).toHaveBeenCalledWith('um hello world')
    expect(harness.deliverOutput).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello, world.' }),
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
