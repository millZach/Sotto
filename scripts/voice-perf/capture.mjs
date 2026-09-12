/* global process, window, console */
import { _electron as electron } from 'playwright'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { cpus, release, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2] || join(root, 'artifacts/voice-perf/latest'))
mkdirSync(output, { recursive: true })
const turns = join(output, 'turns.jsonl')
writeFileSync(turns, '')
const rows = []
const env = { ...process.env, SOTTO_VOICE_PERF_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE
for (let processTrial = 1; processTrial <= 3; processTrial++) {
  const app = await electron.launch({ args: [join(root, 'artifacts/voice-perf/build/main.cjs')], env })
  let isolated
  try {
    isolated = await app.evaluate(({ app }) => app.getPath('userData'))
    const page = await app.firstWindow()
    await page.waitForFunction(() => window.voicePerfReady)
    for (let repeat = 1; repeat <= 5; repeat++) {
      const sample = await page.evaluate(() => window.runVoiceTrial())
      appendFileSync(turns, JSON.stringify(sample.record) + '\n')
      rows.push({ processTrial, repeat, phase: sample.record.timings.voicePhase, timings: sample.record.timings,
        speechToRenderedFeedbackMs: sample.renderedAt - Date.parse(sample.record.timings.speechEndedAt) })
      console.log(JSON.stringify({ processTrial, repeat, phase: rows.at(-1).phase, feedbackMs: rows.at(-1).speechToRenderedFeedbackMs }))
    }
  } finally {
    await app.close()
    if (isolated && dirname(resolve(isolated)) === resolve(tmpdir()) && basename(isolated).startsWith('sotto-voice-perf-')) {
      rmSync(isolated, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
}
const productionSources = ['src/renderer/public/audio-capture-worklet.js', 'src/renderer/src/agents/voiceCapture.ts', 'src/renderer/src/agents/voiceSession.ts', 'src/renderer/src/transcription/openRouterTranscriber.ts', 'src/main/asr/openRouterTranscriptionService.ts', 'src/main/agents/control.ts', 'src/main/agents/turns.ts', 'src/shared/agents.ts']
const sourceHash = createHash('sha256')
for (const file of productionSources) sourceHash.update(file).update(readFileSync(join(root, file)))
writeFileSync(join(output, 'capture.json'), JSON.stringify({ productionSources, productionSourceSha256: sourceHash.digest('hex'), generatedAt: new Date().toISOString(), cpu: cpus()[0]?.model, os: release(), platform: process.platform,
  fixtureSha256: createHash('sha256').update(readFileSync(join(root, 'scripts/asr-bench/fixtures/speech-tiny.wav'))).digest('hex'),
  method: 'Synthetic fixture played in real time through WebAudio MediaStream; production capture/worklet/session/MAI transcription/control/turn recorder. Fixture wake always activates; fake provider; no reasoning or delegation. Feedback is a benchmark DOM draft after two animation frames, not the shipping React UI. No physical microphone or speaker measurement.',
  cold: 'First MAI request in a new Electron process; Windows/network/provider caches not flushed', warm: 'Four subsequent requests in each process; capture reopened, HTTP process reused', rows }, null, 2) + '\n')
