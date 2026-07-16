import { E2E_TRANSCRIPT, type E2EScenario } from '../../../shared/e2e'
import type { AudioRecorderOptions, AudioRecordingResult } from '../audio/audioRecorder'
import type { MicrophoneTestController } from '../features/onboarding/microphoneTest'
import {
  createProductionDictationController,
  type AppControllerFactory,
  type ProductionControllerFactories,
} from '../state/AppContext'

let microphoneRequestCount = 0

export function createE2EMicrophoneTest(scenario: E2EScenario): MicrophoneTestController {
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
