// Run labelled Sotto memory histories against a registered backend, score with
// regular expressions, and save a versioned report. No LLM is used for scoring.
// Usage: node scripts/memeval/bench-memeval.mjs --backend none --cases scripts/memeval/cases/v1.json [--out scripts/memeval/results]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createBackend as createRegisteredBackend } from './backends/index.mjs'
import { caseSetSchema } from './schema.mjs'
import { buildCategoryTable, scoreCase } from './score.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const answerSchema = z.object({ answer: z.string().nullable(), memoryIds: z.array(z.string()) })

function parseArgs(argv) {
  const args = { backend: 'none', casesPath: join(HERE, 'cases', 'v1.json'), outDir: join(HERE, 'results') }
  for (let i = 2; i < argv.length; i++) {
    const separator = argv[i].indexOf('=')
    const flag = separator < 0 ? argv[i] : argv[i].slice(0, separator)
    const inlineVal = separator < 0 ? undefined : argv[i].slice(separator + 1)
    const value = () => {
      const val = inlineVal ?? argv[++i]
      if (!val || val.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      return val
    }
    switch (flag) {
      case '--backend': args.backend = value(); break
      case '--cases': args.casesPath = value(); break
      case '--out': args.outDir = value(); break
      default: throw new Error(`Unknown flag: ${flag}`)
    }
  }
  return args
}

export async function runMemEval({ backend, casesPath, outDir = join(HERE, 'results'), createBackend = createRegisteredBackend }) {
  let caseSet
  try {
    caseSet = caseSetSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8').replace(/^\uFEFF/, '')))
  } catch (error) {
    throw new Error(`Invalid case set ${casesPath}: ${error.message}`, { cause: error })
  }
  const instance = await createBackend(backend)
  const cases = []
  try {
    for (const entry of caseSet.cases) {
      await instance.reset()
      for (const event of entry.history) await instance.observe(event)
      const response = await instance.answer({ question: entry.question, project: entry.project, asOf: entry.asOf,
        ...(entry.threadId === undefined ? {} : { threadId: entry.threadId }) })
      const parsed = answerSchema.safeParse(response)
      if (!parsed.success) throw new Error(`Invalid answer from ${instance.name} for case ${entry.id}: ${parsed.error.message}`)
      cases.push({ id: entry.id, category: entry.category, ...scoreCase(entry, parsed.data), ...parsed.data })
    }
  } finally {
    await instance.dispose?.()
  }
  const passed = cases.filter((entry) => entry.pass).length
  const generatedAt = new Date().toISOString()
  const results = {
    backend: instance.name,
    caseSet: { path: resolve(casesPath), version: caseSet.version },
    generatedAt,
    cases,
    table: buildCategoryTable(cases),
    totals: { cases: cases.length, passed, rate: passed / cases.length },
  }
  const stamp = generatedAt.replace(/[:.]/g, '-')
  const filenamePart = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '-')
  const outPath = resolve(outDir, `${filenamePart(instance.name)}-${filenamePart(caseSet.version)}-${stamp}.json`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n', { flag: 'wx' })
  return { results, outPath }
}

function printTable(results) {
  const printRow = (category, cases, passed, rate, mean = '-') => {
    console.log(`${category.padEnd(18)} ${String(cases).padStart(5)} ${String(passed).padStart(6)} ${rate.padStart(8)} ${mean.padStart(13)}`)
  }
  console.log(`SottoMemEval: ${results.backend}, case set ${results.caseSet.version}`)
  printRow('category', 'cases', 'passed', 'rate', 'meanMemoryIds')
  for (const row of results.table) {
    printRow(row.category, row.cases, row.passed, `${(row.rate * 100).toFixed(1)}%`, row.meanMemoryIds?.toFixed(2))
  }
  const totals = results.totals
  printRow('total', totals.cases, totals.passed, `${(totals.rate * 100).toFixed(1)}%`)
}

async function main() {
  const { results, outPath } = await runMemEval(parseArgs(process.argv))
  printTable(results)
  console.log(`\nwrote ${outPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`SottoMemEval: ${error.message}`)
    process.exitCode = 1
  })
}
