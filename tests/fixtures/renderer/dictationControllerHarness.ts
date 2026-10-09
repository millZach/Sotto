import { vi } from 'vitest'

import { type AudioRecorderOptions } from '../../../src/renderer/src/audio/audioRecorder'
import {
  DictationController,
  type DictationControllerDependencies,
  type DictationRecorder
} from '../../../src/renderer/src/features/dictation/dictationController'
import type {
  TranscribeOptions,
  TranscriptionResult
} from '../../../src/renderer/src/transcription/openRouterTranscriber'
import { type WidgetSnapshot } from '../../../src/shared/dictation'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'


export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

export function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

export type HarnessOptions = {
  readonly currentSettings?: AppSettings
  readonly recorder?: Partial<DictationRecorder>
  readonly transcribe?: (options: TranscribeOptions) => Promise<TranscriptionResult>
  readonly deliverOutput?: DictationControllerDependencies['deliverOutput']
  readonly addHistory?: DictationControllerDependencies['addHistory']
  readonly publishWidgetState?: DictationControllerDependencies['publishWidgetState']
  readonly cuePlayer?: NonNullable<DictationControllerDependencies['cuePlayer']>
  readonly now?: () => number
  readonly ids?: string[]
  readonly getSettings?: () => AppSettings
  readonly polishTranscript?: NonNullable<DictationControllerDependencies['polishTranscript']>
  readonly platform?: NonNullable<DictationControllerDependencies['platform']>
}

export function createHarness(options: HarnessOptions = {}) {
  const currentSettings = options.currentSettings ?? settings()
  const recorder: DictationRecorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      samples: new Float32Array([0.2]),
      sourceSampleRate: 16_000,
      durationMs: 500,
    })),
    cancel: vi.fn(async () => undefined),
    ...options.recorder,
  }
  const recorders: DictationRecorder[] = []
  const createRecorder = vi.fn((factoryOptions: AudioRecorderOptions) => {
    void factoryOptions
    recorders.push(recorder)
    return recorder
  })
  const transcriber = {
    transcribe: vi.fn(
      options.transcribe ??
        (async () => ({ text: '  hello   world  ', language: 'en' })),
    ),
    load: vi.fn(async () => undefined),
    cancel: vi.fn(),
    dispose: vi.fn(),
  }
  const deliverOutput = vi.fn(
    options.deliverOutput ?? (async () => 'pasted' as const),
  )
  const addHistory = vi.fn(options.addHistory ?? (async () => []))
  const retainOutput = vi.fn()
  const publishWidgetState = vi.fn(options.publishWidgetState ?? (() => undefined))
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const setTimer = vi.fn((callback: () => void) => {
    const handle = nextTimer++
    timers.set(handle, callback)
    return handle
  })
  const clearTimer = vi.fn((handle: unknown) => timers.delete(handle as number))
  const ids = [...(options.ids ?? ['session'])]
  const polishTranscript =
    options.polishTranscript === undefined ? undefined : vi.fn(options.polishTranscript)
  const dependencies: DictationControllerDependencies = {
    createRecorder,
    transcriber,
    getSettings: options.getSettings ?? (() => currentSettings),
    deliverOutput,
    addHistory,
    retainOutput,
    publishWidgetState,
    ...(polishTranscript === undefined ? {} : { polishTranscript }),
    ...(options.cuePlayer === undefined ? {} : { cuePlayer: options.cuePlayer }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    now: options.now ?? (() => 1_000),
    createId: () => ids.shift() ?? 'later-session',
    setTimer,
    clearTimer,
  }
  return {
    addHistory,
    retainOutput,
    clearTimer,
    controller: new DictationController(dependencies),
    createRecorder,
    currentSettings,
    deliverOutput,
    fireTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const callback of pending) callback()
    },
    polishTranscript,
    publishWidgetState,
    recorder,
    recorders,
    setTimer,
    transcriber,
  }
}

export function recorderOptions(
  harness: ReturnType<typeof createHarness>,
  index = 0,
): AudioRecorderOptions {
  const call = harness.createRecorder.mock.calls[index]
  if (call === undefined) throw new Error('Recorder factory was not called')
  return call[0]
}

export function snapshots(harness: ReturnType<typeof createHarness>): WidgetSnapshot[] {
  return harness.publishWidgetState.mock.calls.map(([snapshot]) => snapshot)
}
