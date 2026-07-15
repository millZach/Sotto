export const LOCAL_MODEL_ROOT = 'talktype-model://model/' as const
export const LOCAL_RUNTIME_ROOT = 'talktype-runtime://runtime/' as const

interface WasmEnvironment {
  wasmPaths?: unknown
}

export interface LocalInferenceEnvironment {
  allowRemoteModels: boolean
  allowLocalModels: boolean
  localModelPath: string
  useFS: boolean
  useBrowserCache: boolean
  useFSCache: boolean
  useCustomCache: boolean
  backends: {
    onnx: {
      wasm?: WasmEnvironment | undefined
    }
  }
}

export function configureLocalInferenceEnvironment(
  environment: LocalInferenceEnvironment,
): void {
  const wasmEnvironment = environment.backends.onnx.wasm
  if (wasmEnvironment === undefined) {
    throw new Error('The local inference runtime is unavailable.')
  }

  environment.allowRemoteModels = false
  environment.allowLocalModels = true
  environment.localModelPath = LOCAL_MODEL_ROOT
  environment.useFS = false
  environment.useBrowserCache = false
  environment.useFSCache = false
  environment.useCustomCache = false
  wasmEnvironment.wasmPaths = LOCAL_RUNTIME_ROOT
}
