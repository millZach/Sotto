// LLM formatting-pass benchmark for TalkType.
//
// Compares wall-clock latency and output quality of candidate backends for
// the dictation cleanup pass:
//   - OpenRouter API models (needs OPENROUTER_API_KEY env var or .openrouter-key file)
//   - Claude Code headless (`claude -p`)
//   - Codex CLI (`codex exec`)
//
// Usage:
//   node scripts/llm-bench/bench-llm.mjs                 # everything
//   node scripts/llm-bench/bench-llm.mjs --backends api  # api | claude | codex (comma-separated)
//   node scripts/llm-bench/bench-llm.mjs --runs 2 --fixtures 02,03
//   node scripts/llm-bench/bench-llm.mjs --models anthropic/claude-haiku-4.5
//
// Writes a markdown report to scripts/llm-bench/results/.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { buildSystemPrompt, buildFewshotSystemPrompt, buildUserPrompt } from './prompt.mjs'

let systemPrompt = buildSystemPrompt()

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(HERE, 'fixtures')
const RESULTS_DIR = join(HERE, 'results')

// Sweep field. `reasoning: false` asks OpenRouter to disable/minimize reasoning
// where the model supports the unified `reasoning` param.
const API_MODELS = [
  { id: 'anthropic/claude-haiku-4.5', reasoning: false },
  { id: 'openai/gpt-5.4-mini', reasoning: false },
  { id: 'openai/gpt-5.4-nano', reasoning: false },
  { id: 'google/gemini-3.5-flash', reasoning: 'minimal' },
  { id: 'google/gemini-3.5-flash-lite', reasoning: 'minimal' },
  { id: 'meta-llama/llama-3.3-70b-instruct', provider: ['groq', 'cerebras'] },
  { id: 'meta-llama/llama-3.1-8b-instruct', provider: ['groq'] },
  { id: 'qwen/qwen3-32b', provider: ['cerebras', 'groq'], reasoning: false },
  { id: 'z-ai/glm-5-turbo', reasoning: false },
  { id: 'mistralai/ministral-8b-2512' },
]

function parseArgs(argv) {
  const args = { backends: ['api', 'claude', 'codex'], runs: 2, fixtures: null, models: null, fewshot: false }
  for (let i = 2; i < argv.length; i++) {
    const [flag, inlineVal] = argv[i].split('=')
    const val = inlineVal ?? argv[i + 1]
    switch (flag) {
      case '--backends': args.backends = val.split(','); if (!inlineVal) i++; break
      case '--runs': args.runs = Number(val); if (!inlineVal) i++; break
      case '--fixtures': args.fixtures = val.split(','); if (!inlineVal) i++; break
      case '--models': args.models = val.split(','); if (!inlineVal) i++; break
      case '--fewshot': args.fewshot = true; break
      default: throw new Error(`unknown flag ${flag}`)
    }
  }
  return args
}

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim()
  const keyFile = join(HERE, '.openrouter-key')
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim()
  return null
}

function loadFixtures(filter) {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.txt'))
    .filter((f) => !filter || filter.some((p) => f.startsWith(p) || f.includes(p)))
    .sort()
    .map((f) => ({
      name: basename(f, '.txt'),
      text: readFileSync(join(FIXTURE_DIR, f), 'utf8').trim(),
    }))
}

async function runOpenRouter(apiKey, model, transcript) {
  const body = {
    model: model.id,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserPrompt(transcript) },
    ],
    max_tokens: 2000,
  }
  if (model.reasoning === false) body.reasoning = { enabled: false }
  else if (typeof model.reasoning === 'string') body.reasoning = { effort: model.reasoning }
  if (model.provider) body.provider = { order: model.provider, allow_fallbacks: true }

  const t0 = performance.now()
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json()
  const ms = performance.now() - t0
  if (!res.ok || json.error) {
    return { ms, error: json.error?.message ?? `HTTP ${res.status}` }
  }
  return {
    ms,
    output: json.choices?.[0]?.message?.content?.trim() ?? '',
    tokens: json.usage?.completion_tokens,
    servedBy: json.provider,
  }
}

function runCli(cmd, cliArgs, stdinText) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const child = spawn(cmd, cliArgs, { shell: true, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ms: performance.now() - t0, error: 'timeout (120s)' })
    }, 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = performance.now() - t0
      if (code !== 0) resolve({ ms, error: `exit ${code}: ${err.slice(0, 300)}` })
      else resolve({ ms, output: out.trim() })
    })
    if (stdinText != null) child.stdin.write(stdinText)
    child.stdin.end()
  })
}

