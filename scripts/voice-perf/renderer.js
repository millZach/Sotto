/* global window, document, AudioContext, navigator, requestAnimationFrame, setTimeout, clearTimeout */
import { AgentVoiceSession } from '../../src/renderer/src/agents/voiceSession'
const bridge = window.voicePerf
const sourceContext = new AudioContext()
const destination = sourceContext.createMediaStreamDestination()
const fixture = await sourceContext.decodeAudioData((await bridge.fixture()).buffer)
// The ONLY substituted audio boundary: a checked-in synthetic fixture replaces physical mic input.
// Production capture, real-time WebAudio/worklet, segmentation, resampling and upload are unchanged.
navigator.mediaDevices.getUserMedia = async () => destination.stream.clone()
let completion
const session = new AgentVoiceSession({
  transcriptionBridge: bridge,
  wakeDetector: { async load() {}, async detect() { return { detected: true, endSeconds: 0 } }, dispose() {} },
  getSettings: () => ({ microphoneId: null, language: 'en' }),
  onState: state => { if (state.error) completion?.reject(new Error('Voice pipeline failed: ' + state.error)) },
  onUtterance: async (text, voiceTiming) => {
    try {
      const result = await bridge.utterance({ type: 'utterance', text, voiceTiming })
      document.getElementById('feedback').textContent = result.draft
      requestAnimationFrame(() => requestAnimationFrame(() => completion?.resolve({ record: result.record, renderedAt: Date.now() })))
    } catch (error) { completion?.reject(error) }
  },
  conversationTimeoutMs: 0,
})
window.runVoiceTrial = async () => {
  await bridge.prepare()
  document.getElementById('feedback').textContent = ''
  await sourceContext.resume()
  await session.start()
  let timeout
  const source = sourceContext.createBufferSource()
  source.buffer = fixture
  source.connect(destination)
  try {
    return await new Promise((resolve, reject) => {
      completion = { resolve, reject }
      timeout = setTimeout(() => reject(new Error('Voice trial timed out')), 30_000)
      source.start()
    })
  } finally {
    clearTimeout(timeout)
    completion = null
    source.stop()
    source.disconnect()
    await session.stop()
  }
}
window.voicePerfReady = true
