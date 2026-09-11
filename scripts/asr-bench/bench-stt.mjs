// Does OpenRouter MAI beat Forge Parakeet plus Sotto's medium cleanup pass,
// and where do Voxtral Mini Transcribe 2 and GPT Transcribe land?
//
// Sends the seven synthetic WAV fixtures, serially. Times from before fetch
// through parsed transcript, including retries; cleanup has its own leg.
// WER stays frozen for historical comparisons. Names use exact normalized
// token matching, not aligned span WER. No recordings from dictation history.
//
// Usage:
//   node scripts/asr-bench/bench-stt.mjs --smoke
//   node scripts/asr-bench/bench-stt.mjs --screen                 # default
//   node scripts/asr-bench/bench-stt.mjs --full --runs 30         # opt-in
//   node scripts/asr-bench/bench-stt.mjs --only mai,mai+hints --budget 2
//   node scripts/asr-bench/bench-stt.mjs --forge-url http://host:5092
//
// Writes stt-<stamp>.json + .md in results. Warmups and hint probes are
// excluded from scores but retained and charged. No API keys are persisted.
// The cleanup deadline mirrors production: max(user timeout 2500ms, medium
// tier floor 7000ms) plus min(9000, 30ms per word), so a timed-out cleanup
// here means a timed-out cleanup in the app.

/* global AbortSignal */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mean, median } from './stats.mjs'
import { normalize, wer, missedWords } from './wer.mjs'
import { scoreProperNouns, shouldSkipCleanup } from './stt-scoring.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API = 'https://openrouter.ai/api/v1'
const DICTIONARY = ['Sotto', 'Moonshine', 'Whisper', 'Wispr Flow', 'Superwhisper', 'Zache',
  'Electron', 'ONNX', 'Kubernetes', 'Anthropic', 'Priya', 'Sowmya', 'Otter', 'Descript']
const MODELS = {
  'forge-parakeet': { model: 'parakeet-tdt-0.6b', minute: 0 },
  mai: { model: 'microsoft/mai-transcribe-2', minute: 0.001667 },
  voxtral: { model: 'mistralai/voxtral-mini-transcribe', minute: 0.0033 },
  gpt: { model: 'openai/gpt-transcribe', minute: 0.0045 },
}
const CONFIGS = Object.entries(MODELS).flatMap(([base, spec]) =>
  ['', ...(base === 'forge-parakeet' ? [] : ['+hints']), '+cleanup'].map((suffix) => ({
    id: base + suffix, base, ...spec, hints: suffix === '+hints', cleanup: suffix === '+cleanup',
    requestForm: suffix === '+hints' ? 'json/input_audio/wav' : 'multipart/file/wav',
  })))
const CLEANUP = [
  { model: 'amazon/nova-2-lite-v1', reasoning: { enabled: false } },
  { model: 'google/gemini-3.1-flash-lite', reasoning: { effort: 'minimal' } },
]
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const hash = (text) => createHash('sha256').update(text).digest('hex')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const p95 = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] : null
const average = (xs) => xs.length ? mean(xs) : null
const distribution = (xs) => xs.reduce((out, x) => { out[x] = (out[x] ?? 0) + 1; return out }, {})
const percent = (x) => x == null ? 'N/A' : `${(x * 100).toFixed(1)}%`
const dollars = (x) => x == null ? 'N/A' : `$${x.toFixed(6)}`
const latency = (xs) => xs.length ? `${Math.round(median(xs))}/${Math.round(p95(xs))}` : 'not measured'

function parseArgs(argv) {
  const args = { mode: 'screen', runs: 30, budget: 2, only: null, forgeUrl: 'http://forge.tail5728ca.ts.net:5092' }
  let explicitMode = false
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=')
    if (['--screen', '--full', '--smoke'].includes(flag)) {
      if (explicitMode) throw new Error('Choose one mode')
      args.mode = flag.slice(2); explicitMode = true; continue
    }
    const value = inline ?? argv[++i]
    if (!value || value.startsWith('--')) throw new Error('Missing option value')
    if (flag === '--runs') args.runs = Number(value)
    else if (flag === '--budget') args.budget = Number(value)
    else if (flag === '--only') args.only = value.split(',')
    else if (flag === '--forge-url') args.forgeUrl = value.replace(/\/+$/u, '')
    else throw new Error('Unknown argument')
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || !Number.isFinite(args.budget) || args.budget <= 0) {
    throw new Error('Runs must be a positive integer and budget must be positive')
  }
  if (args.only?.some((id) => !CONFIGS.some((c) => c.id === id))) throw new Error('Unknown configuration')
  const url = new URL(args.forgeUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Forge URL must be HTTP(S) without credentials, query or fragment')
  }
  args.runs = args.mode === 'smoke' ? 1 : args.mode === 'screen' ? 5 : args.runs
  return args
}

