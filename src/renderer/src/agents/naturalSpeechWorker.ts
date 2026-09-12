/// <reference lib="webworker" />
import { env, pipeline, type TextToAudioPipeline } from '@huggingface/transformers'
import { configureLocalInferenceEnvironment, LOCAL_MODEL_ROOT } from './inferenceEnvironment'
import { NATURAL_VOICES } from '../../../shared/agents'
import { encodeSpeechWave, splitSpeechText } from './speechAudio'

configureLocalInferenceEnvironment(env, navigator.hardwareConcurrency)
const repository = 'onnx-community/Supertonic-TTS-ONNX'
const scope = self as DedicatedWorkerGlobalScope
let synthesizer: Promise<TextToAudioPipeline> | undefined
let tail: Promise<void> = Promise.resolve()
scope.onmessage = (event: MessageEvent<{ id: number; text: string; voice: string }>) => {
  const request = event.data
  tail = tail.then(async () => {
    try {
      if (!Number.isSafeInteger(request.id) || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 2_000 || !NATURAL_VOICES.some(voice => voice === request.voice)) throw new Error('Invalid speech request.')
      synthesizer ??= pipeline('text-to-speech', repository, { dtype: 'fp32', device: 'wasm' }) as Promise<TextToAudioPipeline>
      const engine = await synthesizer
      const parts: Float32Array[] = []
      let samples = 0
      for (const text of splitSpeechText(request.text)) {
        const result = await engine(text, { speaker_embeddings: `${LOCAL_MODEL_ROOT}${repository}/voices/${request.voice}.bin`, num_inference_steps: 8, speed: 1.05 })
        const part = result.audio
        if (!(part instanceof Float32Array) || result.sampling_rate !== 44_100 || part.length === 0 || part.some(sample => !Number.isFinite(sample))) throw new Error('The natural voice returned invalid audio.')
        samples += part.length
        if (samples > 44_100 * 120) throw new Error('The spoken reply is too long. Read it in the thread.')
        parts.push(part)
      }
      const audio = encodeSpeechWave(parts, 44_100)
      scope.postMessage({ id: request.id, audio }, [audio])
    } catch {
      synthesizer = undefined
      scope.postMessage({ id: request.id, error: 'Natural speech could not be generated. Check the voice download and preview it again.' })
    }
  }).catch(() => undefined)
}
