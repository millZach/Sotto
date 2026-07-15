/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers'

import { createTranscriptionRuntime, type PipelineFactory } from './runtime'

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = 'talktype-model://model/'
env.useFS = false
env.useBrowserCache = false
env.useFSCache = false
env.useCustomCache = false
env.backends.onnx.wasm!.wasmPaths = 'talktype-runtime://runtime/'

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope
const runtime = createTranscriptionRuntime({
  createPipeline: pipeline as unknown as PipelineFactory,
  postMessage: (message) => workerScope.postMessage(message),
  probeWebGpu: async () => {
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<unknown> }
      }
    ).gpu
    if (gpu === undefined) return false
    try {
      return (await gpu.requestAdapter()) !== null
    } catch {
      return false
    }
  },
})

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  void runtime.handleMessage(event.data)
})
