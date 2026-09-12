/* global process, console */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { summarizeVoice, markdown } from './report.mjs'
const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name} value`); return resolve(args[i + 1]) }
if (args.includes('--report-only') && !args.includes('--output')) throw new Error('--report-only requires --output pointing to an existing completed capture')
const output = option('--output', join(root, 'artifacts/voice-perf', new Date().toISOString().replace(/[:.]/g, '-')))
mkdirSync(output, { recursive: true })
function run(executable, arguments_, env = process.env, acceptedStatuses = [0]) {
  const result = spawnSync(executable, arguments_, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (!acceptedStatuses.includes(result.status)) throw new Error(`Measurement step failed (${result.status ?? result.error?.code}); no completed report written`)
}
if (!args.includes('--report-only')) {
  if (process.platform !== 'win32') throw new Error('Fresh voice measurement currently requires Windows; report replay works on other platforms')
  if (['capture.json', 'retrieval.json', 'report.json'].some(file => existsSync(join(output, file)))) throw new Error('Choose an empty --output directory for a fresh measurement')
  const require = createRequire(import.meta.url)
  run(require('electron'), [join(root, 'scripts/memeval/bench-retrieval.mjs'), join(output, 'retrieval.json')], { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, [0, 1])
  // A failed budget is reportable; a crashed retrieval step has no valid evidence.
  const retrievalEvidence = JSON.parse(readFileSync(join(output, 'retrieval.json'), 'utf8'))
  if (!Array.isArray(retrievalEvidence.samplesMs) || !retrievalEvidence.samplesMs.length) throw new Error('Retrieval measurement produced no samples')
  run(process.execPath, [join(root, 'scripts/voice-perf/build.mjs')])
  run(process.execPath, [join(root, 'scripts/voice-perf/capture.mjs'), output])
}
const playbackPath = option('--playback', join(root, 'docs/perf/data/2026-09-11-tts-playback.json'))
const retrieval = JSON.parse(readFileSync(join(output, 'retrieval.json'), 'utf8'))
const capture = JSON.parse(readFileSync(join(output, 'capture.json'), 'utf8'))
const playback = JSON.parse(readFileSync(playbackPath, 'utf8'))
const turnPath = option('--turns', null)
// Do not echo input records, paths, transcripts, errors, IDs or credentials.
const turns = turnPath ? readFileSync(turnPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { const value = JSON.parse(line); return { source: value.source, timings: value.timings } }) : []
const provenance = { generatedAt: new Date().toISOString(), retrievalEnvironment: retrieval.environment, captureGeneratedAt: capture.generatedAt,
  captureFixtureSha256: capture.fixtureSha256, historicalPlaybackRun: playback.run,
  historicalPlaybackSha256: createHash('sha256').update(readFileSync(playbackPath)).digest('hex'),
  transcription: 'microsoft/mai-transcribe-2 via OpenRouter; fixture dictionary empty', speech: 'Grok default / Kokoro economical',
  command: 'npm run perf:voice (15 at-most-5s uploads, each at most one retry; at most 150 billed audio seconds, about $0.005 at recorded MAI rate)',
}
const report = summarizeVoice({ retrieval, capture, playback, turns })
writeFileSync(join(output, 'report.json'), JSON.stringify({ provenance, ...report }, null, 2) + '\n')
writeFileSync(join(output, 'report.md'), markdown(report, provenance))
console.log(`Voice report: ${join(output, 'report.md')}`)
// Measurement failures throw; failed/unmeasured product budgets remain explicit report outcomes.
