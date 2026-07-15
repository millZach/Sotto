import {
  initialDictationState,
  reduceDictation,
  type DictationEvent,
  type DictationState,
  type WidgetProcessingStage,
  type WidgetSnapshot,
} from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/settings'
import { formatTranscript } from '../../../../shared/transcript'
import {
  AudioRecorderError,
  type AudioRecorderOptions,
  type AudioRecordingResult,
} from '../../audio/audioRecorder'
import type {
  TranscribeOptions,
  TranscriptionProgress,
  TranscriptionResult,
} from '../../transcription/client'

export interface DictationRecorder {
  start(): Promise<void>
  stop(): Promise<AudioRecordingResult | null>
  cancel(): Promise<void>
}

export interface DictationTranscriber {
  transcribe(options: TranscribeOptions): Promise<TranscriptionResult>
  cancel(sessionId: string): void
  dispose(): void
}

export interface DictationCuePlayer {
  playStart(): void | Promise<void>
  playStop(): void | Promise<void>
}

export type DictationOutputResult =
  | 'pasted'
  | 'copied'
  | 'empty'
  | Readonly<{ ok: false; reason: 'unavailable' }>

export interface DictationControllerDependencies {
  readonly createRecorder: (options: AudioRecorderOptions) => DictationRecorder
  readonly transcriber: DictationTranscriber
  readonly getSettings: () => AppSettings
  readonly deliverOutput: (text: string) => DictationOutputResult | Promise<DictationOutputResult>
  readonly addHistory: (entry: HistoryEntry) => unknown | Promise<unknown>
  readonly publishWidgetState: (snapshot: WidgetSnapshot) => unknown | Promise<unknown>
  readonly cuePlayer?: DictationCuePlayer
  readonly now?: () => number
  readonly createId?: () => string
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface ActiveSession {
  readonly id: string
  readonly token: number
  readonly settings: Readonly<AppSettings>
  recorder?: DictationRecorder
  stopClaimed: boolean
  cancellable: boolean
  processingStage: WidgetProcessingStage
  progress: number
  acceptProgress: boolean
  processing?: Promise<void>
}

const ERROR_MESSAGES = Object.freeze({
  MIC_PERMISSION_DENIED: 'Microphone permission was denied.',
  MIC_DEVICE_NOT_FOUND: 'The selected microphone is unavailable.',
  MIC_START_FAILED: 'The microphone could not be started.',
  RECORDING_FAILED: 'The recording could not be completed.',
  NO_SPEECH: 'No speech was detected.',
  TRANSCRIPTION_FAILED: 'Local transcription failed.',
  OUTPUT_UNAVAILABLE: 'Output is unavailable.',
  OUTPUT_FAILED: 'The transcript could not be delivered.',
  HISTORY_FAILED: 'The transcript was delivered but history could not be updated.',
} as const)

type ControllerErrorCode = keyof typeof ERROR_MESSAGES

const defaultSetTimer = (callback: () => void, delayMs: number): unknown =>
  globalThis.setTimeout(callback, delayMs)
const defaultClearTimer = (handle: unknown): void =>
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)

function snapshotSettings(settings: AppSettings): Readonly<AppSettings> {
  return Object.freeze({ ...settings })
}

function boundedProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function historyDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

function isTerminal(state: DictationState): boolean {
  return state.status === 'success' || state.status === 'cancelled' || state.status === 'error'
}

function classifyStartFailure(error: unknown): ControllerErrorCode {
  const name = error instanceof AudioRecorderError ? error.startFailureName : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'MIC_PERMISSION_DENIED'
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'OverconstrainedError'
  ) {
    return 'MIC_DEVICE_NOT_FOUND'
  }
  return 'MIC_START_FAILED'
}

export class DictationController {
  private state: DictationState = initialDictationState
  private session: ActiveSession | null = null
  private lifecycleToken = 0
  private resetTimer: unknown
  private disposed = false

