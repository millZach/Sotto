import {
  AudioRecorder,
  AudioRecorderError,
  type AudioRecorderOptions,
} from '../../audio/audioRecorder'
import { ensureMicrophoneAccess } from '../../audio/ensureMicrophoneAccess'
import { microphoneConstraints, type MicrophoneConstraints } from '../../audio/microphoneConstraints'

export type MicrophoneTestState =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'denied'
  | 'missing'
  | 'error'

export type MicrophoneTestOutcome = Exclude<MicrophoneTestState, 'idle' | 'requesting'>

interface MediaTrackLike {
  stop(): void
  addEventListener?(type: 'ended', listener: () => void): void
  removeEventListener?(type: 'ended', listener: () => void): void
}

interface MediaStreamLike {
  getTracks(): MediaTrackLike[]
}

interface AudioNodeLike {
  connect(destination: unknown): unknown
  disconnect(): void
}

interface GainLike extends AudioNodeLike {
  gain: { value: number }
}

interface AnalyserLike extends AudioNodeLike {
  fftSize: number
  getFloatTimeDomainData(samples: Float32Array): void
}

interface AudioContextLike {
  readonly state?: string
  readonly destination: AudioNodeLike
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike
  createAnalyser(): AnalyserLike
  createGain(): GainLike
  resume?(): Promise<void>
  close(): Promise<void>
}

export interface MicrophoneTestDependencies {
  readonly ensureAccess?: () => Promise<boolean>
  readonly getUserMedia: (constraints: MicrophoneTestConstraints) => Promise<MediaStreamLike>
  readonly createAudioContext: () => AudioContextLike
  readonly requestFrame: (callback: () => void) => number
  readonly cancelFrame: (handle: number) => void
}

export type MicrophoneTestConstraints = MicrophoneConstraints

export interface MicrophoneTestController {
  start(onLevel: (level: number) => void, selectedDeviceId?: string, onEnded?: (outcome: 'missing') => void): Promise<MicrophoneTestOutcome>
  stop(): Promise<void>
}

function productionDependencies(): MicrophoneTestDependencies {
  const browser = globalThis as unknown as {
    navigator: {
      mediaDevices?: {
        getUserMedia(constraints: MicrophoneTestConstraints): Promise<MediaStreamLike>
      }
    }
    AudioContext: new () => AudioContextLike
    requestAnimationFrame(callback: () => void): number
    cancelAnimationFrame(handle: number): void
  }
  return {
    ensureAccess: () => ensureMicrophoneAccess(),
    getUserMedia: (constraints) => {
      const mediaDevices = browser.navigator.mediaDevices
      return mediaDevices === undefined
        ? Promise.reject(new Error('MICROPHONE_API_UNAVAILABLE'))
        : mediaDevices.getUserMedia(constraints)
    },
    createAudioContext: () => new browser.AudioContext(),
    requestFrame: (callback) => browser.requestAnimationFrame(callback),
    cancelFrame: (handle) => browser.cancelAnimationFrame(handle),
  }
}

function classifyMicrophoneFailure(error: unknown): MicrophoneTestOutcome {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'error'
  const name = String((error as { name: unknown }).name)
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
  return 'error'
}

export class BrowserMicrophoneTest implements MicrophoneTestController {
  private stream: MediaStreamLike | null = null
  private context: AudioContextLike | null = null
  private source: AudioNodeLike | null = null
  private analyser: AnalyserLike | null = null
  private mute: GainLike | null = null
  private frame: number | null = null
  private generation = 0
  private trackListeners: Array<{ track: MediaTrackLike; listener: () => void }> = []

  constructor(private readonly dependencies: MicrophoneTestDependencies = productionDependencies()) {}

  async start(onLevel: (level: number) => void, selectedDeviceId?: string, onEnded?: (outcome: 'missing') => void): Promise<MicrophoneTestOutcome> {
    const generation = ++this.generation
    await this.releaseOwnedResources()
    if (generation !== this.generation) return 'error'
    let stream: MediaStreamLike | null = null
    let context: AudioContextLike | null = null
    let source: AudioNodeLike | null = null
    let analyser: AnalyserLike | null = null
    let mute: GainLike | null = null
    try {
      // Open the context in this turn, before getUserMedia. macOS shows a TCC
      // dialog that consumes the click's user gesture; a context created after
      // that dialog stays suspended and the analyser reports silence.
      context = this.dependencies.createAudioContext()
      this.context = context
      if (context.state === 'suspended') await context.resume?.()
      if (generation !== this.generation) {
        await this.abandon(context)
        return 'error'
      }
      // Chromium's check handler cannot prompt: false is a denial. Ask the OS
      // here so getUserMedia runs only after a grant.
      const allowed = await (this.dependencies.ensureAccess?.() ?? Promise.resolve(true))
      if (generation !== this.generation) {
        await this.abandon(context)
        return 'error'
      }
      if (!allowed) {
        await this.abandon(context)
        return 'denied'
      }
      stream = await this.dependencies.getUserMedia(microphoneConstraints(selectedDeviceId))
      if (generation !== this.generation) {
        this.stopTracks(stream)
        await this.abandon(context)
        return 'error'
      }
      if (context.state === 'suspended') await context.resume?.()
      if (generation !== this.generation) {
        this.stopTracks(stream)
        await this.abandon(context)
        return 'error'
      }
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      mute = context.createGain()
      mute.gain.value = 0
      // Chromium does not pull a MediaStream through an analyser unless the
      // node is in a graph that reaches destination. Mute the tap so the test
      // cannot play back through the speakers. Dictation uses the same shape.
      source.connect(analyser)
      analyser.connect(mute)
      mute.connect(context.destination)
      this.stream = stream
      this.context = context
      this.source = source
      this.analyser = analyser
      this.mute = mute
      for (const track of stream.getTracks()) {
        const listener = (): void => {
          if (generation !== this.generation) return
          void this.stop()
          onEnded?.('missing')
        }
        this.trackListeners.push({ track, listener })
        track.addEventListener?.('ended', listener)
      }
      this.scheduleLevel(generation, onLevel)
      return 'ready'
    } catch (error: unknown) {
      this.safeDisconnect(source)
      this.safeDisconnect(analyser)
      this.safeDisconnect(mute)
      if (stream !== null) this.stopTracks(stream)
      await this.abandon(context)
      if (generation === this.generation) this.clearOwnedResources()
      return classifyMicrophoneFailure(error)
    }
  }

