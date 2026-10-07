import {
  initialDictationState,
  isTranscriptionErrorCode,
  MICROPHONE_NOT_SET_UP_DETAIL,
  reduceDictation,
  TRANSCRIPTION_ERROR_DETAIL,
  TRANSCRIPTION_KEPT_DETAIL,
  type DictationEvent,
  type DictationState,
  type WidgetProcessingStage,
  type TranscriptionErrorCode,
  type WidgetErrorCode,
  type WidgetSnapshot,
} from '../../../../shared/dictation'
import type { HistoryEntry } from '../../../../shared/history'
import type {
  OutputDeliveryRequest,
  TranscriptPolishAsrContext,
  TranscriptPolishResult,
} from '../../../../shared/contracts'
import { defaultHotkey, type SottoPlatform } from '../../../../shared/platform'
import { defaultSettings, type AppSettings } from '../../../../shared/settings'
import { widgetPresentationFor } from '../../../../shared/themeBranding'
import { formatTranscript } from '../../../../shared/transcript'
import { collapseRepeatedPhrases, countWords } from '../../../../shared/textRepair'
import {
  AudioRecorderError,
  type AudioRecorderOptions,
  type AudioRecordingResult,
} from '../../audio/audioRecorder'
import { calculateRms } from '../../audio/audioMath'
import type {
  LoadOptions,
  TranscribeOptions,
  TranscriptionProgress,
  TranscriptionResult,
} from '../../transcription/openRouterTranscriber'
import { TranscriptionError } from '../../transcription/openRouterTranscriber'

export interface DictationRecorder {
  start(): Promise<void>
  stop(): Promise<AudioRecordingResult | null>
  cancel(): Promise<void>
}

export interface DictationTranscriber {
  transcribe(options: TranscribeOptions): Promise<TranscriptionResult>
  load?(options: LoadOptions): Promise<unknown>
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
  /** Capture the destination synchronously before opening audio; never resolve it at delivery. */
  readonly captureOutput?: () => DictationControllerDependencies['deliverOutput'] | undefined
  readonly createRecorder: (options: AudioRecorderOptions) => DictationRecorder
  readonly transcriber: DictationTranscriber
  readonly getSettings: () => AppSettings
  readonly deliverOutput: (
    request: OutputDeliveryRequest,
  ) => DictationOutputResult | Promise<DictationOutputResult>
  readonly addHistory: (entry: HistoryEntry) => unknown | Promise<unknown>
  /** Completed words that output could not deliver. Kept by the app in memory until dismissed. */
  readonly retainOutput?: (entry: HistoryEntry) => void
  readonly publishWidgetState: (snapshot: WidgetSnapshot) => unknown | Promise<unknown>
  /** Optional LLM cleanup pass; any failure falls back to the raw transcript. */
  readonly polishTranscript?: (
    text: string,
    asr?: TranscriptPolishAsrContext,
  ) => Promise<TranscriptPolishResult>
  readonly cuePlayer?: DictationCuePlayer
  /** Chooses the default hotkey used when settings cannot be read; win32 when unset. */
  readonly platform?: SottoPlatform
  readonly now?: () => number
  readonly createId?: () => string
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

interface ActiveSession {
  readonly deliverOutput: DictationControllerDependencies['deliverOutput']
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
  errorCode?: WidgetErrorCode
  /** When listening began, kept so Try again returns to the same processing state. */
  startedAt: number
  /** The recording's parts in order: segments emitted while listening, then the tail. */
  readonly parts: RecordingPart[]
  /** The whole recording's length, once it has stopped. */
  durationMs: number
  /** A transcription failed and the parts without text are kept for Try again. */
  kept: boolean
  /** Try again has been pressed for this recording. */
  retried: boolean
  /** Why the recording was kept, so a cancelled Try again can return to it. */
  keptCode?: TranscriptionErrorCode
  /** Whether the kept error being shown came from a Try again, so a cancelled one says the same. */
  keptAfterRetry: boolean
  /** Counts each wait for the parts, so a cancelled Try again's late answers are ignored. */
  attempt: number
  /** The cleanup pass under way for this recording's text, kept for a Try again after a cancel. */
  cleanup?: { readonly text: string; readonly result: Promise<TranscriptPolishResult> }
}

/**
 * One piece of a recording on its way to text. Its audio stays in memory only
 * until its text comes back, so a part that was turned away can be sent again
 * without re-sending the parts that already worked. Nothing here reaches disk.
 */
interface RecordingPart {
  audio: Float32Array | null
  readonly rms: number
  result?: Promise<TranscriptionResult>
  /** What came back for this part, once it has. */
  transcript?: TranscriptionResult
}

/** Diagnostics-only precision: three decimals distinguish silence from speech. */
function roundRms(rms: number): number {
  return Number.isFinite(rms) ? Math.round(rms * 1_000) / 1_000 : 0
}

const ERROR_MESSAGES = Object.freeze({
  MIC_PERMISSION_DENIED: 'Microphone permission was denied.',
  MIC_DEVICE_NOT_FOUND: 'The selected microphone is unavailable.',
  MIC_START_FAILED: 'The microphone could not be started.',
  MIC_NOT_SET_UP: MICROPHONE_NOT_SET_UP_DETAIL,
  RECORDING_FAILED: 'The recording could not be completed.',
  NO_SPEECH: 'No speech was detected.',
  ...TRANSCRIPTION_ERROR_DETAIL,
  OUTPUT_UNAVAILABLE: 'Output is unavailable.',
  OUTPUT_FAILED: 'The transcript could not be delivered.',
  HISTORY_FAILED: 'The transcript was delivered but history could not be updated.',
  SETTINGS_UNAVAILABLE: 'Settings are unavailable.',
} as const)

type ControllerErrorCode = WidgetErrorCode

const defaultSetTimer = (callback: () => void, delayMs: number): unknown =>
  globalThis.setTimeout(callback, delayMs)
const defaultClearTimer = (handle: unknown): void =>
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)

