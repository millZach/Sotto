/* global console, process, window, setTimeout */
import { _electron as electron } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { startLoopback, qpcMs } from './loopback.mjs'
const root = resolve(import.meta.dirname, '../..')
const dir = join(root, 'artifacts/tts-bench', `${new Date().toISOString().replace(/[:.]/g, '-')}-cancellation`)
mkdirSync(dir, { recursive: true })
const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures.json'), 'utf8'))
const first = fixtures.find(f => f.id === 'summary-02'), replacement = fixtures.find(f => f.id === 'status-01')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [join(import.meta.dirname, 'playback-main.cjs')], env })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let capture
const results = []
try {
  const page = await app.firstWindow(); await page.waitForFunction(() => window.benchmarkReady)
  capture = await startLoopback(await app.evaluate(() => process.pid))
  for (const provider of ['supertonic', 'grok', 'kokoro']) for (const replace of [false, true]) {
    const packetIndex = capture.packets.length, start = qpcMs()
    await page.evaluate(options => {
      window.playbackStarts = []; window.synthesisEvents = []
      window.pendingTrial = window.runPlaybackTrial(options)
    }, { provider, fixtureId: first.id, text: first.text, cold: true, stopAfterMs: null })
    await delay(100)
    const beforeStop = capture.summarize(start)
    await page.evaluate(() => window.stopPlayback())
    const cancelled = await page.evaluate(() => window.pendingTrial)
    assert.equal(cancelled.audio, undefined, 'Pre-onset cancellation must occur before synthesis completes')
    assert.equal(beforeStop.firstOutputQpcMs, null, 'No rendered output before early stop')
    if (replace) {
      const next = await page.evaluate(options => window.runPlaybackTrial(options), { provider, fixtureId: replacement.id, text: replacement.text, cold: false, stopAfterMs: 600 })
      assert.equal(next.ok, true, 'Replacement must synthesize and play')
    }
    await page.waitForFunction(count => window.synthesisEvents.length === count, replace ? 2 : 1, { timeout: 10000 })
    await delay(1200)
    const starts = await page.evaluate(() => window.playbackStarts)
    assert.equal(starts.length, replace ? 1 : 0, 'Stopped request must never create a late audio player')
    if (replace) assert.equal(starts[0].fixtureId, replacement.id)
    const signal = capture.summarize(start)
    if (replace) {
      assert.notEqual(signal.firstOutputQpcMs, null)
      assert.ok(signal.observationEndQpcMs - signal.lastOutputQpcMs > 300)
    } else assert.equal(signal.firstOutputQpcMs, null, 'No late rendered speech after cancellation')
    assert.equal(signal.timestampErrors, 0)
    const row = { provider, replace, passed: true, signal, playerStarts: starts, packets: capture.packets.slice(packetIndex) }
    results.push(row)
    writeFileSync(join(dir, 'results.json'), JSON.stringify({ results, reservedUsd: await app.evaluate(({ app }) => app.benchReservedUsd || 0) }, null, 2))
    console.log(JSON.stringify({ provider, replace, passed: true }))
  }
  console.log(JSON.stringify({ output: dir, passed: results.length }))
} finally { await capture?.stop(); await app.close() }
