import { calculateRms, resampleMono } from './audioMath'

export const AUDIO_CAPTURE_PROCESSOR_NAME = 'talktype-audio-capture'

export type AudioRecorderErrorCode =
  | 'ALREADY_RECORDING'
  | 'INVALID_DURATION'
  | 'LEVEL_CALLBACK_FAILED'
  | 'DURATION_CALLBACK_FAILED'
  | 'FINALIZE_FAILED'
  | 'START_FAILED'

export class AudioRecorderError extends Error {
  constructor(
    readonly code: AudioRecorderErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AudioRecorderError'
  }
}

export interface AudioNodeAdapter {
  connect(node: AudioNodeAdapter): AudioNodeAdapter
  disconnect(): void
}

export interface GainNodeAdapter extends AudioNodeAdapter {
  gain: { value: number }
}

export interface AudioWorkletNodeAdapter extends AudioNodeAdapter {
  port: { onmessage: ((event: { data: unknown }) => void) | null }
}

export interface MediaStreamAdapter {
  getTracks(): { stop(): void }[]
}

export interface AudioContextAdapter {
  readonly sampleRate: number
  readonly destination: AudioNodeAdapter
  readonly audioWorklet: { addModule(url: string): Promise<void> }
  createMediaStreamSource(stream: MediaStreamAdapter): AudioNodeAdapter
  createGain(): GainNodeAdapter
  close(): Promise<void>
}

export interface AudioRecorderDependencies {
  mediaDevices: {
    getUserMedia(constraints: MicrophoneConstraints): Promise<MediaStreamAdapter>
  }
  createAudioContext(): AudioContextAdapter
  createAudioWorkletNode(
    context: AudioContextAdapter,
    processorName: string,
  ): AudioWorkletNodeAdapter
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

export interface AudioRecordingResult {
  samples: Float32Array
  sourceSampleRate: number
  durationMs: number
}

export interface AudioRecorderOptions {
  selectedDeviceId?: string
  maxRecordingSeconds?: number
  onLevel?: (level: number) => void
  onDurationLimit?: (result: AudioRecordingResult) => void
}

export interface MicrophoneConstraints {
  audio: {
    deviceId: { exact: string } | undefined
    channelCount: 1
    echoCancellation: true
    noiseSuppression: true
    autoGainControl: true
  }
}

interface RecordingSession {
  chunks: Float32Array[]
  sourceFrames: number
  starting: boolean
  terminated: boolean
  resolveStartOnTermination?: boolean
  stream?: MediaStreamAdapter
  context?: AudioContextAdapter
  source?: AudioNodeAdapter
  worklet?: AudioWorkletNodeAdapter
  gain?: GainNodeAdapter
  timer?: unknown
  finalization?: Promise<AudioRecordingResult | null>
}

function defaultDependencies(): AudioRecorderDependencies {
  const browser = globalThis as unknown as {
    navigator: {
      mediaDevices: {
        getUserMedia(constraints: MicrophoneConstraints): Promise<MediaStreamAdapter>
      }
    }
    AudioContext: new () => AudioContextAdapter
    AudioWorkletNode: new (
      context: AudioContextAdapter,
      processorName: string,
    ) => AudioWorkletNodeAdapter
    setTimeout(callback: () => void, delayMs: number): number
    clearTimeout(handle: number): void
  }
  return {
    mediaDevices: {
      getUserMedia: (constraints) => browser.navigator.mediaDevices.getUserMedia(constraints),
    },
    createAudioContext: () => new browser.AudioContext(),
    createAudioWorkletNode: (context, processorName) =>
      new browser.AudioWorkletNode(context, processorName),
    setTimer: (callback, delayMs) => browser.setTimeout(callback, delayMs),
    clearTimer: (handle) => browser.clearTimeout(handle as number),
  }
}

function cloneResult(result: AudioRecordingResult): AudioRecordingResult {
  return { ...result, samples: result.samples.slice() }
}

export class AudioRecorder {
  private readonly dependencies: AudioRecorderDependencies
  private session: RecordingSession | null = null
  private lastResult: AudioRecordingResult | null = null
  private lastError: AudioRecorderError | null = null

  constructor(
    private readonly options: AudioRecorderOptions = {},
    dependencies?: AudioRecorderDependencies,
  ) {
    this.dependencies = dependencies ?? defaultDependencies()
    const duration = options.maxRecordingSeconds
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
      throw new AudioRecorderError(
        'INVALID_DURATION',
        'Maximum recording duration must be a finite positive number.',
      )
    }
  }

