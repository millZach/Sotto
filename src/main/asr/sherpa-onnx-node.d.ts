// The part of sherpa-onnx-node (Apache-2.0) that Sotto calls, typed from the package's own JSDoc
// (`non-streaming-asr.js`, `types.js`). The package ships no declarations. It is CommonJS, and
// import() names only the exports Node can find by reading it (OnlineRecognizer, not
// OfflineRecognizer), so callers read the default export, which is the whole module.exports.
declare module 'sherpa-onnx-node' {
  export interface OfflineRecognizerConfig {
    readonly featConfig: { readonly sampleRate: number; readonly featureDim: number }
    readonly modelConfig: {
      readonly transducer: { readonly encoder: string; readonly decoder: string; readonly joiner: string }
      readonly tokens: string
      readonly modelType: 'nemo_transducer'
      readonly numThreads: number
      readonly provider: 'cpu'
      readonly debug: 0 | 1
    }
    readonly decodingMethod?: 'greedy_search'
  }

  export interface OfflineStream {
    acceptWaveform(wave: { readonly sampleRate: number; readonly samples: Float32Array }): void
  }

  export interface OfflineRecognizerResult {
    readonly text?: string
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
  }

  const sherpa: { readonly OfflineRecognizer: typeof OfflineRecognizer }
  export default sherpa
}
