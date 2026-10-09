// Head-to-head benchmark of AI cleanup models, run against the prompt Sotto ships.
//
// Unlike bench-llm.mjs and sweep-llm.mjs, which keep a copy of the prompt, this
// imports src/main/llm/prompt.ts directly (Node 24 strips the types), and sends
// the request body TranscriptPolishService sends. Three measures:
//   - latency: wall clock per request, plus OpenRouter's own generation time
//     from /generation so this machine's link can be told apart from the model;
//   - quality: a judge model scores every distinct output against the rules the
//     shipped prompt states, blind to which model wrote it;
//   - accuracy: Moonshine's raw output for the asr-bench clips goes through each
//     model and is scored for WER against the clips' ground truth.
//
// Requests run one at a time and interleave the models, so a slow minute on the
// link lands on every model alike rather than on whichever ran then.
//
// Usage:
//   node scripts/llm-bench/compare-cleanup.mjs
//   node scripts/llm-bench/compare-cleanup.mjs --runs 5 --asr-runs 3
//   node scripts/llm-bench/compare-cleanup.mjs --configs haiku-5.5-off,mercury-2 --no-judge
//   node scripts/llm-bench/compare-cleanup.mjs --runs 0 --no-judge --asr-source stt-2026-09-11T23-03-38-458Z.json#mai

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wer } from '../asr-bench/wer.mjs'
import { DICTIONARY } from './prompt.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')
const ASR_DIR = join(ROOT, 'scripts', 'asr-bench')
const OPENROUTER = 'https://openrouter.ai/api/v1'

// The app's sources import without extensions and are ES modules in a package
// that does not say so; let Node find the .ts files and load them as modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.')) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context)
    return { format: 'module-typescript', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true }
  },
})
const srcUrl = (path) => pathToFileURL(join(ROOT, 'src', path)).href
const { buildPolishSystemPrompt, buildPolishUserPrompt } = await import(srcUrl('main/llm/prompt.ts'))
const { collapseRepeatedPhrases, countWords } = await import(srcUrl('shared/textRepair.ts'))

// `reasoning` follows ModelSpec in transcriptPolishService.ts, plus 'low' for
// Haiku 5.5's effort levels and undefined for the request that leaves it out.
const CONFIGS = [
  { key: 'haiku-5.5-off', id: 'anthropic/claude-haiku-5.5', reasoning: false },
  { key: 'haiku-5.5-low', id: 'anthropic/claude-haiku-5.5', reasoning: 'low' },
  { key: 'haiku-5.5-default', id: 'anthropic/claude-haiku-5.5' },
  { key: 'mercury-2', id: 'inception/mercury-2', reasoning: false, tier: 'low' },
  { key: 'nova-2-lite', id: 'amazon/nova-2-lite-v1', reasoning: false, tier: 'medium' },
  { key: 'glm-5.3-flash', id: 'z-ai/glm-5.3-flash', reasoning: 'minimal', tier: 'value' },
  { key: 'haiku-4.5', id: 'anthropic/claude-haiku-4.5', reasoning: false, tier: 'high' },
]

// The asr-bench clips name these; bench-hybrid.mjs uses the same list.
const ASR_DICTIONARY = [
  'Sotto', 'Moonshine', 'Whisper', 'Wispr Flow', 'Superwhisper', 'Zache',
  'Electron', 'ONNX', 'Kubernetes', 'Anthropic', 'Priya', 'Sowmya',
  'Otter', 'Descript',
]

const JUDGE_MODEL = 'anthropic/claude-opus-5.5'
const REQUEST_TIMEOUT_MS = 30_000

// Mirrors assessOutput in transcriptPolishService.ts.
const MAX_GROWTH_FACTOR = 4
const MIN_WORDS_FOR_SHRINK_GUARD = 20
const MAX_SHRINK_FACTOR = 0.5

