/* global Buffer, process, console, performance, window, setTimeout */
import { _electron as electron } from 'playwright'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { cpus, release } from 'node:os'
import { createHash } from 'node:crypto'
import { startLoopback, qpcMs } from './loopback.mjs'
import { percentile, waveInfo } from './bench.mjs'

const root = resolve(import.meta.dirname, '../..')
const smoke = process.argv.includes('--smoke')
const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures.json'), 'utf8'))
const selected = smoke ? fixtures.filter(f => f.id === 'status-01') : fixtures
const output = join(root, 'artifacts/tts-bench', `${new Date().toISOString().replace(/[:.]/g, '-')}-playback${smoke ? '-smoke' : ''}`)
mkdirSync(join(output, 'audio'), { recursive: true })
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [join(import.meta.dirname, 'playback-main.cjs')], env })
let capture
const rows = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const round = n => n == null ? null : Math.round(n * 100) / 100
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.benchmarkReady)
  capture = await startLoopback(await app.evaluate(() => process.pid))
  // Chromium performance.now and QPC have different origins. Bound their offset
  // with the minimum of 12 round-trip pings, then retain per-trial calibration.
  async function clockSync() {
    const probes = []
    for (let i = 0; i < 12; i++) {
      const before = qpcMs(), renderer = await page.evaluate(() => performance.now()), after = qpcMs()
      probes.push({ offsetMs: (before + after) / 2 - renderer, uncertaintyMs: (after - before) / 2 })
    }
    return probes.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0]
  }
  const manifest = { startedAt: new Date().toISOString(), cpu: cpus()[0]?.model, os: release(), electron: await app.evaluate(() => process.versions.electron), model: JSON.parse(readFileSync(join(root, 'src/main/agents/speechModelManifest.json'), 'utf8')), fixtures, fixtureHash: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'), capture: capture.metadata, providers: ['supertonic:F1', 'grok:altair', 'kokoro:af_heart'], budgetUsd: 0.5, scope: 'Real production synthesizers and HTMLAudioElement player, isolated profile; process-tree Windows output loopback. No microphone or unrelated process audio.', stopPolicy: '600 ms after playing event, retain only trials with output active within 50ms before stop and at least 100ms of source speech remaining. Observe 400ms after stop.', cold: 'New Supertonic worker for three separate cold trials; warm screen reuses worker. Hosted process/network reuse, no claim about provider model residency.' }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const jobs = []
  for (let i = 0; i < (smoke ? 1 : 3); i++) jobs.push({ provider: 'supertonic', fixture: fixtures.find(f => f.id === 'status-01'), phase: 'cold', repeat: i + 1, cold: true })
  for (let repeat = 1; repeat <= (smoke ? 1 : 3); repeat++) for (let i = 0; i < selected.length; i++) for (let j = 0; j < 3; j++) jobs.push({ provider: ['supertonic', 'grok', 'kokoro'][(i + j + repeat - 1) % 3], fixture: selected[i], phase: 'screen', repeat, cold: false })
  console.log(JSON.stringify({ event: 'plan', output, trials: jobs.length, budgetUsd: 0.5 }))
  for (const job of jobs) {
    const clock = await clockSync()
    const packetStart = capture.packets.length
    const result = await page.evaluate(options => window.runPlaybackTrial(options), { provider: job.provider, text: job.fixture.text, fixtureId: job.fixture.id, stopAfterMs: 600, cold: job.cold })
    await delay(400)
    const { audio, ...timings } = result
    const requestQpc = result.requestMs + clock.offsetMs
    const stopQpc = result.stopMs === undefined ? null : result.stopMs + clock.offsetMs
    const packets = capture.packets.slice(packetStart)
    const signal = capture.summarize(requestQpc)
    const preStopActive = stopQpc !== null && packets.some(p => p.firstFrame >= 0 && p.qpcMs + p.firstFrame / 48 <= stopQpc && p.qpcMs + (p.lastFrame + 1) / 48 >= stopQpc - 50)
    const bytes = audio ? Buffer.from(audio.audioBase64, 'base64') : null
    const info = bytes ? waveInfo(bytes) : null
    const hasSpeechRemaining = info && result.mediaTimeAtStop !== undefined && info.durationMs > result.mediaTimeAtStop * 1000 + 100
    const silenceMs = stopQpc === null || signal.lastOutputQpcMs === null ? null : signal.observationEndQpcMs - Math.max(stopQpc, signal.lastOutputQpcMs)
    let sourceActiveFrames = 0
    if (bytes && info && result.mediaTimeAtStop !== undefined) {
      const first = Math.floor(result.mediaTimeAtStop * info.rate)
      for (let frame = first; frame < first + info.rate * .1 && frame < info.bytes / 2 / info.channels; frame++) {
        if (Math.abs(bytes.readInt16LE(info.offset + frame * info.channels * 2)) >= 33) sourceActiveFrames++
      }
    }
    const sourceContinues = Boolean(info && sourceActiveFrames >= info.rate * .01)
    const stopValid = Boolean(stopQpc !== null && preStopActive && hasSpeechRemaining && sourceContinues && signal.lastOutputQpcMs >= stopQpc && silenceMs >= 300 && signal.timestampErrors === 0 && signal.discontinuities === 0 && clock.uncertaintyMs < 2)
    const stem = `${String(rows.length + 1).padStart(3, '0')}-${job.provider}-${job.fixture.id}-r${job.repeat}`
    if (bytes) writeFileSync(join(output, 'audio', `${stem}.wav`), bytes)
    const row = { ...job, fixture: job.fixture.id, ...timings, clock, signal, preStopActive, sourceContinues, stopValid,
      firstOutputMs: signal.firstOutputQpcMs === null ? null : round(signal.firstOutputQpcMs - requestQpc),
      synthesisMs: round(result.wavReadyMs - result.requestMs),
      playingEventMs: round(result.playingMs - result.requestMs),
      stopToSilenceMs: stopValid ? round(signal.lastOutputQpcMs - stopQpc) : null,
      silenceObservedMs: stopQpc === null || signal.lastOutputQpcMs === null ? null : round(signal.observationEndQpcMs - Math.max(stopQpc, signal.lastOutputQpcMs)),
      audio: bytes ? `audio/${stem}.wav` : null, audioSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null, audioInfo: info }
    rows.push(row)
    appendFileSync(join(output, 'trials.jsonl'), JSON.stringify(row) + '\n')
    appendFileSync(join(output, 'packets.jsonl'), JSON.stringify({ trial: stem, packets }) + '\n')
    console.log(JSON.stringify({ completed: rows.length, total: jobs.length, provider: job.provider, fixture: job.fixture.id, ok: row.ok, firstOutputMs: row.firstOutputMs, stopToSilenceMs: row.stopToSilenceMs }))
    if (!row.ok || signal.timestampErrors || row.firstOutputMs === null) throw new Error('Trial failed or output timing unavailable; inspect local result')
  }
  const summaries = ['supertonic', 'grok', 'kokoro'].map(provider => {
    const trials = rows.filter(r => r.provider === provider && r.phase === 'screen')
    const starts = trials.filter(r => r.ok).map(r => r.firstOutputMs)
    const stops = trials.filter(r => r.stopValid).map(r => r.stopToSilenceMs)
    return { provider, trials: trials.length, failures: trials.filter(r => !r.ok).length, onsetP50Ms: percentile(starts, .5), onsetP95Ms: percentile(starts, .95), stopTrials: stops.length, stopP50Ms: percentile(stops, .5), stopP95Ms: percentile(stops, .95), minimumSilenceMs: Math.min(...trials.filter(r => r.stopValid).map(r => r.silenceObservedMs)) }
  })
  const reservedUsd = await app.evaluate(({ app }) => app.benchReservedUsd || 0)
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ summaries, cold: rows.filter(r => r.phase === 'cold'), reservedUsd, clockUncertaintyMaxMs: Math.max(...rows.map(r => r.clock.uncertaintyMs)) }, null, 2))
  console.log(JSON.stringify({ event: 'complete', output, summaries, reservedUsd }))
} finally { await capture?.stop(); await app.close() }
