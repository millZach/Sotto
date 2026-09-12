import { summarizePackets } from '../tts-bench/loopback.mjs'
import { waveInfo } from '../tts-bench/bench.mjs'

/** Validate a stopped, actively speaking source against actual Windows output and its silence tail. */
export function measureSpeechTrial(result, packets, clock, inputQpcMs, observationEndMs, bytes) {
  const requestQpcMs = result.requestMs + clock.offsetMs
  const handlerQpcMs = result.stopHandlerMs + clock.offsetMs
  const signal = summarizePackets(packets, requestQpcMs, observationEndMs)
  const info = waveInfo(bytes)
  const preStopActive = packets.some(packet => packet.firstFrame >= 0 && packet.qpcMs + packet.firstFrame / 48 <= inputQpcMs && packet.qpcMs + (packet.lastFrame + 1) / 48 >= inputQpcMs - 50)
  const hasSpeechRemaining = info.durationMs > result.mediaTimeAtStop * 1000 + 100
  let activeFrames = 0
  const first = Math.floor(result.mediaTimeAtStop * info.rate)
  for (let frame = first; frame < first + info.rate * .1 && frame < info.bytes / 2 / info.channels; frame++) {
    if (Math.abs(bytes.readInt16LE(info.offset + frame * info.channels * 2)) >= 33) activeFrames++
  }
  const sourceContinues = activeFrames >= info.rate * .01
  const silenceMs = signal.lastOutputQpcMs === null || signal.observationEndQpcMs === null ? null : signal.observationEndQpcMs - Math.max(inputQpcMs, signal.lastOutputQpcMs)
  const timingValid = signal.timestampErrors === 0 && signal.discontinuities === 0 && clock.uncertaintyMs < 2
  const stopValid = Boolean(result.ok && result.trustedClick && preStopActive && hasSpeechRemaining && sourceContinues &&
    signal.lastOutputQpcMs >= handlerQpcMs && silenceMs >= 300 && timingValid)
  return { signal, timingValid, preStopActive, hasSpeechRemaining, sourceContinues, stopValid, silenceObservedMs: silenceMs,
    onsetMs: timingValid && signal.firstOutputQpcMs !== null ? signal.firstOutputQpcMs - requestQpcMs : null,
    inputToSilenceMs: stopValid ? signal.lastOutputQpcMs - inputQpcMs : null,
    stopMs: stopValid ? signal.lastOutputQpcMs - handlerQpcMs : null,
    inputToHandlerMs: handlerQpcMs - inputQpcMs, clockUncertaintyMs: clock.uncertaintyMs,
    timestampErrors: signal.timestampErrors, discontinuities: signal.discontinuities,
  }
}
