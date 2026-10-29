// How accurate and how fast is each speech model OpenRouter offers, on dictation-sized clips?
//
// Sends Sotto's seven English fixtures (2 to 17 s) to every model OpenRouter lists under
// output_modalities=transcription, the way cloud dictation sends a segment: JSON input_audio as
// 16 kHz WAV, through /api/v1/audio/transcriptions, routed to a zero-data-retention host when the
// model has one. Times run from before fetch to the parsed transcript, including any retry, because
// that is what someone dictating waits for. Clips go one at a time, so no request competes with
// another. Each model also gets one probe with `keyterms`, to learn whether it takes spelling hints,
// and one warm-up request that is charged but not scored.
//
// Other languages, when a folder from fetch-multilingual.mjs is given, run once each and are scored
// on their own; the ranking Sotto ships is English, because that is what its fixtures measure.
//
// Usage:
//   node scripts/asr-bench/bench-openrouter-stt.mjs                      # every model, 3 runs
//   node scripts/asr-bench/bench-openrouter-stt.mjs --only elevenlabs/scribe-v2 --runs 1
//   node scripts/asr-bench/bench-openrouter-stt.mjs --multi <dir> --budget 2
//   node scripts/asr-bench/bench-openrouter-stt.mjs --only mistralai/voxtral-mini-transcribe --no-zdr
//   node scripts/asr-bench/bench-openrouter-stt.mjs --only microsoft/mai-transcribe-2 --azure-hints
//
// --no-zdr sends without zero-retention routing, for a model OpenRouter lists with a zero-retention host that its
// transcription route then refuses. --azure-hints sends the fixtures' names as Azure's phrase list, the only spelling
// hints a transcription model on OpenRouter took on October 29, 2026 (every model refused `keyterms`).
//
// Reads the key from OPENROUTER_API_KEY or scripts/llm-bench/.openrouter-key (gitignored). Writes
// openrouter-stt-<stamp>.json and .md to results. Never writes the key, request bodies or audio.

/* global AbortSignal */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { median } from './stats.mjs'
import { wer } from './wer.mjs'
import { scoreProperNouns } from './stt-scoring.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = 'https://openrouter.ai/api/v1'
const FIXTURES = join(HERE, 'fixtures')
const CLIPS = ['tiny', 'short', 'long', 'technical', 'numbers', 'propernoun', 'homophone']
const KEYTERMS = ['Sotto', 'Zache', 'Wispr Flow', 'Superwhisper', 'Kubernetes', 'Anthropic']
const DEADLINE_MS = 30_000
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const p95 = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] : null
const round = (value, places) => value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places))

