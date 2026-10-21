import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import { TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'

/** A loaded speech model: float samples at 16 kHz in, the words heard out. */
export interface SpeechEngine {
  transcribe(samples: Float32Array): Promise<string>
  /** Stops a model that runs in its own process; engines inside main's process leave it out. */
  dispose?(): void
  /** Tells `listener` once if a model in its own process stops by itself, so it can be loaded again. */
  onStopped?(listener: () => void): void
}

/** Starts the engine on a verified model folder; rejects when the native module or the model will not load. */
export type SpeechEngineLoader = (modelDirectory: string) => Promise<SpeechEngine>

/**
 * Half the cores, at most four. In the October 10 benchmark four threads were a fifth faster than two
 * on a 17-second clip and no faster on a 2-second one, and dictation should not take the whole
 * machine from whatever the person is doing.
 */
function threadCount(): number {
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))
}

/**
 * Parakeet through sherpa-onnx (ADR-0071), imported on first use like node-pty, so a machine where
 * the native module cannot load still starts Sotto and reports the engine as failed. Loading and
 * decoding both run on the native thread pool; main's event loop keeps going while a segment is
 * transcribed. Samples go in as a Float32Array made in JavaScript: sherpa's own WAV reader returns
 * an external buffer, which Electron's memory cage rejects. The package is CommonJS whose exports
 * Node's import() cannot list, so its classes are read from the default export, which is all of
 * module.exports.
 */
export const loadParakeetEngine: SpeechEngineLoader = async (modelDirectory) => {
  const { OfflineRecognizer } = (await import('sherpa-onnx-node')).default
  const recognizer = await OfflineRecognizer.createAsync({
    featConfig: { sampleRate: TRANSCRIPTION_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDirectory, 'encoder.int8.onnx'),
        decoder: join(modelDirectory, 'decoder.int8.onnx'),
        joiner: join(modelDirectory, 'joiner.int8.onnx'),
      },
      tokens: join(modelDirectory, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: threadCount(),
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  })
  return {
    async transcribe(samples) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: TRANSCRIPTION_SAMPLE_RATE, samples })
      const result = await recognizer.decodeAsync(stream)
      return (result.text ?? '').trim()
    },
  }
}
