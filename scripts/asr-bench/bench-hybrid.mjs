// Does Sotto's *existing* LLM polish pass already fix Moonshine's errors?
//
// Moonshine's mistakes are overwhelmingly proper nouns and technical terms
// ("Zache" -> "Zach", "Kubernetes" -> "Kubernet's"). Sotto already sends every
// transcript through a polish LLM with a user dictionary, so those may be
// recoverable for free — the pass runs either way. If so, the accuracy problem
// is a prompt/dictionary problem, not a reason to replace the ASR model.
//
// Scores the same clips and metric as bench-asr.mjs:
//   raw Moonshine WER  ->  polished WER,  plus the latency the pass adds.
//
// Usage:
//   node scripts/asr-bench/bench-hybrid.mjs
//   node scripts/asr-bench/bench-hybrid.mjs --tiers low,high --runs 3

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { wer } from './wer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(HERE, 'results')
const FIXTURE_DIR = join(HERE, 'fixtures')
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'

// Mirrors QUALITY_TIERS in src/main/llm/transcriptPolishService.ts.
const TIERS = {
  low: { id: 'inception/mercury-2', reasoning: false },
  medium: { id: 'amazon/nova-2-lite-v1', reasoning: false },
  high: { id: 'anthropic/claude-haiku-4.5', reasoning: false },
}

// The words a Sotto user would realistically have in their dictionary, given
// they dictate about this project. This is the lever being tested.
const DICTIONARY = [
  'Sotto', 'Moonshine', 'Whisper', 'Wispr Flow', 'Superwhisper', 'Zache',
  'Electron', 'ONNX', 'Kubernetes', 'Anthropic', 'Priya', 'Sowmya',
  'Otter', 'Descript',
]

// Copied from src/main/llm/prompt.ts so the benchmark exercises the shipped
// prompt rather than an idealized one.
const BASE_RULES = `You clean up raw speech-to-text transcripts for dictation. Rewrite the transcript as polished text while staying faithful to the speaker's words.

Rules:
- Add punctuation, capitalization, and sentence breaks.
- Remove filler words "um" and "uh" only. Keep words like "like" and "you know".
- Fix obvious speech-recognition errors using context.
- Resolve self-corrections: "meet at 3 no wait make that 4" becomes "meet at 4".
- Interpret the spoken commands "new line" and "new paragraph" as literal line/paragraph breaks.
- Do not rewrite, summarize, or restructure. Do not add content.`
const OUTPUT_RULE = 'Output ONLY the cleaned text. No preamble, no quotes, no explanation.'

function parseArgs(argv) {
  const args = { runs: 2, tiers: ['low', 'medium', 'high'], dictionary: true }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      case '--tiers': args.tiers = val.split(','); if (!inlineVal) i++; break
      case '--no-dictionary': args.dictionary = false; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const median = (xs) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

async function polish(apiKey, spec, transcript, dictionary) {
  const dictRule = dictionary.length
    ? `\n- Words the speaker may use (correct misspellings toward these): ${dictionary.join(', ')}.`
    : ''
  const system = `${BASE_RULES}${dictRule}\n\n${OUTPUT_RULE}`
  const t0 = performance.now()
  const res = await fetch(OPENROUTER, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: spec.id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Transcript:\n${transcript}` },
      ],
      temperature: 0,
      max_tokens: 1000,
      ...(spec.reasoning === false ? { reasoning: { enabled: false } } : {}),
      usage: { include: true },
    }),
  })
  const ms = performance.now() - t0
  const body = await res.json()
  if (!res.ok || body.error) return { ok: false, ms, error: body.error?.message ?? `http ${res.status}` }
  return {
    ok: true,
    ms,
    text: (body.choices?.[0]?.message?.content ?? '').trim(),
    cost: Number(body.usage?.cost ?? 0),
  }
}

const args = parseArgs(process.argv)
const apiKey = process.env.OPENROUTER_API_KEY?.trim()
if (!apiKey) throw new Error('no OPENROUTER_API_KEY')

const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))

// The most recent local run supplies Moonshine's raw output and its latency.
const localFile = readdirSync(RESULTS_DIR).filter((f) => f.startsWith('local-')).sort().pop()
if (!localFile) throw new Error('run bench-local.mjs first')
const local = JSON.parse(readFileSync(join(RESULTS_DIR, localFile), 'utf8'))
const moonshine = local.rows.find((r) => r.tier === 'instant')
console.log(`[hybrid] Moonshine raw: mean WER ${(moonshine.meanWer * 100).toFixed(1)}%  (from ${localFile})`)

const dictionary = args.dictionary ? DICTIONARY : []
const rows = []
for (const tierName of args.tiers) {
  const spec = TIERS[tierName]
  const perClip = []
  for (const c of moonshine.perClip) {
    const runs = []
    for (let i = 0; i < args.runs; i++) {
      const r = await polish(apiKey, spec, c.text, dictionary)
      if (r.ok) runs.push(r)
      else console.log(`  FAIL ${tierName}/${c.clip}: ${r.error}`)
    }
    if (!runs.length) { perClip.push({ clip: c.clip, rawWer: c.wer, wer: NaN, ms: NaN }); continue }
    perClip.push({
      clip: c.clip,
      rawWer: c.wer,
      wer: mean(runs.map((r) => wer(truth[c.clip], r.text).wer)),
      ms: median(runs.map((r) => r.ms)),
      asrMs: c.ms,
      text: runs[0].text,
      cost: mean(runs.map((r) => r.cost)),
    })
  }
  const row = {
    tier: tierName,
    model: spec.id,
    rawWer: mean(perClip.map((p) => p.rawWer)),
    polishedWer: mean(perClip.map((p) => p.wer).filter(Number.isFinite)),
    polishMs: median(perClip.map((p) => p.ms).filter(Number.isFinite)),
    totalMs: median(perClip.map((p) => (p.asrMs ?? 0) + (p.ms ?? 0)).filter(Number.isFinite)),
    perClip,
  }
  rows.push(row)
  console.log(`[hybrid] ${tierName} (${spec.id}): ${(row.rawWer * 100).toFixed(1)}% -> ${(row.polishedWer * 100).toFixed(1)}%  (+${Math.round(row.polishMs)}ms)`)
}

mkdirSync(RESULTS_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
writeFileSync(join(RESULTS_DIR, `hybrid-${stamp}.json`), JSON.stringify({ rows, dictionary, source: localFile }, null, 2))
console.log(`\nwrote ${join(RESULTS_DIR, `hybrid-${stamp}.json`)}`)
console.table(rows.map((r) => ({
  tier: r.tier,
  model: r.model,
  raw: (r.rawWer * 100).toFixed(1) + '%',
  polished: (r.polishedWer * 100).toFixed(1) + '%',
  'polish ms': Math.round(r.polishMs),
  'total ms': Math.round(r.totalMs),
})))
