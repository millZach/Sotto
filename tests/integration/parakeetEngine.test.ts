// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createParakeetEngineLoader, parakeetDeadlineMs } from '../../src/main/asr/parakeetEngine'
import { MAX_TRANSCRIPTION_SAMPLES } from '../../src/shared/audio'
import { exited, fakeParakeetFork, running } from '../fixtures/fakeParakeetFork'

let mode = 'ready'
const { fork, children } = fakeParakeetFork(() => mode)

const load = (options: Parameters<typeof createParakeetEngineLoader>[2] = {}) => createParakeetEngineLoader('/helper/parakeetHelper.js', fork, options)('/models/parakeet-ultra-int8')

afterEach(() => {
  mode = 'ready'
  for (const child of children.splice(0)) child.kill()
})

describe('Parakeet engine', () => {
  it('starts the helper on the model folder and answers requests in order', async () => {
    const engine = await load()
    const [first, second] = await Promise.all([engine.transcribe(new Float32Array([0.5, 0, 0])), engine.transcribe(new Float32Array([-0.25, 0, 0, 0, 0]))])
    expect(first).toBe(`heard 3 samples from 0.5 to 0 in /models/parakeet-ultra-int8 with ${8 * 1024 * 1024} bytes`)
    expect(second).toMatch(/^heard 5 samples from -0.25 to 0 /)
    engine.dispose?.()
  })

  it('sends a recording as long as the longest one whole, and refuses only what is longer', async () => {
    const engine = await load()
    const longest = new Float32Array(MAX_TRANSCRIPTION_SAMPLES)
    longest[0] = 0.5
    longest[longest.length - 1] = 0.75
    await expect(engine.transcribe(longest)).resolves.toMatch(new RegExp(`^heard ${MAX_TRANSCRIPTION_SAMPLES} samples from 0.5 to 0.75 `))
    // Longer than any recording: refused before the helper sees it, and the engine keeps working.
    await expect(engine.transcribe(new Float32Array(MAX_TRANSCRIPTION_SAMPLES + 1))).rejects.toThrow('longer than the longest recording')
    await expect(engine.transcribe(new Float32Array([0.5]))).resolves.toMatch(/^heard 1 samples/)
    engine.dispose?.()
  })

  it('asks the helper to exit when disposed, without saying it stopped by itself', async () => {
    const engine = await load()
    const stopped = vi.fn()
    engine.onStopped?.(stopped)
    const helper = children.at(-1)!
    expect(running(helper)).toBe(true)
    engine.dispose?.()
    await exited(helper)
    // It exited by itself, as asked, rather than being killed.
    expect(helper.exitCode).toBe(0)
    expect(helper.signalCode).toBeNull()
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('disposed')
    expect(stopped).not.toHaveBeenCalled()
  })

  it('kills a helper that does not exit when asked', async () => {
    mode = 'ignores-stop'
    const engine = await load({ stopGraceMs: 100 })
    const helper = children.at(-1)!
    engine.dispose?.()
    await exited(helper)
    expect(helper.signalCode).toBe('SIGTERM')
  })

  it('ends a helper whose load is cancelled before the model is ready', async () => {
    mode = 'never-ready'
    const cancel = new AbortController()
    const loading = createParakeetEngineLoader('/helper/parakeetHelper.js', fork)('/models/parakeet-ultra-int8', cancel.signal)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    cancel.abort()
    await expect(loading).rejects.toThrow('cancelled')
    await exited(children[0]!)
    expect(children[0]!.exitCode).toBe(0)
  })

  it('starts no helper for a load cancelled before it began', async () => {
    const cancel = new AbortController()
    cancel.abort()
    await expect(createParakeetEngineLoader('/helper/parakeetHelper.js', fork)('/models/x', cancel.signal)).rejects.toThrow('cancelled')
    expect(children).toHaveLength(0)
  })

  it('rejects the load, and ends the helper, when sherpa-onnx or the model will not load', async () => {
    mode = 'module-fail'
    await expect(load()).rejects.toThrow('could not load sherpa-onnx')
    mode = 'model-fail'
    await expect(load()).rejects.toThrow('could not load the model')
    await Promise.all(children.map(exited))
  })

  it('rejects the load when the helper never says it is ready', async () => {
    mode = 'never-ready'
    await expect(load({ loadTimeoutMs: 200 })).rejects.toThrow('did not load in time')
    await exited(children.at(-1)!)
  })

  it('says the engine stopped when the helper crashes by itself, and rejects pending and later requests', async () => {
    mode = 'crash-after-ready'
    const engine = await load()
    const stopped = vi.fn()
    engine.onStopped?.(stopped)
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
    expect(stopped).toHaveBeenCalledOnce()
    // A listener added after the crash hears at once.
    const late = vi.fn()
    engine.onStopped?.(late)
    expect(late).toHaveBeenCalledOnce()
  })

  it('ends a helper that stops answering, and says it stopped', async () => {
    mode = 'hang'
    const engine = await load({ requestTimeoutMs: () => 200 })
    const stopped = vi.fn()
    engine.onStopped?.(stopped)
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped answering')
    await exited(children.at(-1)!)
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('ends the helper and says it stopped when Electron reports a fatal error in it', async () => {
    const engine = await load()
    const stopped = vi.fn()
    engine.onStopped?.(stopped)
    const helper = children.at(-1)!
    helper.emit('error', new Error('FatalError'))
    await exited(helper)
    expect(stopped).toHaveBeenCalledOnce()
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('failed')
  })

  it('gives a request 30 seconds plus its audio\'s length', () => {
    expect(parakeetDeadlineMs(16_000 * 6)).toBe(36_000)
    expect(parakeetDeadlineMs(MAX_TRANSCRIPTION_SAMPLES)).toBe(330_000)
  })
})
