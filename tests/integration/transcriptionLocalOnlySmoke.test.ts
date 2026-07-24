import { env, pipeline } from '@huggingface/transformers'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configureLocalInferenceEnvironment } from '../../src/renderer/src/transcription/environment'

const originalEnvironment = {
  allowRemoteModels: env.allowRemoteModels,
  allowLocalModels: env.allowLocalModels,
  localModelPath: env.localModelPath,
  useFS: env.useFS,
  useBrowserCache: env.useBrowserCache,
  useFSCache: env.useFSCache,
  useCustomCache: env.useCustomCache,
  wasmPaths: env.backends.onnx.wasm?.wasmPaths,
  fetch: env.fetch,
}

afterEach(() => {
  env.allowRemoteModels = originalEnvironment.allowRemoteModels
  env.allowLocalModels = originalEnvironment.allowLocalModels
  env.localModelPath = originalEnvironment.localModelPath
  env.useFS = originalEnvironment.useFS
  env.useBrowserCache = originalEnvironment.useBrowserCache
  env.useFSCache = originalEnvironment.useFSCache
  env.useCustomCache = originalEnvironment.useCustomCache
  if (env.backends.onnx.wasm !== undefined && originalEnvironment.wasmPaths !== undefined) {
    env.backends.onnx.wasm.wasmPaths = originalEnvironment.wasmPaths
  }
  env.fetch = originalEnvironment.fetch
})

describe('Transformers.js local-only resolution smoke', () => {
  it('configures the real runtime root and resolves model metadata only locally', async () => {
    const observedUrls: string[] = []
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      observedUrls.push(url)
      return new Response('', { status: 404 })
    })
    configureLocalInferenceEnvironment(env)
    env.fetch = fetchSpy

    expect(env.backends.onnx.wasm?.wasmPaths).toBe('sotto-runtime://runtime/')

    await expect(
      pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        dtype: 'q8',
        device: 'wasm',
        local_files_only: true,
      }),
    ).rejects.toThrow()

    expect(observedUrls.length).toBeGreaterThan(0)
    expect(observedUrls.every((url) => url.startsWith('sotto-model://model/'))).toBe(
      true,
    )
    expect(fetchSpy).toHaveBeenCalled()
  })
})
