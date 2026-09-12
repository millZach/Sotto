import { Buffer } from 'node:buffer'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pcmWave, waveInfo, pcmFormat, percentile, normalizeWave } from './bench.mjs'

test('PCM rates come from response metadata; unknown/endian-ambiguous audio is rejected', () => {
  assert.deepEqual(pcmFormat('audio/pcm;rate=44100;channels=1'),{rate:44100,channels:1})
  assert.equal(pcmFormat('audio/pcm'),null)
  assert.equal(pcmFormat('audio/L16;rate=24000'),null)
  assert.equal(pcmFormat('application/json'),null)
})
test('WAV wrapping preserves PCM and measures signal after leading silence', () => {
  const pcm=Buffer.alloc(4800)
  pcm.writeInt16LE(1000,480)
  const wav=pcmWave(pcm,24000)
  assert.deepEqual(wav.subarray(44),pcm)
  const info=waveInfo(wav)
  assert.equal(info.durationMs,100)
  assert.equal(info.leadingSignalMs,10)
  assert.equal(info.firstSignalByte,526)
  assert.equal(info.peak,1000)
})
test('silent audio cannot supply a signal timing, malformed PCM is rejected', () => {
  assert.equal(waveInfo(pcmWave(Buffer.alloc(480),24000)).firstSignalByte,null)
  assert.throws(()=>pcmWave(Buffer.alloc(3),24000))
  assert.throws(()=>waveInfo(Buffer.alloc(44)))
})
test('nearest-rank percentile keeps tail values and leaves empty sets unknown', () => {
  assert.equal(percentile([], .95),null)
  assert.equal(percentile([100,200,300,400],.5),200)
  assert.equal(percentile([100,200,300,400],.95),400)
})
test('streaming WAV size sentinels become finite listening containers without changing PCM', () => {
  const pcm=Buffer.alloc(4800);pcm.writeInt16LE(1000,480)
  const wav=pcmWave(pcm,24000)
  wav.writeUInt32LE(0x7fffffff,4);wav.writeUInt32LE(0x7fffffff,40)
  const fixed=normalizeWave(wav)
  assert.equal(fixed.readUInt32LE(4),fixed.length-8)
  assert.equal(fixed.readUInt32LE(40),pcm.length)
  assert.deepEqual(fixed.subarray(44),pcm)
  assert.equal(waveInfo(fixed).durationMs,100)
})
