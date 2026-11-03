/* global AudioWorkletProcessor, registerProcessor */

class SottoAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.stopped = false
    this.port.onmessage = ({ data }) => {
      if (data !== 'stop') return
      this.stopped = true
      this.port.onmessage = null
      this.port.close()
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const channels = inputs[0]
    if (channels?.length) {
      let frameCount = 0
      for (const channel of channels) frameCount = Math.max(frameCount, channel?.length ?? 0)
      if (frameCount === 0) return true

      const mono = new Float32Array(frameCount)
      for (let frame = 0; frame < frameCount; frame += 1) {
        let sum = 0
        let availableChannels = 0
        for (const channel of channels) {
          if (!channel || frame >= channel.length) continue
          const sample = channel[frame]
          sum += Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
          availableChannels += 1
        }
        mono[frame] = availableChannels === 0 ? 0 : sum / availableChannels
      }
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}

registerProcessor('sotto-audio-capture', SottoAudioCaptureProcessor)
