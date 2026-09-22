/* global window, performance, Audio, setTimeout, clearTimeout */
import { NaturalSpeechSynthesizer } from '../../src/renderer/src/agents/naturalSpeech'
import { NativeSystemSpeech } from '../../src/renderer/src/agents/voiceSpeech'

const bridge = window.bench
let local = new NaturalSpeechSynthesizer(() => bridge.status())
const BrowserAudio = Audio
let trial, player, stopTimer
window.playbackStarts = []
window.synthesisEvents = []
// Observe the real HTMLAudioElement without substituting its playback methods.
window.Audio = function (url) {
  const audio = new BrowserAudio(url)
  window.playbackStarts.push({ fixtureId: trial.fixtureId, timeMs: performance.now() })
  player = audio
  audio.addEventListener('playing', () => {
    if (trial.playingMs !== undefined) return
    trial.playingMs = performance.now()
    if (trial.stopAfterMs !== null) stopTimer = setTimeout(() => {
      trial.stopMs = performance.now()
      trial.mediaTimeAtStop = audio.currentTime
      output.stop()
      trial.stopReturnedMs = performance.now()
    }, trial.stopAfterMs)
  })
  return audio
}
const output = new NativeSystemSpeech(async text => {
  const owner = trial
  let result
  try {
    result = owner.provider === 'supertonic'
      ? await local.synthesize(text, 'F1')
      : await bridge.synthesize(owner.provider, text, owner.fixtureId)
  } finally { window.synthesisEvents.push({ fixtureId: owner.fixtureId, timeMs: performance.now() }) }
  owner.wavReadyMs = performance.now()
  // Save after playback starts so disk I/O is not inside request-to-output latency.
  owner.audio = result
  return result
}, () => { local.cancel(); void bridge.cancel() })

window.runPlaybackTrial = async options => {
  clearTimeout(stopTimer)
  if (options.cold) { local.dispose(); local = new NaturalSpeechSynthesizer(() => bridge.status()) }
  const owner = trial = { ...options, requestMs: performance.now() }
  try { await output.speak(options.text); owner.ok = true }
  catch (error) { owner.ok = false; owner.error = error.message }
  owner.settledMs = performance.now()
  clearTimeout(stopTimer)
  if (player) owner.pausedAfter = player.paused
  // The natural voice resolves with the worker's ArrayBuffer, which page.evaluate cannot
  // return. Encode it here, after playback, so the cost stays out of the measured latency.
  if (owner.audio && 'audio' in owner.audio) owner.audio = { audioBase64: toBase64(owner.audio.audio), mimeType: owner.audio.mimeType }
  return owner
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return window.btoa(binary)
}
window.stopPlayback = () => { const stopMs = performance.now(); output.stop(); return stopMs }
window.benchmarkReady = true
