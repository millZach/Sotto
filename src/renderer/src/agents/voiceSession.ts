import type { AppSettings } from '../../../shared/settings'
import type { AgentWakeDetection } from '../../../shared/agents'
import { TranscriptionClient, type LoadOptions, type TranscribeOptions } from '../transcription/client'
import { BrowserVoiceCapture, type VoiceCapture, type VoiceCaptureOptions } from './voiceCapture'
import { LocalSystemSpeech, type VoiceSpeechOutput } from './voiceSpeech'
import { calculateRms } from '../audio/audioMath'

export type AgentVoiceStatus = 'off' | 'starting' | 'wake' | 'listening' | 'speaking'
  | 'muted' | 'dictation' | 'error'

export interface AgentVoiceState {
  readonly status: AgentVoiceStatus
  readonly error?: string
}

export interface AgentVoiceOptions {
  readonly wakeDetector?: LocalWakeDetector
  readonly speechOutput?: VoiceSpeechOutput
  readonly getSettings: () => Pick<AppSettings, 'microphoneId' | 'modelPreset' | 'language'>
  readonly onState: (state: AgentVoiceState) => void
  readonly onWake?: () => void | Promise<void>
  /** Receives activated speech only. Caller owns prompt composition and send-it semantics. */
  readonly onUtterance: (text: string) => void | Promise<void>
  readonly onLevel?: (level: number) => void
  /** Zero keeps the conversation open; expiry never submits or clears a draft. */
  readonly conversationTimeoutMs?: number
}

interface LocalVoiceTranscriber {
  load(options: LoadOptions): Promise<unknown>
  transcribe(options: TranscribeOptions): Promise<{ text: string; language: string }>
  cancel(sessionId: string): void
  dispose(): void
}

export interface LocalWakeDetector {
  load(): Promise<void>
  detect(audio: Float32Array): Promise<AgentWakeDetection>
  dispose(): void
}

export interface AgentVoiceDependencies {
  readonly createWakeDetector: () => LocalWakeDetector
  readonly createCapture: (options: VoiceCaptureOptions) => VoiceCapture
  /** Must always be the local worker, never the optional remote dictation fallback. */
  readonly createLocalTranscriber: () => LocalVoiceTranscriber
  readonly speech: VoiceSpeechOutput
  readonly createId: () => string
  readonly setTimer: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer: (handle: unknown) => void
}

const MAX_PENDING_UTTERANCES = 8
const SPEECH_ECHO_GUARD_MS = 450
const DEFAULT_CONVERSATION_TIMEOUT_MS = 120_000

function productionDependencies(): AgentVoiceDependencies {
  return {
    createWakeDetector: () => ({
      async load() { throw new Error('Wake setup required. Configure a supported local wake model in Agent connection settings.') },
      async detect() { return { detected: false, endSeconds: 0 } },
      dispose() {},
    }),
    createCapture: (options) => new BrowserVoiceCapture(options),
    createLocalTranscriber: () => new TranscriptionClient(),
    speech: new LocalSystemSpeech(),
    createId: () => crypto.randomUUID(),
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

/** Match wake words at the beginning of an utterance, never inside ordinary speech. */
function afterWake(text: string): string | null {
  const match = /^[\s\p{P}]*hey[\s\p{P}]+sot{1,2}o(?=$|[\s\p{P}])[\s\p{P}]*/iu.exec(text)
  return match === null ? null : text.slice(match[0].length).trim()
}

function controlWords(text: string): string {
  return text.toLocaleLowerCase('en').replace(/[\p{P}]/gu, '').replace(/\s+/g, ' ').trim()
}

function voiceFailure(error: unknown, fallback: string): string {
  // Electron adds IPC plumbing to native errors. Keep the actionable message.
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method 'sotto:agents:[^']+': (?:Error: )?/u, '')
    : fallback
}

function microphoneFailure(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow Sotto to use the microphone, then retry.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return 'The selected microphone is unavailable. Choose an available microphone, then retry.'
  }
  return voiceFailure(error, 'Local voice input is unavailable. Retry to reconnect.')
}

/**
 * Owns audio activation only. It has no app bridge, remote transcription,
 * clipboard, provider credentials, or persistent background transcript.
 */
export class AgentVoiceSession {
  private readonly dependencies: AgentVoiceDependencies
  private enabled = false
  private muted = false
  private dictationActive = false
  private conversation = false
  private disposed = false
  private starting = false
  private capture: VoiceCapture | null = null
  private local: LocalVoiceTranscriber | null = null
  private wake: LocalWakeDetector | null = null
  private inputError: string | undefined
  private speechError: string | undefined
  private captureGeneration = 0
  private audioGeneration = 0
  private recognitionId: string | null = null
  private queue: Array<{ audio: Float32Array; generation: number }> = []
  private draining = false
  private speechGeneration = 0
  private speechPending = 0
  private speechTail: Promise<void> = Promise.resolve()
  private echoTimer: unknown
  private inactivityTimer: unknown
  private echoSuppressed = false