function parseArgs(argv) {
  const args = { runs: 3, budget: 3, only: null, multi: null, multiPerLanguage: 4, zdr: true, azureHints: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    if (flag === '--runs') args.runs = Number(next())
    else if (flag === '--budget') args.budget = Number(next())
    else if (flag === '--only') args.only = next().split(',')
    else if (flag === '--multi') args.multi = next()
    else if (flag === '--multi-per-language') args.multiPerLanguage = Number(next())
    else if (flag === '--no-zdr') args.zdr = false
    else if (flag === '--azure-hints') args.azureHints = true
    else throw new Error(`Unknown flag ${flag}`)
  }
  return args
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

class BudgetStop extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const keyPath = join(HERE, '../llm-bench/.openrouter-key')
  const key = process.env.OPENROUTER_API_KEY?.trim() || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '')
  if (!key) throw new Error('No OPENROUTER_API_KEY and no scripts/llm-bench/.openrouter-key')

  const listed = (await getJson(`${API}/models?output_modalities=transcription`)).data
  const zdrModels = new Set((await getJson(`${API}/endpoints/zdr`)).data.map((endpoint) => endpoint.model_id))
  const models = listed
    .filter((model) => model.architecture?.output_modalities?.includes('transcription'))
    .filter((model) => !args.only || args.only.includes(model.id))
    .map((model) => ({ id: model.id, name: model.name, zdr: args.zdr && zdrModels.has(model.id) }))

  const truth = readJson(join(FIXTURES, 'ground-truth.json'))
  const names = readJson(join(FIXTURES, 'proper-nouns.json'))
  const phrases = [...new Set(Object.values(names).flat())]
  const english = CLIPS.map((clip) => ({ clip, wav: readFileSync(join(FIXTURES, `speech-${clip}.wav`)), reference: truth[clip], names: names[clip] ?? [] }))
  const multi = args.multi ? pickPerLanguage(readJson(join(args.multi, 'manifest.json')), args.multiPerLanguage)
    .map((entry) => ({ ...entry, wav: readFileSync(join(args.multi, entry.file)) })) : []

  let spent = 0
  const send = async (model, wav, extra = {}) => {
    if (spent >= args.budget) throw new BudgetStop()
    const body = JSON.stringify({
      model: model.id,
      input_audio: { data: wav.toString('base64'), format: 'wav' },
      ...(model.zdr || args.azureHints ? { provider: {
        ...(model.zdr ? { zdr: true } : {}),
        ...(args.azureHints ? { options: { azure: { phraseList: { phrases } } } } : {}),
      } } : {}),
      ...extra,
    })
    const started = performance.now()
    let attempts = 0
    for (;;) {
      attempts += 1
      let response
      try {
        response = await fetch(`${API}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Sotto speech benchmark' },
          body,
          signal: AbortSignal.timeout(DEADLINE_MS),
        })
      } catch (error) {
        return { ok: false, status: null, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network', ms: performance.now() - started, attempts }
      }
      if (response.status === 429 && attempts <= 3) {
        const retryAfter = Number(response.headers.get('retry-after'))
        await response.text().catch(() => '')
        await wait(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, 1000 * 2 ** (attempts - 1)))
        continue
      }
      if (!response.ok) {
        await response.text().catch(() => '')
        return { ok: false, status: response.status, reason: 'http', ms: performance.now() - started, attempts }
      }
      const payload = await response.json().catch(() => null)
      const ms = performance.now() - started
      const cost = Number(payload?.usage?.cost)
      if (Number.isFinite(cost)) spent += cost
      if (typeof payload?.text !== 'string') return { ok: false, status: response.status, reason: 'malformed', ms, attempts }
      return { ok: true, text: payload.text, ms, attempts, cost: Number.isFinite(cost) ? cost : null, seconds: Number(payload?.usage?.seconds) || null }
    }
  }

  const results = []
  try {
    for (const model of models) {
      process.stdout.write(`${model.id} `)
      const warmup = await send(model, english[0].wav)
      const probe = await send(model, english[0].wav, { keyterms: KEYTERMS })
      const runs = []
      for (let run = 0; run < args.runs; run++) {
        for (const clip of english) {
          const answer = await send(model, clip.wav)
          runs.push({ run, clip: clip.clip, audioMs: Math.round(clip.wav.length / 32), ...summarise(answer, clip.reference, clip.names) })
          process.stdout.write(answer.ok ? '.' : 'x')
        }
      }
      const other = []
      for (const clip of multi) {
        const answer = await send(model, clip.wav)
        other.push({ language: clip.language, file: clip.file, ...summarise(answer, clip.reference, []) })
        process.stdout.write(answer.ok ? ',' : 'x')
      }
      results.push({ ...model, warmupOk: warmup.ok, keyterms: probe.ok ? 'accepted' : probe.status === 400 ? 'rejected' : 'unknown', runs, other })
      process.stdout.write(` $${spent.toFixed(3)}\n`)
    }
  } catch (error) {
    if (!(error instanceof BudgetStop)) throw error
    console.log(`\nStopped at the $${args.budget} budget.`)
  }

  const rows = results.map(score).sort((a, b) => (a.englishWer ?? Infinity) - (b.englishWer ?? Infinity))
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const out = join(HERE, 'results')
  mkdirSync(out, { recursive: true })
  const meta = { at: new Date().toISOString(), runs: args.runs, clips: CLIPS, otherClips: multi.length, zdr: args.zdr, azureHints: args.azureHints, spentUsd: round(spent, 4) }
  writeFileSync(join(out, `openrouter-stt-${stamp}.json`), JSON.stringify({ meta, rows, results }, null, 2))
  writeFileSync(join(out, `openrouter-stt-${stamp}.md`), table(meta, rows))
  console.log(`Wrote results/openrouter-stt-${stamp}.{json,md}; spent $${spent.toFixed(3)}`)
}

function pickPerLanguage(manifest, perLanguage) {
  const seen = new Map()
  return manifest.filter((entry) => {
    const count = seen.get(entry.language) ?? 0
    seen.set(entry.language, count + 1)
    return count < perLanguage && entry.language !== 'japanese'
  })
}

function summarise(answer, reference, clipNames) {
  if (!answer.ok) return { ok: false, status: answer.status, reason: answer.reason, ms: Math.round(answer.ms), attempts: answer.attempts }
  const scored = wer(reference, answer.text)
  const named = clipNames.length ? scoreProperNouns(answer.text, clipNames) : null
  return {
    ok: true, ms: Math.round(answer.ms), attempts: answer.attempts, errors: scored.errors, refWords: scored.refWords,
    ...(named ? { namesMatched: named.matched, namesTotal: named.total } : {}),
    cost: answer.cost, seconds: answer.seconds, text: answer.text,
  }
}

function score(result) {
  const ok = result.runs.filter((run) => run.ok)
  const pooled = (runs) => {
    const words = runs.reduce((sum, run) => sum + run.refWords, 0)
    return words ? runs.reduce((sum, run) => sum + run.errors, 0) / words : null
  }
  const otherOk = result.other.filter((run) => run.ok)
  const cost = ok.reduce((sum, run) => sum + (run.cost ?? 0), 0)
  const seconds = ok.reduce((sum, run) => sum + (run.seconds ?? 0), 0)
  return {
    id: result.id,
    name: result.name,
    zdr: result.zdr,
    keyterms: result.keyterms,
    failures: result.runs.length - ok.length,
    englishWer: round(pooled(ok), 4),
    otherWer: round(pooled(otherOk), 4),
    namesRight: ok.some((run) => run.namesTotal) ? `${ok.reduce((s, r) => s + (r.namesMatched ?? 0), 0)}/${ok.reduce((s, r) => s + (r.namesTotal ?? 0), 0)}` : null,
    medianMs: round(median(ok.map((run) => run.ms)), 0),
    shortMedianMs: round(median(ok.filter((run) => run.audioMs <= 5_000).map((run) => run.ms)), 0),
    p95Ms: p95(ok.map((run) => run.ms)),
    usdPerHour: seconds > 0 ? round(cost / seconds * 3600, 3) : null,
  }
}

function table(meta, rows) {
  const pct = (value) => value === null ? '–' : `${(value * 100).toFixed(1)}%`
  const ms = (value) => value === null ? '–' : `${(value / 1000).toFixed(2)} s`
  const lines = [
    `# OpenRouter speech models on Sotto's fixtures, ${meta.at.slice(0, 10)}`,
    '',
    `${meta.runs} runs of ${meta.clips.length} English clips; ${meta.otherClips} clips in other languages, once each. Spent $${meta.spentUsd}.`,
    '',
    '| Model | English WER | Names | Median | Short clips | p95 | Other languages WER | $/hour | Zero retention | Keyterms | Failed |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.id} | ${pct(row.englishWer)} | ${row.namesRight ?? '–'} | ${ms(row.medianMs)} | ${ms(row.shortMedianMs)} | ${ms(row.p95Ms)} | ${pct(row.otherWer)} | ${row.usdPerHour ?? '–'} | ${row.zdr ? 'yes' : 'no'} | ${row.keyterms} | ${row.failures} |`),
    '',
  ]
  return lines.join('\n')
}

await main()
