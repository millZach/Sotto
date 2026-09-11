// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { caseSetSchema, CATEGORIES, type CaseSet, type Expected } from '../../../scripts/memeval/schema.mjs'
import { buildCategoryTable, scoreCase } from '../../../scripts/memeval/score.mjs'
import { runMemEval } from '../../../scripts/memeval/bench-memeval.mjs'
import * as backends from '../../../scripts/memeval/backends/index.mjs'

const casesPath = resolve('scripts/memeval/cases/v1.json')
const cliPath = resolve('scripts/memeval/bench-memeval.mjs')
const temporaryRoots: string[] = []
function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'sotto-memeval-'))
  temporaryRoots.push(path)
  return path
}
function fixture(): CaseSet {
  return caseSetSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')))
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const path of temporaryRoots.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep) || !basename(path).startsWith('sotto-memeval-')) {
      throw new Error('Unexpected temporary directory')
    }
    rmSync(path, { recursive: true, force: true })
  }
})

describe('SottoMemEval case set', () => {
  it('contains 24 valid draft cases, four per category, with unique ids', () => {
    const set = fixture()
    expect(set.version).toBe('v1')
    expect(set.cases).toHaveLength(24)
    expect(new Set(set.cases.map(({ id }) => id)).size).toBe(24)
    expect(set.cases.every(({ status }) => status === 'draft')).toBe(true)
    for (const category of CATEGORIES) {
      expect(set.cases.filter((entry) => entry.category === category)).toHaveLength(4)
    }
  })

  it.each([
    ['duplicate id', (set: CaseSet) => { set.cases[1]!.id = set.cases[0]!.id }],
    ['19 cases', (set: CaseSet) => { set.cases = set.cases.slice(0, 19) }],
    ['31 cases', (set: CaseSet) => { set.cases = [...set.cases, ...set.cases.slice(0, 7).map((entry) => ({ ...entry, id: `extra-${entry.id}` }))] }],
    ['missing category', (set: CaseSet) => { set.cases = set.cases.filter(({ category }) => category !== 'exception') }],
    ['recall without pattern', (set: CaseSet) => { Reflect.deleteProperty(set.cases.find(({ category }) => category === 'recall')!.expected, 'pattern') }],
    ['category and kind mismatch', (set: CaseSet) => { set.cases[0]!.expected = { kind: 'abstain' } }],
    ['invalid date', (set: CaseSet) => { set.cases[0]!.asOf = '2026-02-30' }],
    ['invalid event timestamp', (set: CaseSet) => { set.cases[0]!.history[0]!.at = 'yesterday' }],
    ['invalid regex', (set: CaseSet) => { set.cases[0]!.expected = { kind: 'recall', pattern: '[' } }],
    ['short history', (set: CaseSet) => { set.cases[0]!.history = set.cases[0]!.history.slice(0, 2) }],
  ] as const)('rejects %s', (_label, mutate) => {
    const set = fixture()
    mutate(set)
    expect(caseSetSchema.safeParse(set).success).toBe(false)
  })
})

describe('deterministic scoring', () => {
  const examples: { expected: Expected; answer: string | null; pass: boolean }[] = [
    { expected: { kind: 'recall', pattern: 'vitest' }, answer: 'Run VITEST.', pass: true },
    { expected: { kind: 'recall', pattern: 'vitest' }, answer: null, pass: false },
    { expected: { kind: 'recall', pattern: 'vitest' }, answer: 'Run jest.', pass: false },
    { expected: { kind: 'abstain' }, answer: null, pass: true },
    { expected: { kind: 'abstain' }, answer: 'SQLite', pass: false },
    { expected: { kind: 'abstain' }, answer: '', pass: false },
    ...(['temporal', 'exception'] as const).flatMap((kind) => [
      { expected: { kind, pattern: 'screenshots', stalePattern: 'skip' }, answer: 'Take SCREENSHOTS.', pass: true },
      { expected: { kind, pattern: 'screenshots', stalePattern: 'skip' }, answer: 'Skip screenshots.', pass: false },
      { expected: { kind, pattern: 'screenshots', stalePattern: 'skip' }, answer: 'Run tests.', pass: false },
      { expected: { kind, pattern: 'screenshots', stalePattern: 'skip' }, answer: null, pass: false },
    ]),
    ...(['project-leak', 'authority-leak'] as const).flatMap((kind) => [
      { expected: { kind, leakPattern: 'permission granted' }, answer: null, pass: true },
      { expected: { kind, leakPattern: 'permission granted' }, answer: 'Ask for approval.', pass: true },
      { expected: { kind, leakPattern: 'permission granted' }, answer: 'PERMISSION GRANTED', pass: false },
    ]),
  ]
  it.each(examples)('$expected.kind with answer $answer passes: $pass', ({ expected, answer, pass }) => {
    const result = scoreCase({ expected }, { answer, memoryIds: [] })
    expect(result.pass).toBe(pass)
    if (!pass) expect(result.reason).toEqual(expect.any(String))
  })

  it('averages returned memory ids across passed and failed recall-type cases', () => {
    const rows = buildCategoryTable(CATEGORIES.flatMap((category) => [
      { category, pass: true, memoryIds: ['a', 'b'] },
      { category, pass: false, memoryIds: ['c'] },
    ]))
    expect(rows.map(({ category }) => category)).toEqual(CATEGORIES)
    for (const row of rows) {
      expect(row).toMatchObject({ cases: 2, passed: 1, rate: 0.5 })
      if (['recall', 'temporal', 'exception'].includes(row.category)) expect(row.meanMemoryIds).toBe(1.5)
      else expect(row).not.toHaveProperty('meanMemoryIds')
    }
  })
})

