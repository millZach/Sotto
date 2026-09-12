/* global window, Audio, document, performance */
import { NativeSystemSpeech } from '../../src/renderer/src/agents/voiceSpeech'
import { AgentVoiceSession } from '../../src/renderer/src/agents/voiceSession'
const bridge = window.voicePerfSpeech
const BrowserAudio = Audio
let trial, player
window.Audio = function (url) {
  const audio = new BrowserAudio(url)
  player = audio
  audio.addEventListener('playing', () => { trial.playingMs ??= performance.now() })
  return audio
}
const output = new NativeSystemSpeech(async text => {
  const result = await bridge.synthesize(trial.provider, text)
  trial.wavReadyMs = performance.now()
  trial.audio = result
  return result
}, () => { void bridge.cancel() })
const session = new AgentVoiceSession({
  speechOutput: output,
  getSettings: () => ({ microphoneId: null, language: 'en' }),
  onState: state => { if (state.error) trial.error = state.error },
  onUtterance: async () => {},
})
document.getElementById('stop').addEventListener('click', event => {
  trial.stopHandlerMs = performance.now()
  trial.trustedClick = event.isTrusted
  trial.mediaTimeAtStop = player?.currentTime
  // Same immediate local stop path used by AgentContext's Stop speech button.
  session.stopSpeaking()
  trial.stopReturnedMs = performance.now()
})
window.beginSpeechTrial = options => {
  trial = { ...options, requestMs: performance.now() }
  void session.speak(options.text).then(() => {
    trial.ok = !trial.error
    trial.settledMs = performance.now()
  })
}
window.speechTrial = () => ({ playingMs: trial?.playingMs, settledMs: trial?.settledMs })
window.finishSpeechTrial = () => trial
window.speechPerfReady = true