function loadFixtures() {
  const truth = readJson(join(HERE, 'fixtures/ground-truth.json'))
  const names = readJson(join(HERE, 'fixtures/proper-nouns.json'))
  return Object.entries(truth).map(([clip, reference]) => {
    const wav = readFileSync(join(HERE, `fixtures/speech-${clip}.wav`))
    let dataBytes = null
    let format = null
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV')
    for (let offset = 12; offset + 8 <= wav.length;) {
      const kind = wav.toString('ascii', offset, offset + 4)
      const size = wav.readUInt32LE(offset + 4)
      if (offset + 8 + size > wav.length) throw new Error('Truncated WAV')
      if (kind === 'fmt ') format = [wav.readUInt16LE(offset + 8), wav.readUInt16LE(offset + 10), wav.readUInt32LE(offset + 12), wav.readUInt16LE(offset + 22)]
      if (kind === 'data') dataBytes = size
      offset += 8 + size + (size % 2)
    }
    if (String(format) !== '1,1,16000,16' || !dataBytes) throw new Error('Expected 16kHz mono PCM16 WAV')
    if (!Array.isArray(names[clip]) || names[clip].some((name) => !reference.includes(name))) throw new Error('Invalid name annotations')
    return { clip, reference, names: names[clip], wav, seconds: dataBytes / 32000, sha256: hash(wav) }
  })
}

function loadPrompt() {
  // Read only literal template constants, never execute source. This preserves
  // the exact current few-shot prompt while staying runnable on Node 22.
  const source = readFileSync(join(ROOT, 'src/main/llm/prompt.ts'), 'utf8')
  const literal = (name) => {
    const value = source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'))?.[1]
    if (!value || value.includes('${')) throw new Error('Prompt source changed; review the benchmark mirror')
    return value.replace(/\r\n/gu, '\n')
  }
  const output = source.match(/const OUTPUT_RULE = '([^']+)'/u)?.[1]
  if (!output) throw new Error('Output rule not found')
  const words = [...new Set(DICTIONARY.map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 64))]
  return `${literal('BASE_RULES')}\n- Words the speaker may use (correct misspellings toward these): ${words.join(', ')}.\n\n${output}\n\n${literal('FEWSHOT_EXAMPLES')}`
}

function collapsedWordCount(text) {
  // Mirrors textRepair.ts's repetition collapse for the shrink guard.
  const words = text.split(/\s+/u).filter(Boolean)
  const keys = words.map((word) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '') || `\0${word}`)
  for (let length = 1; length <= 4; length++) {
    for (let start = 0; start + length <= keys.length; start++) {
      let repeats = 1
      while (start + (repeats + 1) * length <= keys.length &&
        keys.slice(start, start + length).every((key, i) => key === keys[start + repeats * length + i])) repeats++
      if (repeats >= 3) keys.splice(start + length, (repeats - 1) * length)
    }
  }
  return keys.length
}