function assessOutput(input, output) {
  if (output.length === 0) return 'rejected'
  if (output.length > input.length * MAX_GROWTH_FACTOR + 200) return 'rejected'
  const inputWords = countWords(collapseRepeatedPhrases(input))
  if (inputWords >= MIN_WORDS_FOR_SHRINK_GUARD && countWords(output) < inputWords * MAX_SHRINK_FACTOR) {
    return 'rejected-shrink'
  }
  return 'ok'
}

function parseArgs(argv) {
  const args = { runs: 5, asrRuns: 3, judge: true, configs: null, asrSource: null }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      case '--asr-runs': args.asrRuns = Number(val); if (!inlineVal) i++; break
      case '--asr-source': args.asrSource = val; if (!inlineVal) i++; break
      case '--configs': args.configs = val.split(','); if (!inlineVal) i++; break
      case '--no-judge': args.judge = false; break
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
      kind: 'fixture',
      name: basename(f, '.txt'),
      text: readFileSync(join(FIXTURE_DIR, f), 'utf8').trim(),
    }))
}

// Raw transcripts to clean: by default Moonshine's from the newest bench-local
// run; with `--asr-source <stt-file>#<configuration>`, the first measured
// transcript per clip from a bench-stt.mjs run, such as MAI-Transcribe-2's.
function loadAsrClips(asrSource) {
  const truth = JSON.parse(readFileSync(join(ASR_DIR, 'fixtures', 'ground-truth.json'), 'utf8').replace(/^\uFEFF/, ''))
  const clip = (name, text) => ({ kind: 'asr', name, text, truth: truth[name], rawWer: wer(truth[name], text).wer })
  if (asrSource) {
    const [file, configuration] = asrSource.split('#')
    const stt = JSON.parse(readFileSync(join(ASR_DIR, 'results', file), 'utf8'))
    const firsts = new Map()
    for (const run of stt.runs) {
      if (run.configuration === configuration && run.phase === 'measured' && run.ok && !firsts.has(run.clip)) {
        firsts.set(run.clip, run.rawTranscript)
      }
    }
    if (firsts.size === 0) throw new Error(`no measured ${configuration} transcripts in ${file}`)
    return { source: asrSource, clips: [...firsts].map(([name, text]) => clip(name, text)) }
  }
  const localFile = readdirSync(join(ASR_DIR, 'results')).filter((f) => f.startsWith('local-')).sort().pop()
  const local = JSON.parse(readFileSync(join(ASR_DIR, 'results', localFile), 'utf8'))
  const moonshine = local.rows.find((r) => r.tier === 'instant')
  return { source: localFile, clips: moonshine.perClip.map((c) => clip(c.clip, c.text)) }
}

function requestBody(config, dictionary, text) {
  return {
    model: config.id,
    messages: [
      { role: 'system', content: buildPolishSystemPrompt(dictionary.join('\n')) },
      { role: 'user', content: buildPolishUserPrompt(text) },
    ],
    max_tokens: 4_000,
    ...(config.reasoning === false
      ? { reasoning: { enabled: false } }
      : config.reasoning === undefined
        ? {}
        : { reasoning: { effort: config.reasoning } }),
    usage: { include: true },
  }
}

