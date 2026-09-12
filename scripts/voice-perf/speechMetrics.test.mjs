import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import test from 'node:test'
import { measureSpeechTrial } from './speechMetrics.mjs'

function wave(active = true) {
  const bytes = Buffer.alloc(44 + 16000 * 2 * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  if (active) for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(1000, i)
  return bytes
}
const result = { requestMs: 0, stopHandlerMs: 1001, stopReturnedMs: 1001.2, mediaTimeAtStop: .6, trustedClick: true, ok: true }
const clock = { offsetMs: 0, uncertaintyMs: .3 }
const packet = (qpcMs, active = true) => ({ qpcMs, frames: 480, firstFrame: active ? 0 : -1, lastFrame: active ? 479 : -1, flags: 0, peak: active ? .2 : 0 })
const packets = [packet(990), packet(1060), packet(1400, false)]

test('input and handler stop metrics end at last actual output, never method return', () => {
  const measured = measureSpeechTrial(result, packets, clock, 1000, 1420, wave())
  assert.equal(measured.stopValid, true)
  assert.equal(measured.inputToSilenceMs, 70)
  assert.equal(measured.stopMs, 69)
  assert.equal(measured.silenceObservedMs, 340)
})
test('missing silence packets, untrusted clicks, natural source pauses and bad clocks never prove stop', () => {
  assert.equal(measureSpeechTrial(result, packets.slice(0, 2), clock, 1000, 1420, wave()).stopValid, false)
  assert.equal(measureSpeechTrial({ ...result, trustedClick: false }, packets, clock, 1000, 1420, wave()).stopValid, false)
  assert.equal(measureSpeechTrial(result, packets, clock, 1000, 1420, wave(false)).stopValid, false)
  assert.equal(measureSpeechTrial(result, packets, { ...clock, uncertaintyMs: 3 }, 1000, 1420, wave()).stopValid, false)
  assert.equal(measureSpeechTrial(result, [{ ...packets[0], flags: 4 }, ...packets.slice(1)], clock, 1000, 1420, wave()).inputToSilenceMs, null)
})
