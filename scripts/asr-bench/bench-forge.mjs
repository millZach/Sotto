// Benchmark a self-hosted OpenAI-compatible ASR server (Parakeet on Forge)
// against the same fixtures and WER scoring the other asr-bench scripts use.
//
// The question it answers: does Parakeet on the LAN GPU box beat local
// Moonshine on accuracy AND stay under the push-to-talk latency bar
// (Moonshine: 185ms for a 2s clip, ~1.8s for 16.6s — see
// docs/perf/2026-07-28-asr-model-benchmark.md)?
//
// Usage:
//   node scripts/asr-bench/bench-forge.mjs                          # default Forge URL
//   node scripts/asr-bench/bench-forge.mjs --url http://host:5092 --runs 5
//
// Writes markdown + json to scripts/asr-bench/results/ as forge-<stamp>.*

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { mean, median } from './stats.mjs'
import { wer, missedWords } from './wer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')

function parseArgs(argv) {
  const args = { url: 'http://forge.tail5728ca.ts.net:5092', runs: 5 }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--url': args.url = val.replace(/\/$/, ''); if (!inlineVal) i++; break
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

function loadFixtures() {
  const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))
  return Object.entries(truth).map(([name, text]) => {
    const wav = readFileSync(join(FIXTURE_DIR, `speech-${name}.wav`))
    return { name, reference: text, wav, seconds: (wav.length - 44) / (16000 * 2) }
  })
}

async function transcribe(baseUrl, fixture) {
  const form = new FormData()
  form.append('file', new Blob([fixture.wav], { type: 'audio/wav' }), `${fixture.name}.wav`)
  form.append('model', 'parakeet')
  const start = performance.now()
  try {
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: form })
    const ms = performance.now() - start
    if (!res.ok) return { ok: false, ms, error: `http ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const body = await res.json()
    const text = (body.text ?? '').trim()
    if (!text) return { ok: false, ms, error: 'empty output' }
    return { ok: true, ms, text }
  } catch (err) {
    return { ok: false, ms: performance.now() - start, error: err.message }
  }
}

const percentile = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

async function main() {
  const args = parseArgs(process.argv)
  const fixtures = loadFixtures()
  console.log(`[bench] ${args.url} — ${fixtures.length} clips x ${args.runs} runs`)

  // Warmup so model load / first-request setup is not charged to run 1.
  const warm = await transcribe(args.url, fixtures[0])
  if (!warm.ok) throw new Error(`warmup failed: ${warm.error}`)
  console.log(`[warmup] ok in ${Math.round(warm.ms)}ms`)

  const raw = []
  for (const fixture of fixtures) {
    for (let run = 0; run < args.runs; run++) {
      const r = await transcribe(args.url, fixture)
      raw.push({ clip: fixture.name, run, ...r })
      if (!r.ok) console.log(`  FAIL ${fixture.name}/${run}: ${r.error}`)
    }
    const mine = raw.filter((r) => r.clip === fixture.name && r.ok)
    console.log(`  ${fixture.name} (${fixture.seconds.toFixed(1)}s): median ${Math.round(median(mine.map((r) => r.ms)))}ms, ${mine.length}/${args.runs} ok`)
  }

  const perClip = fixtures.map((f) => {
    const runs = raw.filter((r) => r.clip === f.name && r.ok)
    if (!runs.length) return { clip: f.name, seconds: f.seconds, wer: NaN, text: null, ms: NaN }
    const scored = runs.map((r) => ({ ...r, w: wer(f.reference, r.text).wer }))
    return {
      clip: f.name,
      seconds: f.seconds,
      wer: mean(scored.map((s) => s.w)),
      text: runs[0].text,
      ms: median(runs.map((r) => r.ms)),
      p90: percentile(runs.map((r) => r.ms), 90),
      missed: missedWords(f.reference, runs[0].text),
    }
  })

  const good = raw.filter((r) => r.ok)
  const summary = {
    url: args.url,
    runs: args.runs,
    ok: good.length,
    total: raw.length,
    meanWer: mean(perClip.map((c) => c.wer).filter(Number.isFinite)),
    medianMs: median(good.map((r) => r.ms)),
    p90Ms: percentile(good.map((r) => r.ms), 90),
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  writeFileSync(join(RESULTS_DIR, `forge-${stamp}.json`), JSON.stringify({ summary, perClip, raw }, null, 2))

  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—')
  const ms = (x) => (Number.isFinite(x) ? Math.round(x) + ' ms' : '—')
  const lines = []
  lines.push(`# Forge Parakeet benchmark — ${stamp}`)
  lines.push('')
  lines.push(`Server: ${args.url} — ${summary.ok}/${summary.total} requests ok, ${args.runs} runs per clip.`)
  lines.push(`Mean WER **${pct(summary.meanWer)}**, median wall latency **${ms(summary.medianMs)}**, p90 **${ms(summary.p90Ms)}**.`)
  lines.push('')
  lines.push('| Clip | Audio | WER | Median | p90 |')
  lines.push('|------|-------|-----|--------|-----|')
  for (const c of perClip) lines.push(`| ${c.clip} | ${c.seconds.toFixed(1)}s | ${pct(c.wer)} | ${ms(c.ms)} | ${ms(c.p90)} |`)
  lines.push('')
  lines.push('## Transcripts')
  for (const c of perClip) {
    lines.push('')
    lines.push(`- **${c.clip}** (WER ${pct(c.wer)}): ${c.text ? c.text.replace(/\n+/g, ' ') : '—'}`)
    if (c.missed?.length) lines.push(`  - missed: ${c.missed.join(', ')}`)
  }

  const mdPath = join(RESULTS_DIR, `forge-${stamp}.md`)
  writeFileSync(mdPath, lines.join('\n'))
  console.log(`\nwrote ${mdPath}`)
  console.table(perClip.map((c) => ({ clip: c.clip, wer: pct(c.wer), median: ms(c.ms) })))
}

main().catch((err) => { console.error(err); process.exit(1) })
