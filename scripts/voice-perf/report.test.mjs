import assert from 'node:assert/strict'
import test from 'node:test'
import { distribution, summarizeVoice } from './report.mjs'

test('nearest-rank percentiles retain zero and reject missing/nonfinite/negative values', () => {
  assert.deepEqual(distribution([null, undefined, NaN, -1, 0, 1, 5, 9]), { n: 4, p50: 1, p95: 9, max: 9 })
  assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, max: null })
})
test('missing evidence never passes and physical gates never inherit software proxies', () => {
  const report = summarizeVoice({ retrieval: { samplesMs: [1, 2], coldConnection: { samplesMs: [3] } },
    capture: { rows: [{ phase: 'warm', speechToRenderedFeedbackMs: 500, timings: { speechToFirstFeedbackMs: 450 } }] }, playback: { trials: [] } })
  assert.equal(report.rows.find(r => r.metric === 'Acoustic end to shipping UI feedback').status, 'UNMEASURED')
  assert.equal(report.rows.find(r => r.metric === 'Detector frame to benchmark DOM feedback' && r.phase === 'warm').status, 'PASS')
  assert.equal(report.rows.find(r => r.metric === 'Physical hotkey/button to silence').status, 'UNMEASURED')
  assert.equal(report.rows.find(r => r.metric === 'Memory retrieval' && r.phase === 'warm').status, 'PASS')
})
test('failed playback and invalid stop observations do not count toward percentiles', () => {
  const trials = [
    { provider: 'grok', phase: 'screen', ok: true, onsetMs: 100, stopValid: false, stopMs: 0, timestampErrors: 0, discontinuities: 0, clockUncertaintyMs: 1 },
    { provider: 'grok', phase: 'screen', ok: false, onsetMs: 1, stopValid: true, stopMs: 1 },
    { provider: 'grok', phase: 'screen', ok: true, onsetMs: 600, stopValid: true, stopMs: 70, timestampErrors: 0, discontinuities: 0, clockUncertaintyMs: 1 },
  ]
  const rows = summarizeVoice({ playback: { trials } }).rows
  assert.equal(rows.find(r => r.metric === 'Grok playback interrupt to loopback silence' && r.phase === 'warm').n, 1)
  assert.equal(rows.find(r => r.metric === 'Grok request to first loopback audio' && r.phase === 'warm').p95, 600)
})

test('fresh cold/warm speech replaces historical playback and includes input-to-silence gates', () => {
  const trial = { provider: 'grok', ok: true, stopValid: true, stopMs: 70, inputToSilenceMs: 71, timestampErrors: 0, discontinuities: 0, clockUncertaintyMs: .3 }
  const rows = summarizeVoice({ playback: { trials: [{ ...trial, phase: 'screen', onsetMs: 9999 }] },
    speech: { trials: [{ ...trial, phase: 'cold', onsetMs: 1200 }, { ...trial, phase: 'warm', onsetMs: 800 }] } }).rows
  assert.equal(rows.find(r => r.metric === 'Grok request to first loopback audio' && r.phase === 'cold').p95, 1200)
  assert.equal(rows.find(r => r.metric === 'Grok request to first loopback audio' && r.phase === 'warm').p95, 800)
  assert.equal(rows.find(r => r.metric === 'Grok injected Stop button input to loopback silence' && r.phase === 'warm').status, 'PASS')
})
