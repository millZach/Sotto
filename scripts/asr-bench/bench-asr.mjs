// Speech-to-text accuracy/latency benchmark for Sotto's transcription stage.
//
// Benchmarks every OpenRouter model that advertises audio input against the
// local Moonshine/Whisper tiers the app ships today. The question it answers:
// is there a hosted model materially more accurate than Moonshine without
// giving up the latency that makes Moonshine worth using?
//
// Phases:
//   1. Catalog — fetch /models, keep audio-input models, drop :batch (async),
//                "~" aliases, and openrouter/* routers.
//   2. Screen  — every candidate transcribes 2 clips once. Drops hard errors
//                and models that advertise audio but never receive it.
//   3. Deep    — survivors transcribe all clips, --runs times.
//   4. Report  — WER vs ground truth, latency percentiles, cost per 1k clips.
//
// Usage:
//   node scripts/asr-bench/bench-asr.mjs                    # full sweep
//   node scripts/asr-bench/bench-asr.mjs --runs 3
//   node scripts/asr-bench/bench-asr.mjs --only gemini,gpt-audio
//   node scripts/asr-bench/bench-asr.mjs --no-screen
//
// Needs OPENROUTER_API_KEY (env var or scripts/llm-bench/.openrouter-key).
// Writes a markdown report to scripts/asr-bench/results/.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { mean, median } from './stats.mjs'
import { wer, missedWords } from './wer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')
const OPENROUTER = 'https://openrouter.ai/api/v1'

// Screen on the two shortest clips: the phase only decides "does audio reach
// this model at all", and a tight timeout keeps one stalled provider from
// dominating the run. A model that cannot return a 2s clip within 30s has
// already failed the brief for push-to-talk dictation.
const SCREEN_CLIPS = ['tiny', 'short']
const SCREEN_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 60_000
// Every request is serial. Concurrency queues requests behind each other at the
// provider: a first pass with 6-way concurrency reported 30-60s latencies and
// timeout-rejected models that answer in ~1.2s when asked one at a time.
const RETRIES = 2

// Verbatim instruction: Sotto polishes downstream, so the ASR stage must not
// paraphrase. Kept identical across models so the comparison is fair.
const PROMPT =
  'Transcribe the audio verbatim. Output only the transcript text, with no preamble, ' +
  'no quotes, no commentary, and no translation. If the audio is silent, output nothing.'

function parseArgs(argv) {
  const args = { runs: 3, only: null, screen: true, limit: null }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      case '--only': args.only = val.split(','); if (!inlineVal) i++; break
      case '--limit': args.limit = Number(val); if (!inlineVal) i++; break
      case '--no-screen': args.screen = false; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const keyFile = join(HERE, '..', 'llm-bench', '.openrouter-key')
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim()
  throw new Error('no OPENROUTER_API_KEY')
}

function loadFixtures() {
  // Windows PowerShell's -Encoding utf8 writes a BOM; Node's JSON.parse chokes on it.
  const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))
  return Object.entries(truth).map(([name, text]) => {
    const wav = readFileSync(join(FIXTURE_DIR, `speech-${name}.wav`))
    // 16 kHz mono PCM16 + 44-byte RIFF header.
    const seconds = (wav.length - 44) / (16000 * 2)
    // Prefer mp3 when it exists: raw PCM is ~8x larger, and on a slow uplink
    // the upload dominates everything else (a 190 KB body measured 16-49s at
    // the 4-12 KB/s this machine uploads at). Same audio, 8x less to send.
    const mp3Path = join(FIXTURE_DIR, `speech-${name}.mp3`)
    const useMp3 = existsSync(mp3Path)
    const audio = useMp3 ? readFileSync(mp3Path) : wav
    return {
      name,
      reference: text,
      base64: audio.toString('base64'),
      format: useMp3 ? 'mp3' : 'wav',
      bytes: audio.length,
      seconds,
    }
  })
}