  constructor(private readonly options: AgentVoiceOptions, dependencies?: AgentVoiceDependencies) {
    this.dependencies = dependencies ?? {
      ...productionDependencies(),
      ...(options.speechOutput === undefined ? {} : { speech: options.speechOutput }),
      ...(options.wakeDetector === undefined ? {} : { createWakeDetector: () => options.wakeDetector! }),
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.enabled = true
    this.inputError = undefined
    await this.ensureCapture()
  }

  async stop(): Promise<void> {
    this.enabled = false
    this.conversation = false
    this.clearInactivity()
    this.stopSpeaking()
    await this.releaseCapture()
    this.publish()
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.disposed || this.muted === muted) return
    this.muted = muted
    this.conversation = false
    this.clearInactivity()
    if (muted) {
      this.stopSpeaking()
      await this.releaseCapture()
    } else {
      this.inputError = undefined
      await this.ensureCapture()
    }
    this.publish()
  }

  async setDictationActive(active: boolean): Promise<void> {
    if (this.disposed || this.dictationActive === active) return
    this.dictationActive = active
    this.conversation = false
    this.clearInactivity()
    if (active) {
      this.stopSpeaking()
      await this.releaseCapture()
    } else {
      this.inputError = undefined
      await this.ensureCapture()
    }
    this.publish()
  }

  /** Return to wake-only monitoring. The application retains any composed draft. */
  sleep(): void {
    this.conversation = false
    this.capture?.setWakeMode?.(true)
    this.clearInactivity()
    this.invalidateAudio()
    this.capture?.setSuppressed(this.speechPending > 0 || this.echoSuppressed)
    this.publish()
  }

  speak(text: string): Promise<void> {
    if (this.disposed || text.trim().length === 0 || this.dictationActive) {
      return Promise.resolve()
    }
    const generation = this.speechGeneration
    ++this.speechPending
    this.clearEchoTimer()
    this.clearInactivity()
    this.invalidateAudio()
    this.capture?.setSuppressed(true)
    this.publish()
    const request = this.speechTail.then(async () => {
      if (generation !== this.speechGeneration || this.disposed) return
      try {
        await this.dependencies.speech.speak(text)
        if (generation === this.speechGeneration) {
          this.speechError = undefined
          this.publish()
        }
      } catch (error: unknown) {
        if (generation === this.speechGeneration) {
          this.speechError = voiceFailure(error, 'Spoken reply is unavailable. Read it in the widget.')
          this.publish()
        }
      }
    }).finally(() => {
      if (generation !== this.speechGeneration) return
      --this.speechPending
      if (this.speechPending === 0) this.guardSpeakerEcho()
    })
    this.speechTail = request.catch(() => undefined)
    return request
  }

  stopSpeaking(): void {
    ++this.speechGeneration
    this.speechPending = 0
    this.dependencies.speech.stop()
    this.guardSpeakerEcho()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    this.clearInactivity()
    ++this.speechGeneration
    this.speechPending = 0
    this.dependencies.speech.stop()
    this.clearEchoTimer()
    void this.releaseCapture()
  }

  getState(): AgentVoiceState {
    let status: AgentVoiceStatus
    if (!this.enabled) status = 'off'
    else if (this.muted) status = 'muted'
    else if (this.dictationActive) status = 'dictation'
    else if (this.speechPending > 0 || this.echoSuppressed) status = 'speaking'
    else if (this.starting) status = 'starting'
    else if (this.capture === null && this.inputError !== undefined) status = 'error'
    else status = this.conversation ? 'listening' : 'wake'
    const error = this.inputError ?? this.speechError
    return { status, ...(error === undefined ? {} : { error }) }
  }

  private async ensureCapture(): Promise<void> {
    if (!this.canCapture() || this.capture !== null || this.starting) {
      this.publish()
      return
    }
    const generation = ++this.captureGeneration
    this.starting = true
    this.publish()
    try {
      const settings = this.options.getSettings()
      const wake = this.dependencies.createWakeDetector()
      this.wake = wake
      await wake.load()
      if (generation !== this.captureGeneration || !this.canCapture()) return
      const local = this.dependencies.createLocalTranscriber()
      this.local = local
      await local.load({ preset: settings.modelPreset, inferencePreference: 'wasm' })
      if (generation !== this.captureGeneration || !this.canCapture()) return
      const capture = this.dependencies.createCapture({
        ...(settings.microphoneId === null ? {} : { selectedDeviceId: settings.microphoneId }),
        onUtterance: (audio) => {
          if (generation === this.captureGeneration) this.enqueue(audio)
        },
        ...(this.options.onLevel === undefined ? {} : { onLevel: this.options.onLevel }),
        onError: (error) => {
          if (generation !== this.captureGeneration) return
          this.inputError = microphoneFailure(error)
          void this.releaseCapture().then(() => this.publish())
        },
      })
      this.capture = capture
      capture.setWakeMode?.(!this.conversation)
      capture.setSuppressed(this.speechPending > 0 || this.echoSuppressed)
      await capture.start()
      if (generation !== this.captureGeneration) return
      this.starting = false
      this.publish()
    } catch (error: unknown) {
      if (generation !== this.captureGeneration) return
      this.inputError = microphoneFailure(error)
      await this.releaseCapture()
      this.publish()
    }
  }

