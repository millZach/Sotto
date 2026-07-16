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
  const track = { stop: vi.fn() }
  const stream = { getTracks: vi.fn(() => [track]) }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.2)),
  }
  const context = {
    state: 'running',
    createMediaStreamSource: vi.fn(() => source),
    createAnalyser: vi.fn(() => analyser),
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
  return { analyser, context, dependencies, frames, source, stream, track }
}

describe('browser microphone setup test', () => {
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
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.dependencies.cancelFrame).toHaveBeenCalledOnce()
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

    await expect(test.start(vi.fn())).resolves.toBe(outcome)
    expect(harness.dependencies.createAudioContext).not.toHaveBeenCalled()
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
    expect(harness.dependencies.createAudioContext).not.toHaveBeenCalled()
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