  async stop(): Promise<void> {
    ++this.generation
    await this.releaseOwnedResources()
  }

  private async releaseOwnedResources(): Promise<void> {
    const frame = this.frame
    const analyser = this.analyser
    const source = this.source
    const mute = this.mute
    const stream = this.stream
    const context = this.context
    this.clearOwnedResources()
    if (frame !== null) {
      try { this.dependencies.cancelFrame(frame) } catch { /* continue cleanup */ }
    }
    this.safeDisconnect(source)
    this.safeDisconnect(analyser)
    this.safeDisconnect(mute)
    if (stream !== null) this.stopTracks(stream)
    if (context !== null) await this.safeClose(context)
  }

  private scheduleLevel(generation: number, onLevel: (level: number) => void): void {
    const analyser = this.analyser
    if (analyser === null) return
    const samples = new Float32Array(analyser.fftSize)
    const sample = (): void => {
      if (generation !== this.generation || this.analyser !== analyser) return
      try {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const value of samples) sum += value * value
        const rms = Math.sqrt(sum / Math.max(1, samples.length))
        onLevel(Math.min(1, Math.max(0, rms * 3)))
      } catch {
        // A visual meter is observational and cannot make resource cleanup fail.
      }
      if (generation === this.generation) {
        this.frame = this.dependencies.requestFrame(sample)
      }
    }
    this.frame = this.dependencies.requestFrame(sample)
  }

  private clearOwnedResources(): void {
    for (const { track, listener } of this.trackListeners) {
      try { track.removeEventListener?.('ended', listener) } catch { /* continue cleanup */ }
    }
    this.trackListeners = []
    this.frame = null
    this.analyser = null
    this.source = null
    this.mute = null
    this.stream = null
    this.context = null
  }

  private stopTracks(stream: MediaStreamLike): void {
    let tracks: MediaTrackLike[]
    try { tracks = stream.getTracks() } catch { return }
    for (const track of tracks) {
      try { track.stop() } catch { /* continue stopping independent tracks */ }
    }
  }

  private safeDisconnect(node: AudioNodeLike | null): void {
    if (node === null) return
    try { node.disconnect() } catch { /* continue cleanup */ }
  }

  private async safeClose(context: AudioContextLike): Promise<void> {
    try { await context.close() } catch { /* test resources are best-effort */ }
  }

  /** Close a context only if this instance still owns it; stop() may have already. */
  private async abandon(context: AudioContextLike | null): Promise<void> {
    if (context === null || this.context !== context) return
    this.context = null
    await this.safeClose(context)
  }
}

type LevelRecorder = {
  start(): Promise<void>
  cancel(): Promise<void>
}

/** Live meter used in the app: same capture graph as dictation, not AnalyserNode. */
export class WorkletMicrophoneTest implements MicrophoneTestController {
  private recorder: LevelRecorder | null = null
  private generation = 0

  constructor(
    private readonly createRecorder: (options: AudioRecorderOptions) => LevelRecorder = (options) =>
      new AudioRecorder(options),
  ) {}

  async start(onLevel: (level: number) => void, selectedDeviceId?: string, onEnded?: (outcome: 'missing') => void): Promise<MicrophoneTestOutcome> {
    const generation = ++this.generation
    await this.stopRecorder()
    if (generation !== this.generation) return 'error'
    const recorder: LevelRecorder = this.createRecorder({
      onLevel,
      levelsOnly: true,
      // The recorder has already released the input; drop it and say so once.
      onDeviceUnavailable: () => {
        if (generation !== this.generation || this.recorder !== recorder) return
        this.recorder = null
        onEnded?.('missing')
      },
      ...(selectedDeviceId ? { selectedDeviceId } : {}),
    })
    this.recorder = recorder
    try {
      await recorder.start()
      if (generation !== this.generation) {
        await this.stopRecorder()
        return 'error'
      }
      return 'ready'
    } catch (error: unknown) {
      if (this.recorder === recorder) this.recorder = null
      await recorder.cancel().catch(() => undefined)
      if (generation !== this.generation) return 'error'
      if (error instanceof AudioRecorderError) {
        return classifyMicrophoneFailure({ name: error.startFailureName ?? error.name })
      }
      return classifyMicrophoneFailure(error)
    }
  }

  async stop(): Promise<void> {
    this.generation += 1
    await this.stopRecorder()
  }

  private async stopRecorder(): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    if (recorder !== null) await recorder.cancel().catch(() => undefined)
  }
}