class BudgetStop extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configs = CONFIGS.filter((c) => !args.only || args.only.includes(c.id))
  const keyPath = join(HERE, '../llm-bench/.openrouter-key')
  const key = process.env.OPENROUTER_API_KEY?.trim() || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '')
  if (configs.some((c) => c.base !== 'forge-parakeet' || c.cleanup) && !key) throw new Error('No OPENROUTER_API_KEY')
  // Defense in depth: all persisted text passes through this redactor. Never
  // save request headers, request bodies, audio payloads, or environment dumps.
  const redact = (value) => {
    let text = String(value).replace(/sk-or-v1-[a-zA-Z0-9_-]+/gu, '[REDACTED]')
    if (key) text = text.split(key).join('[REDACTED]')
    return text
  }
  const allFixtures = loadFixtures()
  const fixtures = allFixtures.filter((f) => args.mode === 'full' ||
    (args.mode === 'smoke' ? f.clip === 'tiny' : ['tiny', 'short', 'propernoun'].includes(f.clip)))
  const system = loadPrompt()
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const outBase = join(HERE, 'results', `stt-${stamp}`)
  mkdirSync(dirname(outBase), { recursive: true })
  const result = {
    date: new Date().toISOString(), args, status: 'running', configs, runs: [], requests: [], hints: {}, summary: [],
    spend: { reported: 0, estimated: 0, accounted: 0 },
    setup: {
      node: process.version, platform: process.platform, dictionary: DICTIONARY, cleanupModels: CLEANUP,
      cleanupSystemPrompt: system, cleanupPromptSha256: hash(system),
      cleanupPolicy: 'Production deadline: max(user llmTimeoutMs 2500, medium tier floor 7000) + min(9000, 30 * inputWords) ms; fallback reserve min(6000, 1200 + 15 * inputWords) ms; minimum fallback budget 500ms. Fewer than five whitespace words skips cleanup. Production prompts, reasoning, max_tokens=4000 and output guards mirrored. One network/429 retry within each leg deadline is a benchmark requirement.',
      fixtures: allFixtures.map(({ wav: _wav, ...f }) => ({ ...f, bytes: _wav.length })),
      networkRoute: '', forge: {}, endpoints: {}, cleanupPricing: {},
      priceSource: 'docs/research/2026-09-11-stt-bench-candidates.md; Voxtral estimate uses conservative EU $0.0033/min (default $0.003). usage.cost wins.',
      hintSource: 'https://openrouter.ai/docs/guides/overview/multimodal/stt',
    },
  }
  let budgetExceeded = false

  function save() {
    result.summary = summarize(result, fixtures)
    writeFileSync(`${outBase}.json`, redact(JSON.stringify(result, null, 2)))
    writeFileSync(`${outBase}.md`, redact(markdown(result, fixtures)))
  }

  function charge(cost, source) {
    result.spend[source === 'usage.cost' ? 'reported' : 'estimated'] += cost
    result.spend.accounted += cost
  }

  // This single gateway owns every HTTP attempt. Retry is once, for network
  // errors or 429 only. Costs cover warmups, probes, retries and aborted calls.
  async function request({ url, makeBody, form = 'json', model, reserve = 0, price, seconds = 0, deadline = Infinity, meta = {} }) {
    const began = performance.now()
    const attempts = []
    for (let retry = 0; retry < 2; retry++) {
      if (reserve && result.spend.accounted + reserve > args.budget) throw new BudgetStop('Budget reserve would exceed cap')
      const remaining = Math.min(60_000, Math.floor(deadline - performance.now()))
      if (remaining <= 0) return { ok: false, error: 'timeout', attempts, ms: performance.now() - began }
      const attempt = { ...meta, model, requestForm: form, attempt: retry + 1, httpStatus: null, cost: 0, costSource: 'none', usage: null }
      result.requests.push(attempt)
      attempts.push(attempt)
      const started = performance.now()
      let payload
      let text = null
      try {
        const response = await fetch(url, {
          method: makeBody ? 'POST' : 'GET',
          headers: { ...(url.startsWith(API) && key ? { Authorization: `Bearer ${key}` } : {}), ...(makeBody && form === 'json' ? { 'Content-Type': 'application/json' } : {}) },
          ...(makeBody ? { body: makeBody() } : {}), signal: AbortSignal.timeout(remaining),
        })
        attempt.httpStatus = response.status
        const bodyText = await response.text()
        try { payload = JSON.parse(bodyText) } catch { attempt.error = 'malformed-json' }
        text = typeof payload?.text === 'string' ? payload.text.trim() : typeof payload?.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content.trim() : null
        if (!response.ok || payload?.error) attempt.error = `http-${response.status}: ${redact(JSON.stringify(payload?.error ?? 'request failed')).slice(0, 1200)}`
        attempt.retryAfterMs = Math.min(5000, Math.max(500, (Number(response.headers.get('retry-after')) || 0) * 1000))
      } catch (error) {
        attempt.error = ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network'
      }
      attempt.ms = performance.now() - started
      if (reserve) {
        const usage = payload?.usage
        attempt.usage = usage ? Object.fromEntries(['cost', 'seconds', 'prompt_tokens', 'completion_tokens', 'total_tokens'].filter((k) => Number.isFinite(usage[k])).map((k) => [k, usage[k]])) : null
        if (Number.isFinite(usage?.cost) && usage.cost >= 0) {
          attempt.cost = usage.cost; attempt.costSource = 'usage.cost'
        } else if (price && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens)) {
          attempt.cost = usage.prompt_tokens * price.prompt + usage.completion_tokens * price.completion
          attempt.costSource = 'catalog-token-estimate'
        } else if (attempt.httpStatus && attempt.httpStatus >= 400) {
          attempt.costSource = 'HTTP-rejected-no-usage'
        } else {
          attempt.cost = reserve; attempt.costSource = price ? 'unsettled-cleanup-upper-bound' : 'brief-audio-estimate'
        }
        attempt.audioSeconds = Number.isFinite(usage?.seconds) ? usage.seconds : seconds
        charge(attempt.cost, attempt.costSource)
      }
      // Return the last parsed response so runOne can save its transcript before
      // stopping. No further attempt may be dispatched after this flag is set.
      budgetExceeded = result.spend.accounted > args.budget
      const retryable = attempt.error === 'network' || attempt.httpStatus === 429
      if (!budgetExceeded && retryable && retry === 0) {
        const delay = attempt.retryAfterMs ?? 500
        if (performance.now() + delay + 1 < deadline) { await wait(delay); continue }
      }
      return { ok: !attempt.error, error: attempt.error ?? null, payload, text, attempts, ms: performance.now() - began }
    }
  }

  async function transcribe(config, fixture, phase, run, optionsOverride) {
    const cloud = config.base !== 'forge-parakeet'
    const providerOptions = optionsOverride ?? hintOptions(config.base, result.setup.endpoints[config.base])
    const json = config.hints || optionsOverride !== undefined
    const response = await request({
      url: cloud ? `${API}/audio/transcriptions` : `${args.forgeUrl}/v1/audio/transcriptions`,
      form: json ? 'json' : 'multipart', model: config.model,
      reserve: cloud ? fixture.seconds / 60 * config.minute : 0, seconds: fixture.seconds,
      meta: { configuration: config.id, clip: fixture.clip, phase, run, leg: 'asr' },
      makeBody: () => {
        if (json) return JSON.stringify({ model: config.model, input_audio: { data: fixture.wav.toString('base64'), format: 'wav' }, provider: { options: providerOptions } })
        const body = new FormData()
        body.append('file', new Blob([fixture.wav], { type: 'audio/wav' }), `speech-${fixture.clip}.wav`)
        body.append('model', config.model)
        return body
      },
    })
    if (response.ok && !response.text) { response.ok = false; response.error = 'empty-transcript' }
    return response
  }

  async function cleanup(raw, config, fixture, phase, run) {
    if (shouldSkipCleanup(raw)) return { text: raw, ms: 0, outcome: 'skipped', attempts: [] }
    const start = performance.now()
    const inputWords = raw.split(/\s+/u).filter(Boolean).length
    // Mirrors transcriptPolishService: max(llmTimeoutMs, tier.minTimeoutMs) + length budget.
    const deadline = start + Math.max(2500, 7000) + Math.min(9000, inputWords * 30)
    const fallbackReserve = Math.min(6000, 1200 + inputWords * 15)
    const attempts = []
    for (let index = 0; index < CLEANUP.length; index++) {
      if (index && deadline - performance.now() < 500) break
      const spec = CLEANUP[index]
      const body = JSON.stringify({ model: spec.model, messages: [{ role: 'system', content: system }, { role: 'user', content: `Transcript:\n${raw}` }], max_tokens: 4000, reasoning: spec.reasoning })
      const price = result.setup.cleanupPricing[spec.model]
      // Byte count bounds input tokens conservatively; max_tokens bounds output.
      const reserve = BufferByteLength(body) * price.prompt + 4000 * price.completion
      const r = await request({ url: `${API}/chat/completions`, model: spec.model, makeBody: () => body,
        reserve, price, deadline: index ? deadline : deadline - fallbackReserve,
        meta: { configuration: config.id, clip: fixture.clip, phase, run, leg: 'cleanup', role: index ? 'fallback' : 'primary' } })
      attempts.push(...r.attempts)
      const words = collapsedWordCount(raw)
      const outputWords = r.text?.split(/\s+/u).filter(Boolean).length ?? 0
      const valid = r.ok && r.text && r.text.length <= raw.length * 4 + 200 && (words < 20 || outputWords >= words * 0.5)
      if (r.attempts.length) r.attempts.at(-1).cleanupVerdict = valid ? 'applied' : r.error ?? 'rejected-output'
      if (valid) return { text: r.text, ms: performance.now() - start, outcome: index ? 'fallback-applied' : 'primary-applied', attempts }
      if (budgetExceeded) break
    }
    return { text: raw, ms: performance.now() - start, outcome: 'raw-fallback', attempts }
  }

  async function runOne(config, fixture, phase, run, options) {
    const started = performance.now()
    const requestStart = result.requests.length
    let asr = { ok: false, text: null, error: 'not-started', attempts: [], ms: 0 }
    let polish = null
    let interruption = null
    try {
      asr = await transcribe(config, fixture, phase, run, options)
      if (!budgetExceeded && asr.ok && config.cleanup) polish = await cleanup(asr.text, config, fixture, phase, run)
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error
      interruption = error.message
    }
    if (budgetExceeded) interruption = 'Cumulative OpenRouter cost exceeded cap'
    const text = asr.ok ? polish?.text ?? asr.text : null
    const total = performance.now() - started
    const attempts = result.requests.slice(requestStart)
    const cleanupAttempts = attempts.filter((a) => a.leg === 'cleanup')
    const cleanupMs = polish?.ms ?? (cleanupAttempts.length ? total - asr.ms : 0)
    const row = {
      configuration: config.id, clip: fixture.clip, phase, run, ok: asr.ok && !interruption,
      interrupted: Boolean(interruption), error: interruption ?? asr.error,
      transcript: text, rawTranscript: asr.text, normalizedTranscript: text == null ? null : normalize(text).join(' '),
      wer: text == null ? null : wer(fixture.reference, text).wer,
      nameAccuracy: text == null ? null : scoreProperNouns(text, fixture.names),
      missedWords: text == null ? null : missedWords(fixture.reference, text),
      timings: { asrMs: asr.ms, cleanupMs, totalMs: total },
      cleanupOutcome: polish?.outcome ?? (interruption ? 'budget-interrupted' : 'not-requested'),
      httpStatus: asr.attempts.at(-1)?.httpStatus ?? null,
      httpStatuses: attempts.map((a) => a.httpStatus ?? a.error), retries: attempts.filter((a) => a.attempt === 2).length,
      cost: sum(attempts.map((a) => a.cost)), asrCost: sum(attempts.filter((a) => a.leg === 'asr').map((a) => a.cost)), cleanupCost: sum(cleanupAttempts.map((a) => a.cost)),
      requestForm: options !== undefined ? 'json/input_audio/wav' : config.requestForm,
    }
    result.runs.push(row)
    save()
    if (interruption) throw new BudgetStop(interruption)
    return row
  }

  try {
    let route = 'Tailscale direct/relay path not established'
    try { route = execFileSync('tailscale', ['ping', '--c', '1', new URL(args.forgeUrl).hostname], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim() } catch { /* Optional route diagnostic. */ }
    result.setup.networkRoute = `Windows host to Forge: ${route}. Cloud: this machine's normal Internet route to openrouter.ai; no proxy configured by harness. Upload and full body parsing included; no encoding/IPC/paste timing.`
    for (const path of ['/health', '/v1/models']) {
      const r = await request({ url: args.forgeUrl + path, meta: { phase: 'setup' } })
      result.setup.forge[path] = { httpStatus: r.attempts.at(-1)?.httpStatus, response: r.payload ?? null, error: r.error }
      if (!r.ok || (path === '/health' && r.payload?.status !== 'ok')) throw new Error('Forge setup probe failed')
    }
    if (!result.setup.forge['/v1/models'].response?.data?.some((m) => m.id === MODELS['forge-parakeet'].model)) throw new Error('Expected Forge model not listed')
    for (const base of [...new Set(configs.filter((c) => c.hints).map((c) => c.base))]) {
      const r = await request({ url: `${API}/models/${MODELS[base].model}/endpoints`, meta: { phase: 'setup' } })
      if (!r.ok) throw new Error('Endpoint discovery failed')
      result.setup.endpoints[base] = r.payload.data.endpoints.map((e) => ({ tag: e.tag, name: e.name, pricing: e.pricing }))
    }
    if (configs.some((c) => c.cleanup)) {
      const r = await request({ url: `${API}/models`, meta: { phase: 'setup' } })
      if (!r.ok) throw new Error('Cleanup pricing discovery failed')
      for (const { model } of CLEANUP) {
        const p = r.payload.data.find((m) => m.id === model)?.pricing
        if (!p || !Number.isFinite(Number(p.prompt)) || !Number.isFinite(Number(p.completion))) throw new Error('Missing cleanup token prices')
        result.setup.cleanupPricing[model] = { prompt: Number(p.prompt), completion: Number(p.completion) }
      }
    }
    save()
    for (const config of configs) {
      console.log(`[stt] ${config.id}`)
      if (config.hints) {
        // A valid tiny response is only a wiring check. An intentionally wrong
        // field type should trigger upstream validation if the field is forwarded.
        const tiny = allFixtures.find((f) => f.clip === 'tiny')
        const valid = await runOne(config, tiny, 'hint-valid-probe', 0)
        const unavailable = (row) => !row.ok && (![400, 422].includes(row.httpStatus))
        if (unavailable(valid)) {
          result.hints[config.id] = { status: 'verification-blocked', evidence: `Valid probe failed (${valid.error}); no inference about forwarding is possible.` }
          save()
          throw new Error(`Hint verification blocked by HTTP ${valid.httpStatus}`)
        }
        const invalidOptions = hintOptions(config.base, result.setup.endpoints[config.base], true)
        const invalid = await runOne(config, tiny, 'hint-invalid-probe', 0, invalidOptions)
        if (unavailable(invalid)) {
          result.hints[config.id] = { status: 'verification-blocked', evidence: `Invalid probe failed (${invalid.error}); no inference about forwarding is possible.` }
          save()
          throw new Error('Hint verification blocked by an inconclusive invalid probe')
        }
        const field = config.base === 'mai' ? /phrase|list/iu : config.base === 'voxtral' ? /context_bias/iu : /prompt/iu
        const forwarded = valid.ok && !invalid.ok && field.test(invalid.error ?? '') && /400|422/u.test(invalid.error ?? '')
        result.hints[config.id] = {
          status: forwarded ? 'forwarding-verified' : 'hints not forwarded',
          evidence: forwarded ? 'Valid dictionary accepted; invalid field type rejected with field-specific HTTP 400/422 error.' : 'No field-specific rejection of invalid option (or valid hints rejected); forwarding unverified, skipped conservatively. Acceptance alone is not proof of forwarding.',
          validStatus: valid.httpStatus, invalidStatus: invalid.httpStatus, invalidError: invalid.error,
          options: hintOptions(config.base, result.setup.endpoints[config.base]),
        }
        save()
        if (!forwarded) { console.log('  hints not forwarded (see probe evidence)'); continue }
      }
      if (args.mode !== 'smoke') {
        // Short activates cleanup, so both legs really receive two warmups.
        const warm = allFixtures.find((f) => f.clip === 'short')
        for (let i = 0; i < 2; i++) await runOne(config, warm, 'warmup', i)
      }
      for (const fixture of fixtures) {
        for (let i = 0; i < args.runs; i++) await runOne(config, fixture, 'measured', i)
        const rows = result.runs.filter((r) => r.configuration === config.id && r.clip === fixture.clip && r.phase === 'measured')
        console.log(`  ${fixture.clip}: ${rows.filter((r) => r.ok).length}/${rows.length}, p50/p95 ${latency(rows.filter((r) => r.ok).map((r) => r.timings.totalMs))} ms`)
      }
    }
    result.status = result.runs.some((r) => r.phase === 'measured' && !r.ok) ? 'completed-with-failures' : 'complete'
    if (result.status === 'completed-with-failures') process.exitCode = 1
  } catch (error) {
    result.status = error instanceof BudgetStop ? 'budget-aborted' : 'aborted'
    result.error = redact(error.message)
    process.exitCode = 1
  } finally {
    result.finishedAt = new Date().toISOString()
    save()
    console.log(`[stt] ${result.status}; accounted ${dollars(result.spend.accounted)} (reported ${dollars(result.spend.reported)}, estimates/reserves ${dollars(result.spend.estimated)})`)
    console.log(`[stt] ${outBase}.json\n[stt] ${outBase}.md`)
  }
}