  async start(): Promise<void> {
    if (this.session !== null) {
      throw new AudioRecorderError('ALREADY_RECORDING', 'Microphone capture is already active.')
    }

    const session: RecordingSession = {
      chunks: [],
      sourceFrames: 0,
      starting: true,
      terminated: false,
    }
    this.session = session
    this.lastResult = null
    this.lastError = null

    try {
      const selected = this.options.selectedDeviceId
      session.stream = await this.dependencies.mediaDevices.getUserMedia({
        audio: {
          deviceId: selected ? { exact: selected } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      this.assertSessionLive(session)

      session.context = this.dependencies.createAudioContext()
      await session.context.audioWorklet.addModule('/audio-capture-worklet.js')
      this.assertSessionLive(session)

      session.source = session.context.createMediaStreamSource(session.stream)
      session.worklet = this.dependencies.createAudioWorkletNode(
        session.context,
        AUDIO_CAPTURE_PROCESSOR_NAME,
      )
      session.gain = session.context.createGain()
      session.gain.gain.value = 0
      session.source.connect(session.worklet)
      session.worklet.connect(session.gain)
      session.gain.connect(session.context.destination)
      session.worklet.port.onmessage = (event) => this.receiveChunk(session, event.data)

      if (this.options.maxRecordingSeconds !== undefined) {
        session.timer = this.dependencies.setTimer(() => {
          void this.finishAtDurationLimit(session).catch((error: unknown) => {
            this.lastError =
              error instanceof AudioRecorderError
                ? error
                : new AudioRecorderError(
                    'FINALIZE_FAILED',
                    'Unable to finalize microphone capture.',
                  )
          })
        }, this.options.maxRecordingSeconds * 1_000)
      }
      session.starting = false
    } catch {
      const resolveCancelledStart = session.resolveStartOnTermination === true
      session.starting = false
      session.terminated = true
      await this.cleanup(session)
      if (this.session === session) this.session = null
      if (resolveCancelledStart) return
      throw new AudioRecorderError('START_FAILED', 'Unable to start microphone capture.')
    }
  }

  async stop(): Promise<AudioRecordingResult | null> {
    const session = this.session
    if (session === null) return null
    if (session.starting) {
      if (!session.terminated) session.resolveStartOnTermination = true
      await this.finalize(session, false)
      return null
    }
    const result = await this.finalize(session, true)
    return result === null ? null : cloneResult(result)
  }

  async cancel(): Promise<void> {
    const session = this.session
    if (session === null) return
    await this.finalize(session, false)
  }

  getLastResult(): AudioRecordingResult | null {
    return this.lastResult === null ? null : cloneResult(this.lastResult)
  }

  getLastError(): AudioRecorderError | null {
    return this.lastError
  }

  private assertSessionLive(session: RecordingSession): void {
    if (session.terminated || this.session !== session) throw new Error('session terminated')
  }

  private receiveChunk(session: RecordingSession, data: unknown): void {
    if (session.terminated || this.session !== session || !(data instanceof Float32Array)) return

    const chunk = new Float32Array(data)
    session.chunks.push(chunk)
    session.sourceFrames += chunk.length
    try {
      this.options.onLevel?.(calculateRms(chunk))
    } catch {
      this.lastError = new AudioRecorderError(
        'LEVEL_CALLBACK_FAILED',
        'Audio level callback failed.',
      )
      void this.finalize(session, false).catch(() => undefined)
    }
  }

  private async finishAtDurationLimit(session: RecordingSession): Promise<void> {
    if (session.terminated || this.session !== session) return
    const result = await this.finalize(session, true)
    if (result === null || this.options.onDurationLimit === undefined) return
    try {
      this.options.onDurationLimit(cloneResult(result))
    } catch {
      this.lastError = new AudioRecorderError(
        'DURATION_CALLBACK_FAILED',
        'Recording duration callback failed.',
      )
    }
  }

  private finalize(
    session: RecordingSession,
    includeAudio: boolean,
  ): Promise<AudioRecordingResult | null> {
    if (session.finalization !== undefined) return session.finalization

    session.terminated = true
    session.finalization = (async () => {
      let result: AudioRecordingResult | null = null
      try {
        if (includeAudio) {
          const sampleRate = session.context?.sampleRate ?? 16_000
          const joined = new Float32Array(session.sourceFrames)
          let offset = 0
          for (const chunk of session.chunks) {
            joined.set(chunk, offset)
            offset += chunk.length
          }
          result = {
            samples: resampleMono(joined, sampleRate),
            sourceSampleRate: sampleRate,
            durationMs: (session.sourceFrames / sampleRate) * 1_000,
          }
        }
      } catch {
        const error = new AudioRecorderError(
          'FINALIZE_FAILED',
          'Unable to finalize microphone capture.',
        )
        this.lastError = error
        throw error
      } finally {
        session.chunks.length = 0
        await this.cleanup(session)
        if (!session.starting && this.session === session) this.session = null
      }
      if (result !== null) this.lastResult = result
      return result
    })()
    return session.finalization
  }

  private async cleanup(session: RecordingSession): Promise<void> {
    const timer = session.timer
    delete session.timer
    if (timer !== undefined) this.safely(() => this.dependencies.clearTimer(timer))

    const worklet = session.worklet
    delete session.worklet
    if (worklet !== undefined) {
      this.safely(() => {
        worklet.port.onmessage = null
      })
      this.safely(() => worklet.disconnect())
    }

    const source = session.source
    delete session.source
    if (source !== undefined) this.safely(() => source.disconnect())

    const gain = session.gain
    delete session.gain
    if (gain !== undefined) this.safely(() => gain.disconnect())

    const stream = session.stream
    delete session.stream
    if (stream !== undefined) {
      let tracks: { stop(): void }[] = []
      try {
        tracks = stream.getTracks()
      } catch {
        // Continue closing graph/context resources when stream access itself fails.
      }
      for (const track of tracks) this.safely(() => track.stop())
    }

    const context = session.context
    delete session.context
    if (context !== undefined) {
      try {
        await context.close()
      } catch {
        // Cleanup failures never replace the primary recorder result or finite app error.
      }
    }
  }

  private safely(action: () => void): void {
    try {
      action()
    } catch {
      // Best-effort release continues for the remaining independently owned resources.
    }
  }
}
