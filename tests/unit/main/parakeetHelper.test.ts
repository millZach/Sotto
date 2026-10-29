// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { type ParakeetAnswer, type ParentLink, serveParakeet } from '../../../src/main/asr/parakeetHelper'
import { MAX_TRANSCRIPTION_SAMPLES } from '../../../src/shared/audio'

/** Electron's parent port as the helper sees it: requests arrive as `{ data }`, answers are collected. */
function link() {
  const answers: ParakeetAnswer[] = []
  let deliver: ((event: { readonly data: unknown }) => void) | undefined
  const port: ParentLink = {
    on: (_event, listener) => { deliver = listener },
    postMessage: (answer) => { answers.push(answer) },
  }
  return { port, answers, send: (data: unknown) => deliver?.({ data }) }
}

describe('Parakeet helper', () => {
  it('loads the model from the folder it is given, says it is ready, and answers each request by its id', async () => {
    const { port, answers, send } = link()
    const transcribe = vi.fn(async (samples: Float32Array) => `heard ${samples.length}`)
    const load = vi.fn(async () => ({ transcribe }))
    await expect(serveParakeet(port, '/models/parakeet-ultra-int8', load)).resolves.toBe(true)
    expect(load).toHaveBeenCalledExactlyOnceWith('/models/parakeet-ultra-int8')
    expect(answers).toEqual([{ ready: true }])
    send({ id: 7, samples: new Float32Array(3) })
    await vi.waitFor(() => expect(answers).toContainEqual({ id: 7, text: 'heard 3' }))
  })

  it('says the model would not load when loading fails after the import, and serves nothing', async () => {
    const { port, answers } = link()
    // Only the helper's own import failure counts as the module; any other failure is the model.
    await expect(serveParakeet(port, '/models/x', async () => { throw Object.assign(new Error(), { name: 'ModuleError' }) })).resolves.toBe(false)
    expect(answers).toEqual([{ error: 'model' }])
  })

  it('refuses samples that are not a Float32Array or are longer than the longest recording, without decoding them', async () => {
    const { port, answers, send } = link()
    const transcribe = vi.fn(async () => 'words')
    await serveParakeet(port, '/models/x', async () => ({ transcribe }))
    send({ id: 1, samples: [0.5, 0.25] })
    send({ id: 2, samples: new Float32Array(MAX_TRANSCRIPTION_SAMPLES + 1) })
    send({ nothing: true })
    expect(answers).toEqual([{ ready: true }, { id: 1, error: 'failed' }, { id: 2, error: 'failed' }])
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('answers failed when a decode fails, and keeps serving', async () => {
    const { port, answers, send } = link()
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('decode')).mockResolvedValueOnce('words')
    await serveParakeet(port, '/models/x', async () => ({ transcribe }))
    send({ id: 1, samples: new Float32Array(2) })
    send({ id: 2, samples: new Float32Array(2) })
    await vi.waitFor(() => expect(answers).toEqual([{ ready: true }, { id: 1, error: 'failed' }, { id: 2, text: 'words' }]))
  })

  it('exits when asked to stop, whether the model has loaded or is still loading', async () => {
    const loading = link()
    const exitWhileLoading = vi.fn()
    let finish: ((recognizer: { transcribe: () => Promise<string> }) => void) | undefined
    void serveParakeet(loading.port, '/models/x', () => new Promise((resolve) => { finish = resolve }), exitWhileLoading)
    loading.send({ stop: true })
    expect(exitWhileLoading).toHaveBeenCalledOnce()
    finish?.({ transcribe: async () => 'words' })

    const loaded = link()
    const exitWhenLoaded = vi.fn()
    await serveParakeet(loaded.port, '/models/x', async () => ({ transcribe: async () => 'words' }), exitWhenLoaded)
    loaded.send({ stop: true })
    expect(exitWhenLoaded).toHaveBeenCalledOnce()
  })

  it('answers no request that arrives before the model has loaded', async () => {
    const { port, answers, send } = link()
    let finish: ((recognizer: { transcribe: () => Promise<string> }) => void) | undefined
    const served = serveParakeet(port, '/models/x', () => new Promise((resolve) => { finish = resolve }))
    send({ id: 1, samples: new Float32Array(2) })
    finish?.({ transcribe: async () => 'words' })
    await served
    expect(answers).toEqual([{ ready: true }])
  })

  it('reports a sherpa-onnx-node that will not load as the module', async () => {
    vi.resetModules()
    vi.doMock('sherpa-onnx-node', () => { throw new Error('no addon for this platform') })
    const { serveParakeet: serve } = await import('../../../src/main/asr/parakeetHelper')
    const { port, answers } = link()
    await expect(serve(port, '/models/x')).resolves.toBe(false)
    expect(answers).toEqual([{ error: 'module' }])
    vi.doUnmock('sherpa-onnx-node')
  })
})
