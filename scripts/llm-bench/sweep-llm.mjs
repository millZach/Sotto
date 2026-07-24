// Wide OpenRouter sweep for the Sotto formatting pass.
//
// Phases:
//   1. Catalog — fetch /models, filter to plausible fast text-cleanup models.
//   2. Screen  — every candidate runs 2 fixtures once; drop errors, garbage
//                output, and anything slower than the latency ceiling.
//   3. Deep    — survivors (plus the current tier baselines) run the
//                remaining fixtures.
//   4. Judge   — a strong model scores every output against the cleanup spec.
//
// Usage:
//   node scripts/llm-bench/sweep-llm.mjs                # full sweep (~100 models)
//   node scripts/llm-bench/sweep-llm.mjs --limit 60
//   node scripts/llm-bench/sweep-llm.mjs --survivors 25
//
// Writes a markdown report to scripts/llm-bench/results/.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DICTIONARY, buildSystemPrompt, buildUserPrompt } from './prompt.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')
const OPENROUTER = 'https://openrouter.ai/api/v1'

const SCREEN_FIXTURES = ['02-short', '05-technical']
const SCREEN_TIMEOUT_MS = 12_000
const LATENCY_CEILING_MS = 5_000 // slower than the high tier's deadline is useless
const JUDGE_MODEL = 'anthropic/claude-sonnet-5'
const CONCURRENCY = 8

// Current tier models: always deep-benched so every candidate has a baseline.
const BASELINES = [
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemini-3.5-flash',
  'anthropic/claude-haiku-4.5',
]

// Model ids that can never be a dictation cleanup model: routers, code/image/
// audio specialists, alias slugs, roleplay tunes.
const EXCLUDE = /(^~|^openrouter\/|coder|codex|-code\b|image|audio|vision|search|agent|thinking|devstral|-her\b|roleplay|guard|embed)/i

function parseArgs(argv) {
  const args = { limit: 100, survivors: 25, judge: true, only: null, runs: 1 }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--limit': args.limit = Number(val); if (!inlineVal) i++; break
      case '--survivors': args.survivors = Number(val); if (!inlineVal) i++; break
      case '--no-judge': args.judge = false; break
      // Head-to-head mode: skip screening, bench only these models (substring
      // match), all fixtures x --runs, judge everything.
      case '--only': args.only = val.split(','); if (!inlineVal) i++; break
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const keyFile = join(HERE, '.openrouter-key')
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim()
  throw new Error('no OPENROUTER_API_KEY and no scripts/llm-bench/.openrouter-key')
}

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => ({
      name: basename(f, '.txt'),
      text: readFileSync(join(FIXTURE_DIR, f), 'utf8').trim(),
    }))
}

