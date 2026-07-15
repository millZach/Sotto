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

    configureLocalInferenceEnvironment(environment)

    expect(environment).toEqual({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: LOCAL_MODEL_ROOT,
      useFS: false,
      useBrowserCache: false,
      useFSCache: false,
      useCustomCache: false,
      backends: { onnx: { wasm: { wasmPaths: LOCAL_RUNTIME_ROOT } } },
    })
  })

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
