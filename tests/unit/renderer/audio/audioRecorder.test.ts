import { describe, expect, it, vi } from 'vitest'

import { MAX_TRANSCRIPTION_SAMPLES, TRANSCRIPTION_SAMPLE_RATE } from '../../../../src/shared/audio'
import { transcriptionRequestSchema } from '../../../../src/shared/contracts'
import { encodeWavPcm16 } from '../../../../src/shared/wav'

import {
  AUDIO_CAPTURE_PROCESSOR_NAME,
  AudioRecorderError,
  type AudioRecordingResult,
  type MediaStreamAdapter
} from '../../../../src/renderer/src/audio/audioRecorder'
import { createHarness, deferred } from '../../../fixtures/renderer/audioRecorderHarness'

describe('AudioRecorder', () => {
  it('resumes a context the permission dialog left suspended', async () => {
    const harness = createHarness()
    const order: string[] = []
    const context = harness.context
    context.state = 'suspended'
    context.resume.mockImplementation(async () => {
      order.push(context.state)
      context.state = 'running'
    })
    harness.getUserMedia.mockImplementation(async () => {
      order.push('capture')
      context.state = 'suspended'
      return harness.stream
    })

    await harness.recorder().start()

    expect(order).toEqual(['suspended', 'capture', 'suspended'])
  })

  it('requests exact constraints and wires a silent processing graph', async () => {
    const harness = createHarness()
    const recorder = harness.recorder({ selectedDeviceId: 'mic-2' })

    await recorder.start()

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-2' },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    expect(harness.context.audioWorklet.addModule).toHaveBeenCalledWith(
      'file:///C:/Program%20Files/Sotto/resources/app.asar/out/renderer/audio-capture-worklet.js',
    )
    expect(harness.dependencies.createAudioWorkletNode).toHaveBeenCalledWith(
      harness.context,
      AUDIO_CAPTURE_PROCESSOR_NAME,
    )
    expect(harness.context.source.connect).toHaveBeenCalledWith(harness.worklet)
    expect(harness.worklet.connect).toHaveBeenCalledWith(harness.context.gain)
    expect(harness.context.gain.gain.value).toBe(0)
    expect(harness.context.gain.connect).toHaveBeenCalledWith(harness.context.destination)
  })

  it('includes an undefined deviceId when no device is selected', async () => {
    const harness = createHarness()
    await harness.recorder().start()

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  })

  it('keeps the selected input when extra constraints are rejected', async () => {
    const harness = createHarness()
    const overconstrained = new Error('constraints')
    overconstrained.name = 'OverconstrainedError'
    harness.getUserMedia
      .mockRejectedValueOnce(overconstrained)
      .mockResolvedValueOnce(harness.stream)

    await harness.recorder({ selectedDeviceId: 'mic-c922' }).start()

    expect(harness.getUserMedia).toHaveBeenNthCalledWith(2, { audio: { deviceId: { exact: 'mic-c922' } } })
  })

  it('throttles level callbacks to the emit interval while chunks arrive at audio rate', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const onLevel = vi.fn()
      const recorder = harness.recorder({ onLevel })
      await recorder.start()
      const chunk = new Float32Array(128).fill(0.5)

      // Worklet frames arrive every ~2.7ms; only ~30Hz may reach the callback.
      for (let i = 0; i < 12; i += 1) {
        harness.worklet.port.onmessage?.({ data: chunk })
        vi.advanceTimersByTime(3)
      }
      expect(onLevel.mock.calls.length).toBeLessThanOrEqual(2)

      vi.advanceTimersByTime(40)
      harness.worklet.port.onmessage?.({ data: chunk })
      expect(onLevel.mock.calls.length).toBeGreaterThanOrEqual(2)
      await recorder.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('copies chunks, emits normalized levels, resamples, and reports captured duration', async () => {
    const harness = createHarness()
    const onLevel = vi.fn()
    const recorder = harness.recorder({ onLevel })
    await recorder.start()
    const callerChunk = new Float32Array(4_800).fill(0.5)

    harness.worklet.port.onmessage?.({ data: callerChunk })
    callerChunk.fill(1)
    const result = await recorder.stop()

    expect(onLevel).toHaveBeenCalledWith(0.5)
    expect(result?.sourceSampleRate).toBe(48_000)
    expect(onLevel).toHaveBeenCalledTimes(1)
    expect(result?.samples).toHaveLength(1_600)
    expect(result?.samples[0]).toBeCloseTo(0.5)
    expect(result?.durationMs).toBe(100)
    expect(await recorder.stop()).toBeNull()
  })

  it('keeps no audio in levels-only mode but still reports levels', async () => {
    const harness = createHarness()
    const onLevel = vi.fn()
    const onSegment = vi.fn()
    const recorder = harness.recorder({ onLevel, onSegment, levelsOnly: true })
    await recorder.start()

    for (let index = 0; index < 400; index += 1) {
      harness.worklet.port.onmessage?.({ data: new Float32Array(4_800).fill(0.5) })
    }

    expect(onLevel).toHaveBeenCalledWith(0.5)
    expect(onSegment).not.toHaveBeenCalled()
    await expect(recorder.stop()).resolves.toBeNull()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('allows only one active or start-in-flight session', async () => {
    const media = deferred<MediaStreamAdapter>()
    const getUserMedia = vi.fn(() => media.promise)
    const harness = createHarness({ mediaDevices: { getUserMedia } })
    const recorder = harness.recorder()
    const starting = recorder.start()

    await expect(recorder.start()).rejects.toMatchObject({ code: 'ALREADY_RECORDING' })
    expect(getUserMedia).toHaveBeenCalledOnce()
    media.resolve(harness.stream)
    await starting
    await expect(recorder.start()).rejects.toMatchObject({ code: 'ALREADY_RECORDING' })
  })

  it('keeps a cancelled permission request reserved until its late stream is stopped', async () => {
    const media = deferred<MediaStreamAdapter>()
    const getUserMedia = vi.fn(() => media.promise)
    const harness = createHarness({ mediaDevices: { getUserMedia } })
    const recorder = harness.recorder()
    const starting = recorder.start()
    // The audio graph now builds before the microphone opens; wait until the
    // permission request is actually in flight.
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())

    await recorder.cancel()
    const repeatedStart = recorder.start()
    media.resolve(harness.stream)
    await expect(starting).rejects.toMatchObject({ code: 'START_FAILED' })
    const repeatedOutcome = await repeatedStart.then(
      () => 'resolved',
      (error: unknown) => (error as { code?: string }).code,
    )
    await recorder.cancel()

    expect(repeatedOutcome).toBe('ALREADY_RECORDING')
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    await expect(recorder.start()).resolves.toBeUndefined()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    await recorder.cancel()
  })

  it('does not let a later stop replace cancel semantics during initialization', async () => {
    const media = deferred<MediaStreamAdapter>()
    const getUserMedia = vi.fn(() => media.promise)
    const harness = createHarness({ mediaDevices: { getUserMedia } })
    const recorder = harness.recorder()
    const starting = recorder.start()
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())

    await recorder.cancel()
    await expect(recorder.stop()).resolves.toBeNull()
    media.resolve(harness.stream)

    await expect(starting).rejects.toMatchObject({ code: 'START_FAILED' })
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)(
    'treats stop during getUserMedia as clean cancellation after late %s',
    async (outcome) => {
      const media = deferred<MediaStreamAdapter>()
      const getUserMedia = vi.fn(() => media.promise)
      const harness = createHarness({ mediaDevices: { getUserMedia } })
      const onDurationLimit = vi.fn()
      const onLevel = vi.fn()
      const recorder = harness.recorder({ maxRecordingSeconds: 1, onDurationLimit, onLevel })
      const starting = recorder.start()
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())

      await expect(recorder.stop()).resolves.toBeNull()
      if (outcome === 'resolve') media.resolve(harness.stream)
      else media.reject(new Error('late permission details'))
      await expect(starting).resolves.toBeUndefined()

      expect(recorder.getLastError()).toBeNull()
      expect(harness.track.stop).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0)
      // The pre-built audio graph is torn down with the cancelled session.
      expect(harness.context.close).toHaveBeenCalledOnce()
      expect(harness.context.createMediaStreamSource).not.toHaveBeenCalled()
      expect(harness.dependencies.setTimer).not.toHaveBeenCalled()
      expect(onDurationLimit).not.toHaveBeenCalled()
      expect(onLevel).not.toHaveBeenCalled()
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'treats stop during worklet loading as clean cancellation after late %s',
    async (outcome) => {
      const moduleLoad = deferred<undefined>()
      const harness = createHarness()
      harness.context.audioWorklet.addModule.mockImplementationOnce(() => moduleLoad.promise)
      const recorder = harness.recorder({ maxRecordingSeconds: 1 })
      const starting = recorder.start()
      await vi.waitFor(() => expect(harness.context.audioWorklet.addModule).toHaveBeenCalledOnce())

      await expect(recorder.stop()).resolves.toBeNull()
      if (outcome === 'resolve') moduleLoad.resolve(undefined)
      else moduleLoad.reject(new Error('late module details'))
      await expect(starting).resolves.toBeUndefined()

      expect(recorder.getLastError()).toBeNull()
      // Worklet loading now precedes the permission request: the microphone
      // was never opened, so there is no track to stop.
      expect(harness.getUserMedia).not.toHaveBeenCalled()
      expect(harness.track.stop).not.toHaveBeenCalled()
      expect(harness.context.close).toHaveBeenCalledOnce()
      expect(harness.context.createMediaStreamSource).not.toHaveBeenCalled()
      expect(harness.dependencies.createAudioWorkletNode).not.toHaveBeenCalled()
      expect(harness.dependencies.setTimer).not.toHaveBeenCalled()
    },
  )

  it('stops automatically at the duration limit and exposes the result exactly once', async () => {
    const harness = createHarness()
    const onDurationLimit = vi.fn()
    const recorder = harness.recorder({ maxRecordingSeconds: 1, onDurationLimit })
    await recorder.start()
    harness.worklet.port.onmessage?.({
      data: new Float32Array(48_000).fill(0.25),
    })

    harness.fireTimer()
    await vi.waitFor(() => expect(onDurationLimit).toHaveBeenCalledOnce())

    expect(onDurationLimit).toHaveBeenCalledWith({
      samples: new Float32Array(TRANSCRIPTION_SAMPLE_RATE).fill(0.25),
      sourceSampleRate: 48_000,
      durationMs: 1_000,
    })
    expect(await recorder.stop()).toBeNull()
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })

  it.each([['stop', TRANSCRIPTION_SAMPLE_RATE], ['limit', 48_000]] as const)(
    'keeps the first five minutes accepted by transcription when %s at %i Hz follows a delayed limit timer',
    async (delivery, sampleRate) => {
      const harness = createHarness({}, sampleRate)
      const onDurationLimit = vi.fn<(result: AudioRecordingResult) => void>()
      const recorder = harness.recorder({ maxRecordingSeconds: 300, onDurationLimit })
      await recorder.start()
      harness.worklet.port.onmessage?.({
        data: new Float32Array(300 * sampleRate).fill(0.25),
      })
      // Audio keeps arriving before a throttled renderer runs its limit timer.
      harness.worklet.port.onmessage?.({ data: new Float32Array(128).fill(0.75) })

      let result: AudioRecordingResult | null
      if (delivery === 'limit') {
        harness.fireTimer()
        await vi.waitFor(() => expect(onDurationLimit).toHaveBeenCalledOnce())
        result = onDurationLimit.mock.calls[0]![0]
      } else {
        result = await recorder.stop()
      }

      expect(result).not.toBeNull()
      const wav = encodeWavPcm16(result!.samples, TRANSCRIPTION_SAMPLE_RATE)
      expect(transcriptionRequestSchema.safeParse({
        requestId: 'delayed-limit', wav: wav.buffer, timeoutMs: 30_000,
      }).success).toBe(true)
      expect(result!.samples).toHaveLength(MAX_TRANSCRIPTION_SAMPLES)
      expect(result!.samples[0]).toBe(0.25)
      // Downsampling's low-pass filter blends samples near the cut boundary.
      expect(result!.samples[MAX_TRANSCRIPTION_SAMPLES - 1]).toBeCloseTo(0.25, 1)
      expect(await recorder.stop()).toBeNull()
      expect(harness.track.stop).toHaveBeenCalledOnce()
    },
  )

  it.each(['stop', 'limit'] as const)(
    'releases its audio result after %s delivers it',
    async (delivery) => {
      const harness = createHarness()
      const onDurationLimit = vi.fn<(result: AudioRecordingResult) => void>()
      const recorder = harness.recorder({ maxRecordingSeconds: 1, onDurationLimit })
      await recorder.start()
      harness.worklet.port.onmessage?.({ data: new Float32Array(48_000).fill(0.25) })

      let result: AudioRecordingResult | null
      if (delivery === 'limit') {
        harness.fireTimer()
        await vi.waitFor(() => expect(onDurationLimit).toHaveBeenCalledOnce())
        result = onDurationLimit.mock.calls[0]![0]
      } else {
        result = await recorder.stop()
      }

      expect(result?.samples).toHaveLength(TRANSCRIPTION_SAMPLE_RATE)
      expect(result?.samples[0]).toBe(0.25)
      // Inspect ownership directly rather than relying on nondeterministic GC.
      const retainsAudio = Object.values(recorder).some((value) =>
        typeof value === 'object' && value !== null &&
        'samples' in value && value.samples instanceof Float32Array,
      )
      expect(retainsAudio).toBe(false)
      expect(recorder).toHaveProperty('session', null)
      expect(await recorder.stop()).toBeNull()
    },
  )

  it('reports a finite device-unavailable error and releases capture when the active track ends', async () => {
    const harness = createHarness()
    const onDeviceUnavailable = vi.fn()
    const recorder = harness.recorder({ onDeviceUnavailable })
    await recorder.start()

    harness.endTrack()
    await vi.waitFor(() => expect(onDeviceUnavailable).toHaveBeenCalledOnce())

    expect(recorder.getLastError()).toMatchObject({
      code: 'DEVICE_UNAVAILABLE',
      message: 'The microphone became unavailable.',
    })
    await expect(recorder.stop()).resolves.toBeNull()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('reports active device loss without waiting for a slow audio-context close', async () => {
    const close = deferred<undefined>()
    const harness = createHarness()
    harness.context.close.mockReturnValueOnce(close.promise)
    const onDeviceUnavailable = vi.fn()
    const recorder = harness.recorder({ onDeviceUnavailable })
    await recorder.start()

    harness.endTrack()
    await Promise.resolve()

    expect(onDeviceUnavailable).toHaveBeenCalledOnce()
    close.resolve(undefined)
    await recorder.cancel()
  })

  it('reports device unavailability and releases capture when the active track is removed', async () => {
    const harness = createHarness()
    const onDeviceUnavailable = vi.fn()
    const recorder = harness.recorder({ onDeviceUnavailable })
    await recorder.start()

    harness.removeTrack()
    await vi.waitFor(() => expect(onDeviceUnavailable).toHaveBeenCalledOnce())

    expect(recorder.getLastError()).toMatchObject({ code: 'DEVICE_UNAVAILABLE' })
    await expect(recorder.stop()).resolves.toBeNull()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('makes stop, timeout, and cancel races release resources only once', async () => {
    const harness = createHarness()
    const recorder = harness.recorder({ maxRecordingSeconds: 1 })
    await recorder.start()
    const stop = recorder.stop()
    harness.fireTimer()
    await recorder.cancel()
    await stop
    await Promise.resolve()

    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('cancels without audio and ignores late messages and timers', async () => {
    const harness = createHarness()
    const onLevel = vi.fn()
    const onDurationLimit = vi.fn()
    const recorder = harness.recorder({ maxRecordingSeconds: 1, onDurationLimit, onLevel })
    await recorder.start()
    const lateHandler = harness.worklet.port.onmessage

    await recorder.cancel()
    lateHandler?.({ data: new Float32Array([1]) })
    harness.fireTimer()
    await Promise.resolve()

    expect(await recorder.stop()).toBeNull()
    expect(onLevel).not.toHaveBeenCalled()
    expect(onDurationLimit).not.toHaveBeenCalled()
    expect(harness.worklet.port.onmessage).toBeNull()
  })

  it.each(['media', 'module', 'node', 'connect'] as const)(
    'rolls back every partial resource after a %s start failure',
    async (failurePoint) => {
      const harness = createHarness()
      if (failurePoint === 'media') harness.getUserMedia.mockRejectedValueOnce(new Error('device-id'))
      if (failurePoint === 'module')
        harness.context.audioWorklet.addModule.mockRejectedValueOnce(new Error('local-path'))
      if (failurePoint === 'node')
        vi.mocked(harness.dependencies.createAudioWorkletNode).mockImplementationOnce(() => {
          throw new Error('node details')
        })
      if (failurePoint === 'connect')
        harness.context.source.connect.mockImplementationOnce(() => {
          throw new Error('graph details')
        })

      await expect(harness.recorder().start()).rejects.toEqual(
        new AudioRecorderError('START_FAILED', 'Unable to start microphone capture.'),
      )

      // The graph is built before the microphone opens, so the context always
      // needs rollback, and only the post-stream connect failure leaves a
      // live track to stop.
      expect(harness.track.stop).toHaveBeenCalledTimes(failurePoint === 'connect' ? 1 : 0)
      expect(harness.context.close).toHaveBeenCalledOnce()
    },
  )

  it.each([
    'NotAllowedError',
    'SecurityError',
    'NotFoundError',
    'DevicesNotFoundError',
    'OverconstrainedError',
  ])('preserves only the safe DOM failure name %s on start errors', async (name) => {
    const harness = createHarness()
    harness.getUserMedia.mockRejectedValueOnce({
      name,
      message: 'private browser or device detail',
    })

    await expect(harness.recorder().start()).rejects.toEqual(
      new AudioRecorderError(
        'START_FAILED',
        'Unable to start microphone capture.',
        name,
      ),
    )
  })

  it('does not preserve an arbitrary start error name or message', async () => {
    const harness = createHarness()
    harness.getUserMedia.mockRejectedValueOnce({
      name: 'VendorPrivateError',
      message: 'USB microphone serial 1234',
    })

    await expect(harness.recorder().start()).rejects.toEqual(
      new AudioRecorderError('START_FAILED', 'Unable to start microphone capture.'),
    )
  })

  it('cleans up when a level callback throws without creating an unhandled rejection', async () => {
    const harness = createHarness()
    const recorder = harness.recorder({
      onLevel: () => {
        throw new Error('consumer details')
      },
    })
    await recorder.start()

    harness.worklet.port.onmessage?.({ data: new Float32Array([0.2]) })
    await vi.waitFor(() => expect(harness.context.close).toHaveBeenCalledOnce())

    expect(recorder.getLastError()).toEqual(
      new AudioRecorderError('LEVEL_CALLBACK_FAILED', 'Audio level callback failed.'),
    )
  })

  it('sanitizes finalization failures and still releases every resource', async () => {
    const harness = createHarness()
    Object.defineProperty(harness.context, 'sampleRate', { value: 0 })
    const recorder = harness.recorder()
    await recorder.start()
    harness.worklet.port.onmessage?.({ data: new Float32Array([0.2]) })

    await expect(recorder.stop()).rejects.toEqual(
      new AudioRecorderError('FINALIZE_FAILED', 'Unable to finalize microphone capture.'),
    )

    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('contains duration-limit finalization failures and exposes a finite last error', async () => {
    const harness = createHarness()
    Object.defineProperty(harness.context, 'sampleRate', { value: Number.NaN })
    const recorder = harness.recorder({ maxRecordingSeconds: 1 })
    await recorder.start()
    harness.worklet.port.onmessage?.({ data: new Float32Array([0.2]) })

    harness.fireTimer()
    await vi.waitFor(() =>
      expect(recorder.getLastError()).toEqual(
        new AudioRecorderError('FINALIZE_FAILED', 'Unable to finalize microphone capture.'),
      ),
    )

    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })

  it('continues cleanup when port detachment and track enumeration throw', async () => {
    const harness = createHarness()
    let handler: ((event: { data: unknown }) => void) | null = null
    Object.defineProperty(harness.worklet.port, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (value: ((event: { data: unknown }) => void) | null) => {
        if (value === null) throw new Error('port internals')
        handler = value
      },
    })
    harness.stream.getTracks = vi.fn(() => {
      throw new Error('stream internals')
    })
    const recorder = harness.recorder()
    await recorder.start()

    await expect(recorder.cancel()).resolves.toBeUndefined()

    expect(harness.context.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.gain.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })
})
