import { calculateRms, resampleMono } from '../audio/audioMath'
import {
  AUDIO_CAPTURE_PROCESSOR_NAME,
  LEVEL_EMIT_INTERVAL_MS,
  type AudioContextAdapter,
  type AudioNodeAdapter,
  type AudioWorkletNodeAdapter,
  type GainNodeAdapter,
  type MediaStreamAdapter,
  type MediaStreamTrackAdapter,
  type MicrophoneConstraints,
} from '../audio/audioRecorder'

export interface VoiceCaptureOptions {
  readonly selectedDeviceId?: string
  /** Finite mono 16 kHz PCM in [-1, 1], with a short local pre-roll. */
  readonly onUtterance: (audio: Float32Array) => void
  readonly onLevel?: (level: number) => void
  readonly onError: (error: Error) => void
}

export interface VoiceCapture {
  start(): Promise<void>
  stop(): Promise<void>
  /** Clears any partial utterance and discards microphone frames while true. */
  setSuppressed(suppressed: boolean): void
}

// These are initial capture settings, not claims about measured wake accuracy.
const SPEECH_RMS = 0.012
const PRE_ROLL_SECONDS = 0.18
const END_SILENCE_SECONDS = 0.65
const MIN_VOICED_SECONDS = 0.14
const MAX_UTTERANCE_SECONDS = 8

interface CaptureSession {
  readonly context: VoiceAudioContext
  terminated: boolean
  stream?: MediaStreamAdapter
  source?: AudioNodeAdapter
  worklet?: AudioWorkletNodeAdapter
  gain?: GainNodeAdapter
  tracks: MediaStreamTrackAdapter[]
  ended?: () => void
}

interface VoiceAudioContext extends AudioContextAdapter {
  readonly state?: string
  resume?(): Promise<void>
}

interface VoiceBrowser {
  readonly document: { readonly baseURI: string }
  readonly navigator: {
    readonly mediaDevices: { getUserMedia(options: MicrophoneConstraints): Promise<MediaStreamAdapter> }
  }
  readonly AudioContext: new () => VoiceAudioContext
  readonly AudioWorkletNode: new (context: VoiceAudioContext, name: string) => AudioWorkletNodeAdapter
}

/**
 * A separate microphone path for short voice turns. The existing dictation
 * recorder keeps its long recording/segmentation behavior unchanged.
 */
export class BrowserVoiceCapture implements VoiceCapture {
  private session: CaptureSession | null = null
  private suppressed = false
  private preRoll: Float32Array[] = []
  private preRollFrames = 0
  private chunks: Float32Array[] = []
  private frames = 0
  private voicedFrames = 0
  private silentFrames = 0
  private lastLevelAt = 0

  constructor(private readonly options: VoiceCaptureOptions) {}

  async start(): Promise<void> {
    if (this.session !== null) return
    const browser = globalThis as unknown as VoiceBrowser
    const context = new browser.AudioContext()
    const session: CaptureSession = { context, terminated: false, tracks: [] }
    this.session = session
    this.clearAudio()
    try {
      // Prepare the graph before opening the microphone to preserve first words.
      await context.audioWorklet.addModule(new URL('audio-capture-worklet.js', browser.document.baseURI).href)
      if (session.terminated) return
      session.worklet = new browser.AudioWorkletNode(context, AUDIO_CAPTURE_PROCESSOR_NAME)
      session.gain = context.createGain()
      session.gain.gain.value = 0
      session.worklet.connect(session.gain)
      session.gain.connect(context.destination)
      session.stream = await browser.navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.options.selectedDeviceId === undefined
            ? undefined : { exact: this.options.selectedDeviceId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      session.tracks = session.stream.getTracks()
      if (session.terminated) {
        await this.release(session)
        return
      }
      session.ended = () => {
        if (session.terminated) return
        void this.stop()
        this.options.onError(new Error('The microphone became unavailable. Reconnect it, then retry.'))
      }
      for (const track of session.tracks) track.addEventListener?.('ended', session.ended)
      session.stream.addEventListener?.('removetrack', session.ended)
      session.worklet.port.onmessage = (event: { data: unknown }) => {
        if (this.session !== session || session.terminated || this.suppressed) return
        if (!(event.data instanceof Float32Array)) return
        this.receive(event.data, context.sampleRate)
      }
      session.source = context.createMediaStreamSource(session.stream)
      session.source.connect(session.worklet)
      if (context.state === 'suspended') await context.resume?.()
    } catch (error: unknown) {
      const cancelled = session.terminated
      await this.release(session)
      if (this.session === session) this.session = null
      if (!cancelled) throw error
    }
  }

  async stop(): Promise<void> {
    const session = this.session
    this.session = null
    this.clearAudio()
    if (session !== null) await this.release(session)
  }

  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed
    this.clearAudio()
  }

  private receive(input: Float32Array, sampleRate: number): void {
    const level = calculateRms(input)
    const now = Date.now()
    if (now - this.lastLevelAt >= LEVEL_EMIT_INTERVAL_MS) {
      this.lastLevelAt = now
      this.options.onLevel?.(level)
    }
    const voiced = level >= SPEECH_RMS
    const chunk = input.slice()
    if (this.chunks.length === 0 && !voiced) {
      this.preRoll.push(chunk)
      this.preRollFrames += chunk.length
      while (this.preRollFrames > PRE_ROLL_SECONDS * sampleRate) {
        this.preRollFrames -= this.preRoll.shift()?.length ?? 0
      }
      return
    }
    if (this.chunks.length === 0) {
      this.chunks = this.preRoll
      this.frames = this.preRollFrames
      this.preRoll = []
      this.preRollFrames = 0
    }
    this.chunks.push(chunk)
    this.frames += chunk.length
    if (voiced) {
      this.voicedFrames += chunk.length
      this.silentFrames = 0
    } else {
      this.silentFrames += chunk.length
    }
    if (this.silentFrames < END_SILENCE_SECONDS * sampleRate
      && this.frames < MAX_UTTERANCE_SECONDS * sampleRate) return

    if (this.voicedFrames >= MIN_VOICED_SECONDS * sampleRate) {
      const joined = new Float32Array(this.frames)
      let offset = 0
      for (const pending of this.chunks) {
        joined.set(pending, offset)
        offset += pending.length
      }
      this.clearAudio()
      const audio = resampleMono(joined, sampleRate)
      // Sinc resampling can ring beyond full scale even after the microphone
      // worklet clamps its input. Bound the voice PCM sent to wake detection.
      for (let index = 0; index < audio.length; index += 1) {
        const sample = audio[index]!
        audio[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
      }
      this.options.onUtterance(audio)
    } else {
      this.clearAudio()
    }
  }

  private clearAudio(): void {
    this.preRoll = []
    this.preRollFrames = 0
    this.chunks = []
    this.frames = 0
    this.voicedFrames = 0
    this.silentFrames = 0
  }

  private async release(session: CaptureSession): Promise<void> {
    session.terminated = true
    if (session.ended !== undefined) {
      session.stream?.removeEventListener?.('removetrack', session.ended)
      for (const track of session.tracks) track.removeEventListener?.('ended', session.ended)
    }
    if (session.worklet !== undefined) {
      session.worklet.port.onmessage = null
      try { session.worklet.disconnect() } catch { /* release other resources */ }
    }
    try { session.source?.disconnect() } catch { /* release other resources */ }
    try { session.gain?.disconnect() } catch { /* release other resources */ }
    for (const track of session.tracks) {
      try { track.stop() } catch { /* release other tracks */ }
    }
    try { await session.context.close() } catch { /* already closed */ }
  }
}