  private readonly now: () => number
  private readonly createId: () => string
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly dependencies: DictationControllerDependencies) {
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => crypto.randomUUID())
    this.setTimer = dependencies.setTimer ?? defaultSetTimer
    this.clearTimer = dependencies.clearTimer ?? defaultClearTimer
  }

  getState(): DictationState {
    return this.state
  }

  start(): Promise<void> {
    if (this.disposed || this.isActive()) return Promise.resolve()
    this.clearResetTimer()
    if (isTerminal(this.state) && this.session !== null) {
      this.dispatch({ type: 'RESET' }, this.session)
    }

    let settings: Readonly<AppSettings>
    try {
      settings = snapshotSettings(this.dependencies.getSettings())
    } catch {
      settings = snapshotSettings(DEFAULT_SETTINGS)
    }

    const session: ActiveSession = {
      id: this.createId(),
      token: ++this.lifecycleToken,
      settings,
      stopClaimed: false,
      cancellable: true,
      processingStage: 'preparing-audio',
      progress: 0,
      acceptProgress: true,
    }
    this.session = session
    this.dispatch({ type: 'REQUESTED', sessionId: session.id }, session)

    try {
      session.recorder = this.dependencies.createRecorder({
        ...(settings.microphoneId === null ? {} : { selectedDeviceId: settings.microphoneId }),
        maxRecordingSeconds: settings.maxRecordingSeconds,
        onLevel: (level) => this.handleLevel(session, level),
        onDurationLimit: (result) => this.handleDurationLimit(session, result),
      })
    } catch (error: unknown) {
      this.fail(session, classifyStartFailure(error))
      return Promise.resolve()
    }

    return this.startRecorder(session)
  }

  stop(): Promise<void> {
    const session = this.session
    if (session === null || this.state.status !== 'listening') {
      return session?.processing ?? Promise.resolve()
    }
    if (!this.claimStop(session)) return session.processing ?? Promise.resolve()

    const recorder = session.recorder
    if (recorder === undefined) return Promise.resolve()
    const processing = (async () => {
      this.playCue(session, 'stop')
      let result: AudioRecordingResult | null
      try {
        result = await recorder.stop()
      } catch {
        if (this.isCurrent(session)) this.fail(session, 'RECORDING_FAILED')
        return
      }
      if (!this.isCurrent(session)) return
      if (result === null) {
        this.fail(session, 'NO_SPEECH')
        return
      }
      await this.processRecording(session, result)
    })()
    session.processing = processing
    return processing
  }

  toggle(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.state.status === 'listening') return this.stop()
    if (
      this.state.status === 'requesting-permission' ||
      this.state.status === 'processing'
    ) {
      return Promise.resolve()
    }
    return this.start()
  }

  async cancel(): Promise<void> {
    const session = this.session
    if (session === null || !session.cancellable || !this.isCancellableState()) return

    const resetToken = ++this.lifecycleToken
    this.dispatch({ type: 'CANCELLED', sessionId: session.id }, session)
    this.scheduleReset(session, resetToken)

    let cancelRecording: Promise<void> | undefined
    try {
      cancelRecording = session.recorder?.cancel()
    } catch {
      // Continue cancelling the independently owned transcription request.
    }
    try {
      this.dependencies.transcriber.cancel(session.id)
    } catch {
      // Cancellation is best effort after the session has already been invalidated.
    }
    try {
      await cancelRecording
    } catch {
      // Cancellation is already complete from the controller's perspective.
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const session = this.session
    ++this.lifecycleToken
    this.session = null
    this.clearResetTimer()
    if (session?.recorder !== undefined) {
      try {
        void session.recorder.cancel().catch(() => undefined)
      } catch {
        // Continue disposing independent resources.
      }
    }
    if (session !== null) {
      try {
        this.dependencies.transcriber.cancel(session.id)
      } catch {
        // Continue disposing independent resources.
      }
    }
    try {
      this.dependencies.transcriber.dispose()
    } catch {
      // Dispose remains synchronous and best effort.
    }
  }

  private async startRecorder(session: ActiveSession): Promise<void> {
    try {
      await session.recorder?.start()
    } catch (error: unknown) {
      if (this.isCurrent(session)) this.fail(session, classifyStartFailure(error))
      return
    }
    if (!this.isCurrent(session) || this.state.status !== 'requesting-permission') return
    this.dispatch(
      { type: 'STARTED', sessionId: session.id, startedAt: finiteTimestamp(this.now()) },
      session,
    )
    this.playCue(session, 'start')
  }

  private claimStop(session: ActiveSession): boolean {
    if (!this.isCurrent(session) || session.stopClaimed || this.state.status !== 'listening') {
      return false
    }
    session.stopClaimed = true
    session.processingStage = 'preparing-audio'
    session.progress = 0
    this.dispatch({ type: 'STOPPED', sessionId: session.id }, session)
    return true
  }

  private handleDurationLimit(session: ActiveSession, result: AudioRecordingResult): void {
    if (!this.claimStop(session)) return
    this.playCue(session, 'stop')
    const processing = this.processRecording(session, result)
    session.processing = processing
    void processing.catch(() => undefined)
  }

  private async processRecording(
    session: ActiveSession,
    recording: AudioRecordingResult,
  ): Promise<void> {
    if (!this.isCurrent(session)) return
    if (recording.samples.length === 0) {
      this.fail(session, 'NO_SPEECH')
      return
    }

    let result: TranscriptionResult
    try {
      result = await this.dependencies.transcriber.transcribe({
        sessionId: session.id,
        audio: recording.samples,
        preset: session.settings.modelPreset,
        language: session.settings.language,
        inferencePreference: session.settings.inferencePreference,
        onProgress: (progress) => this.handleProgress(session, progress),
      })
    } catch {
      if (this.isCurrent(session)) this.fail(session, 'TRANSCRIPTION_FAILED')
      return
    }
    if (!this.isCurrent(session)) return
    session.acceptProgress = false

    const normalized = formatTranscript(result.text)
    if (normalized.length === 0) {
      this.fail(session, 'NO_SPEECH')
      return
    }
    const text = session.settings.formatWhitespace ? normalized : result.text

    session.cancellable = false
    session.processingStage = 'delivering-output'
    session.progress = 1
    this.publish(session)

    let output: DictationOutputResult
    try {
      output = await this.dependencies.deliverOutput(text)
    } catch {
      if (this.isCurrent(session)) this.fail(session, 'OUTPUT_FAILED')
      return
    }
    if (!this.isCurrent(session)) return
    if (typeof output === 'object') {
      this.fail(session, 'OUTPUT_UNAVAILABLE')
      return
    }
    if (output === 'empty') {
      this.fail(session, 'OUTPUT_FAILED')
      return
    }

    if (session.settings.historyEnabled) {
      try {
        await this.dependencies.addHistory({
          id: session.id,
          text,
          createdAt: Math.round(finiteTimestamp(this.now())),
          durationMs: historyDuration(recording.durationMs),
          language: result.language,
          modelPreset: session.settings.modelPreset,
        })
      } catch {
        if (this.isCurrent(session)) this.fail(session, 'HISTORY_FAILED')
        return
      }
      if (!this.isCurrent(session)) return
    }

    this.dispatch(
      { type: 'TRANSCRIBED', sessionId: session.id, text, output },
      session,
    )
    this.scheduleReset(session)
  }

  private handleLevel(session: ActiveSession, level: number): void {
    if (!this.isCurrent(session) || this.state.status !== 'listening') return
    this.dispatch({ type: 'LEVEL_CHANGED', sessionId: session.id, level }, session)
  }

  private handleProgress(session: ActiveSession, progress: TranscriptionProgress): void {
    if (
      !this.isCurrent(session) ||
      !session.acceptProgress ||
      this.state.status !== 'processing'
    ) {
      return
    }
    session.processingStage = progress.stage
    session.progress = boundedProgress(progress.progress)
    this.publish(session)
  }

  private dispatch(event: DictationEvent, session: ActiveSession): void {
    if (this.disposed) return
    const next = reduceDictation(this.state, event)
    if (next === this.state) return
    this.state = next
    this.publish(session)
  }

  private fail(session: ActiveSession, code: ControllerErrorCode): void {
    if (!this.isCurrent(session)) return
    session.cancellable = false
    this.dispatch(
      { type: 'FAILED', sessionId: session.id, code, message: ERROR_MESSAGES[code] },
      session,
    )
    this.scheduleReset(session)
  }

  private publish(session: ActiveSession): void {
    if (this.disposed) return
    const snapshot = this.toWidgetSnapshot(session)
    try {
      const publication = this.dependencies.publishWidgetState(snapshot)
      void Promise.resolve(publication).catch(() => undefined)
    } catch {
      // Widget synchronization is observational and cannot break dictation.
    }
  }

  private toWidgetSnapshot(session: ActiveSession): WidgetSnapshot {
    const metadata = {
      theme: session.settings.theme,
      reducedMotion: session.settings.reducedMotion,
      shortcut: session.settings.hotkey,
      cancellable: session.cancellable && this.isCancellableState(),
    } as const
    const state = this.state
    switch (state.status) {
      case 'idle':
        return { status: 'idle', ...metadata, cancellable: false }
      case 'requesting-permission':
        return { status: state.status, sessionId: state.sessionId, ...metadata }
      case 'listening':
        return {
          status: state.status,
          sessionId: state.sessionId,
          startedAt: state.startedAt,
          level: state.level,
          ...metadata,
        }
      case 'processing':
        return {
          status: state.status,
          sessionId: state.sessionId,
          startedAt: state.startedAt,
          stage: session.processingStage,
          progress: boundedProgress(session.progress),
          ...metadata,
        }
      case 'success':
        return {
          status: state.status,
          sessionId: state.sessionId,
          output: state.output,
          ...metadata,
          cancellable: false,
        }
      case 'cancelled':
        return {
          status: state.status,
          sessionId: state.sessionId,
          ...metadata,
          cancellable: false,
        }
      case 'error':
        return {
          status: state.status,
          ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
          code: state.code,
          message: state.message,
          ...metadata,
          cancellable: false,
        }
    }
  }

  private scheduleReset(session: ActiveSession, token = session.token): void {
    this.clearResetTimer()
    this.resetTimer = this.setTimer(() => {
      if (
        this.disposed ||
        this.session !== session ||
        this.lifecycleToken !== token ||
        !isTerminal(this.state)
      ) {
        return
      }
      this.resetTimer = undefined
      this.state = reduceDictation(this.state, { type: 'RESET' })
      this.publish(session)
      this.session = null
    }, session.settings.successDisplayMs)
  }

  private clearResetTimer(): void {
    if (this.resetTimer === undefined) return
    try {
      this.clearTimer(this.resetTimer)
    } catch {
      // A failed timer cleanup is still protected by the lifecycle token.
    }
    this.resetTimer = undefined
  }

  private playCue(session: ActiveSession, kind: 'start' | 'stop'): void {
    if (!session.settings.soundCues || this.dependencies.cuePlayer === undefined) return
    try {
      const playback =
        kind === 'start'
          ? this.dependencies.cuePlayer.playStart()
          : this.dependencies.cuePlayer.playStop()
      void Promise.resolve(playback).catch(() => undefined)
    } catch {
      // Optional cue failures never change dictation state.
    }
  }

  private isCurrent(session: ActiveSession): boolean {
    return (
      !this.disposed &&
      this.session === session &&
      this.lifecycleToken === session.token
    )
  }

  private isActive(): boolean {
    return (
      this.state.status === 'requesting-permission' ||
      this.state.status === 'listening' ||
      this.state.status === 'processing'
    )
  }

  private isCancellableState(): boolean {
    return (
      this.state.status === 'requesting-permission' ||
      this.state.status === 'listening' ||
      this.state.status === 'processing'
    )
  }
}