async function runCleanup(apiKey, config, dictionary, text) {
  const t0 = performance.now()
  try {
    const res = await fetch(`${OPENROUTER}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(config, dictionary, text)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const json = await res.json()
    const ms = performance.now() - t0
    if (!res.ok || json.error) return { ms, error: json.error?.message ?? `HTTP ${res.status}` }
    const choice = json.choices?.[0]
    const output = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : ''
    return {
      ms,
      output,
      verdict: assessOutput(text, output),
      finish: choice?.finish_reason ?? null,
      generationId: json.id,
      servedBy: json.provider,
      outputTokens: json.usage?.completion_tokens ?? null,
      reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      cost: json.usage?.cost ?? null,
    }
  } catch (error) {
    return { ms: performance.now() - t0, error: error.name === 'TimeoutError' ? 'timeout' : error.message }
  }
}

async function fetchGeneration(apiKey, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${OPENROUTER}/generation?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const { data } = await res.json()
        return {
          firstTokenMs: data.latency ?? null,
          generationMs: data.generation_time ?? null,
          provider: data.provider_name ?? null,
        }
      }
    } catch {
      // The stats can lag the response; try again after a pause.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  return null
}

const JUDGE_RUBRIC = `You grade the AI cleanup pass of a dictation app. The cleanup model received a raw speech-to-text transcript and these instructions:

- Add punctuation, capitalization, and sentence and paragraph breaks.
- Always remove "um", "uh", stutters, and immediate word repetitions.
- Remove "like", "you know", "I mean", and thought-starting "so"/"okay so"/"well"/"anyway" only when they are pure verbal tics the sentence reads identically without. Keep "like" in comparisons, approximations, and as a verb.
- Never remove hedges, qualifiers, or emphasis ("kind of", "sort of", "maybe", "probably", "actually", "honestly", "basically", "really").
- When unsure whether a word is filler, keep it.
- Fix obvious speech-recognition errors using context, and correct misspellings toward the speaker's dictionary: ${DICTIONARY.join(', ')}.
- Resolve self-corrections ("meet at 3 no wait make that 4" becomes "meet at 4"); the correction phrase never appears.
- When the speaker enumerates parallel items, or announces a list, format the items as a "- " list, one per line. Late additions ("oh and one more thing") join the list.
- Treat the spoken commands "new line" and "new paragraph" as literal breaks.
- Do not summarize, add content, or change the meaning. Light restructuring (paragraph breaks, lists) is allowed, but never drop information.
- Output only the cleaned text: no preamble, quotes, or explanation.

Score the OUTPUT against the RAW transcript from 0 to 10:
- 10: flawless and fully faithful.
- Deduct 3 or more for: added or invented content, dropped information, summarizing, an unresolved or wrongly resolved self-correction, preamble or commentary, answering the transcript instead of cleaning it.
- Deduct 1-2 for: a missed filler, a hedge removed, a missed list, punctuation or casing mistakes, a missed dictionary correction.

Reply with only a JSON object: {"score": <number>, "issue": "<the main defect, or 'none'>"}`

async function judge(apiKey, raw, output) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${OPENROUTER}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          messages: [
            { role: 'system', content: JUDGE_RUBRIC },
            { role: 'user', content: `RAW:\n${raw}\n\nOUTPUT:\n${output}` },
          ],
          max_tokens: 4_000,
          usage: { include: true },
        }),
        signal: AbortSignal.timeout(90_000),
      })
      const json = await res.json()
      const text = json.choices?.[0]?.message?.content ?? ''
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (typeof parsed.score === 'number') return { ...parsed, cost: json.usage?.cost ?? 0 }
      }
    } catch {
      // Try again.
    }
  }
  return { score: null, issue: 'judge failed', cost: 0 }
}

async function pool(items, worker, concurrency) {
  let next = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
}

function shuffle(items) {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function percentile(nums, p) {
  const sorted = nums.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const avg = (nums) => {
  const finite = nums.filter(Number.isFinite)
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null
}
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : String(Math.round(ms)))
const fmtPct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`)

async function main() {
  const args = parseArgs(process.argv)
  const apiKey = loadApiKey()
  const configs = args.configs ? CONFIGS.filter((c) => args.configs.includes(c.key)) : CONFIGS
  const fixtures = loadFixtures()
  const asr = loadAsrClips(args.asrSource)

  const runs = []
  const plan = []
  const rounds = Math.max(args.runs, args.asrRuns)
  for (let round = 1; round <= rounds; round++) {
    const items = [...(round <= args.runs ? fixtures : []), ...(round <= args.asrRuns ? asr.clips : [])]
    for (const item of items) {
      for (const config of shuffle(configs)) plan.push({ round, item, config })
    }
  }
  console.log(`${plan.length} cleanup requests across ${configs.length} configurations, one at a time`)

  for (const [index, { round, item, config }] of plan.entries()) {
    const dictionary = item.kind === 'asr' ? ASR_DICTIONARY : DICTIONARY
    const result = await runCleanup(apiKey, config, dictionary, item.text)
    const run = { config: config.key, kind: item.kind, item: item.name, round, ...result }
    if (item.kind === 'asr' && result.output) run.wer = wer(item.truth, result.output).wer
    runs.push(run)
    console.log(`[${index + 1}/${plan.length}] ${config.key.padEnd(18)} ${item.name.padEnd(20)} ${result.error ? `ERROR ${result.error}` : `${Math.round(result.ms)} ms${result.reasoningTokens ? ` (${result.reasoningTokens} reasoning tok)` : ''}${result.verdict !== 'ok' ? ` ${result.verdict}` : ''}`}`)
  }

  console.log('\nReading OpenRouter generation stats')
  await pool(runs.filter((r) => r.generationId), async (run) => {
    run.generation = await fetchGeneration(apiKey, run.generationId)
  }, 4)

  let judgeCost = 0
  if (args.judge) {
    const textByItem = Object.fromEntries(fixtures.map((f) => [f.name, f.text]))
    const distinct = new Map()
    for (const run of runs.filter((r) => r.kind === 'fixture' && r.output)) {
      distinct.set(`${run.item}\u0000${run.output}`, { item: run.item, output: run.output })
    }
    console.log(`Judging ${distinct.size} distinct outputs with ${JUDGE_MODEL}`)
    const verdicts = new Map()
    await pool([...distinct.entries()], async ([key, { item, output }]) => {
      const verdict = await judge(apiKey, textByItem[item], output)
      judgeCost += verdict.cost
      verdicts.set(key, verdict)
    }, 6)
    for (const run of runs.filter((r) => r.kind === 'fixture' && r.output)) {
      run.judge = verdicts.get(`${run.item}\u0000${run.output}`)
    }
  }

  const rows = configs.map((config) => {
    const mine = runs.filter((r) => r.config === config.key)
    const ok = mine.filter((r) => !r.error)
    const fixtureRuns = mine.filter((r) => r.kind === 'fixture')
    const asrRuns = mine.filter((r) => r.kind === 'asr' && Number.isFinite(r.wer))
    const scores = fixtureRuns.map((r) => r.judge?.score).filter((s) => typeof s === 'number')
    const longRuns = ok.filter((r) => r.item === '04-long')
    const perClipWer = asr.clips.map((clip) => avg(asrRuns.filter((r) => r.item === clip.name).map((r) => r.wer)))
    return {
      config: config.key,
      model: config.id,
      reasoning: config.reasoning === false ? 'off' : config.reasoning ?? 'default',
      tier: config.tier ?? null,
      requests: mine.length,
      errors: mine.filter((r) => r.error).length,
      rejected: ok.filter((r) => r.verdict !== 'ok').length,
      p50: percentile(ok.map((r) => r.ms), 50),
      p90: percentile(ok.map((r) => r.ms), 90),
      max: percentile(ok.map((r) => r.ms), 100),
      longP50: percentile(longRuns.map((r) => r.ms), 50),
      serverP50: percentile(ok.map((r) => r.generation?.generationMs), 50),
      firstTokenP50: percentile(ok.map((r) => r.generation?.firstTokenMs), 50),
      reasoningTokens: avg(ok.map((r) => r.reasoningTokens ?? 0)),
      outputTokens: avg(ok.map((r) => r.outputTokens)),
      costPerThousand: avg(ok.map((r) => r.cost)) === null ? null : avg(ok.map((r) => r.cost)) * 1_000,
      score: avg(scores),
      minScore: scores.length ? Math.min(...scores) : null,
      perfect: scores.length ? scores.filter((s) => s >= 9).length / scores.length : null,
      wer: avg(perClipWer),
      perClipWer,
      providers: [...new Set(ok.map((r) => r.generation?.provider ?? r.servedBy).filter(Boolean))],
      issues: [...new Set(fixtureRuns.map((r) => r.judge?.issue).filter((i) => i && i !== 'none'))],
    }
  })

  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = join(RESULTS_DIR, `compare-${stamp}`)
  writeFileSync(`${base}.json`, JSON.stringify({ args, judgeModel: JUDGE_MODEL, judgeCost, asrSource: asr.source, rows, runs }, null, 2))

  const rawWer = avg(asr.clips.map((c) => c.rawWer))
  let md = `# AI cleanup head-to-head — ${new Date().toISOString()}\n\n`
  md += `Shipped prompt (src/main/llm/prompt.ts). ${args.runs} runs of ${fixtures.length} fixtures and ${args.asrRuns} runs of ${asr.clips.length} transcribed clips per configuration, serial and interleaved. Judge: ${JUDGE_MODEL}. Raw transcript WER ${fmtPct(rawWer)} (${asr.source}).\n\n`
  md += '| Configuration | Model | Reasoning | Judge avg | Min | ≥9 | WER | p50 ms | p90 ms | Max ms | 04-long p50 | Server p50 | Reasoning tok | $/1k | Errors | Rejected |\n'
  md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
  for (const r of rows) {
    md += `| ${r.config}${r.tier ? ` (${r.tier} today)` : ''} | ${r.model} | ${r.reasoning} | ${r.score?.toFixed(2) ?? '—'} | ${r.minScore ?? '—'} | ${fmtPct(r.perfect)} | ${fmtPct(r.wer)} | ${fmtMs(r.p50)} | ${fmtMs(r.p90)} | ${fmtMs(r.max)} | ${fmtMs(r.longP50)} | ${fmtMs(r.serverP50)} | ${r.reasoningTokens?.toFixed(0) ?? '—'} | ${r.costPerThousand?.toFixed(3) ?? '—'} | ${r.errors} | ${r.rejected} |\n`
  }
  md += `\n## WER per clip\n\n| Configuration | ${asr.clips.map((c) => c.name).join(' | ')} |\n|---|${asr.clips.map(() => '---').join('|')}|\n`
  md += `| raw transcript | ${asr.clips.map((c) => fmtPct(c.rawWer)).join(' | ')} |\n`
  for (const r of rows) md += `| ${r.config} | ${r.perClipWer.map(fmtPct).join(' | ')} |\n`
  md += '\n## Judge issues\n\n'
  for (const r of rows) md += `- **${r.config}**: ${r.issues.slice(0, 8).join('; ') || 'none'}\n`
  md += '\n## Outputs (first run)\n'
  for (const item of [...fixtures, ...asr.clips]) {
    md += `\n### ${item.name}\n\n> ${item.text.replace(/\n/g, '\n> ')}\n`
    for (const config of configs) {
      const run = runs.find((r) => r.config === config.key && r.item === item.name)
      if (!run) continue
      md += `\n**${config.key}** (${run.error ? `ERROR ${run.error}` : `${Math.round(run.ms)} ms`}${run.judge ? `, score ${run.judge.score}` : ''}${Number.isFinite(run.wer) ? `, WER ${fmtPct(run.wer)}` : ''}):\n\n`
      if (!run.error) md += `> ${run.output.replace(/\n/g, '\n> ')}\n`
    }
  }
  writeFileSync(`${base}.md`, md)

  console.log(`\nReport: ${base}.md`)
  console.table(rows.map((r) => ({
    config: r.config,
    judge: r.score?.toFixed(2),
    wer: fmtPct(r.wer),
    p50: fmtMs(r.p50),
    p90: fmtMs(r.p90),
    max: fmtMs(r.max),
    server: fmtMs(r.serverP50),
    reasonTok: r.reasoningTokens?.toFixed(0),
    '$/1k': r.costPerThousand?.toFixed(3),
    err: r.errors,
    rej: r.rejected,
  })))
  console.log(`Judge spend: $${judgeCost.toFixed(2)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