async function fetchCandidates(apiKey, limit) {
  const res = await fetch(`${OPENROUTER}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const { data } = await res.json()
  const viable = data.filter((m) => {
    const inMod = m.architecture?.input_modalities ?? []
    const outMod = m.architecture?.output_modalities ?? []
    if (!inMod.includes('text') || !outMod.includes('text')) return false
    if (EXCLUDE.test(m.id)) return false
    if ((m.context_length ?? 0) < 8_000) return false
    const pIn = parseFloat(m.pricing?.prompt ?? '0')
    const pOut = parseFloat(m.pricing?.completion ?? '0')
    if (pIn < 0 || pOut < 0) return false // router pseudo-pricing
    if (m.id.endsWith(':free')) return false // hard rate limits skew latency
    if (pIn > 0.0000025 || pOut > 0.000012) return false // skip flagship pricing
    return true
  })
  viable.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  const picked = viable.slice(0, limit)
  for (const id of BASELINES) {
    if (!picked.some((m) => m.id === id)) {
      const found = data.find((m) => m.id === id)
      if (found) picked.push(found)
    }
  }
  return picked
}

// reasoningMode: 'off' -> {enabled:false}; 'minimal' -> {effort:'minimal'}
// (for endpoints where reasoning is mandatory); 'omit' -> no param at all.
async function runModel(apiKey, modelId, transcript, timeoutMs, reasoningMode = 'off') {
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(transcript) },
    ],
    max_tokens: 2_000,
    ...(reasoningMode === 'off'
      ? { reasoning: { enabled: false } }
      : reasoningMode === 'minimal'
        ? { reasoning: { effort: 'minimal' } }
        : {}),
  }
  const t0 = performance.now()
  try {
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json()
    const ms = performance.now() - t0
    if (!res.ok || json.error) {
      const message = json.error?.message ?? `HTTP ${res.status}`
      // Escalate through reasoning modes: mandatory-reasoning endpoints get
      // minimal effort; hosts that reject the unified param get none at all.
      if (/reasoning/i.test(message)) {
        if (reasoningMode === 'off') return runModel(apiKey, modelId, transcript, timeoutMs, 'minimal')
        if (reasoningMode === 'minimal') return runModel(apiKey, modelId, transcript, timeoutMs, 'omit')
      }
      return { ms, error: message }
    }
    return {
      ms,
      output: json.choices?.[0]?.message?.content?.trim() ?? '',
      tokens: json.usage?.completion_tokens,
      cost: json.usage?.cost,
      servedBy: json.provider,
      reasoningMode,
    }
  } catch (e) {
    return { ms: performance.now() - t0, error: e.name === 'TimeoutError' ? 'timeout' : e.message }
  }
}

function saneOutput(input, output) {
  if (!output || output.length === 0) return false
  if (output.length > input.length * 3 + 200) return false
  if (output.length < input.length * 0.3) return false
  if (/^(here is|here's|cleaned|transcript:|sure)/i.test(output)) return false
  return true
}

async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
  return results
}

const JUDGE_RUBRIC = `You are grading a speech-to-text cleanup model for a dictation app. The model was told to: add punctuation/capitalization/sentence breaks; remove only "um"/"uh" fillers (keep "like"/"you know"); fix obvious mis-hearings from context; resolve self-corrections (keep only the corrected version, drop the correction phrase); honor spoken "new line"/"new paragraph"; never rewrite, summarize, restructure, or add content; output only the cleaned text.

Score the OUTPUT against the RAW transcript from 0-10:
- 10: flawless cleanup, fully faithful.
- Deduct heavily (3+) for: added/invented content, dropped meaning, summarizing, unresolved or wrongly-resolved self-corrections, preamble/quotes around the text.
- Deduct 1-2 for: missed fillers, punctuation/casing mistakes, missed dictionary-word corrections, removed words it should have kept.

The personal dictionary is: ${DICTIONARY.join(', ')}. Correcting a mis-heard or mis-spelled word TOWARD one of these dictionary spellings (e.g. "zack"/"Zach" -> "Zache", "wisper flow" -> "Wispr Flow", "o n n x" -> "onnx") is REQUIRED behavior — never penalize it; penalize leaving the mis-heard spelling in place instead.

Reply with ONLY a JSON object: {"score": <number>, "issue": "<main defect or 'none'>"}`

async function judgeOutput(apiKey, raw, output) {
  const body = {
    model: JUDGE_MODEL,
    messages: [
      { role: 'system', content: JUDGE_RUBRIC },
      { role: 'user', content: `RAW:\n${raw}\n\nOUTPUT:\n${output}` },
    ],
    max_tokens: 300,
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${OPENROUTER}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const json = await res.json()
      const text = json.choices?.[0]?.message?.content ?? ''
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (typeof parsed.score === 'number') return parsed
      }
    } catch {
      // retry once
    }
  }
  return { score: null, issue: 'judge failed' }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  return s.length === 0 ? null : s[Math.floor(s.length / 2)]
}

async function main() {
  const args = parseArgs(process.argv)
  const apiKey = loadApiKey()
  const fixtures = loadFixtures()
  const fixtureByName = Object.fromEntries(fixtures.map((f) => [f.name, f]))

  // ---- phase 1: catalog ----
  const candidates = await fetchCandidates(apiKey, args.limit)
  console.log(`Phase 1: ${candidates.length} candidates from catalog`)

  let survivors
  let screened = []
  let passed = []
  if (args.only) {
    // Head-to-head: no screening; every listed model runs all fixtures x runs.
    survivors = candidates
      .filter((m) => args.only.some((q) => m.id.includes(q)))
      .map((m) => ({ model: m, runs: [] }))
    passed = survivors
    console.log(`Head-to-head: ${survivors.map((s) => s.model.id).join(', ')}`)
    await pool(
      survivors.flatMap((s) => fixtures.flatMap((fx) => Array.from({ length: args.runs }, () => ({ s, fx })))),
      async ({ s, fx }) => {
        const r = await runModel(apiKey, s.model.id, fx.text, SCREEN_TIMEOUT_MS)
        s.runs.push({ fixture: fx.name, ...r })
        console.log(`[deep] ${s.model.id}  ${fx.name}  ${r.error ? 'ERR ' + r.error : Math.round(r.ms) + ' ms'}`)
      },
    )
  } else {
    // ---- phase 2: screen ----
    const screenFixtures = SCREEN_FIXTURES.map((n) => fixtureByName[n])
    screened = await pool(candidates, async (m) => {
      const runs = []
      for (const fx of screenFixtures) {
        const r = await runModel(apiKey, m.id, fx.text, SCREEN_TIMEOUT_MS)
        runs.push({ fixture: fx.name, ...r })
        console.log(`[screen] ${m.id}  ${fx.name}  ${r.error ? 'ERR ' + r.error : Math.round(r.ms) + ' ms'}`)
      }
      return { model: m, runs }
    })

    passed = screened.filter(({ runs }) =>
      runs.every(
        (r) =>
          !r.error &&
          r.ms <= LATENCY_CEILING_MS &&
          saneOutput(fixtureByName[r.fixture].text, r.output),
      ),
    )
    passed.sort((a, b) => Math.max(...a.runs.map((r) => r.ms)) - Math.max(...b.runs.map((r) => r.ms)))
    survivors = passed.slice(0, args.survivors)
    for (const id of BASELINES) {
      if (!survivors.some((s) => s.model.id === id)) {
        const s = screened.find((x) => x.model.id === id)
        if (s) survivors.push(s)
      }
    }
    console.log(`\nPhase 2: ${passed.length}/${candidates.length} passed screen; deep-benching ${survivors.length}`)

    // ---- phase 3: deep bench (remaining fixtures) ----
    const deepFixtures = fixtures.filter((f) => !SCREEN_FIXTURES.includes(f.name))
    await pool(survivors, async (s) => {
      for (const fx of deepFixtures) {
        const r = await runModel(apiKey, s.model.id, fx.text, SCREEN_TIMEOUT_MS)
        s.runs.push({ fixture: fx.name, ...r })
        console.log(`[deep] ${s.model.id}  ${fx.name}  ${r.error ? 'ERR ' + r.error : Math.round(r.ms) + ' ms'}`)
      }
    })
  }

  // ---- phase 4: judge ----
  if (args.judge) {
    const jobs = survivors.flatMap((s) =>
      s.runs.filter((r) => !r.error && r.output).map((r) => ({ s, r })),
    )
    console.log(`\nPhase 4: judging ${jobs.length} outputs with ${JUDGE_MODEL}`)
    await pool(jobs, async ({ s, r }) => {
      const verdict = await judgeOutput(apiKey, fixtureByName[r.fixture].text, r.output)
      r.judge = verdict
      console.log(`[judge] ${s.model.id}  ${r.fixture}  ${verdict.score ?? 'ERR'}${verdict.issue && verdict.issue !== 'none' ? '  (' + verdict.issue + ')' : ''}`)
    })
  }

  // ---- report ----
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportPath = join(RESULTS_DIR, `sweep-${stamp}.md`)

  const rows = survivors.map((s) => {
    const ok = s.runs.filter((r) => !r.error)
    const scores = s.runs.map((r) => r.judge?.score).filter((x) => typeof x === 'number')
    const issues = s.runs
      .map((r) => r.judge?.issue)
      .filter((x) => x && x !== 'none')
    return {
      id: s.model.id,
      baseline: BASELINES.includes(s.model.id),
      medianMs: median(ok.map((r) => r.ms)),
      maxMs: ok.length ? Math.max(...ok.map((r) => r.ms)) : null,
      errors: s.runs.filter((r) => r.error).length,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      minScore: scores.length ? Math.min(...scores) : null,
      pricing: s.model.pricing,
      issues: [...new Set(issues)].slice(0, 3),
      runs: s.runs,
    }
  })
  rows.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1) || (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9))

  let md = `# LLM formatting sweep — ${new Date().toISOString()}\n\n`
  md += `Screened ${candidates.length} models on ${SCREEN_FIXTURES.join(', ')}; ${passed.length} passed (no errors, <${LATENCY_CEILING_MS} ms, sane output). Deep-benched ${survivors.length} on all ${fixtures.length} fixtures. Judge: ${JUDGE_MODEL}.\n\n`
  md += `| Model | Avg score | Min score | Median ms | Max ms | Errors | $/M in | $/M out | Issues |\n|---|---|---|---|---|---|---|---|---|\n`
  for (const r of rows) {
    md += `| ${r.baseline ? '**' + r.id + '** (baseline)' : r.id} | ${r.avgScore?.toFixed(2) ?? '—'} | ${r.minScore ?? '—'} | ${r.medianMs === null ? '—' : Math.round(r.medianMs)} | ${r.maxMs === null ? '—' : Math.round(r.maxMs)} | ${r.errors} | ${(parseFloat(r.pricing?.prompt ?? 0) * 1e6).toFixed(2)} | ${(parseFloat(r.pricing?.completion ?? 0) * 1e6).toFixed(2)} | ${r.issues.join('; ')} |\n`
  }

  md += `\n## Screen failures\n\n`
  for (const s of screened.filter((x) => !passed.includes(x))) {
    const why = s.runs
      .map((r) => (r.error ? `${r.fixture}: ${r.error}` : r.ms > LATENCY_CEILING_MS ? `${r.fixture}: ${Math.round(r.ms)} ms` : saneOutput(fixtureByName[r.fixture].text, r.output) ? null : `${r.fixture}: bad output`))
      .filter(Boolean)
    md += `- ${s.model.id} — ${why.join('; ') || 'below survivor cutoff'}\n`
  }

  md += `\n## Outputs\n`
  for (const r of rows) {
    md += `\n### ${r.id}\n`
    for (const run of r.runs) {
      md += `\n**${run.fixture}** (${run.error ? 'ERROR: ' + run.error : Math.round(run.ms) + ' ms' + (run.judge ? `, score ${run.judge.score}` : '')}):\n\n`
      if (!run.error) md += `> ${run.output.replace(/\n/g, '\n> ')}\n`
    }
  }

  writeFileSync(reportPath, md)
  console.log(`\nReport: ${reportPath}`)

  // Console summary for quick reading
  console.log('\n=== TOP 15 (avg judge score, then latency) ===')
  for (const r of rows.slice(0, 15)) {
    console.log(
      `${r.avgScore?.toFixed(2) ?? ' — '}  ${String(Math.round(r.medianMs ?? 0)).padStart(5)} ms  ${r.errors ? `[${r.errors} ERR] ` : ''}${r.id}${r.baseline ? '  <- baseline' : ''}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
