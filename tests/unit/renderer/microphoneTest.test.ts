import { describe, expect, it, vi } from 'vitest'

import {
  BrowserMicrophoneTest,
  type MicrophoneTestDependencies,
} from '../../../src/renderer/src/features/onboarding/microphoneTest'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

function createHarness() {
  const events = new EventTarget()
  const track = { stop: vi.fn(), addEventListener: events.addEventListener.bind(events), removeEventListener: vi.fn(events.removeEventListener.bind(events)) }
  const stream = { getTracks: vi.fn(() => [track]) }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.2)),
  }
  const mute = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const destination = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    state: 'running',
    destination,
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
    createGain: vi.fn(() => mute),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const frames = new Map<number, () => void>()
  let nextFrame = 1
  const dependencies: MicrophoneTestDependencies = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: vi.fn(() => context),
    requestFrame: vi.fn((callback) => {
      const handle = nextFrame++
      frames.set(handle, callback)
      return handle
    }),
    cancelFrame: vi.fn((handle) => { frames.delete(handle) }),
  }
  return { analyser, context, destination, dependencies, events, frames, mute, source, stream, track }
}

describe('browser microphone setup test', () => {
  it.each([undefined, 'headset'])('requests the same exact input dictation selects (%s)', async selectedDeviceId => {
    const harness = createHarness()
    const test = new BrowserMicrophoneTest(harness.dependencies)
    await expect(test.start(vi.fn(), selectedDeviceId)).resolves.toBe('ready')
    expect(harness.dependencies.getUserMedia).toHaveBeenCalledWith({ audio: {
      deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } })
    await test.stop()
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })

  it('releases every resource and reports missing when the input track ends', async () => {
    const harness = createHarness()
    const missing = vi.fn()
    const test = new BrowserMicrophoneTest(harness.dependencies)
    await test.start(vi.fn(), 'headset', missing)
    harness.events.dispatchEvent(new Event('ended'))
    await Promise.resolve()
    expect(missing).toHaveBeenCalledExactlyOnceWith('missing')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.analyser.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.dependencies.cancelFrame).toHaveBeenCalledOnce()
    expect(harness.track.removeEventListener).toHaveBeenCalledWith('ended', expect.any(Function))
    await test.stop()
    harness.events.dispatchEvent(new Event('ended'))
    expect(missing).toHaveBeenCalledOnce()
    expect(harness.track.stop).toHaveBeenCalledOnce()
  })

  it('reports live RMS activity and releases every native resource on stop', async () => {
    const harness = createHarness()
    const levels: number[] = []
    const test = new BrowserMicrophoneTest(harness.dependencies)

    await expect(test.start((level) => levels.push(level))).resolves.toBe('ready')
    harness.frames.get(1)?.()
    expect(levels[0]).toBeCloseTo(0.6)

    await test.stop()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.analyser.disconnect).toHaveBeenCalledOnce()
    expect(harness.mute.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.dependencies.cancelFrame).toHaveBeenCalledOnce()
  })

  it('opens the audio context before asking for the microphone so a permission dialog cannot swallow the click', async () => {
    const harness = createHarness()
    const permission = deferred<typeof harness.stream>()
    vi.mocked(harness.dependencies.getUserMedia).mockReturnValueOnce(permission.promise)
    const test = new BrowserMicrophoneTest(harness.dependencies)

    const starting = test.start(vi.fn())
    await Promise.resolve()
    expect(harness.dependencies.createAudioContext).toHaveBeenCalledOnce()
    expect(harness.dependencies.getUserMedia).toHaveBeenCalledOnce()
    expect(harness.context.createAnalyser).not.toHaveBeenCalled()

    permission.resolve(harness.stream)
    await expect(starting).resolves.toBe('ready')
  })

  it('keeps the analyser in a muted running graph so Chromium delivers samples', async () => {
    const harness = createHarness()
    const test = new BrowserMicrophoneTest(harness.dependencies)

    await expect(test.start(vi.fn())).resolves.toBe('ready')
    expect(harness.source.connect).toHaveBeenCalledWith(harness.analyser)
    expect(harness.analyser.connect).toHaveBeenCalledWith(harness.mute)
    expect(harness.mute.connect).toHaveBeenCalledWith(harness.destination)
    expect(harness.mute.gain.value).toBe(0)
  })

  it('resumes a context that is still suspended after the permission dialog', async () => {
    const harness = createHarness()
    harness.context.state = 'suspended'
    const test = new BrowserMicrophoneTest(harness.dependencies)

    await expect(test.start(vi.fn())).resolves.toBe('ready')
    expect(harness.context.resume).toHaveBeenCalled()
  })

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'missing'],
    ['OverconstrainedError', 'missing'],
    ['AbortError', 'error'],
  ] as const)('normalizes %s without exposing exception details', async (name, outcome) => {
    const harness = createHarness()
    vi.mocked(harness.dependencies.getUserMedia).mockRejectedValueOnce({ name, secret: 'raw device detail' })
    const test = new BrowserMicrophoneTest(harness.dependencies)

    await expect(test.start(vi.fn(), 'selected-headset')).resolves.toBe(outcome)
    expect(harness.dependencies.getUserMedia).toHaveBeenCalledOnce()
    expect(harness.dependencies.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ deviceId: { exact: 'selected-headset' } }),
    }))
    expect(harness.context.createAnalyser).not.toHaveBeenCalled()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('stops a late permission stream after cancellation without creating an audio graph', async () => {
    const harness = createHarness()
    const permission = deferred<typeof harness.stream>()
    vi.mocked(harness.dependencies.getUserMedia).mockReturnValueOnce(permission.promise)
    const test = new BrowserMicrophoneTest(harness.dependencies)

    const starting = test.start(vi.fn())
    await Promise.resolve()
    await test.stop()
    permission.resolve(harness.stream)

    await expect(starting).resolves.toBe('error')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.context.createMediaStreamSource).not.toHaveBeenCalled()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('lets an immediate stop invalidate start before permission is requested', async () => {
    const harness = createHarness()
    const test = new BrowserMicrophoneTest(harness.dependencies)

    const starting = test.start(vi.fn())
    await test.stop()

    await expect(starting).resolves.toBe('error')
    expect(harness.dependencies.getUserMedia).not.toHaveBeenCalled()
  })

  it('cleans the stream and context when graph setup fails', async () => {
    const harness = createHarness()
    harness.context.createAnalyser.mockImplementationOnce(() => { throw new Error('device secret') })
    const test = new BrowserMicrophoneTest(harness.dependencies)

    await expect(test.start(vi.fn())).resolves.toBe('error')
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.source.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })
})
