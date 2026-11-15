// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hostPushSchema } from '../../../src/shared/hostProtocol'
import { watcherProgressChange, withWatcherProgress, type WatcherHostProjection } from '../../../src/shared/watcherHost'

/**
 * A progress push carries what moved in a projection's progress (ADR-0073, November 10, 2026 amendment), and the desktop
 * puts it into the projection it holds. Whatever the change, the list it ends with is the host's own, in its order.
 */
const hostId = '11111111-1111-4111-8111-111111111111'
const AT = '2026-11-10T12:00:00.000Z'
const entry = (thread: string, step = 0) => ({ target: { hostId, threadId: thread }, fingerprint: String(step).padStart(64, '0') })
const projection = (progress: ReturnType<typeof entry>[]): WatcherHostProjection => ({ hostId, master: { target: { hostId: '22222222-2222-4222-8222-222222222222', threadId: 'watcher' },
  projectId: 'project', provider: 'codex', creationOperationId: '33333333-3333-4333-8333-333333333333', createdAt: AT }, requests: [], operations: [], evidence: [], progress, standingWatches: [], revision: 'before', observedAt: AT })

describe('watcherProgressChange and withWatcherProgress', () => {
  const held = [entry('a'), entry('b'), entry('c')]
  const cases: [string, ReturnType<typeof entry>[], Partial<ReturnType<typeof watcherProgressChange>>][] = [
    ['one thread took a step', [entry('a'), entry('b', 1), entry('c')], { changed: [entry('b', 1)] }],
    ['nothing moved', held, { changed: [] }],
    ['a thread is watched after the others', [...held, entry('d')], { changed: [entry('d')] }],
    ['a thread stopped being watched', [entry('a'), entry('c')], { changed: [], removed: [entry('b').target] }],
    ['one stopped and another took a step', [entry('a', 2), entry('c')], { changed: [entry('a', 2)], removed: [entry('b').target] }],
    ['a thread is watched above the others', [entry('z'), ...held], { changed: [entry('z'), ...held], whole: true }],
    ['the threads moved', [entry('c'), entry('a'), entry('b')], { changed: [entry('c'), entry('a'), entry('b')], whole: true }],
    ['every thread went', [], { changed: [], removed: held.map(item => item.target) }],
  ]
  it.each(cases)('carries what moved when %s, and the desktop ends with the host\'s list', (_name, next, carried) => {
    const change = watcherProgressChange(held, next)
    expect(change).toEqual(carried)
    const push = { baseRevision: 'before', revision: 'after', observedAt: '2026-11-10T12:00:01.000Z', ...change }
    expect(hostPushSchema.safeParse({ v: 1, event: 'watcher-progress', progress: push }).success).toBe(true)
    const before = projection(held), after = withWatcherProgress(before, push)
    expect(after).toEqual({ ...before, progress: next, revision: 'after', observedAt: '2026-11-10T12:00:01.000Z' })
    // The record's part is the very lists the desktop held.
    expect(after.requests).toBe(before.requests); expect(after.operations).toBe(before.operations); expect(after.evidence).toBe(before.evidence)
  })

  it('starts from no list when the projection held none', () => {
    const push = { baseRevision: 'before', revision: 'after', observedAt: AT, ...watcherProgressChange([], [entry('a')]) }
    expect(withWatcherProgress({ ...projection([]), progress: undefined }, push).progress).toEqual([entry('a')])
  })

  it('carries the whole list when a target appears twice, so the desktop still ends with the host\'s', () => {
    const next = [entry('a', 1), entry('b'), entry('a', 2)]
    const change = watcherProgressChange(held, next)
    expect(withWatcherProgress(projection(held), { baseRevision: 'before', revision: 'after', observedAt: AT, ...change }).progress).toEqual(next)
  })
})
