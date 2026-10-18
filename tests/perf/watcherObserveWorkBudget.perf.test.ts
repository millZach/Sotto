// @vitest-environment node
/**
 * Deterministic work budget for local WatcherService.observe, including real record copying/schema parsing.
 * The accepted receipt/retained unknown outcome isolates head classification from existing history outcome scans.
 * A running native machine head plus an expanded pane history must not reread all earlier message identities.
 */
import { expect, it } from 'vitest'
import { watcherObservePerformance } from '../fixtures/watcherObservePerformance'

it.each([1, 6])('does bounded message work per observation with %i running standing watches', async watches => {
  const results = []
  for (const olderMessages of [20, 20_000]) {
    const f = await watcherObservePerformance({ watches, olderMessages, retainedTakeovers: 0,
      includeTakeoverMetadata: true, operationOutcome: 'unknown', countMessageReads: true })
    try {
      f.resetReads(); f.observe()
      const work = { olderMessages, ...f.reads }
      results.push(work)
      expect(f.state().watches?.every(watch => watch.pausedByUserMessageId === null)).toBe(true)
    } finally { await f.close() }
  }
  const small = results[0]!, expanded = results[1]!, seen = JSON.stringify({ watches, small, expanded })
  expect(expanded.id + expanded.role, `one observation grows with expanded history: ${seen}`)
    .toBeLessThanOrEqual(small.id + small.role + watches)
  expect(expanded.id + expanded.role, `one observation exceeds its per-watch message work budget: ${seen}`)
    .toBeLessThanOrEqual(12 * watches)
})

it('keeps a later human message protected while the native head still names Watcher', async () => {
  const f = await watcherObservePerformance({ watches: 1, olderMessages: 20_000, retainedTakeovers: 0,
    includeTakeoverMetadata: true, operationOutcome: 'unknown', countMessageReads: true })
  try {
    f.newerHuman(); f.resetReads(); f.observe()
    expect(f.state().watches).toHaveLength(1)
    expect(f.state().watches![0]!.pausedByUserMessageId).toBe('machine-0')
  } finally { await f.close() }
})
