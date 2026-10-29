/**
 * The Parakeet helper: a utility process of Sotto's own that runs Parakeet through sherpa-onnx (ADR-0071), started by
 * `parakeetEngine.ts` with the model folder as its last argument. sherpa-onnx-node frees its native model only when V8
 * collects a small wrapper, which it rarely does, and Windows' heap may not give the memory back even then (#1787). In
 * a process of its own, letting go of the model ends the process, and the operating system takes back every byte.
 *
 * It speaks one message per request over Electron's parent port: `{ ready: true }` once the model is loaded, or one
 * `{ error }` and an exit when it is not; then `{ id, samples }` in, `{ id, text }` or `{ id, error }` out. `{ stop: true }`
 * makes it exit at once, loaded or not; main kills it only if it has not. Samples come
 * in as a structured-clone copy, a Float32Array made in JavaScript: sherpa's own WAV reader returns an external buffer,
 * which Electron's memory cage rejects. Nothing it hears or answers is logged.
 */
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import { MAX_TRANSCRIPTION_SAMPLES, TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'

export interface ParakeetRequest {
  readonly id: number
  readonly samples: Float32Array
}

/** Main letting go of the model: the helper exits, at any point, loaded or still loading. */
export interface ParakeetStop {
  readonly stop: true
}

/**
 * What the helper says. `module` means sherpa-onnx-node would not load here; `model` means it loaded but would not
 * start on the folder, which the packaged-resources check expects for a folder with no model in it.
 */
export type ParakeetAnswer =
  | { readonly ready: true }
  | { readonly error: 'module' | 'model' }
  | { readonly id: number; readonly text: string }
  | { readonly id: number; readonly error: 'failed' }

export interface ParakeetRecognizer {
  transcribe(samples: Float32Array): Promise<string>
}

/** The helper's end of its link to main: Electron's `process.parentPort`, or a test's stand-in. */
export interface ParentLink {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown
  postMessage(answer: ParakeetAnswer): void
}

class ModuleError extends Error {}

/**
 * Half the cores, at most four. In the October 10 benchmark four threads were a fifth faster than two
 * on a 17-second clip and no faster on a 2-second one, and dictation should not take the whole
 * machine from whatever the person is doing.
 */
function threadCount(): number {
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))
}

/**
 * Parakeet through sherpa-onnx, imported here so the helper reports a module that will not load rather than failing
 * to start. Loading and decoding both run on the native thread pool. The package is CommonJS whose exports Node's
 * import() cannot list, so its classes are read from the default export, which is all of module.exports.
 */
async function loadSherpa(modelDirectory: string): Promise<ParakeetRecognizer> {
  const sherpa = await import('sherpa-onnx-node').catch(() => { throw new ModuleError() })
  const { OfflineRecognizer } = sherpa.default
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

/**
 * Loads the model and answers requests until main ends the process. Resolves false when the model would not load,
 * after saying why, so the caller exits.
 */
export async function serveParakeet(
  link: ParentLink,
  modelDirectory: string,
  load: (modelDirectory: string) => Promise<ParakeetRecognizer> = loadSherpa,
  exit: () => void = () => process.exit(0),
): Promise<boolean> {
  let recognizer: ParakeetRecognizer | null = null
  // Listening starts before the model loads, so main can stop a helper that is still loading.
  link.on('message', ({ data }) => {
    const request = data as (Partial<ParakeetRequest> & Partial<ParakeetStop>) | null
    if (request?.stop === true) {
      exit()
      return
    }
    if (recognizer === null || typeof request?.id !== 'number') return
    const { id, samples } = request
    // Main refuses anything longer than Sotto's longest recording before sending it; this holds the line here too.
    if (!(samples instanceof Float32Array) || samples.length > MAX_TRANSCRIPTION_SAMPLES) {
      link.postMessage({ id, error: 'failed' })
      return
    }
    recognizer.transcribe(samples).then(
      (text) => link.postMessage({ id, text }),
      () => link.postMessage({ id, error: 'failed' }),
    )
  })
  try {
    recognizer = await load(modelDirectory)
  } catch (error) {
    link.postMessage({ error: error instanceof ModuleError ? 'module' : 'model' })
    return false
  }
  link.postMessage({ ready: true })
  return true
}

/** How long a helper whose model would not load waits for main to read why before it exits by itself. */
const EXIT_AFTER_FAILURE_MS = 1_000

// In Electron's utility process the parent port is there; imported anywhere else (main, a test) this file starts nothing.
const parentPort = (process as { parentPort?: ParentLink }).parentPort
if (parentPort !== undefined) {
  void serveParakeet(parentPort, process.argv.at(-1) ?? '').then((served) => {
    if (!served) setTimeout(() => process.exit(1), EXIT_AFTER_FAILURE_MS)
  })
}
