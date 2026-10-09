import { describe, expect, it, vi } from 'vitest'

import { AudioRecorderError } from '../../../../../src/renderer/src/audio/audioRecorder'
import {
  type DictationOutputResult,
  type DictationRecorder
} from '../../../../../src/renderer/src/features/dictation/dictationController'
import type {
  TranscribeOptions,
  TranscriptionResult
} from '../../../../../src/renderer/src/transcription/openRouterTranscriber'
import { widgetSnapshotSchema } from '../../../../../src/shared/contracts'
import { widgetPaletteFor } from '../../../../../src/shared/themeBranding'
import { createHarness, deferred, recorderOptions, settings, snapshots } from '../../../../fixtures/renderer/dictationControllerHarness'

describe('DictationController', () => {
  it('pairs Linux push-to-talk without recording an unpaired stop or a repeated start', async () => {
    const harness = createHarness({ platform: 'linux' })
    await harness.controller.stop()
    expect(harness.controller.getState().status).toBe('idle')
    expect(harness.createRecorder).not.toHaveBeenCalled()
    await harness.controller.start()
    await harness.controller.start()
    expect(harness.controller.getState().status).toBe('listening')
    expect(harness.createRecorder).toHaveBeenCalledOnce()
    expect(harness.recorder.start).toHaveBeenCalledOnce()
    await harness.controller.stop()
    await harness.controller.stop()
    expect(harness.recorder.stop).toHaveBeenCalledOnce()
    expect(harness.deliverOutput).toHaveBeenCalledOnce()
  })

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

  it('says no microphone is set up when setup was finished without one', async () => {
    const harness = createHarness({ currentSettings: settings({ microphoneSkipped: true }) })

    await harness.controller.toggle()

    expect(harness.controller.getState()).toMatchObject({ status: 'error', code: 'MIC_NOT_SET_UP' })
    expect(harness.createRecorder).not.toHaveBeenCalled()
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(snapshots(harness).at(-1)).toEqual(expect.objectContaining({
      status: 'error', code: 'MIC_NOT_SET_UP',
    }))
  })

  it.each([
    [undefined, 'CommandOrControl+Shift+Space'],
    ['win32', 'CommandOrControl+Shift+Space'],
    ['darwin', 'Control+Shift+Space'],
  ] as const)(
    'falls back to the %s default shortcut when settings are unavailable',
    async (platform, shortcut) => {
      const harness = createHarness({
        ...(platform === undefined ? {} : { platform }),
        getSettings: () => { throw new Error('private settings path') },
      })

      await harness.controller.start()

      expect(snapshots(harness).at(-1)).toMatchObject({
        code: 'SETTINGS_UNAVAILABLE',
        shortcut,
      })
    },
  )

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

  it('toggles from the shortcut and ignores start or toggle during processing', async () => {
    const stopping = deferred<null>()
    const harness = createHarness({
      recorder: {
        stop: vi.fn(() => stopping.promise),
      },
    })

    await harness.controller.toggle()

    const stop = harness.controller.toggle()
    await harness.controller.toggle()
    await harness.controller.start()
    expect(harness.recorder.stop).toHaveBeenCalledTimes(1)
    expect(harness.createRecorder).toHaveBeenCalledTimes(1)
    stopping.resolve(null)
    await stop
  })

  it.each(['stop', 'toggle'] as const)('remembers %s while connecting and cancels when the microphone is ready', async (action) => {
    const starting = deferred<void>()
    const cuePlayer = { playStart: vi.fn(), playStop: vi.fn() }
    const harness = createHarness({
      currentSettings: settings({ streamingAsr: true }),
      recorder: { start: vi.fn(() => starting.promise) },
      cuePlayer,
    })
    const start = harness.controller.start()

    await harness.controller[action]()
    await harness.controller[action]()
    await harness.controller.start()
    expect(harness.controller.getState().status).toBe('requesting-permission')
    expect(harness.createRecorder).toHaveBeenCalledTimes(1)
    expect(harness.recorder.cancel).not.toHaveBeenCalled()
    recorderOptions(harness).onSegment?.({
      samples: new Float32Array([0.5]), sourceSampleRate: 16_000, durationMs: 300,
    })
    starting.resolve()
    await start

    expect(harness.controller.getState().status).toBe('cancelled')
    expect(harness.recorder.cancel).toHaveBeenCalledTimes(1)
    expect(harness.recorder.stop).not.toHaveBeenCalled()
    expect(harness.transcriber.transcribe).not.toHaveBeenCalled()
    expect(harness.deliverOutput).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(cuePlayer.playStart).not.toHaveBeenCalled()
    expect(cuePlayer.playStop).not.toHaveBeenCalled()
    expect(snapshots(harness).some((snapshot) => snapshot.status === 'listening')).toBe(false)

    await harness.controller.start()
    expect(harness.controller.getState().status).toBe('listening')
    await harness.controller.stop()
    expect(harness.transcriber.transcribe).toHaveBeenCalledTimes(1)
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

  it('uses one immutable settings snapshot for the whole session', async () => {
    const current = settings({
      microphoneId: 'mic-original',
      language: 'es',
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
      language: 'de',
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
      language: 'es',
    }))
    expect(harness.deliverOutput).toHaveBeenCalledWith({
      text: 'hello world',
      autoPaste: false,
      pasteDelayMs: 320,
    })
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({ modelPreset: 'mai' }))
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

  it('publishes the palette of the settings in force now, keeping the session shortcut', async () => {
    let current = settings({ hotkey: 'Control+Alt+D', lightTheme: 'nocturne', darkTheme: 'nocturne' })
    const harness = createHarness({ getSettings: () => current })
    await harness.controller.start()
    recorderOptions(harness).onLevel?.(0.3)
    expect(snapshots(harness).at(-1)?.palette).toEqual(widgetPaletteFor(current))

    // A theme chosen mid-session reaches the next level publication, not only the next session.
    current = settings({ hotkey: 'Control+Alt+X', lightTheme: 'tropic', darkTheme: 'citrine' })
    recorderOptions(harness).onLevel?.(0.6)
    const latest = snapshots(harness).at(-1)!
    expect(latest.palette).toEqual(widgetPaletteFor(current))
    expect(latest.palette.dark.accent).not.toBe(widgetPaletteFor(settings()).dark.accent)
    expect(latest.shortcut).toBe('Control+Alt+D')
    expect(widgetSnapshotSchema.parse(latest)).toEqual(latest)
  })
})

describe('kept recordings', () => {

  it('announces nothing before setup is finished', () => {
    const harness = createHarness({ currentSettings: settings({ onboardingComplete: false }) })
    harness.controller.announceIdle()
    expect(harness.publishWidgetState).not.toHaveBeenCalled()
  })

  it('announces idle for a new controller, and not over a session', async () => {
    const harness = createHarness({ currentSettings: settings({ onboardingComplete: true }) })
    harness.controller.announceIdle()
    expect(snapshots(harness).at(-1)).toMatchObject({ status: 'idle', cancellable: false })
    expect(widgetSnapshotSchema.safeParse(snapshots(harness).at(-1)).success).toBe(true)
    await harness.controller.start()
    const published = harness.publishWidgetState.mock.calls.length
    harness.controller.announceIdle()
    expect(harness.publishWidgetState).toHaveBeenCalledTimes(published)
  })
})
