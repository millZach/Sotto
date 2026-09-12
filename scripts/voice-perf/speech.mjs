/* global process, window, console, performance, Buffer, setTimeout */
import { _electron as electron } from 'playwright'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { cpus, release, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { startLoopback, qpcMs } from '../tts-bench/loopback.mjs'
import { measureSpeechTrial } from './speechMetrics.mjs'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2] || join(root, 'artifacts/voice-perf', new Date().toISOString().replace(/[:.]/g, '-')))
mkdirSync(join(output, 'speech-audio'), { recursive: true })
const fixture = JSON.parse(readFileSync(join(root, 'scripts/tts-bench/fixtures.json'), 'utf8')).find(item => item.id === 'status-01')
const env = { ...process.env, SOTTO_VOICE_PERF_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE
const rows = [], captures = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
for (const provider of ['grok', 'kokoro']) for (let processTrial = 1; processTrial <= 3; processTrial++) {
  const app = await electron.launch({ args: [join(root, 'artifacts/voice-perf/build/speech-main.cjs')], env })
  let isolated, capture
  try {
    isolated = await app.evaluate(({ app }) => app.getPath('userData'))
    const page = await app.firstWindow()
    await page.waitForFunction(() => window.speechPerfReady)
    capture = await startLoopback(await app.evaluate(() => process.pid))
    captures.push({ provider, processTrial, ...capture.metadata })
    for (let repeat = 1; repeat <= 4; repeat++) {
      const probes = []
      for (let index = 0; index < 12; index++) {
        const before = qpcMs(), renderer = await page.evaluate(() => performance.now()), after = qpcMs()
        probes.push({ offsetMs: (before + after) / 2 - renderer, uncertaintyMs: (after - before) / 2 })
      }
      const clock = probes.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]
      const packetStart = capture.packets.length
      await page.evaluate(options => window.beginSpeechTrial(options), { provider, text: fixture.text })
      await page.waitForFunction(() => window.speechTrial().playingMs !== undefined || window.speechTrial().settledMs !== undefined, null, { timeout: 65_000 })
      await delay(600)
      const bounds = await page.locator('#stop').boundingBox()
      if (!bounds) throw new Error('Benchmark Stop speech button has no layout')
      const inputQpcMs = await app.evaluate(({ BrowserWindow }, point) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        const started = Number(process.hrtime.bigint()) / 1e6
        contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        return started
      }, { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) })
      await page.waitForFunction(() => window.speechTrial().settledMs !== undefined)
      await delay(400)
      const result = await page.evaluate(() => window.finishSpeechTrial())
      const { audio, ...timings } = result
      delete timings.text
      if (!result.ok || !audio) throw new Error('Production speech failed; no timing is counted')
      const bytes = Buffer.from(audio.audioBase64, 'base64')
      const packets = capture.packets.slice(packetStart)
      const measured = measureSpeechTrial(result, packets, clock, inputQpcMs, qpcMs(), bytes)
      const stem = `${provider}-process-${processTrial}-trial-${repeat}`
      writeFileSync(join(output, 'speech-audio', `${stem}.wav`), bytes)
      appendFileSync(join(output, 'speech-packets.jsonl'), JSON.stringify({ trial: stem, packets }) + '\n')
      const row = { provider, processTrial, repeat, phase: repeat === 1 ? 'cold' : 'warm', fixture: fixture.id,
        ...timings, ...measured, clock, inputQpcMs, audioSha256: createHash('sha256').update(bytes).digest('hex') }
      rows.push(row)
      appendFileSync(join(output, 'speech-trials.jsonl'), JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ provider, processTrial, repeat, phase: row.phase, onsetMs: row.onsetMs, inputToSilenceMs: row.inputToSilenceMs, stopMs: row.stopMs, stopValid: row.stopValid }))
      if (!row.ok || !row.timingValid || row.onsetMs === null) throw new Error('Speech trial failed or output timing is invalid; inspect retained evidence')
    }
  } finally {
    try { await capture?.stop() } finally { await app.close() }
    if (isolated && dirname(resolve(isolated)) === resolve(tmpdir()) && basename(isolated).startsWith('sotto-voice-perf-')) rmSync(isolated, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
const sources = ['src/main/agents/grokSpeech.ts', 'src/main/agents/kokoroSpeech.ts', 'src/renderer/src/agents/voiceSpeech.ts', 'src/renderer/src/agents/voiceSession.ts', 'scripts/tts-bench/loopback.cpp']
const sourceHash = createHash('sha256')
for (const source of sources) sourceHash.update(source).update(readFileSync(join(root, source)))
writeFileSync(join(output, 'speech.json'), JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, os: release(), cpu: cpus()[0]?.model,
  sourceSha256: sourceHash.digest('hex'), sources, fixtures: [fixture], captures,
  method: 'Production Grok/Kokoro services, NativeSystemSpeech player and AgentVoiceSession stop. Electron mouse input dispatched to a benchmark Stop speech button; trusted renderer click runs the production immediate stop path. Process-tree WASAPI output observes actual audio and >=300ms silence. No microphone, physical input switch, speaker acoustics or unrelated process audio.',
  cold: 'First speech request/playback in each of three fresh Electron processes per provider; no claim about remote model residency or Windows cache flush',
  warm: 'Three further requests in the same process per provider',
  reservedUsd: 12 * Buffer.byteLength(fixture.text, 'utf8') * (15 + 4) / 1e6,
  trials: rows,
}, null, 2) + '\n')
console.log(`Speech evidence: ${join(output, 'speech.json')}`)
