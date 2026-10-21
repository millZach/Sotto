import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { MAX_TRANSCRIPTION_SAMPLES } from '../../shared/audio'
import type { SpeechEngine, SpeechEngineLoader } from './speechEngine'

/** The FluidAudio model versions Sotto's Core ML helper loads. */
export type CoreMlModelVersion = 'v2' | 'v3' | 'ultra'

export interface CoreMlEngineOptions {
  readonly spawnFn?: typeof spawn
  readonly loadTimeoutMs?: number
  /** How long one request may take before the helper counts as hung; defaults to requestDeadlineMs. */
  readonly requestTimeoutMs?: (sampleCount: number) => number
}

/** The first Core ML compile of a model takes about 14 seconds; later loads take under one. */
const DEFAULT_LOAD_TIMEOUT_MS = 120_000
/** How long a disposed helper gets to finish and exit on its own before it is killed. */
const DISPOSE_GRACE_MS = 2_000
/**
 * The longest request: Sotto's longest recording, which the helper also accepts (protocol 2). A
 * recording whose segments could not be sent goes whole, up to five minutes; FluidAudio windows it
 * itself. Anything longer cannot come from the recorder, so it is refused before the helper sees it.
 */
const MAX_SAMPLES = MAX_TRANSCRIPTION_SAMPLES
/**
 * The longest any request may take, however long its audio. Five minutes of audio takes under a
 * second, so this only shortens how long a hung helper holds main's transcription queue.
 */
const MAX_REQUEST_MS = 120_000
/** The protocol this engine speaks; a helper built before it refuses long requests, so it is not used. */
const HELPER_PROTOCOL = 2
/**
 * A request's deadline: 20 seconds plus twice the audio's length, at most MAX_REQUEST_MS. Parakeet takes about a hundredth
 * of the audio's length, so only a hung helper reaches it; it is then stopped, which drains main's
 * transcription queue and lets Try again start it afresh.
 */
export const requestDeadlineMs = (sampleCount: number): number => Math.min(20_000 + (sampleCount / 16_000) * 2_000, MAX_REQUEST_MS)

interface Pending {
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
}

/** One stdout line as a JSON object, or null for FluidAudio's own prints and anything else. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Spawns the helper on a FluidAudio model folder; resolves once it prints {"ready":true}. The helper
 * speaks protocol 2: binary requests on stdin, one JSON line per answer on stdout, in request order.
 * Stderr is ignored, not read: FluidAudio's own prints land there, and nothing the helper says is
 * ever logged, so transcript text cannot reach a log by that road. Once the helper exits for any
 * reason the engine is dead; every pending and later transcribe rejects, and the caller loads again.
 */
export function createCoreMlEngineLoader(helperPath: string, version: CoreMlModelVersion, options: CoreMlEngineOptions = {}): SpeechEngineLoader {
  const spawnFn = options.spawnFn ?? spawn
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? requestDeadlineMs
  return (modelDirectory) =>
    new Promise<SpeechEngine>((resolveLoad, rejectLoad) => {
      const child = spawnFn(helperPath, [modelDirectory, version], { stdio: ['pipe', 'pipe', 'ignore'] })
      const pending = new Map<number, Pending>()
      let nextId = 1
      let ready = false
      let dead: Error | null = null
      let disposed = false
      const stoppedListeners: (() => void)[] = []

      const fail = (error: Error): void => {
        if (dead) return
        dead = error
        clearTimeout(loadTimer)
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        if (!ready) {
          child.kill()
          rejectLoad(error)
        } else if (!disposed) {
          for (const listener of stoppedListeners.splice(0)) listener()
        }
      }

      const loadTimer = setTimeout(() => fail(new Error('Core ML helper did not load in time')), loadTimeoutMs)

      const engine: SpeechEngine = {
        transcribe(samples) {
          if (dead) return Promise.reject(dead)
          if (samples.length > MAX_SAMPLES) return Promise.reject(new Error('Core ML request is longer than the longest recording'))
          const id = nextId++
          const header = Buffer.alloc(8)
          header.writeUInt32LE(id, 0)
          header.writeUInt32LE(samples.length, 4)
          // Float32Array bytes are in host order, little-endian on the Apple silicon Macs the helper runs on.
          const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
          return new Promise<string>((resolve, reject) => {
            const deadline = setTimeout(() => {
              child.kill()
              fail(new Error('Core ML helper stopped answering'))
            }, requestTimeoutMs(samples.length))
            deadline.unref()
            const settle = (): void => clearTimeout(deadline)
            pending.set(id, {
              resolve: (text) => { settle(); resolve(text) },
              reject: (error) => { settle(); reject(error) },
            })
            child.stdin?.write(header)
            child.stdin?.write(body)
          })
        },
        onStopped(listener) {
          if (dead) { if (!disposed) listener(); return }
          stoppedListeners.push(listener)
        },
        dispose() {
          disposed = true
          fail(new Error('Core ML engine was disposed'))
          child.stdin?.end()
          const killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill()
          }, DISPOSE_GRACE_MS)
          killTimer.unref()
        },
      }

      child.on('error', (error) => fail(error))
      child.on('exit', () => fail(new Error('Core ML helper stopped')))
      child.stdin?.on('error', (error) => fail(error))
      if (!child.stdout) {
        fail(new Error('Core ML helper has no stdout'))
        return
      }
      onLines(child.stdout, (line) => {
        const message = parseLine(line)
        if (!message || dead) return
        if (!ready) {
          if (message.ready === true && message.protocol !== HELPER_PROTOCOL) {
            // A helper left from an earlier build (a development checkout that was not rebuilt).
            fail(new Error(`Core ML helper speaks protocol ${String(message.protocol ?? 1)}, not ${HELPER_PROTOCOL}; rebuild it with scripts/build-coreml-asr.mjs`))
          } else if (message.ready === true) {
            ready = true
            clearTimeout(loadTimer)
            resolveLoad(engine)
          } else if ('error' in message) {
            fail(new Error('Core ML helper could not load the model'))
          }
          return
        }
        if (typeof message.id !== 'number') return
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (typeof message.text === 'string') request.resolve(message.text)
        else request.reject(new Error('Core ML helper could not transcribe'))
      })
    })
}

/** True on darwin arm64 when the helper file exists: Core ML models run only on Apple silicon Macs. */
export function coreMlHelperAvailable(helperPath: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean {
  return platform === 'darwin' && arch === 'arm64' && existsSync(helperPath)
}

/**
 * Calls `onLine` for each newline-ended line the helper writes. Split by hand rather than with
 * node:readline, which the release's reviewed list of main-process modules does not carry.
 */
function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    let end = pending.indexOf('\n')
    while (end !== -1) {
      onLine(pending.slice(0, end))
      pending = pending.slice(end + 1)
      end = pending.indexOf('\n')
    }
  })
}
