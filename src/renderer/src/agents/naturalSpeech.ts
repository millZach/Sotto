/// <reference lib="dom" />
import type { AgentBridge, AgentConfiguration } from '../../../shared/agents'
import { NativeSystemSpeech } from './voiceSpeech'

export const NATURAL_SPEECH_REPOSITORY = 'onnx-community/Supertonic-TTS-ONNX'

/** One reusable local worker; neither reply text nor audio is sent to a provider. */
export class NaturalSpeechSynthesizer {
  private worker: Worker | null = null
  private nextId = 0
  private generation = 0
  private readonly pending = new Map<number, { resolve(value: { audioBase64: string; mimeType: 'audio/wav' }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly model: NonNullable<AgentBridge['voiceModel']>) {}

  async synthesize(text: string, voice: AgentConfiguration['speechVoice']): Promise<{ audioBase64: string; mimeType: 'audio/wav' }> {
    const generation = this.generation
    if (!(await this.model('status')).ready) throw new Error('Download the natural voice in Agent connection settings, then preview it.')
    if (generation !== this.generation) throw new Error('Speech was stopped.')
    if (this.worker === null) {
      this.worker = new Worker(new URL('./naturalSpeechWorker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<{ id: number; audio?: ArrayBuffer; error?: string }>) => {
        const message = event.data
        const request = this.pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(message.id)
        if (message.audio === undefined) request.reject(new Error(message.error ?? 'Natural speech could not be generated. Preview the voice and try again.'))
        else {
          const bytes = new Uint8Array(message.audio)
          let binary = ''
          for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384))
          request.resolve({ audioBase64: btoa(binary), mimeType: 'audio/wav' })
        }
      }
      this.worker.onerror = () => this.dispose('Natural speech stopped. Preview the voice to load it again.')
    }
    const worker = this.worker
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose('Natural speech took too long. Try a shorter reply or preview the voice again.'), 60_000)
      this.pending.set(id, { resolve, reject, timer })
      worker.postMessage({ id, text, voice })
    })
  }

  dispose(message = 'Natural speech stopped.'): void {
    ++this.generation
    this.worker?.terminate()
    this.worker = null
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
  }

  cancel(): void {
    ++this.generation
    if (this.pending.size) this.dispose('Speech was stopped.')
  }
}

export function createConfiguredSpeech(bridge: Pick<AgentBridge, 'voiceModel' | 'synthesizeSpeech'>, configuration: () => AgentConfiguration | undefined): { output: NativeSystemSpeech; dispose(): void } {
  const local = bridge.voiceModel ? new NaturalSpeechSynthesizer(bridge.voiceModel) : null
  const output = new NativeSystemSpeech(async text => {
    const selected = configuration()
    if (selected?.speechProvider === 'natural') {
      if (local === null) throw new Error('Natural speech is unavailable in this build. Reopen the updated app.')
      return local.synthesize(text, selected.speechVoice)
    }
    if (!bridge.synthesizeSpeech) throw new Error('System speech is unavailable in this build.')
    return bridge.synthesizeSpeech(text)
  }, () => local?.cancel())
  return { output, dispose() { output.stop(); local?.dispose() } }
}
