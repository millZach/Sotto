import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizePackets } from './loopback.mjs'

test('sample boundaries preserve a rendered tail after stop and observed silence', () => {
  const summary = summarizePackets([
    { qpcMs: 100, frames: 480, flags: 0, firstFrame: 24, lastFrame: 479, peak: 200 },
    { qpcMs: 110, frames: 480, flags: 0, firstFrame: 0, lastFrame: 239, peak: 200 },
    { qpcMs: 120, frames: 480, flags: 2, firstFrame: -1, lastFrame: -1, peak: 0 },
    { qpcMs: 1000, frames: 480, flags: 0, firstFrame: 0, lastFrame: 479, peak: 1000 },
  ], 99, 130)
  assert.equal(summary.firstOutputQpcMs, 100.5)
  assert.equal(summary.lastOutputQpcMs, 115)
  assert.equal(summary.observationEndQpcMs, 130)
  assert.equal(summary.packetCount, 3)
})

test('invalid timestamps remain visible and cannot supply output timing', () => {
  const summary = summarizePackets([
    { qpcMs: 100, frames: 480, flags: 4, firstFrame: 0, lastFrame: 479, peak: 200 },
    { qpcMs: 110, frames: 480, flags: 1, firstFrame: 0, lastFrame: 239, peak: 200 },
  ], 99, 130)
  assert.equal(summary.firstOutputQpcMs, 110)
  assert.equal(summary.timestampErrors, 1)
  assert.equal(summary.discontinuities, 1)
})
