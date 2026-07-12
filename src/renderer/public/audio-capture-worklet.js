/* global AudioWorkletProcessor, registerProcessor */

class TalkTypeAudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      const copy = new Float32Array(channel)
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}

registerProcessor('talktype-audio-capture', TalkTypeAudioCaptureProcessor)
