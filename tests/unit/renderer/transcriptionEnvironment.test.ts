import { describe, expect, it } from 'vitest'

import {
  configureLocalInferenceEnvironment,
  LOCAL_MODEL_ROOT,
  LOCAL_RUNTIME_ROOT,
  type LocalInferenceEnvironment,
} from '../../../src/renderer/src/transcription/environment'

function environmentWithWasm(): LocalInferenceEnvironment {
  return {
    allowRemoteModels: true,
    allowLocalModels: false,
    localModelPath: 'unsafe-default',
    useFS: true,
    useBrowserCache: true,
    useFSCache: true,
    useCustomCache: true,
    backends: { onnx: { wasm: {} } },
  }
}

describe('local inference environment', () => {
  it('atomically applies every production local-only setting', () => {
    const environment = environmentWithWasm()

    configureLocalInferenceEnvironment(environment, 8)

    expect(environment).toEqual({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: LOCAL_MODEL_ROOT,
      useFS: false,
      useBrowserCache: false,
      useFSCache: false,
      useCustomCache: false,
      backends: {
        onnx: { wasm: { wasmPaths: LOCAL_RUNTIME_ROOT, numThreads: 4 } },
      },
    })
  })

  it.each([
    [16, 4],
    [8, 4],
    [4, 3],
    [2, 1],
    [1, 1],
  ])(
    'reserves one core and caps inference at four threads (%i cores -> %i threads)',
    (hardwareConcurrency, expectedThreads) => {
      const environment = environmentWithWasm()

      configureLocalInferenceEnvironment(environment, hardwareConcurrency)

      expect(environment.backends.onnx.wasm).toEqual({
        wasmPaths: LOCAL_RUNTIME_ROOT,
        numThreads: expectedThreads,
      })
    },
  )

  it.each([undefined, 0, -2, Number.NaN, 2.5])(
    'falls back to a single thread when core count is unusable (%s)',
    (hardwareConcurrency) => {
      const environment = environmentWithWasm()

      configureLocalInferenceEnvironment(environment, hardwareConcurrency as number | undefined)

      expect(environment.backends.onnx.wasm).toEqual({
        wasmPaths: LOCAL_RUNTIME_ROOT,
        numThreads: 1,
      })
    },
  )

  it('fails closed before mutation when the WASM backend is unavailable', () => {
    const environment: LocalInferenceEnvironment = {
      ...environmentWithWasm(),
      backends: { onnx: {} },
    }
    const before = structuredClone(environment)

    expect(() => configureLocalInferenceEnvironment(environment)).toThrow(
      'The local inference runtime is unavailable.',
    )
    expect(environment).toEqual(before)
  })
})