// UTF-8 byte count without adding a dependency or relying on browser globals.
function BufferByteLength(text) { return new Blob([text]).size }

function hintOptions(base, endpoints, invalid = false) {
  const value = invalid ? { invalid_type_probe: true } : DICTIONARY
  const native = base === 'mai' ? { phraseList: { phrases: value } }
    : base === 'voxtral' ? { context_bias: value }
      : { prompt: invalid ? value : DICTIONARY.join(', ') }
  return Object.fromEntries((endpoints ?? []).map(({ tag }) => [tag, native]))
}

function summarize(result, fixtures) {
  return result.configs.map((config) => {
    const measured = result.runs.filter((r) => r.configuration === config.id && r.phase === 'measured')
    const good = measured.filter((r) => r.ok)
    const perClip = fixtures.map((f) => {
      const rows = good.filter((r) => r.clip === f.clip)
      const matched = sum(rows.map((r) => r.nameAccuracy.matched))
      const total = sum(rows.map((r) => r.nameAccuracy.total))
      return { clip: f.clip, seconds: f.seconds, samples: rows.length, wer: average(rows.map((r) => r.wer)), nameAccuracy: total ? matched / total : null,
        latency: Object.fromEntries(['asrMs', 'cleanupMs', 'totalMs'].map((leg) => [leg, { p50: rows.length ? median(rows.map((r) => r.timings[leg])) : null, p95: p95(rows.map((r) => r.timings[leg])) }])) }
    })
    const matched = sum(good.map((r) => r.nameAccuracy.matched))
    const total = sum(good.map((r) => r.nameAccuracy.total))
    const requests = result.requests.filter((r) => r.configuration === config.id)
    const short = good.filter((r) => r.clip === 'short')
    const asrRates = good.map((r) => r.asrCost / fixtures.find((f) => f.clip === r.clip).seconds)
    const asrCost1000 = asrRates.length ? average(asrRates) * 3 * 1000 : config.minute * 50
    const cleanupCost1000 = config.cleanup ? (short.length ? average(short.map((r) => r.cleanupCost)) * 1000 : null) : 0
    return { configuration: config.id, state: result.hints[config.id]?.status === 'hints not forwarded' ? 'hints not forwarded' : `${good.length}/${measured.length}`,
      meanWer: perClip.every((p) => p.samples > 0) ? average(perClip.map((p) => p.wer)) : null,
      nameAccuracy: total ? matched / total : null, nameMatched: matched, nameTotal: total, perClip,
      failures: measured.filter((r) => !r.ok).length, retries: sum(measured.map((r) => r.retries)),
      requestFailures: requests.filter((r) => r.error).length, allRetries: requests.filter((r) => r.attempt === 2).length,
      httpStatuses: distribution(requests.map((r) => r.httpStatus ?? r.error)),
      cleanupOutcomes: distribution(measured.map((r) => r.cleanupOutcome)),
      cost: sum(requests.map((r) => r.cost)), asrCost1000, cleanupCost1000,
      totalCost1000: cleanupCost1000 == null ? null : asrCost1000 + cleanupCost1000 }
  })
}