function snapshotSettings(settings: AppSettings): Readonly<AppSettings> {
  return Object.freeze({ ...settings })
}

type WidgetPresentation = ReturnType<typeof widgetPresentationFor>
const widgetPresentations = new WeakMap<object, WidgetPresentation>()

/** Level updates publish many times a second; resolve a settings object's palette once. */
function cachedWidgetPresentation(settings: Readonly<AppSettings>): WidgetPresentation {
  let presentation = widgetPresentations.get(settings)
  if (presentation === undefined) {
    presentation = widgetPresentationFor(settings)
    widgetPresentations.set(settings, presentation)
  }
  return presentation
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

function transcriptionFailureCode(error: unknown): WidgetErrorCode {
  if (error instanceof TranscriptionError) {
    switch (error.reason) {
      case 'unconfigured': return 'TRANSCRIPTION_UNCONFIGURED'
      case 'unauthorized': return 'TRANSCRIPTION_UNAUTHORIZED'
      case 'network':
      case 'timeout': return 'TRANSCRIPTION_OFFLINE'
      case 'billing': return 'TRANSCRIPTION_BILLING'
      case 'rate-limited': return 'TRANSCRIPTION_RATE_LIMITED'
      case 'http': return 'TRANSCRIPTION_SERVICE_ERROR'
    }
  }
  return 'TRANSCRIPTION_FAILED'
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

  private readonly platform: SottoPlatform
  private readonly now: () => number
  private readonly createId: () => string
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly dependencies: DictationControllerDependencies) {
    this.platform = dependencies.platform ?? 'win32'
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? (() => crypto.randomUUID())
    this.setTimer = dependencies.setTimer ?? defaultSetTimer
    this.clearTimer = dependencies.clearTimer ?? defaultClearTimer
  }

  getState(): DictationState {
    return this.state
  }

  /**
   * Tells main this controller holds no session. A reload, by any path, makes
   * a new controller; an error or kept recording the widget still shows from
   * the old one now stays until dismissed, and nothing here could answer it.
   */
  announceIdle(): void {
    if (this.disposed || this.session !== null) return
    let settings: Readonly<AppSettings>
    try {
      settings = this.dependencies.getSettings()
    } catch {
      return
    }
    // Main keeps the widget hidden until setup is finished; an idle publication
    // could reveal the resting sliver early, and there is nothing to reset yet.
    if (!settings.onboardingComplete) return
    try {
      const publication = this.dependencies.publishWidgetState({
        status: 'idle',
        ...cachedWidgetPresentation(settings),
        shortcut: settings.hotkey,
        cancellable: false,
      })
      void Promise.resolve(publication).catch(() => undefined)
    } catch {
      // Widget synchronization is observational and cannot break dictation.
    }
  }

  prewarm(): Promise<void> {
    if (this.disposed || this.isActive()) return Promise.resolve()
    const load = this.dependencies.transcriber.load
    if (load === undefined) return Promise.resolve()

    try {
      return Promise.resolve(
        this.dependencies.transcriber.load?.({}),
      ).then(
        () => undefined,
        () => undefined,
      )
    } catch {
      return Promise.resolve()
    }
  }

  start(): Promise<void> {
    if (this.disposed || this.isActive()) return Promise.resolve()
    this.clearResetTimer()
    if (isTerminal(this.state) && this.session !== null) {
      this.dispatch({ type: 'RESET' }, this.session)
    }

    let settings: Readonly<AppSettings>
    let settingsAvailable = true
    try {
      settings = snapshotSettings(this.dependencies.getSettings())
    } catch {
      settings = snapshotSettings(defaultSettings(defaultHotkey(this.platform)))
      settingsAvailable = false
    }

    const session: ActiveSession = {
      deliverOutput: this.dependencies.captureOutput?.() ?? this.dependencies.deliverOutput,
      id: this.createId(),
      token: ++this.lifecycleToken,
      settings,
      stopClaimed: false,
      cancellable: true,
      processingStage: 'preparing-audio',
      progress: 0,
      acceptProgress: true,
      startedAt: 0,
      parts: [],
      durationMs: 0,
      kept: false,
      retried: false,
      keptAfterRetry: false,
      attempt: 0,
    }
    this.session = session
    this.dispatch({ type: 'REQUESTED', sessionId: session.id }, session)
    if (!settingsAvailable) {
      this.fail(session, 'SETTINGS_UNAVAILABLE')
      return Promise.resolve()
    }
    // Setup was finished without a microphone, so the shortcut says so instead
    // of opening audio that cannot be there.
    if (settings.microphoneSkipped) {
      this.fail(session, 'MIC_NOT_SET_UP')
      return Promise.resolve()
    }

    try {
      session.recorder = this.dependencies.createRecorder({
        ...(settings.microphoneId === null ? {} : { selectedDeviceId: settings.microphoneId }),
        maxRecordingSeconds: settings.maxRecordingSeconds,
        onLevel: (level) => this.handleLevel(session, level),
        onDurationLimit: (result) => this.handleDurationLimit(session, result),
        onDeviceUnavailable: () => this.handleDeviceUnavailable(session),
        ...(settings.streamingAsr
          ? { onSegment: (segment: AudioRecordingResult) => this.handleSegment(session, segment) }
          : {}),
      })
    } catch (error: unknown) {
      this.fail(session, classifyStartFailure(error))
      return Promise.resolve()
    }

    return this.startRecorder(session)
  }

  stop(): Promise<void> {
    const session = this.session
    if (session !== null && this.state.status === 'requesting-permission') {
      // Remember Stop without finalizing audio or starting transcription.
      session.stopClaimed = true
      return Promise.resolve()
    }
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
    if (this.state.status === 'listening' || this.state.status === 'requesting-permission') {
      return this.stop()
    }
    if (this.state.status === 'processing') {
      return Promise.resolve()
    }
    return this.start()
  }

  /** Sends the parts of a kept recording that have no text yet, then finishes the dictation. */
  retry(): Promise<void> {
    const session = this.session
    if (session === null || !session.kept || this.state.status !== 'error' || !this.isCurrent(session)) {
      return Promise.resolve()
    }
    this.clearResetTimer()
    session.kept = false
    session.retried = true
    delete session.errorCode
    session.cancellable = true
    session.acceptProgress = true
    session.processingStage = 'transcribing'
    session.progress = 0
    this.dispatch({ type: 'RETRIED', sessionId: session.id, startedAt: session.startedAt }, session)
    const waiting = session.parts.filter((part) => part.transcript === undefined && part.audio !== null)
    waiting.forEach((part, index) => {
      part.result = this.sendPart(session, part.audio!, index === waiting.length - 1)
    })
    const processing = this.finishRecording(session)
    // Each answer is kept as it arrives, so a part that came back before a
    // cancel is not sent, and paid for, again on the next Try again.
    const attempt = session.attempt
    for (const part of waiting) {
      part.result?.then((transcript) => {
        if (session.attempt !== attempt || part.transcript !== undefined) return
        part.transcript = transcript
        part.audio = null
      }, () => undefined)
    }
    session.processing = processing
    return processing
  }

  async cancel(): Promise<void> {
    const session = this.session
    // An error stays until it is dismissed; dismissing it lets go of a kept recording.
    if (session !== null && this.state.status === 'error' && this.isCurrent(session)) {
      this.dismiss(session)
      return
    }
    if (session === null || !session.cancellable || !this.isCancellableState()) return
    // Cancelling a Try again stops it and returns to the kept recording; only
    // Discard, a new dictation or closing Sotto lets a kept recording go.
    if (this.state.status === 'processing' && session.keptCode !== undefined && this.isCurrent(session)) {
      session.attempt += 1
      try {
        this.dependencies.transcriber.cancel(session.id)
      } catch {
        // The late answers are ignored by attempt regardless.
      }
      for (const part of session.parts) delete part.result
      session.kept = true
      session.retried = session.keptAfterRetry
      this.fail(session, session.keptCode)
      return
    }

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
    if (session.stopClaimed) {
      await this.cancel()
      return
    }
    session.startedAt = finiteTimestamp(this.now())
    this.dispatch(
      { type: 'STARTED', sessionId: session.id, startedAt: session.startedAt },
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

  private handleDeviceUnavailable(session: ActiveSession): void {
    if (!this.isCurrent(session) || this.state.status !== 'listening') return
    session.stopClaimed = true
    let cancellation: Promise<void> | undefined
    try {
      cancellation = session.recorder?.cancel()
    } catch {
      // The finite device error still replaces listening when cleanup throws synchronously.
    }
    this.fail(session, 'MIC_DEVICE_NOT_FOUND')
    void cancellation?.catch(() => undefined)
  }

  private handleSegment(session: ActiveSession, segment: AudioRecordingResult): void {
    if (!this.isCurrent(session) || session.stopClaimed || segment.samples.length === 0) return
    const result = this.sendPart(session, segment.samples, false)
    session.parts.push({ audio: segment.samples, rms: roundRms(calculateRms(segment.samples)), result })
  }

  /** Sends one part for transcription; the last part sent reports progress. */
  private sendPart(session: ActiveSession, audio: Float32Array, reportsProgress: boolean): Promise<TranscriptionResult> {
    const result = this.dependencies.transcriber.transcribe({
      sessionId: session.id,
      audio,
      language: session.settings.language,
      ...(reportsProgress
        ? { onProgress: (progress: TranscriptionProgress) => this.handleProgress(session, progress) }
        : {}),
    })
    // Rejections are re-observed when finishRecording awaits the parts.
    void result.catch(() => undefined)
    return result
  }

  private async processRecording(
    session: ActiveSession,
    recording: AudioRecordingResult,
  ): Promise<void> {
    if (!this.isCurrent(session)) return
    if (recording.samples.length === 0 && session.parts.length === 0) {
      this.fail(session, 'NO_SPEECH')
      return
    }

    session.durationMs = recording.durationMs
    if (recording.samples.length > 0) {
      const result = this.sendPart(session, recording.samples, true)
      session.parts.push({ audio: recording.samples, rms: roundRms(calculateRms(recording.samples)), result })
    }
    await this.finishRecording(session)
  }

  /**
   * Waits for every part, keeps the text of each one that came back, and either
   * finishes the dictation or keeps the recording when a part was turned away.
   */
  private async finishRecording(session: ActiveSession): Promise<void> {
    const parts = session.parts
    const attempt = ++session.attempt
    const outcomes = await Promise.allSettled(
      parts.map((part) => part.result ?? Promise.resolve(part.transcript!)),
    )
    if (!this.isCurrent(session) || session.attempt !== attempt) return
    let failure: { readonly reason: unknown } | undefined
    outcomes.forEach((outcome, index) => {
      const part = parts[index]!
      delete part.result
      if (outcome.status === 'fulfilled') {
        part.transcript = outcome.value
        part.audio = null
      } else {
        failure ??= { reason: outcome.reason }
      }
    })
    if (failure !== undefined) {
      // The parts that came back keep their text; only the others are sent again.
      session.kept = true
      this.fail(session, transcriptionFailureCode(failure.reason))
      return
    }

    const results = parts.map((part) => part.transcript!)
    const segmentWords = results.map((partial) => countWords(partial.text))
    const segmentRms = parts.map((part) => part.rms)
    const single = results.length === 1 ? results[0] : undefined
    const result: TranscriptionResult =
      single !== undefined
        ? single
        : {
            text: results
              .map((partial) => partial.text.trim())
              .filter((partial) => partial.length > 0)
              .join(' '),
            language: results.at(-1)?.language ?? session.settings.language,
          }
    session.acceptProgress = false

    // Transcription decoders occasionally loop on one word/phrase; collapse those
    // runs before the text reaches formatting, cleanup, history, or paste.
    const repairedText = collapseRepeatedPhrases(result.text)

    let normalized = formatTranscript(repairedText)
    if (normalized.length === 0) {
      this.fail(session, 'NO_SPEECH')
      return
    }

    let rawText = repairedText
    if (session.settings.llmFormatting && this.dependencies.polishTranscript !== undefined) {
      // A cleanup call cannot be stopped, so one left running by a cancelled
      // Try again is reused by the next rather than paid for twice.
      if (session.cleanup?.text !== rawText) {
        const pending = this.dependencies.polishTranscript(rawText, {
          segmentWords,
          segmentRms,
          durationMs: Number.isFinite(session.durationMs)
            ? Math.max(0, Math.round(session.durationMs))
            : 0,
        })
        void pending.catch(() => undefined)
        session.cleanup = { text: rawText, result: pending }
      }
      try {
        const polished = await session.cleanup.result
        if (polished.applied && polished.text.trim().length > 0) {
          rawText = polished.text
          normalized = formatTranscript(polished.text)
        }
      } catch {
        // The raw transcript is always deliverable without the cleanup pass.
      }
      // A Try again cancelled during cleanup has already returned to its kept recording.
      if (!this.isCurrent(session) || session.attempt !== attempt) return
    }
    const text = session.settings.formatWhitespace ? normalized : rawText

    // Delivery cannot be cancelled, so the recording's parts are let go only here.
    parts.length = 0
    delete session.cleanup
    session.cancellable = false
    session.processingStage = 'delivering-output'
    session.progress = 1
    this.publish(session)

    const entry: HistoryEntry = {
      id: session.id,
      text,
      createdAt: Math.round(finiteTimestamp(this.now())),
      durationMs: historyDuration(session.durationMs),
      language: result.language,
      modelPreset: 'mai',
    }
    let output: DictationOutputResult = 'empty'
    let outputFailure: 'OUTPUT_FAILED' | 'OUTPUT_UNAVAILABLE' | undefined
    try {
      output = await session.deliverOutput({
        text,
        autoPaste: session.settings.autoPaste,
        pasteDelayMs: session.settings.pasteDelayMs,
      })
    } catch {
      outputFailure = 'OUTPUT_FAILED'
    }
    if (!this.isCurrent(session)) return
    if (typeof output === 'object') outputFailure = 'OUTPUT_UNAVAILABLE'
    else if (output === 'empty') outputFailure = 'OUTPUT_FAILED'
    if (outputFailure) this.dependencies.retainOutput?.(entry)

    if (session.settings.historyEnabled) {
      try {
        await this.dependencies.addHistory(entry)
      } catch {
        if (this.isCurrent(session)) this.fail(session, outputFailure ?? 'HISTORY_FAILED')
        return
      }
      if (!this.isCurrent(session)) return
    }

    if (outputFailure) { this.fail(session, outputFailure); return }
    if (typeof output === 'object' || output === 'empty') return

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

  /** An error stays until it is dismissed, tried again, or a new dictation starts. */
  private fail(session: ActiveSession, code: ControllerErrorCode): void {
    if (!this.isCurrent(session)) return
    session.cancellable = false
    session.errorCode = code
    const kept = session.kept && isTranscriptionErrorCode(code)
    if (kept) {
      session.keptCode = code
      session.keptAfterRetry = session.retried
    } else {
      session.kept = false
      delete session.keptCode
      session.parts.length = 0
    }
    this.dispatch(
      {
        type: 'FAILED',
        sessionId: session.id,
        code,
        message: kept ? TRANSCRIPTION_KEPT_DETAIL[code] : ERROR_MESSAGES[code],
        ...(kept ? { kept: true } : {}),
        ...(kept && session.retried ? { retried: true } : {}),
      },
      session,
    )
  }

  /** Clears an error and lets go of a recording it kept. */
  private dismiss(session: ActiveSession): void {
    this.clearResetTimer()
    session.kept = false
    session.parts.length = 0
    ++this.lifecycleToken
    this.state = reduceDictation(this.state, { type: 'RESET' })
    this.publish(session)
    this.session = null
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
    // Presentation follows the settings in force now, not those the session
    // started with, so a theme chosen mid-session is not reverted by the next
    // publication. The shortcut stays the session's own.
    let presented: Readonly<AppSettings> = session.settings
    try {
      presented = this.dependencies.getSettings()
    } catch {
      // Unreadable settings keep the session's snapshot.
    }
    const metadata = {
      ...cachedWidgetPresentation(presented),
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
          code: session.errorCode ?? 'TRANSCRIPTION_FAILED',
          ...(state.kept === true ? { kept: true } : {}),
          ...(state.retried === true ? { retried: true } : {}),
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