describe('SottoMemEval harness', () => {
  it('awaits a second backend, resets each case, and forwards events and query scope in order', async () => {
    const trace: unknown[] = []
    vi.spyOn(backends, 'createBackend').mockResolvedValue({
      name: 'async-example',
      async reset() { await Promise.resolve(); trace.push('reset') },
      async observe(event) { await Promise.resolve(); trace.push(event) },
      async answer(query) { await Promise.resolve(); trace.push(query); return { answer: null, memoryIds: ['retrieved'] } },
    })
    const { results } = await runMemEval({ backend: 'async-example', casesPath, outDir: temporaryDirectory() })
    expect(trace).toEqual(fixture().cases.flatMap((entry) => [
      'reset', ...entry.history, { question: entry.question, project: entry.project, asOf: entry.asOf },
    ]))
    expect(results.backend).toBe('async-example')
    expect(results.cases.every(({ memoryIds }) => memoryIds.join() === 'retrieved')).toBe(true)
  })

  it('rejects malformed backend answers instead of counting them as safe abstention', async () => {
    vi.spyOn(backends, 'createBackend').mockReturnValue({
      name: 'broken-example',
      reset() {},
      observe() {},
      answer() { return { answer: undefined, memoryIds: [] } as unknown as backends.BackendAnswer },
    })
    const outDir = temporaryDirectory()
    await expect(runMemEval({ backend: 'broken-example', casesPath, outDir })).rejects.toThrow('Invalid answer from broken-example')
    expect(readdirSync(outDir)).toEqual([])
  })

  it('runs the none backend and persists the expected baseline', async () => {
    const outDir = temporaryDirectory()
    const { results, outPath } = await runMemEval({ backend: 'none', casesPath, outDir })
    expect(results.backend).toBe('none')
    expect(results.caseSet).toEqual({ path: casesPath, version: 'v1' })
    expect(results.generatedAt).toEqual(expect.any(String))
    expect(results.totals).toEqual({ cases: 24, passed: 12, rate: 0.5 })
    for (const row of results.table) {
      const recallType = ['recall', 'temporal', 'exception'].includes(row.category)
      expect(row).toMatchObject({ cases: 4, passed: recallType ? 0 : 4, rate: recallType ? 0 : 1 })
      if (recallType) expect(row.meanMemoryIds).toBe(0)
    }
    expect(results.cases).toHaveLength(24)
    expect(results.cases.every(({ answer, memoryIds }) => answer === null && memoryIds.length === 0)).toBe(true)
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(results)
  })

  it('accepts a UTF-8 BOM in the case file', async () => {
    const outDir = temporaryDirectory()
    const bomPath = join(outDir, 'bom.json')
    writeFileSync(bomPath, '\uFEFF' + readFileSync(casesPath, 'utf8'))
    const { results } = await runMemEval({ backend: 'none', casesPath: bomPath, outDir })
    expect(results.cases).toHaveLength(24)
  })

  it('reports invalid cases without writing results', async () => {
    const outDir = temporaryDirectory()
    const invalidPath = join(outDir, 'invalid.json')
    writeFileSync(invalidPath, JSON.stringify({ version: 'v1', cases: [] }))
    await expect(runMemEval({ backend: 'none', casesPath: invalidPath, outDir })).rejects.toThrow(/Invalid case set.*cases/s)
    expect(readdirSync(outDir)).toEqual(['invalid.json'])
  })

  it('rejects unknown backend names', async () => {
    await expect(runMemEval({ backend: 'toString', casesPath, outDir: temporaryDirectory() })).rejects.toThrow('Unknown backend')
  })

  it('runs the CLI, prints all table rows, and writes one named results file', () => {
    const outDir = temporaryDirectory()
    const stdout = execFileSync(process.execPath, [cliPath, '--backend', 'none', '--cases', casesPath, '--out', outDir], { encoding: 'utf8' })
    for (const category of CATEGORIES) expect(stdout).toContain(category)
    expect(stdout).toMatch(/total\s+24\s+12\s+50\.0%/)
    expect(stdout).toContain('meanMemoryIds')
    const files = readdirSync(outDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^none-v1-.*\.json$/)
    const result = JSON.parse(readFileSync(join(outDir, files[0]!), 'utf8'))
    expect(result.backend).toBe('none')
    expect(result.caseSet.version).toBe('v1')
    expect(result.cases).toHaveLength(24)
  })
})
