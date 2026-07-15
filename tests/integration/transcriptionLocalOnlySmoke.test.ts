import { env, pipeline } from '@huggingface/transformers'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  it('resolves the pinned repository only through TalkType protocols', async () => {
    const observedUrls: string[] = []
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      observedUrls.push(String(input instanceof Request ? input.url : input))
      return new Response('', { status: 404 })
    })
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = 'talktype-model://model/'
    env.useFS = false
    env.useBrowserCache = false
    env.useFSCache = false
    env.useCustomCache = false
    env.backends.onnx.wasm!.wasmPaths = 'talktype-runtime://runtime/'
    env.fetch = fetchSpy

    await expect(
      pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
        dtype: 'q8',
        device: 'wasm',
        local_files_only: true,
      }),
    ).rejects.toThrow()

    expect(observedUrls.length).toBeGreaterThan(0)
    expect(
      observedUrls.every(
        (url) =>
          url.startsWith('talktype-model://model/') ||
          url.startsWith('talktype-runtime://runtime/'),
      ),
    ).toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
  })
})
