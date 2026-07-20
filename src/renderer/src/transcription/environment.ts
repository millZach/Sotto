export const LOCAL_MODEL_ROOT = 'talktype-model://model/' as const
export const LOCAL_RUNTIME_ROOT = 'talktype-runtime://runtime/' as const

interface WasmEnvironment {
  wasmPaths?: unknown
  numThreads?: number
}

// Whisper inference stops scaling past four WASM threads, so reserve one core
// for the UI and cap the rest. ORT falls back to one thread without
// SharedArrayBuffer, making an over-request safe on locked-down machines.
const MAX_INFERENCE_THREADS = 4

function inferenceThreads(hardwareConcurrency: number | undefined): number {
  if (
    typeof hardwareConcurrency !== 'number' ||
    !Number.isInteger(hardwareConcurrency) ||
    hardwareConcurrency < 1
  ) {
    return 1
  }
  return Math.min(MAX_INFERENCE_THREADS, Math.max(1, hardwareConcurrency - 1))
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
  hardwareConcurrency?: number,
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
  wasmEnvironment.numThreads = inferenceThreads(hardwareConcurrency)
}
