// @vitest-environment node
import assert from 'node:assert/strict'

import { it } from 'vitest'

import type { ThreadUsage } from '../../../src/shared/threadUsage'
import { nativeUsageBenchTotals as totals } from '../../fixtures/nativeUsageBenchTotals'

const view = (): ThreadUsage => ({ updatedAt: '2026-09-01T00:00:00Z', partial: false, rateVersions: ['fixture-rate'], estimatedUsd: 0.5,
  contextUsed: 3000, contextWindow: 200_000,
  latest: { input: 3000, output: 100, cached: 2000, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  total: { input: 6000, output: 200, cached: 4000, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
})

for (const part of ['latest', 'total'] as const) {
  it.each(['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h'] as const)(`rejects a missing or changed ${part}.%s counter, including zero`, field => {
    const expected = view(), changed = view(), missing = view()
    changed[part]![field]! += 1
    delete missing[part]![field]
    assert.throws(() => assert.deepEqual(totals(changed), totals(expected)))
    assert.throws(() => assert.deepEqual(totals(missing), totals(expected)))
  })
}

it('rejects lost usage and changed price, pricing completeness, context and rate versions', () => {
  assert.throws(() => totals(undefined), /must retain its usage/u)
  const expected = view()
  for (const changed of [
    { ...expected, estimatedUsd: 0.6 }, { ...expected, partial: true }, { ...expected, contextUsed: 3001 },
    { ...expected, contextWindow: 100_000 }, { ...expected, rateVersions: ['different-rate'] },
  ]) assert.throws(() => assert.deepEqual(totals(changed), totals(expected)))
})

it('treats absent optional counters as undefined, without equating absent counters with zero', () => {
  const expected = view()
  const explicitUndefined = { ...expected, latest: { ...expected.latest, cacheWrite5m: undefined } }
  const absent = { ...expected, latest: { ...expected.latest } }
  delete absent.latest.cacheWrite5m
  assert.deepEqual(totals(explicitUndefined), totals(absent))
  assert.throws(() => assert.deepEqual(totals(explicitUndefined), totals(expected)))
})