function markdown(result, fixtures) {
  const lines = [`# Sotto STT benchmark — ${result.date}`, '',
    `${result.args.mode}; ${result.args.runs} measured runs/clip; ${result.status}. Accounted spend ${dollars(result.spend.accounted)} (${dollars(result.spend.reported)} reported + ${dollars(result.spend.estimated)} estimated/reserved). Budget ${dollars(result.args.budget)}.`, '',
    '## Accuracy', '',
    'WER is the macro mean of per-clip means, successful measured runs only; incomplete clip coverage yields N/A. Names are pooled exact-name accuracy: contiguous normalized tokens, not aligned span WER. Unannotated clips are N/A. Repeats measure variability, not independent speech samples. missedWords remains a diagnostic in JSON.', '',
    '| Configuration | Success/state | Mean WER | Exact names | Failures/retries | Cleanup outcomes |',
    '|---|---|---:|---:|---:|---|']
  for (const s of result.summary) lines.push(`| ${s.configuration} | ${s.state} | ${percent(s.meanWer)} | ${percent(s.nameAccuracy)} (${s.nameMatched}/${s.nameTotal}) | ${s.failures}/${s.retries} | ${JSON.stringify(s.cleanupOutcomes)} |`)
  lines.push('', '| Configuration | Clip | WER | Exact names | n |', '|---|---|---:|---:|---:|')
  for (const s of result.summary) for (const p of s.perClip) lines.push(`| ${s.configuration} | ${p.clip} | ${percent(p.wer)} | ${percent(p.nameAccuracy)} | ${p.samples} |`)
  lines.push('', '## Latency', '', 'Milliseconds, p50/p95 (median / nearest-rank p95), successful measured runs including retry/backoff time. Five-run p95 is simply the maximum. No Electron encoding, IPC or paste time. **Tiny 2.0s, short 4.4s and long 16.6s** are shown first; long is not measured in screen/smoke.', '',
    '| Configuration | Tiny 2.0s | Short 4.4s | Long 16.6s |', '|---|---:|---:|---:|')
  for (const s of result.summary) lines.push(`| ${s.configuration} | ${['tiny', 'short', 'long'].map((clip) => latency(result.runs.filter((r) => r.configuration === s.configuration && r.clip === clip && r.phase === 'measured' && r.ok).map((r) => r.timings.totalMs))).join(' | ')} |`)
  lines.push('', '| Configuration | Clip/audio | ASR p50/p95 | Cleanup p50/p95 | Total p50/p95 |', '|---|---|---:|---:|---:|')
  for (const s of result.summary) for (const p of s.perClip) lines.push(`| ${s.configuration} | ${p.clip} ${p.seconds.toFixed(1)}s | ${['asrMs', 'cleanupMs', 'totalMs'].map((leg) => p.samples ? `${Math.round(p.latency[leg].p50)}/${Math.round(p.latency[leg].p95)}` : 'not measured').join(' | ')} |`)
  lines.push('', '## Cost', '', 'USD. ASR per 1,000 3s dictations extrapolates observed per-second costs (brief rate if unmeasured). Cleanup uses observed short-clip cost per call as a proxy; it cannot be inferred from audio duration alone. Tiny skips cleanup. Timeout/network calls without billing telemetry reserve their upper bound, so accounted spend is conservative, not an invoice. Token estimates use live model prices. LAN power/hardware excluded.', '',
    '| Configuration | Run spend, all phases | ASR /1,000 | Cleanup /1,000 proxy | Total /1,000 proxy |', '|---|---:|---:|---:|---:|')
  for (const s of result.summary) lines.push(`| ${s.configuration} | ${dollars(s.cost)} | ${dollars(s.asrCost1000)} | ${dollars(s.cleanupCost1000)} | ${dollars(s.totalCost1000)} |`)
  lines.push('', '## Transcripts (synthetic fixtures only)', '')
  for (const config of result.configs) for (const clip of ['propernoun', 'technical']) {
    const rows = result.runs.filter((r) => r.configuration === config.id && r.clip === clip && r.phase === 'measured' && r.ok)
    lines.push(`### ${config.id} / ${clip}`, '')
    if (!rows.length) lines.push('Not measured.', '')
    for (const transcript of new Set(rows.map((r) => r.transcript))) lines.push(`Runs ${rows.filter((r) => r.transcript === transcript).map((r) => r.run + 1).join(', ')}:`, '', ...transcript.split('\n').map((line) => `> ${line}`), '')
  }
  lines.push('## Setup', '', `Date: ${result.date}; Node ${result.setup.node}; ${result.setup.platform}.`, '',
    `Forge: ${result.args.forgeUrl}; GET responses:`, '', '```json', JSON.stringify(result.setup.forge, null, 2), '```', '',
    `Models: ${result.configs.map((c) => `${c.id} = ${c.model} (${c.requestForm})`).join('; ')}.`, '',
    `Cleanup: ${JSON.stringify(CLEANUP)}. ${result.setup.cleanupPolicy}`, '',
    `Dictionary: ${DICTIONARY.join(', ')}. Current prompt SHA256: ${result.setup.cleanupPromptSha256}; full prompt in JSON.`, '',
    result.setup.networkRoute, '', 'WAV validation: 16 kHz mono PCM16; data-chunk durations and file SHA256 stored in JSON. Every request serial. Two short-clip warmups per configuration (both cleanup legs exercised when needed), none in smoke. Hint validation calls are separate excluded probes; all phases count toward spend.', '',
    '[OpenRouter option contract](https://openrouter.ai/docs/guides/overview/multimodal/stt): provider endpoint tags are discovered live. Invalid-type probes test forwarding; successful valid requests alone do not establish it. No provider pinning is assumed.', '',
    '```json', JSON.stringify(result.hints, null, 2), '```', '',
    '| Configuration | All-phase HTTP statuses | Failed requests (includes intentional probes) | Retries |', '|---|---|---:|---:|')
  for (const s of result.summary) lines.push(`| ${s.configuration} | ${JSON.stringify(s.httpStatuses)} | ${s.requestFailures} | ${s.allRetries} |`)
  lines.push('', `Measured clips: ${fixtures.map((f) => f.clip).join(', ')}. ${result.error ?? ''}`, '')
  return lines.join('\n')
}

main().catch(() => { console.error('[stt] Setup failed; verify arguments, fixtures, prompt and key availability.'); process.exitCode = 1 })
