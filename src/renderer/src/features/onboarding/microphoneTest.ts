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
}

interface MediaStreamLike {
  getTracks(): MediaTrackLike[]
}

interface AudioNodeLike {
  connect(destination: unknown): unknown
  disconnect(): void
}

interface AnalyserLike extends AudioNodeLike {
  fftSize: number
  getFloatTimeDomainData(samples: Float32Array): void
}

interface AudioContextLike {
  readonly state?: string
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike
  createAnalyser(): AnalyserLike
  resume?(): Promise<void>
  close(): Promise<void>
}

export interface MicrophoneTestDependencies {
  readonly getUserMedia: (constraints: MicrophoneTestConstraints) => Promise<MediaStreamLike>
  readonly createAudioContext: () => AudioContextLike
  readonly requestFrame: (callback: () => void) => number
  readonly cancelFrame: (handle: number) => void
}

export interface MicrophoneTestConstraints {
  readonly audio: {
    readonly channelCount: 1
    readonly echoCancellation: true
    readonly noiseSuppression: true
    readonly autoGainControl: true
  }
}

export interface MicrophoneTestController {
  start(onLevel: (level: number) => void): Promise<MicrophoneTestOutcome>
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
  private frame: number | null = null
  private generation = 0

  constructor(private readonly dependencies: MicrophoneTestDependencies = productionDependencies()) {}

  async start(onLevel: (level: number) => void): Promise<MicrophoneTestOutcome> {
    const generation = ++this.generation
    await this.releaseOwnedResources()
    if (generation !== this.generation) return 'error'
    let stream: MediaStreamLike | null = null
    let context: AudioContextLike | null = null
    let source: AudioNodeLike | null = null
    let analyser: AnalyserLike | null = null
    try {
      stream = await this.dependencies.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (generation !== this.generation) {
        this.stopTracks(stream)
        return 'error'
      }
      context = this.dependencies.createAudioContext()
      if (context.state === 'suspended') await context.resume?.()
      if (generation !== this.generation) {
        this.stopTracks(stream)
        await this.safeClose(context)
        return 'error'
      }
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.stream = stream
      this.context = context
      this.source = source
      this.analyser = analyser
      this.scheduleLevel(generation, onLevel)
      return 'ready'
    } catch (error: unknown) {
      this.safeDisconnect(source)
      this.safeDisconnect(analyser)
      if (stream !== null) this.stopTracks(stream)
      if (context !== null) await this.safeClose(context)
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
    const stream = this.stream
    const context = this.context
    this.clearOwnedResources()
    if (frame !== null) {
      try { this.dependencies.cancelFrame(frame) } catch { /* continue cleanup */ }
    }
    this.safeDisconnect(source)
    this.safeDisconnect(analyser)
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
    this.frame = null
    this.analyser = null
    this.source = null
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
}
