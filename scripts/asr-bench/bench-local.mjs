// Local baseline for the ASR benchmark: scores the four on-device tiers Sotto
// ships (Moonshine + the Whisper sizes) on the same clips and the same WER
// metric as bench-asr.mjs, so the hosted and local numbers are comparable.
//
// Delegates the actual inference to scripts/perf-bench/bench-inference.mjs,
// which replicates the app's worker stack (transformers.js web build, ORT WASM,
// q8 weights, 4 threads) rather than approximating it.
//
// Usage:
//   node scripts/asr-bench/bench-local.mjs
//   node scripts/asr-bench/bench-local.mjs --runs 5 --tiers instant,accurate

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { mean, median } from './stats.mjs'
import { wer, missedWords } from './wer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')

// Where each preset's weights actually live: the bundled tier ships in the
// repo, the rest are downloaded into the app's userData dir.
const USER_MODELS = join(homedir(), 'AppData', 'Roaming', 'Sotto', 'models')
const TIERS = [
  { tier: 'instant', model: 'onnx-community/moonshine-base-ONNX', dir: USER_MODELS },
  { tier: 'fast', model: 'Xenova/whisper-tiny', dir: USER_MODELS },
  { tier: 'balanced', model: 'Xenova/whisper-base', dir: join(ROOT, 'resources', 'models') },
  { tier: 'accurate', model: 'Xenova/whisper-small', dir: USER_MODELS },
]

function parseArgs(argv) {
  const args = { runs: 3, tiers: null }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      case '--tiers': args.tiers = val.split(','); if (!inlineVal) i++; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

const args = parseArgs(process.argv)
const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))
const clips = Object.keys(truth)
const tiers = TIERS.filter((t) => !args.tiers || args.tiers.includes(t.tier))

const rows = []
for (const { tier, model, dir } of tiers) {
  console.log(`[local] ${tier} (${model})...`)
  const stdout = execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'perf-bench', 'bench-inference.mjs'),
    '--model', model,
    '--models-dir', dir,
    '--fixtures-dir', FIXTURE_DIR,
    '--clip', clips.join(','),
    '--runs', String(args.runs),
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  // The harness logs progress lines before the JSON blob; take the last object.
  const json = JSON.parse(stdout.slice(stdout.indexOf('{\n  "info"')))
  const perClip = clips.map((clip) => {
    const c = json.clips[clip]
    const w = wer(truth[clip], c.text)
    // Steady state: the first transcribe pays one-off allocation and cache
    // warming, which a user only meets once per session. docs/perf/2026-07-20
    // reports run-2+ numbers, so this stays comparable to it.
    const steady = c.timings.length > 1 ? c.timings.slice(1) : c.timings
    return {
      clip,
      wer: w.wer,
      ms: median(steady),
      firstRunMs: c.timings[0],
      text: c.text,
      audioSeconds: c.audioSeconds,
      missed: missedWords(truth[clip], c.text),
    }
  })
  const row = {
    tier,
    model,
    loadMs: Math.round(json.loadMs),
    meanWer: mean(perClip.map((c) => c.wer)),
    medianMs: median(perClip.map((c) => c.ms)),
    perClip,
  }
  rows.push(row)
  console.log(`  mean WER ${(row.meanWer * 100).toFixed(1)}%, median ${Math.round(row.medianMs)}ms, load ${row.loadMs}ms`)
}

mkdirSync(RESULTS_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(RESULTS_DIR, `local-${stamp}.json`), JSON.stringify({ rows, truth }, null, 2))
console.log(`\nwrote ${join(RESULTS_DIR, `local-${stamp}.json`)}`)
console.table(rows.map((r) => ({
  tier: r.tier,
  wer: (r.meanWer * 100).toFixed(1) + '%',
  median: Math.round(r.medianMs) + ' ms',
  load: r.loadMs + ' ms',
})))
