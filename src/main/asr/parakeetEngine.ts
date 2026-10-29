import { MAX_TRANSCRIPTION_SAMPLES, TRANSCRIPTION_SAMPLE_RATE } from '../../shared/audio'
import type { ParakeetRequest, ParakeetStop } from './parakeetHelper'
import type { SpeechEngine, SpeechEngineLoader } from './speechEngine'

/** The parts of Electron's UtilityProcess the engine uses; a test passes a stand-in. */
export interface HelperProcess {
  postMessage(request: ParakeetRequest | ParakeetStop): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  /** A fatal error in the helper; its details are never read, so nothing it says reaches a log. */
  on(event: 'error', listener: () => void): this
}

/** Starts the helper: Electron's `utilityProcess.fork` in main. */
export type ForkHelper = (modulePath: string, args: string[], options: { serviceName: string; stdio: 'ignore' }) => HelperProcess

export interface ParakeetEngineOptions {
  readonly loadTimeoutMs?: number
  /** How long one request may take before the helper counts as hung; defaults to parakeetDeadlineMs. */
  readonly requestTimeoutMs?: (sampleCount: number) => number
  /** How long a helper asked to stop gets before it is killed; defaults to STOP_GRACE_MS. */
  readonly stopGraceMs?: number
}

/**
 * How long a helper asked to stop gets to exit by itself before it is killed, as the Core ML helper gets to finish. A
 * helper that has hung is killed at once.
 */
const STOP_GRACE_MS = 2_000

/** Loading Parakeet takes a few seconds on the October 10 laptop; a slow disk or a busy machine gets far longer. */
const DEFAULT_LOAD_TIMEOUT_MS = 120_000

/**
 * A request's deadline: 30 seconds plus the audio's own length. Parakeet on the CPU takes about a thirtieth of it (0.6 s
 * for a 17-second clip on the October 10 laptop), so only a hung helper reaches it; it is then stopped, which drains
 * main's transcription queue and reports the model stopped, so Try again starts it afresh.
 */
export const parakeetDeadlineMs = (sampleCount: number): number => 30_000 + (sampleCount / TRANSCRIPTION_SAMPLE_RATE) * 1_000

interface Pending {
  readonly resolve: (text: string) => void
  readonly reject: (error: Error) => void
}

/**
 * Runs Parakeet in the helper (`parakeetHelper.ts`), a utility process of its own, so that letting go of the model ends
 * the process and gives all its memory back (#1787). Resolves once the helper says the model is loaded. Samples cross
 * as a structured-clone copy, which the helper receives as a Float32Array made in JavaScript, the only kind sherpa
 * takes under Electron's memory cage. The helper's output is ignored, never read: nothing it says reaches a log.
 * Once the helper exits for any reason the engine is dead: every pending and later transcribe rejects, a helper that
 * stopped by itself is reported through onStopped, and the caller loads again.
 */
export function createParakeetEngineLoader(helperPath: string, fork: ForkHelper, options: ParakeetEngineOptions = {}): SpeechEngineLoader {
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? parakeetDeadlineMs
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  return (modelDirectory, signal) =>
    new Promise<SpeechEngine>((resolveLoad, rejectLoad) => {
      if (signal?.aborted === true) {
        rejectLoad(new Error('Parakeet load was cancelled'))
        return
      }
      const child = fork(helperPath, [modelDirectory], { serviceName: 'Sotto speech model', stdio: 'ignore' })
      const pending = new Map<number, Pending>()
      let nextId = 1
      let ready = false
      let dead: Error | null = null
      let disposed = false
      const stoppedListeners: (() => void)[] = []

      let exited = false
      const kill = (): void => {
        if (exited) return
        try { child.kill() } catch { /* It has already gone. */ }
      }
      /** Asks the helper to exit, and kills it if it has not within the grace; a hung helper is killed at once. */
      const stop = (hung: boolean): void => {
        if (exited) return
        if (hung) { kill(); return }
        try { child.postMessage({ stop: true }) } catch { kill(); return }
        setTimeout(kill, stopGraceMs).unref()
      }

      const fail = (error: Error, hung = false): void => {
        if (dead) return
        dead = error
        clearTimeout(loadTimer)
        // Ends a helper that is still there, hung or disposed; one that has already exited has nothing left to end.
        stop(hung)
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        if (!ready) rejectLoad(error)
        else if (!disposed) for (const listener of stoppedListeners.splice(0)) listener()
      }

      const loadTimer = setTimeout(() => fail(new Error('Parakeet helper did not load in time'), true), loadTimeoutMs)
      // Dictation turned off, or another model chosen, before the model was ready: the helper ends now, not when it loads.
      signal?.addEventListener('abort', () => { if (!ready) fail(new Error('Parakeet load was cancelled')) }, { once: true })

      const engine: SpeechEngine = {
        transcribe(samples) {
          if (dead) return Promise.reject(dead)
          if (samples.length > MAX_TRANSCRIPTION_SAMPLES) return Promise.reject(new Error('Parakeet request is longer than the longest recording'))
          const id = nextId++
          return new Promise<string>((resolve, reject) => {
            const deadline = setTimeout(() => fail(new Error('Parakeet helper stopped answering'), true), requestTimeoutMs(samples.length))
            deadline.unref()
            pending.set(id, {
              resolve: (text) => { clearTimeout(deadline); resolve(text) },
              reject: (error) => { clearTimeout(deadline); reject(error) },
            })
            try {
              child.postMessage({ id, samples })
            } catch (error) {
              fail(error instanceof Error ? error : new Error('Parakeet helper could not take the request'))
            }
          })
        },
        onStopped(listener) {
          if (dead) { if (!disposed) listener(); return }
          stoppedListeners.push(listener)
        },
        dispose() {
          disposed = true
          fail(new Error('Parakeet engine was disposed'))
        },
      }

      // Without a listener, Electron's fatal-error event would throw in main; the helper is ended and reported instead.
      child.on('error', () => fail(new Error('Parakeet helper failed'), true))
      child.on('exit', () => {
        exited = true
        fail(new Error('Parakeet helper stopped'))
      })
      child.on('message', (message) => {
        if (dead || message === null || typeof message !== 'object') return
        // One of the helper's answers (`ParakeetAnswer`), read field by field since it crossed a process boundary.
        const answer = message as { readonly ready?: unknown; readonly error?: unknown; readonly id?: unknown; readonly text?: unknown }
        if (!ready) {
          if (answer.ready === true) {
            ready = true
            clearTimeout(loadTimer)
            resolveLoad(engine)
          } else if (answer.error === 'module') {
            fail(new Error('Parakeet helper could not load sherpa-onnx'))
          } else if (answer.error !== undefined) {
            fail(new Error('Parakeet helper could not load the model'))
          }
          return
        }
        if (typeof answer.id !== 'number') return
        const request = pending.get(answer.id)
        if (!request) return
        pending.delete(answer.id)
        if (typeof answer.text === 'string') request.resolve(answer.text)
        else request.reject(new Error('Parakeet helper could not transcribe'))
      })
    })
}
