
import { vi } from 'vitest'

import {
  AudioRecorder,
  type AudioContextAdapter,
  type AudioNodeAdapter,
  type AudioRecorderDependencies,
  type AudioWorkletNodeAdapter,
  type MediaStreamAdapter
} from '../../../src/renderer/src/audio/audioRecorder'

export class FakeNode implements AudioNodeAdapter {
  readonly connect = vi.fn<(node: AudioNodeAdapter) => AudioNodeAdapter>((node) => node)
  readonly disconnect = vi.fn()
}

export class FakeWorkletNode extends FakeNode implements AudioWorkletNodeAdapter {
  readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null }
}

export class FakeContext implements AudioContextAdapter {
  constructor(readonly sampleRate = 48_000) {}
  readonly destination = new FakeNode()
  readonly source = new FakeNode()
  readonly gain = Object.assign(new FakeNode(), { gain: { value: 1 } })
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) }
  state: 'suspended' | 'running' | 'closed' = 'running'
  readonly resume = vi.fn(async () => { this.state = 'running' })
  readonly createMediaStreamSource = vi.fn(() => this.source)
  readonly createGain = vi.fn(() => this.gain)
  readonly close = vi.fn(async () => undefined)
}

export { deferred } from '../deferred'

export function createHarness(overrides: Partial<AudioRecorderDependencies> = {}, sampleRate = 48_000) {
  const context = new FakeContext(sampleRate)
  const worklet = new FakeWorkletNode()
  const trackListeners = new Set<() => void>()
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      trackListeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      trackListeners.delete(listener)
    }),
  }
  const streamListeners = new Set<() => void>()
  let trackRemoved = false
  const stream: MediaStreamAdapter = {
    getTracks: vi.fn(() => trackRemoved ? [] : [track]),
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      streamListeners.add(listener)
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      streamListeners.delete(listener)
    }),
  }
  const getUserMedia = vi.fn(async () => stream)
  let timer: (() => void) | undefined
  const dependencies: AudioRecorderDependencies = {
    audioWorkletModuleUrl:
      'file:///C:/Program%20Files/Sotto/resources/app.asar/out/renderer/audio-capture-worklet.js',
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
    endTrack: () => {
      for (const listener of [...trackListeners]) listener()
    },
    removeTrack: () => {
      trackRemoved = true
      for (const listener of [...streamListeners]) listener()
    },
    fireTimer: () => timer?.(),
    getUserMedia,
    recorder: (options: ConstructorParameters<typeof AudioRecorder>[0] = {}) =>
      new AudioRecorder(options, dependencies),
    stream,
    track,
    worklet,
  }
}
