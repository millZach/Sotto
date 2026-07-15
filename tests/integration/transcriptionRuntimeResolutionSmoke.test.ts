import * as ort from 'onnxruntime-web/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureLocalInferenceEnvironment,
  LOCAL_RUNTIME_ROOT,
  type LocalInferenceEnvironment,
} from '../../src/renderer/src/transcription/environment'

const originalWasmPaths = ort.env.wasm.wasmPaths
const originalFetch = globalThis.fetch

afterEach(() => {
  if (originalWasmPaths !== undefined) ort.env.wasm.wasmPaths = originalWasmPaths
  else Reflect.deleteProperty(ort.env.wasm, 'wasmPaths')
  globalThis.fetch = originalFetch
})

describe('installed ONNX runtime resolution smoke', () => {
  it('consumes the production-configured TalkType runtime root', async () => {
    const ortEnvironment = {
      allowRemoteModels: true,
      allowLocalModels: false,
      localModelPath: '',
      useFS: true,
      useBrowserCache: true,
      useFSCache: true,
      useCustomCache: true,
      backends: { onnx: { wasm: ort.env.wasm } },
    } satisfies LocalInferenceEnvironment
    configureLocalInferenceEnvironment(ortEnvironment)
    expect(ort.env.wasm.wasmPaths).toBe(LOCAL_RUNTIME_ROOT)
    const runtimeFetches: string[] = []
    globalThis.fetch = vi.fn(async (input) => {
      runtimeFetches.push(String(input instanceof Request ? input.url : input))
      throw new TypeError('The test intentionally blocks runtime loading.')
    })

    let runtimeFailure = ''
    try {
      await ort.InferenceSession.create(new Uint8Array([0]), {
        executionProviders: ['wasm'],
      })
    } catch (error) {
      runtimeFailure = error instanceof Error ? error.message : String(error)
    }

    // The intentionally invalid model prevents inference. This proves the
    // installed webgpu build consumed the shared production runtime root via
    // either its WASM fetch or module resolver, without loading a real model.
    const consumedLocalRoot =
      runtimeFetches.some((url) => url.startsWith(LOCAL_RUNTIME_ROOT)) ||
      runtimeFailure.includes(LOCAL_RUNTIME_ROOT) ||
      runtimeFailure.includes(`protocol '${new URL(LOCAL_RUNTIME_ROOT).protocol}'`)
    expect(
      consumedLocalRoot,
      JSON.stringify({ runtimeFetches, runtimeFailure }),
    ).toBe(true)
  })
})
