import type { SottoBridge } from '../../../shared/contracts'
import { STORED_CREDENTIAL_PLACEHOLDER, type AppSettings } from '../../../shared/settings'
import { E2E_TRANSCRIPT, type E2EScenario } from '../../../shared/e2e'
import type { AudioRecorderOptions, AudioRecordingResult } from '../audio/audioRecorder'
import { TranscriptionError } from '../transcription/openRouterTranscriber'
import { BrowserMicrophoneTest, type MicrophoneTestController } from '../features/onboarding/microphoneTest'
import {
  createProductionDictationController,
  type AppControllerFactory,
  type ProductionControllerFactories,
} from '../state/AppContext'

let microphoneRequestCount = 0

export function createE2EMicrophoneTest(scenario: E2EScenario): MicrophoneTestController {
  if (scenario === 'microphone-browser') return new BrowserMicrophoneTest()
  return {
    async start(onLevel): Promise<'ready' | 'denied'> {
      microphoneRequestCount += 1
      if (scenario === 'microphone-denied-once' && microphoneRequestCount === 1) return 'denied'
      onLevel(0.58)
      return 'ready'
    },
    async stop(): Promise<void> {},
  }
}

function recording(scenario: E2EScenario): AudioRecordingResult | null {
  if (scenario === 'silence') return null
  return {
    samples: Float32Array.from({ length: 16_000 }, (_, index) => Math.sin(index / 20) * 0.1),
    sourceSampleRate: 16_000,
    durationMs: 1_000,
  }
}

function createE2EFactories(scenario: E2EScenario): ProductionControllerFactories {
  let turnedAway = 0
  return {
    createRecorder(options: AudioRecorderOptions) {
      return {
        async start(): Promise<void> {
          if (scenario === 'design-permission') {
            await new Promise<never>(() => undefined)
          }
          options.onLevel?.(0.58)
        },
        async stop(): Promise<AudioRecordingResult | null> { return recording(scenario) },
        async cancel(): Promise<void> {},
      }
    },
    createTranscriber() {
      return {
        async transcribe(options) {
          if (scenario === 'transcription-failure') throw new Error('DETERMINISTIC_TRANSCRIPTION_FAILURE')
          // A rate-limit burst, followed by a successful retry of the kept recording.
          const refusals = scenario === 'transcription-turned-away-once' ? 1 : scenario === 'transcription-turned-away-twice' ? 2 : 0
          if (turnedAway < refusals) {
            turnedAway += 1
            throw new TranscriptionError('rate-limited')
          }
          options.onProgress?.({ stage: 'loading-model', progress: 1 })
          if (scenario === 'design-processing') {
            await new Promise<never>(() => undefined)
          }
          options.onProgress?.({ stage: 'transcribing', progress: 1 })
          return { text: E2E_TRANSCRIPT, language: 'en' }
        },
        cancel(): void {},
        dispose(): void {},
      }
    },
    createCuePlayer() {
      return { playStart(): void {}, playStop(): void {} }
    },
  }
}

export function createE2EControllerFactory(scenario: E2EScenario): AppControllerFactory {
  const factories = createE2EFactories(scenario)
  return (bindings) => createProductionDictationController(bindings, factories)
}


/** A display-only saved-key fixture; never enters settings storage or an upload. */
export function createE2ESettingsBridge(bridge: SottoBridge, enabled: boolean): SottoBridge {
  if (!enabled) return bridge
  const configured = (settings: AppSettings): AppSettings => ({
    ...settings, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER,
  })
  return {
    ...bridge,
    getSettings: async () => configured(await bridge.getSettings()),
    updateSettings: async (patch) => {
      const persisted = { ...patch }
      delete persisted.llmApiKey
      return configured(await bridge.updateSettings(persisted))
    },
    resetSettings: async () => configured(await bridge.resetSettings()),
    onSettingsChanged: (listener) => bridge.onSettingsChanged((settings) => listener(configured(settings))),
    checkTranscriptionKey: async () => ({ ok: true }),
  }
}
