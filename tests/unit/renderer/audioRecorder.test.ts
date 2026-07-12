import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  AUDIO_CAPTURE_PROCESSOR_NAME,
  AudioRecorder,
  AudioRecorderError,
  type AudioContextAdapter,
  type AudioNodeAdapter,
  type AudioRecorderDependencies,
  type AudioWorkletNodeAdapter,
  type MediaStreamAdapter,
} from '../../../src/renderer/src/audio/audioRecorder'

class FakeNode implements AudioNodeAdapter {
  readonly connect = vi.fn<(node: AudioNodeAdapter) => AudioNodeAdapter>((node) => node)
  readonly disconnect = vi.fn()
}

class FakeWorkletNode extends FakeNode implements AudioWorkletNodeAdapter {
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null }
}

class FakeContext implements AudioContextAdapter {
  readonly sampleRate = 48_000
  readonly destination = new FakeNode()
  readonly source = new FakeNode()
  readonly gain = Object.assign(new FakeNode(), { gain: { value: 1 } })
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }
  readonly createMediaStreamSource = vi.fn(() => this.source)
  readonly createGain = vi.fn(() => this.gain)
  readonly close = vi.fn(async () => undefined)
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, reject: rejectPromise, resolve: resolvePromise }
}

function createHarness(overrides: Partial<AudioRecorderDependencies> = {}) {
  const context = new FakeContext()
  const worklet = new FakeWorkletNode()
  const track = { stop: vi.fn() }
  const stream: MediaStreamAdapter = { getTracks: vi.fn(() => [track]) }
  const getUserMedia = vi.fn(async () => stream)
  let timer: (() => void) | undefined
  const dependencies: AudioRecorderDependencies = {
    mediaDevices: { getUserMedia },
    createAudioContext: vi.fn(() => context),
    createAudioWorkletNode: vi.fn(() => worklet),
    setTimer: vi.fn((callback) => {
      timer = callback
      return 7
    }),
    clearTimer: vi.fn(),
    ...overrides,
  }
  return {
    context,
    dependencies,
    fireTimer: () => timer?.(),
    getUserMedia,
    recorder: (options: ConstructorParameters<typeof AudioRecorder>[0] = {}) =>
      new AudioRecorder(options, dependencies),
    stream,
    track,
    worklet,
  }
}

describe('audio capture worklet', () => {
  it('registers the stable processor and posts fresh transferred channel copies', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/public/audio-capture-worklet.js'),
      'utf8',
    )

    expect(source).toContain(`registerProcessor('${AUDIO_CAPTURE_PROCESSOR_NAME}'`)
    expect(source).toContain('new Float32Array(channel)')
    expect(source).toContain('this.port.postMessage(copy, [copy.buffer])')
    expect(source).toContain('return true')
  })
})

describe('AudioRecorder', () => {
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
      '/audio-capture-worklet.js',
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
    expect(result?.samples).toHaveLength(1_600)
    expect(result?.samples[0]).toBeCloseTo(0.5)
    expect(result?.durationMs).toBe(100)
    expect(await recorder.stop()).toBeNull()
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

    expect(recorder.getLastResult()?.durationMs).toBe(1_000)
    expect(onDurationLimit).toHaveBeenCalledWith(recorder.getLastResult())
    expect(await recorder.stop()).toBeNull()
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
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

      expect(harness.track.stop).toHaveBeenCalledTimes(failurePoint === 'media' ? 0 : 1)
      expect(harness.context.close).toHaveBeenCalledTimes(failurePoint === 'media' ? 0 : 1)
    },
  )

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