async function runClaudeCli(transcript) {
  const prompt = `${systemPrompt}\n\n${buildUserPrompt(transcript)}`
  return runCli('claude', ['-p', '--model', 'haiku', '--output-format', 'text'], prompt)
}

async function runCodexCli(transcript) {
  const prompt = `${systemPrompt}\n\n${buildUserPrompt(transcript)}`
  return runCli('codex', ['exec', '--skip-git-repo-check', '-'], prompt)
}

function fmtMs(ms) {
  return ms == null ? '—' : `${Math.round(ms)} ms`
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.fewshot) systemPrompt = buildFewshotSystemPrompt()
  const fixtures = loadFixtures(args.fixtures)
  const apiKey = loadApiKey()
  const rows = [] // { backend, fixture, run, ms, output, tokens, error, servedBy }

  const models = args.models
    ? API_MODELS.filter((m) => args.models.some((q) => m.id.includes(q)))
    : API_MODELS

  for (const backend of args.backends) {
    if (backend === 'api') {
      if (!apiKey) {
        console.error('SKIP api: no OPENROUTER_API_KEY env var and no scripts/llm-bench/.openrouter-key file')
        continue
      }
      for (const model of models) {
        for (const fx of fixtures) {
          for (let run = 1; run <= args.runs; run++) {
            const r = await runOpenRouter(apiKey, model, fx.text)
            rows.push({ backend: model.id, fixture: fx.name, run, ...r })
            console.log(`[api] ${model.id}  ${fx.name}  run${run}  ${fmtMs(r.ms)}${r.error ? '  ERROR: ' + r.error : ''}${r.servedBy ? '  via ' + r.servedBy : ''}`)
          }
        }
      }
    } else if (backend === 'claude' || backend === 'codex') {
      const fn = backend === 'claude' ? runClaudeCli : runCodexCli
      for (const fx of fixtures) {
        for (let run = 1; run <= args.runs; run++) {
          const r = await fn(fx.text)
          rows.push({ backend: `${backend}-cli`, fixture: fx.name, run, ...r })
          console.log(`[${backend}] ${fx.name}  run${run}  ${fmtMs(r.ms)}${r.error ? '  ERROR: ' + r.error : ''}`)
        }
      }
    } else {
      console.error(`unknown backend ${backend}`)
    }
  }

  // ---- report ----
  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const reportPath = join(RESULTS_DIR, `bench-${stamp}.md`)

  const backends = [...new Set(rows.map((r) => r.backend))]
  const fixtureNames = fixtures.map((f) => f.name)

  let md = `# LLM formatting benchmark — ${new Date().toISOString()}\n\n`
  md += `Runs per cell: ${args.runs}. Cell = best (min) wall-clock of the runs; first-run value in parens.\n\n`
  md += `| Backend | ${fixtureNames.join(' | ')} |\n`
  md += `|---|${fixtureNames.map(() => '---').join('|')}|\n`
  for (const b of backends) {
    const cells = fixtureNames.map((fx) => {
      const rs = rows.filter((r) => r.backend === b && r.fixture === fx)
      if (!rs.length) return '—'
      if (rs.every((r) => r.error)) return `ERR`
      const ok = rs.filter((r) => !r.error)
      const best = Math.min(...ok.map((r) => r.ms))
      const first = rs[0].error ? 'ERR' : Math.round(rs[0].ms)
      return `**${Math.round(best)}** (${first})`
    })
    md += `| ${b} | ${cells.join(' | ')} |\n`
  }

  md += `\n## Outputs (last run per backend/fixture)\n`
  for (const fx of fixtures) {
    md += `\n### ${fx.name}\n\n**Raw transcript:**\n\n> ${fx.text.replace(/\n/g, '\n> ')}\n`
    for (const b of backends) {
      const rs = rows.filter((r) => r.backend === b && r.fixture === fx.name)
      const last = rs[rs.length - 1]
      if (!last) continue
      md += `\n**${b}** (${fmtMs(last.ms)}${last.tokens ? `, ${last.tokens} tok` : ''}${last.servedBy ? `, via ${last.servedBy}` : ''}):\n\n`
      md += last.error ? `> ERROR: ${last.error}\n` : `> ${last.output.replace(/\n/g, '\n> ')}\n`
    }
  }

  writeFileSync(reportPath, md)
  console.log(`\nReport: ${reportPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
