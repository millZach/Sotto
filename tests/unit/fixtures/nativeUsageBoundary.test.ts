// @vitest-environment node
import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { ThreadUsage } from '../../../src/shared/threadUsage'
import { nativeUsageBoundary as boundary } from '../../fixtures/nativeUsageBoundary'

const NATIVE = 'claude-sonnet-4-6'
const PUBLIC = 'native:claude:model:claude-sonnet-4-6'
const usage = (): ThreadUsage => ({ modelId: NATIVE, total: { input: 6000, output: 350, cached: 4000 },
  latest: { input: 3000, output: 250, cached: 2000, cacheWrite: 0, cacheWrite5m: undefined, cacheWrite1h: undefined },
  contextUsed: 3000, contextWindow: 200_000, contextUpdatedAt: '2026-09-01T00:01:00.000Z', updatedAt: '2026-09-01T00:01:00.000Z',
  elapsedMs: 222, estimatedUsd: 0.01245, partial: false, rateVersions: ['fixture-rate'], persistenceError: undefined,
})

it('compares the persisted native view with the provider-qualified renderer view', () => {
  const inMemory = usage()
  const archive = JSON.parse(JSON.stringify(inMemory)) as ThreadUsage
  const bridge = { ...inMemory, modelId: PUBLIC }
  assert.deepEqual(boundary(archive, NATIVE), boundary(bridge, PUBLIC))
})

it('compares renderer usage before and after a JSON-backed restart', () => {
  const before = { ...usage(), modelId: PUBLIC }
  const after = { ...JSON.parse(JSON.stringify(usage())) as ThreadUsage, modelId: PUBLIC }
  assert.deepEqual(boundary(after, PUBLIC), boundary(before, PUBLIC))
})

it('rejects missing usage, a missing model, the wrong model and a model ID from the wrong boundary', () => {
  assert.throws(() => boundary(undefined, NATIVE))
  assert.throws(() => boundary({ ...usage(), modelId: undefined }, NATIVE))
  assert.throws(() => boundary({ ...usage(), modelId: 'claude-opus-5' }, NATIVE))
  assert.throws(() => boundary(usage(), PUBLIC))
  assert.throws(() => boundary({ ...usage(), modelId: PUBLIC }, NATIVE))
})

const changes: Array<[string, (view: ThreadUsage) => void]> = [
  ['total tokens', view => { view.total!.output = 349 }],
  ['latest tokens', view => { view.latest!.output = 249 }],
  ['cached tokens', view => { view.total!.cached = 3999 }],
  ['reported zero', view => { delete view.latest!.cacheWrite }],
  ['cache TTL', view => { view.latest!.cacheWrite5m = 0 }],
  ['price', view => { view.estimatedUsd = 0.01246 }],
  ['partial pricing', view => { view.partial = true }],
  ['rate versions', view => { view.rateVersions = ['another-rate'] }],
  ['context size', view => { view.contextUsed = 3001 }],
  ['context window', view => { view.contextWindow = 100_000 }],
  ['context age', view => { view.contextUpdatedAt = '2026-09-01T00:02:00.000Z' }],
  ['usage age', view => { view.updatedAt = '2026-09-01T00:02:00.000Z' }],
  ['elapsed time', view => { view.elapsedMs = 223 }],
  ['elapsed kind', view => { view.elapsedKind = 'api' }],
  ['persistence failure', view => { view.persistenceError = true }],
]
it.each(changes)('rejects changed %s across the archive/bridge boundary', (_name, change) => {
  const archive = JSON.parse(JSON.stringify(usage())) as ThreadUsage
  const bridge = { ...usage(), modelId: PUBLIC }
  change(bridge)
  assert.throws(() => assert.deepEqual(boundary(archive, NATIVE), boundary(bridge, PUBLIC)))
})
