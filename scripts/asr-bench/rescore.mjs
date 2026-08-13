// Recomputes WER for an existing benchmark result using the current wer.mjs.
//
// The transcripts are the expensive part; the metric is not. When scoring
// changes (compound-word handling, number normalization), rescoring the saved
// runs avoids re-spending on the API and keeps every model on one metric.
//
// Usage:
//   node scripts/asr-bench/rescore.mjs results/asr-2026-07-29T03-40-00.json
//   node scripts/asr-bench/rescore.mjs --all

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wer, missedWords } from './wer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(HERE, 'results')

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const median = (xs) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function rescore(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const truth = data.truth ?? Object.fromEntries((data.fixtures ?? []).map((f) => [f.name, f.reference]))

  for (const row of data.rows) {
    // Prefer the raw per-run transcripts when the file has them: averaging WER
    // across runs is more honest than scoring one representative run.
    const rawForModel = (data.raw ?? []).filter((r) => r.modelId === row.id && r.ok)
    for (const c of row.perClip) {
      const runs = rawForModel.filter((r) => r.clip === c.clip)
      const texts = runs.length ? runs.map((r) => r.text) : c.text == null ? [] : [c.text]
      if (!texts.length) { c.wer = NaN; continue }
      c.wer = mean(texts.map((t) => wer(truth[c.clip], t).wer))
      c.missed = missedWords(truth[c.clip], texts[0])
      if (runs.length) c.ms = median(runs.map((r) => r.ms))
    }
    row.meanWer = mean(row.perClip.map((c) => c.wer).filter(Number.isFinite))
  }

  data.rows.sort((a, b) => (a.meanWer - b.meanWer) || (a.medianMs - b.medianMs))
  writeFileSync(path, JSON.stringify(data, null, 2))
  console.log(`rescored ${basename(path)}`)
  console.table(data.rows.map((r) => ({
    model: r.id ?? r.tier,
    wer: (r.meanWer * 100).toFixed(1) + '%',
    median: Number.isFinite(r.medianMs) ? Math.round(r.medianMs) + ' ms' : '—',
  })))
  return data
}

const arg = process.argv[2]
if (!arg) throw new Error('usage: rescore.mjs <results.json> | --all')
const targets = arg === '--all'
  ? readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).map((f) => join(RESULTS_DIR, f))
  : [arg]
for (const t of targets) rescore(t)