  private async releaseCapture(): Promise<void> {
    ++this.captureGeneration
    this.starting = false
    this.invalidateAudio()
    const capture = this.capture
    this.capture = null
    const local = this.local
    this.local = null
    this.wake?.dispose()
    this.wake = null
    local?.dispose()
    try { await capture?.stop() } catch { /* the input is already invalidated */ }
  }

  private enqueue(audio: Float32Array): void {
    if (!this.canCapture() || this.speechPending > 0 || this.echoSuppressed || this.local === null) return
    if (this.queue.length >= MAX_PENDING_UTTERANCES) {
      if (this.conversation) {
        this.inputError = 'Local transcription could not keep up. Listening paused; review your draft, then retry.'
        this.conversation = false
        void this.releaseCapture().then(() => this.publish())
        return
      }
      // Background observations have no destination and need no retained transcript.
      this.queue.shift()
    }
    this.queue.push({ audio, generation: this.audioGeneration })
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0 && this.canCapture()) {
        const pending = this.queue.shift()!
        const local = this.local
        if (local === null || pending.generation !== this.audioGeneration) continue
        const id = this.dependencies.createId()
        this.recognitionId = id
        try {
          let audio = pending.audio
          let activated = false
          if (!this.conversation) {
            const detection = await this.wake?.detect(audio)
            if (pending.generation !== this.audioGeneration || !this.canCapture() || detection?.detected !== true) continue
            activated = true
            audio = audio.slice(Math.floor(detection.endSeconds * 16_000))
          }
          const settings = this.options.getSettings()
          const result = audio.length < 1 || (activated && calculateRms(audio) < 0.004) ? { text: '' } : await local.transcribe({
            audio,
            sessionId: id,
            preset: settings.modelPreset,
            inferencePreference: 'wasm',
            language: settings.language,
          })
          if (pending.generation !== this.audioGeneration || !this.canCapture()) continue
          this.recognitionId = null
          await this.receiveText(result.text, activated)
        } catch (error: unknown) {
          if (pending.generation !== this.audioGeneration) continue
          this.inputError = voiceFailure(error, 'Local voice transcription failed. Retry to reconnect.')
          await this.releaseCapture()
          this.publish()
          return
        } finally {
          if (this.recognitionId === id) this.recognitionId = null
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async receiveText(input: string, activated = false): Promise<void> {
    let text = input.trim()
    if (text.length === 0 && !activated) return
    const suffix = afterWake(text)
    if (!this.conversation) {
      if (!activated) return
      this.conversation = true
      this.capture?.setWakeMode?.(false)
      this.inputError = undefined
      this.publish()
      await this.options.onWake?.()
      if (!this.canCapture()) return
      text = suffix ?? text
    } else if (suffix !== null) {
      text = suffix
    }
    this.armInactivity()
    const words = controlWords(text)
    if (words === 'stop listening' || words === 'go to sleep') {
      this.sleep()
    } else if (words === 'mute microphone' || words === 'mute listening') {
      await this.setMuted(true)
    } else if (text.length > 0) {
      await this.options.onUtterance(text)
    }
  }

  private invalidateAudio(): void {
    ++this.audioGeneration
    this.queue = []
    if (this.recognitionId !== null) this.local?.cancel(this.recognitionId)
    this.recognitionId = null
  }

  private canCapture(): boolean {
    return this.enabled && !this.disposed && !this.muted && !this.dictationActive
  }

  private guardSpeakerEcho(): void {
    this.clearEchoTimer()
    if (this.disposed || !this.canCapture()) {
      this.echoSuppressed = false
      this.publish()
      return
    }
    this.echoSuppressed = true
    this.capture?.setSuppressed(true)
    this.echoTimer = this.dependencies.setTimer(() => {
      this.echoTimer = undefined
      this.echoSuppressed = false
      this.capture?.setSuppressed(this.speechPending > 0)
      this.armInactivity()
      this.publish()
    }, SPEECH_ECHO_GUARD_MS)
    this.publish()
  }

  private clearEchoTimer(): void {
    if (this.echoTimer !== undefined) this.dependencies.clearTimer(this.echoTimer)
    this.echoTimer = undefined
    this.echoSuppressed = false
  }

  private armInactivity(): void {
    this.clearInactivity()
    const duration = this.options.conversationTimeoutMs ?? DEFAULT_CONVERSATION_TIMEOUT_MS
    if (!this.conversation || this.speechPending > 0 || duration <= 0) return
    this.inactivityTimer = this.dependencies.setTimer(() => this.sleep(), duration)
  }

  private clearInactivity(): void {
    if (this.inactivityTimer !== undefined) this.dependencies.clearTimer(this.inactivityTimer)
    this.inactivityTimer = undefined
  }

  private publish(): void {
    if (this.disposed) return
    try { this.options.onState(this.getState()) } catch { /* observers do not own audio lifetime */ }
  }
}