async function fetchAudioModels(apiKey) {
  const res = await fetch(`${OPENROUTER}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const { data } = await res.json()
  return data
    .filter((m) => (m.architecture?.input_modalities ?? []).includes('audio'))
    // :batch is an async queue (hours, not milliseconds); "~" slugs are moving
    // aliases; openrouter/* are routers that pick some other model for us.
    .filter((m) => !m.id.includes(':batch') && !m.id.startsWith('~') && !m.id.startsWith('openrouter/'))
    .map((m) => ({
      id: m.id,
      name: m.name,
      pricing: m.pricing ?? {},
    }))
}

// A model that "accepts audio" but replies asking for the file never actually
// received it. Cheaper to detect here than to let it pollute the WER table.
const NO_AUDIO_RE = /(provide|share|upload|attach|send)\s+(me\s+)?(the|an?|your)?\s*(audio|file|recording|clip)|i (can'?t|cannot|am unable to) (hear|access|process|listen)|no audio (was )?(provided|attached)|there is no audio/i

// Transient network/provider hiccups should not be scored as model failures,
// so a request gets a couple of attempts before it counts against the model.
// "audio not received" is not retried — that is a stable provider limitation.
async function transcribe(apiKey, model, fixture, { retries = RETRIES, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let last
  // Some endpoints (the newer Gemini thinking models) reject the request
  // outright if reasoning is disabled. Fall back to leaving the param off
  // rather than scoring those models as failures.
  let noReasoning = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await attemptTranscribe(apiKey, model, fixture, timeoutMs, noReasoning)
    if (last.ok || last.error === 'audio not received by provider') return last
    if (/reasoning is mandatory|cannot be disabled/i.test(last.error ?? '') && !noReasoning) {
      noReasoning = true
      attempt-- // the retry budget is for flakiness, not for this one-off correction
      continue
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return last
}

async function attemptTranscribe(apiKey, model, fixture, timeoutMs, noReasoning = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/millZach/Sotto',
        'X-Title': 'Sotto ASR bench',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'input_audio', input_audio: { data: fixture.base64, format: fixture.format } },
          ],
        }],
        max_tokens: 1000,
        temperature: 0,
        // Transcription is a perception task, not a reasoning one. Left on,
        // the thinking models spend most of their wall-clock deliberating —
        // gemini-3.6-flash took 87s on a 20s clip — which is latency and cost
        // spent on nothing. Ignored by models without a reasoning mode.
        ...(noReasoning ? {} : { reasoning: { enabled: false } }),
        usage: { include: true },
      }),
    })
    const ms = performance.now() - start
    const body = await res.json()
    if (!res.ok || body.error) {
      return { ok: false, ms, error: body.error?.message ?? `http ${res.status}` }
    }
    const text = (body.choices?.[0]?.message?.content ?? '').trim()
    if (!text) return { ok: false, ms, error: 'empty output' }
    if (NO_AUDIO_RE.test(text)) return { ok: false, ms, error: 'audio not received by provider' }
    // `id` lets a later pass pull OpenRouter's server-side timing, which is
    // independent of how slow this particular internet connection is.
    return { ok: true, ms, text, cost: Number(body.usage?.cost ?? 0), id: body.id }
  } catch (err) {
    return { ok: false, ms: performance.now() - start, error: err.name === 'AbortError' ? 'timeout' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

const percentile = (xs, p) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

async function main() {
  const args = parseArgs(process.argv)
  const apiKey = loadApiKey()
  const fixtures = loadFixtures()
  const totalAudioSeconds = fixtures.reduce((a, f) => a + f.seconds, 0)

  let models = await fetchAudioModels(apiKey)
  if (args.only) models = models.filter((m) => args.only.some((p) => m.id.includes(p)))
  if (args.limit) models = models.slice(0, args.limit)
  console.log(`[catalog] ${models.length} audio-input models`)
  console.log(`[fixtures] ${fixtures.length} clips, ${totalAudioSeconds.toFixed(1)}s total audio`)

  // ---- Phase 2: screen -----------------------------------------------------
  let survivors = models
  const rejected = []
  if (args.screen) {
    const screenClips = fixtures.filter((f) => SCREEN_CLIPS.includes(f.name))
    console.log(`[screen] ${models.length * screenClips.length} requests, serial...`)
    const byModel = new Map()
    for (const model of models) {
      for (const fixture of screenClips) {
        const r = await transcribe(apiKey, model.id, fixture, { retries: 1, timeoutMs: SCREEN_TIMEOUT_MS })
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${model.id} / ${fixture.name} ${Math.round(r.ms)}ms${r.ok ? '' : ' — ' + r.error}`)
        if (!byModel.has(model.id)) byModel.set(model.id, [])
        byModel.get(model.id).push(r)
      }
    }
    survivors = models.filter((m) => {
      const rs = byModel.get(m.id) ?? []
      const ok = rs.some((r) => r.ok)
      if (!ok) rejected.push({ id: m.id, reason: rs.find((r) => r.error)?.error ?? 'no successful screen run' })
      return ok
    })
    console.log(`[screen] ${survivors.length} survived, ${rejected.length} rejected`)
  }

  // ---- Phase 3: deep -------------------------------------------------------
  // Serial on purpose. Latency is the metric this whole benchmark exists to
  // measure, and firing concurrent requests at one model queues them behind
  // each other at the provider — an early concurrent version of this script
  // reported a 31s median for a model that answers in ~2s. Every request also
  // gets a discarded warmup first so connection setup is not charged to run 1.
  const total = survivors.length * fixtures.length * args.runs
  console.log(`[deep] ${total} requests, serial (${survivors.length} models x ${fixtures.length} clips x ${args.runs} runs)...`)

  const raw = []
  let done = 0
  for (const model of survivors) {
    await transcribe(apiKey, model.id, fixtures[0]) // warmup, not scored
    for (const fixture of fixtures) {
      for (let run = 0; run < args.runs; run++) {
        const r = await transcribe(apiKey, model.id, fixture)
        raw.push({ modelId: model.id, fixture, run, ...r })
        done++
      }
    }
    const mine = raw.filter((r) => r.modelId === model.id && r.ok)
    console.log(`  [deep ${done}/${total}] ${model.id} — median ${Math.round(median(mine.map((r) => r.ms)))}ms, ${mine.length} ok`)
  }

  // ---- Server-side timing --------------------------------------------------
  // Wall-clock above includes this machine's network round trip, which on a
  // slow link dwarfs the model itself (a bare TLS handshake to any host was
  // measured at 1.9-5.5s while collecting this data). OpenRouter reports what
  // the request actually cost at the provider, so both numbers get reported:
  // `serverMs` compares models, `ms` is what a user on this link feels.
  // Fetched after the timed section and concurrently — it is not being timed.
  const withIds = raw.filter((r) => r.ok && r.id)
  console.log(`[stats] fetching server-side timing for ${withIds.length} generations...`)
  let statCursor = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (statCursor < withIds.length) {
      const r = withIds[statCursor++]
      try {
        const res = await fetch(`${OPENROUTER}/generation?id=${encodeURIComponent(r.id)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        const { data } = await res.json()
        if (data) {
          // latency = time to first token (ms); generation_time = streaming time.
          r.serverMs = (data.latency ?? 0) + (data.generation_time ?? 0)
          r.ttftMs = data.latency ?? null
          if (Number.isFinite(data.total_cost)) r.cost = data.total_cost
        }
      } catch { /* timing is best-effort; wall-clock still stands */ }
    }
  }))

  // ---- Aggregate -----------------------------------------------------------
  const rows = survivors.map((m) => {
    const mine = raw.filter((r) => r.modelId === m.id)
    const good = mine.filter((r) => r.ok)
    const latencies = good.map((r) => r.ms)

    const perClip = fixtures.map((f) => {
      const runs = good.filter((r) => r.fixture.name === f.name)
      if (!runs.length) return { clip: f.name, wer: NaN, text: null, ms: NaN }
      // Score the median-latency run's text so one lucky run cannot flatter it.
      const scored = runs.map((r) => ({ ...r, w: wer(f.reference, r.text).wer }))
      const best = scored[0]
      return {
        clip: f.name,
        wer: mean(scored.map((s) => s.w)),
        text: best.text,
        ms: median(runs.map((r) => r.ms)),
        missed: missedWords(f.reference, best.text),
      }
    })

    const clipWers = perClip.map((c) => c.wer).filter(Number.isFinite)
    const costPerClip = good.length ? mean(good.map((r) => r.cost ?? 0)) : NaN
    const serverTimes = good.map((r) => r.serverMs).filter(Number.isFinite)

    return {
      id: m.id,
      name: m.name,
      ok: good.length,
      total: mine.length,
      meanWer: mean(clipWers),
      perClip,
      medianMs: median(latencies),
      p90Ms: percentile(latencies, 90),
      minMs: Math.min(...latencies),
      medianServerMs: median(serverTimes),
      medianTtftMs: median(good.map((r) => r.ttftMs).filter(Number.isFinite)),
      costPer1k: costPerClip * 1000,
    }
  })

  rows.sort((a, b) => (a.meanWer - b.meanWer) || (a.medianMs - b.medianMs))

  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const jsonPath = join(RESULTS_DIR, `asr-${stamp}.json`)
  // Raw runs are kept so the report can be re-scored after a metric change
  // without re-spending on the API.
  writeFileSync(jsonPath, JSON.stringify({
    rows,
    rejected,
    fixtures: fixtures.map((f) => ({ name: f.name, seconds: f.seconds, reference: f.reference })),
    raw: raw.map((r) => ({ modelId: r.modelId, clip: r.fixture.name, run: r.run, ok: r.ok, ms: r.ms, text: r.text, error: r.error, cost: r.cost })),
  }, null, 2))

  // ---- Report --------------------------------------------------------------
  const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—')
  const ms = (x) => (Number.isFinite(x) ? Math.round(x) + ' ms' : '—')
  const lines = []
  lines.push(`# Sotto ASR benchmark — ${stamp}`)
  lines.push('')
  lines.push(`Models: ${survivors.length} benchmarked, ${rejected.length} rejected in screening.`)
  lines.push(`Clips: ${fixtures.length} (${totalAudioSeconds.toFixed(1)}s audio), ${args.runs} runs each.`)
  lines.push('')
  lines.push('## Ranking (mean WER, lower is better)')
  lines.push('')
  lines.push('`server` is OpenRouter-reported provider time; `wall` includes this machine\'s network round trip.')
  lines.push('')
  lines.push('| # | Model | Mean WER | Server | TTFT | Wall (median) | Wall p90 | $/1k clips | ok |')
  lines.push('|---|-------|----------|--------|------|---------------|----------|-----------|----|')
  rows.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${r.id}\` | ${pct(r.meanWer)} | ${ms(r.medianServerMs)} | ${ms(r.medianTtftMs)} | ${ms(r.medianMs)} | ${ms(r.p90Ms)} | $${r.costPer1k.toFixed(2)} | ${r.ok}/${r.total} |`)
  })
  lines.push('')
  lines.push('## Per-clip WER')
  lines.push('')
  lines.push(`| Model | ${fixtures.map((f) => f.name).join(' | ')} |`)
  lines.push(`|-------|${fixtures.map(() => '------').join('|')}|`)
  for (const r of rows) {
    lines.push(`| \`${r.id}\` | ${r.perClip.map((c) => pct(c.wer)).join(' | ')} |`)
  }
  if (rejected.length) {
    lines.push('')
    lines.push('## Rejected in screening')
    lines.push('')
    lines.push('| Model | Reason |')
    lines.push('|-------|--------|')
    for (const x of rejected) lines.push(`| \`${x.id}\` | ${x.reason} |`)
  }
  lines.push('')
  lines.push('## Transcripts')
  for (const r of rows) {
    lines.push('')
    lines.push(`### \`${r.id}\``)
    for (const c of r.perClip) {
      lines.push('')
      lines.push(`- **${c.clip}** (WER ${pct(c.wer)}, ${ms(c.ms)}): ${c.text ? c.text.replace(/\n+/g, ' ') : '—'}`)
      if (c.missed?.length) lines.push(`  - missed: ${c.missed.join(', ')}`)
    }
  }

  const mdPath = join(RESULTS_DIR, `asr-${stamp}.md`)
  writeFileSync(mdPath, lines.join('\n'))
  console.log(`\nwrote ${mdPath}`)
  console.log(`wrote ${jsonPath}`)
  console.table(rows.map((r) => ({ model: r.id, wer: pct(r.meanWer), median: ms(r.medianMs), p90: ms(r.p90Ms) })))
}

main().catch((err) => { console.error(err); process.exit(1) })
