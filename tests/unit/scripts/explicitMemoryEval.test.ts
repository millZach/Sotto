// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMemEval } from '../../../scripts/memeval/bench-memeval.mjs'
import { authoredCaseSetSchema } from '../../../scripts/memeval/schema.mjs'
import { createBackend } from '../../../scripts/memeval/backends/explicit.mjs'

const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'sotto-explicit-eval-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const casesPath = resolve('scripts/memeval/cases/explicit-v1.json')

describe('production explicit memory evaluation', () => {
  it('recalls accepted preferences with no project or authority leaks against the none baseline', async () => {
    const set = authoredCaseSetSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')))
    expect(set.cases.every(entry => entry.status === 'draft')).toBe(true)
    const { results } = await runMemEval({ backend: 'explicit', casesPath, outDir: temp() })
    expect(results.totals).toEqual({ cases: 22, passed: 22, rate: 1 })
    expect(results.table.find(row => row.category === 'recall')).toMatchObject({ cases: 10, passed: 10 })
    const baseline = await runMemEval({ backend: 'none', casesPath, outDir: temp() })
    expect(baseline.results.table.find(row => row.category === 'recall')).toMatchObject({ passed: 0 })
    expect(results.cases.filter(entry => entry.category.endsWith('leak')).every(entry => entry.memoryIds.length === 0)).toBe(true)
  })
  it('never forwards expected labels and produces identical evidence when all answer labels change', async () => {
    const set = authoredCaseSetSchema.parse(JSON.parse(readFileSync(casesPath, 'utf8')))
    const observed: unknown[] = []
    const queried: unknown[] = []
    const factory = () => {
      const backend = createBackend()
      return { ...backend, observe: (event: Parameters<typeof backend.observe>[0]) => {
        observed.push(event); return backend.observe(event)
      }, answer: (query: Parameters<typeof backend.answer>[0]) => { queried.push(query); return backend.answer(query) } }
    }
    const first = await runMemEval({ backend: 'explicit', casesPath, outDir: temp(), createBackend: factory })
    for (const entry of set.cases) {
      if ('pattern' in entry.expected) entry.expected.pattern = 'IMPOSSIBLE_CHANGED_LABEL'
      if ('leakPattern' in entry.expected) entry.expected.leakPattern = 'IMPOSSIBLE_CHANGED_LABEL'
    }
    const changed = join(temp(), 'cases.json')
    writeFileSync(changed, JSON.stringify(set))
    const second = await runMemEval({ backend: 'explicit', casesPath: changed, outDir: temp(), createBackend: factory })
    const evidence = (results: typeof first.results) => results.cases.map(({ answer, memoryIds }) => ({ answer, memoryIds }))
    expect(evidence(first.results)).toEqual(evidence(second.results))
    for (const value of [...observed, ...queried]) {
      expect(value).not.toHaveProperty('expected')
      expect(value).not.toHaveProperty('category')
      expect(value).not.toHaveProperty('status')
    }
  })
  it('disposes the database-backed adapter when answering fails', async () => {
    const backend = createBackend()
    const dispose = vi.fn(backend.dispose)
    await expect(runMemEval({ backend: 'explicit', casesPath, outDir: temp(), createBackend: () => ({
      ...backend, answer: () => { throw new Error('reader failed') }, dispose,
    }) })).rejects.toThrow('reader failed')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
