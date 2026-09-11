import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

interface Stream { acceptWaveform(rate: number, audio: Float32Array): void; inputFinished(): void; free(): void }
interface Spotter {
  createStream(): Stream; isReady(stream: Stream): boolean; decode(stream: Stream): void
  getResult(stream: Stream): { keyword: string; timestamps: number[] }
  free(): void
}
interface Sherpa { createKws(config: unknown): Spotter }

const { directory, runtimeDirectory } = workerData as { directory: string; runtimeDirectory: string }
const load = createRequire(__filename)
let detector: Spotter | null = null

function prepare(): Spotter {
  if (detector !== null) return detector
  const sherpa = load(join(runtimeDirectory, 'index.js')) as Sherpa
  detector = sherpa.createKws({
    modelConfig: { transducer: {
      encoder: join(directory, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: join(directory, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
      joiner: join(directory, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    }, tokens: join(directory, 'tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
    // The name's two pronunciations. SODA (S OW1 D AH0) is deliberately absent.
    keywords: 'HH EY1 S OW1 T OW0 @hey_soto\nHH EY1 S AA1 T OW0 @hey_sotto\n',
    maxActivePaths: 4, numTrailingBlanks: 1, keywordsScore: 1, keywordsThreshold: 0.25,
  })
  return detector
}

parentPort?.on('message', ({ id, type, audio }: { id: number; type: string; audio?: Float32Array }) => {
  try {
    const kws = prepare()
    let result = { detected: false, endSeconds: 0 }
    if (type === 'detect' && audio !== undefined) {
      const stream = kws.createStream()
      try {
        stream.acceptWaveform(16_000, audio)
        stream.acceptWaveform(16_000, new Float32Array(16_000))
        stream.inputFinished()
        while (kws.isReady(stream)) {
          kws.decode(stream)
          const match = kws.getResult(stream)
          if (!match.keyword || match.timestamps.length !== 6) continue
          // Capture supplies at most 180 ms pre-roll; allow the model's roughly 160 ms alignment delay.
          // A wake name embedded later in ordinary speech must not activate the conversation.
          if ((match.timestamps[0] ?? Infinity) > 0.4) break
          const endSeconds = (match.timestamps.at(-1) ?? 0) + 0.12
          if (endSeconds <= audio.length / 16_000) result = { detected: true, endSeconds }
          break
        }
      } finally { stream.free() }
    }
    parentPort?.postMessage({ id, result })
  } catch { parentPort?.postMessage({ id, error: 'The local wake model could not be used. Verify its files and retry.' }) }
})
