import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { AgentWakeDetection } from '../../shared/agents'

// An explicitly supplied model only. No model downloader or network path exists here.
export const WAKE_MODEL_FILES = [
  'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  'decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
  'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt',
] as const
const MODEL_SHA256 = [
  '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48',
  '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21',
  '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1',
  '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0',
] as const

// Standard upstream Node WASM runtime is a development/local-input dependency only.
// Its TTS-linked build is deliberately excluded from Sotto's distribution.
const RUNTIME_SHA256: Readonly<Record<string, string>> = {
  'index.js': '4026ae1122eaab063b19c4c331af33eb96af7536d5e7c2b6a2726661843177d9',
  'package.json': 'b0d41736778dcf7a506fa1a1a784535a87761a719ff4ba7d3c8a2679f37d9033',
  'sherpa-onnx-asr.js': 'd51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
  'sherpa-onnx-kws.js': '03b44e372795fd907e84eecd29419e1d052dc6704ac06935c9bf9fe19b3e3434',
  'sherpa-onnx-punctuation.js': '6d9721e5e11809e248a8cd64a9a50de43b047a9f059cfb35bea88a5e7265f49a',
  'sherpa-onnx-speaker-diarization.js': '7f1a37ea0c31e4352347f8e8945115a7ccffdf93b974c49c01878a8fa472e5bd',
  'sherpa-onnx-speech-enhancement.js': 'f4bdf7affe3e99d1f6879e02b7c9541cb2d88ec992302b4c1828e8e445c845eb',
  'sherpa-onnx-tts.js': 'b9cb4782010b22d64be31298a3e407170d2b8f5def471ea6011c42a921577e8f',
  'sherpa-onnx-vad.js': '893f01168d529add8318c0a6055cf725e788585fda9b81722564a8c3c3f60e34',
  'sherpa-onnx-wasm-nodejs.js': '6f78967dfa404b2d67da0349d17d92c9467d670f6b732ec862485522151e0188',
  'sherpa-onnx-wasm-nodejs.wasm': 'ef5926d45aae2738dabf649a5f626cf9827ba18f45453840c56eebb31ca2dd1b',
  'sherpa-onnx-wave.js': 'bb40258584a8eea84d9e9c09e9642ce5e67e4db68fc1522d8610297420052230',
}

async function validateWakeRuntimeDirectory(input: string): Promise<string> {
  if (!isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//')) throw new Error('Wake runtime setup required. Select a trusted local runtime folder.')
  const directory = await realpath(input).catch(() => { throw new Error('Wake runtime setup required. This build does not include a distributable wake runtime.') })
  for (const [filename, expected] of Object.entries(RUNTIME_SHA256)) {
    const file = await realpath(join(directory, filename)).catch(() => { throw new Error(`Wake runtime is missing ${filename}.`) })
    const inside = relative(directory, file)
    const details = await stat(file)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !details.isFile() || details.size > 20_000_000) throw new Error('Wake runtime files must remain inside the selected folder.')
    if (createHash('sha256').update(await readFile(file)).digest('hex') !== expected) throw new Error('Wake runtime verification failed. Only the supported original runtime is accepted.')
  }
  return directory
}

export async function validateWakeModelDirectory(input: string): Promise<string> {
  if (!isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//')) {
    throw new Error('Wake setup required. Select a local absolute model folder in Agent connection settings.')
  }
  let directory: string
  try { directory = await realpath(input) } catch { throw new Error('The local wake model folder is unavailable.') }
  if (!(await stat(directory)).isDirectory()) throw new Error('The wake model path must be a folder.')
  for (const filename of WAKE_MODEL_FILES) {
    const file = await realpath(join(directory, filename)).catch(() => { throw new Error(`Wake model is missing ${filename}.`) })
    const inside = relative(directory, file)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Wake model files must remain inside the selected folder.')
    const details = await stat(file)
    if (!details.isFile() || details.size === 0 || details.size > 20_000_000) throw new Error('The local wake model contains an invalid file.')
    if (createHash('sha256').update(await readFile(file)).digest('hex') !== MODEL_SHA256[WAKE_MODEL_FILES.indexOf(filename)]) {
      throw new Error(`Wake model verification failed for ${filename}. Use the supported original model files.`)
    }
  }
  return directory
}

interface Pending {
  resolve: (result: AgentWakeDetection) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One isolated local CPU worker, with bounded PCM input and no background audio storage. */
export class AgentWakeService {
  private worker: Worker | null = null
  private directory = ''
  private nextId = 0
  private pending = new Map<number, Pending>()
  private preparation: Promise<void> | null = null
  private generation = 0
  private selectedRuntime = ''

  constructor(private readonly runtimeDirectory: string, private readonly workerPath: string) {}

  async prepare(input: string, runtime = this.runtimeDirectory): Promise<void> {
    if (this.worker !== null && this.directory === input && this.selectedRuntime === runtime && this.preparation !== null) return this.preparation
    this.dispose()
    this.directory = input
    this.selectedRuntime = runtime
    const preparation = this.start(input, runtime, this.generation)
    this.preparation = preparation
    return preparation
  }

  private async start(input: string, runtime: string, generation: number): Promise<void> {
    const directory = await validateWakeModelDirectory(input)
    const runtimeDirectory = await validateWakeRuntimeDirectory(runtime)
    if (this.directory !== input || this.generation !== generation) throw new Error('Wake setup changed. Retry listening.')
    // Keep file validation outside the worker and do not execute anything from the model folder.
    const worker = new Worker(this.workerPath, { workerData: { directory, runtimeDirectory } })
    this.worker = worker
    worker.on('message', (message: { id: number; result?: AgentWakeDetection; error?: string }) => {
      if (this.worker !== worker) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(message.error))
      else pending.resolve(message.result ?? { detected: false, endSeconds: 0 })
    })
    worker.on('error', () => { if (this.worker === worker) this.dispose('The local wake detector could not start. Check the configured model.') })
    worker.on('exit', () => { if (this.worker === worker) this.dispose('The local wake detector stopped. Retry listening.') })
    await this.request('prepare')
  }

  async detect(audio: Float32Array): Promise<AgentWakeDetection> {
    if (this.preparation === null) throw new Error('Wake setup required. Configure a local wake model first.')
    await this.preparation
    if (audio.length < 1 || audio.length > 132_000 || audio.some(sample => !Number.isFinite(sample) || Math.abs(sample) > 1)) {
      throw new Error('Wake audio must be at most 8.25 seconds of normalized mono 16 kHz PCM.')
    }
    return this.request('detect', audio)
  }

  dispose(message = 'Local wake detection was stopped.'): void {
    ++this.generation
    const worker = this.worker
    this.worker = null
    this.directory = ''
    this.selectedRuntime = ''
    this.preparation = null
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.pending.clear()
    void worker?.terminate()
  }

  private request(type: 'prepare' | 'detect', audio?: Float32Array): Promise<AgentWakeDetection> {
    if (this.worker === null) return Promise.reject(new Error('Local wake detection is unavailable.'))
    if (this.pending.size >= 2) return Promise.reject(new Error('Local wake detection is busy. Retry listening.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose('Local wake detection timed out. Retry listening.'), 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.postMessage({ id, type, audio })
    })
  }
}
