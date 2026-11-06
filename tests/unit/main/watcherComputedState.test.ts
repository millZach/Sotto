// @vitest-environment node
// What read_state works out from live data at each read (#1274): the merge queue, what holds a pending settle, and the
// kept notes that name something Sotto's records say is over.
import { expect, it } from 'vitest'
import { mergeTurnHolds, watcherMergeQueue, watcherStaleNotes, type WatcherKnownThread } from '../../../src/main/agents/watcherComputedState'
import { WatcherEvidenceStore } from '../../../src/main/agents/watcherEvidence'
import type { WatcherKeptItem } from '../../../src/shared/watcher'
import { toldEventsForLater } from '../../../src/main/agents/watcherNews'
import { WATCHER_UNWATCHED_REQUEST_ID, type WatcherEvent } from '../../../src/shared/watcherNews'

const target = (threadId: string) => ({ hostId: '11111111-1111-4111-8111-111111111111', threadId })
const NOW = Date.parse('2026-10-24T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1_000
/** Kept lines from their words, IDs given in list order as Sotto gives them, each touched `ago` before NOW. */
function kept(words: { decisions?: string[]; rules?: string[]; issues?: string[] }, ago = 0) {
  const touchedAt = new Date(NOW - ago).toISOString()
  const lines = (letter: string, texts: string[] = []): WatcherKeptItem[] => texts.map((text, at) => ({ id: `${letter}${at + 1}`, text, touchedAt }))
  return { decisions: lines('d', words.decisions), rules: lines('r', words.rules), issues: lines('i', words.issues) }
}
const nothing = kept({})

it('queues open pull requests whose summaries are not stale, that are not drafts and whose checks passed, oldest pass first', () => {
  const queue = watcherMergeQueue([
    { target: target('a'), title: 'Login fix', open: [
      { summary: { number: 12, state: 'open', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T10:05:00.000Z' },
      { summary: { number: 13, state: 'open', checks: 'pending' }, draft: false },
      { summary: { number: 14, state: 'open', checks: 'passed' }, draft: true, checksPassedAt: '2026-10-21T09:00:00.000Z' },
      // Read only from evidence, which does not say whether it is a draft: not queued.
      { summary: { number: 15, state: 'open', checks: 'passed' }, draft: undefined, checksPassedAt: '2026-10-21T08:30:00.000Z' },
      { summary: { number: 16, state: 'open', checks: 'passed', stale: true }, draft: false, checksPassedAt: '2026-10-21T08:00:00.000Z' }] },
    { target: target('b'), title: 'Docs pass', open: [
      { summary: { number: 9, state: 'open', checks: 'passed', approved: true }, draft: false, checksPassedAt: '2026-10-21T10:00:00.000Z' },
      { summary: { number: 8, state: 'open', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T10:05:00.000Z' },
      // Merged since its links were read: not open, so not queued.
      { summary: { number: 7, state: 'merged', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T08:00:00.000Z' }] },
  ])
  expect(queue.map(item => [item.title, item.pullRequest.number])).toEqual([['Docs pass', 9], ['Docs pass', 8], ['Login fix', 12]])
  expect(queue[0]).toMatchObject({ target: target('b'), pullRequest: { approved: true }, checksPassedAt: '2026-10-21T10:00:00.000Z' })
})

const threads: WatcherKnownThread[] = [
  { target: target('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), title: 'Release notes draft', settled: true, watched: false },
  { target: target('22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), title: 'Flaky e2e hunt', settled: false, watched: false },
  { target: target('33333333-cccc-4ccc-8ccc-cccccccccccc'), title: 'Login timeout fix', settled: false, watched: true },
  { target: target('44444444-dddd-4ddd-8ddd-dddddddddddd'), title: 'Fix', settled: true, watched: false },
  // Two words name a thread whatever their length.
  { target: target('77777777-1111-4111-8111-111111111111'), title: 'Fix CI', settled: true, watched: false },
  { target: target('55555555-eeee-4eee-8eee-eeeeeeeeeeee'), title: 'New thread', settled: true, watched: false },
  // A title a watched, unsettled thread shares names that thread, so it flags nothing.
  { target: target('66666666-ffff-4fff-8fff-ffffffffffff'), title: 'Login timeout fix', settled: true, watched: false },
]
const pullRequests = [
  { url: 'https://github.com/o/r/pull/40', number: 40, state: 'merged' as const },
  { url: 'https://github.com/o/r/pull/41', number: 41, state: 'closed' as const },
  { url: 'https://github.com/o/r/pull/42', number: 42, state: 'open' as const },
  // The same number in two repositories flags only when neither is open.
  { url: 'https://github.com/o/r/pull/43', number: 43, state: 'merged' as const },
  { url: 'https://github.com/o/s/pull/43', number: 43, state: 'open' as const },
]

it('flags a kept note that names a settled or unwatched thread, by title or ID, or a merged or closed pull request', () => {
  const stale = watcherStaleNotes(kept({
    decisions: ['Merge #40 once CI is green?', 'Ask about PR 41 and pull request #42', 'Merge https://github.com/o/r/pull/40/files after review'],
    rules: ['Leave the release notes draft alone', 'Thread 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb needs a look', 'Keep the Login timeout fix moving'],
    issues: ['#43 Watcher keeps stale notes', '#9999 not a pull request Sotto knows', 'Fix the new thread button',
      // Two links with one number name two pull requests: the merged one flags, whichever comes first.
      'Compare https://github.com/o/s/pull/43 with https://github.com/o/r/pull/43', 'Look at fix ci again'],
  }), threads, pullRequests, NOW)
  expect(stale).toEqual([
    { list: 'decisions', id: 'd1', reasons: ['Names pull request #40, which is merged.'] },
    { list: 'decisions', id: 'd2', reasons: ['Names pull request #41, which is closed.'] },
    { list: 'decisions', id: 'd3', reasons: ['Names pull request #40, which is merged.'] },
    { list: 'rules', id: 'r1', reasons: ['Names the thread “Release notes draft”, which is settled.'] },
    { list: 'rules', id: 'r2', reasons: ['Names the thread “Flaky e2e hunt”, which Watcher does not watch.'] },
    { list: 'issues', id: 'i4', reasons: ['Names pull request #43, which is merged.'] },
    { list: 'issues', id: 'i5', reasons: ['Names the thread “Fix CI”, which is settled.'] },
  ])
})

it('reads `owner/repo#N` in its own repository, and a bare number in the issues list as the issue’s own', () => {
  expect(watcherStaleNotes(kept({
    decisions: ['Merge o/r#40 once CI is green?', 'Filed o/x#40 about the crash'],
    rules: [],
    // Issue numbers are written as pull request numbers are: only "PR 40" or a link names a pull request here.
    issues: ['#40 Watcher keeps stale notes', 'o/other#40 crash on start', 'PR 40 follow-up'],
  }), [], pullRequests, NOW)).toEqual([
    { list: 'decisions', id: 'd1', reasons: ['Names pull request #40, which is merged.'] },
    { list: 'issues', id: 'i3', reasons: ['Names pull request #40, which is merged.'] },
  ])
})

it('flags nothing when the kept notes name only what is live, or nothing at all', () => {
  expect(watcherStaleNotes(nothing, threads, pullRequests, NOW)).toEqual([])
  expect(watcherStaleNotes(kept({ rules: ['Full test suites run in CI, not on the laptop.', 'Release notes drafting waits for Zach'] }), threads, pullRequests, NOW)).toEqual([])
})

// October 24, 2026: a line nobody has added or edited in a few days may be done, so it is flagged for review.
it('flags an open line not added or edited for three days, beside anything else it names, and never a closed one', () => {
  const old = kept({ decisions: ['Merge #40 once CI is green?', 'Ask Zach which icon he wants'], rules: ['Suites run in CI.'] }, 3 * DAY + 60_000)
  old.rules[0] = { ...old.rules[0]!, closedAt: new Date(NOW - DAY / 2).toISOString() }
  const review = 'Not added or edited for 3 days. If it is done, close it; if it still stands, edit it, with the same words if they still fit; if it is wrong, drop it.'
  expect(watcherStaleNotes(old, threads, pullRequests, NOW)).toEqual([
    { list: 'decisions', id: 'd1', reasons: ['Names pull request #40, which is merged.', review] },
    { list: 'decisions', id: 'd2', reasons: [review] },
  ])
  // Touched under three days ago: nothing to review yet.
  expect(watcherStaleNotes(kept({ decisions: ['Ask Zach which icon he wants'] }, 3 * DAY - 60_000), threads, pullRequests, NOW)).toEqual([])
})

it('keeps since when a pull request’s checks first passed, through later reads, and starts again on a new commit', () => {
  const store = new WatcherEvidenceStore(), url = 'https://github.com/o/r/pull/1', at = target('worker')
  const read = (head: string, checks: 'passed' | 'failed', observedAt: string) =>
    store.pullRequest(at, { url, head, observedAt, availability: 'available', checks, checkCount: 1, state: 'open' })
  read('head-a', 'failed', '2026-10-21T09:00:00.000Z')
  expect(store.checksPassedSince(at, url)).toBeUndefined()
  read('head-a', 'passed', '2026-10-21T09:10:00.000Z')
  read('head-a', 'passed', '2026-10-21T09:20:00.000Z')
  expect(store.checksPassedSince(at, url)).toBe('2026-10-21T09:10:00.000Z')
  read('head-b', 'passed', '2026-10-21T09:30:00.000Z')
  expect(store.checksPassedSince(at, url)).toBe('2026-10-21T09:30:00.000Z')
  read('head-b', 'failed', '2026-10-21T09:40:00.000Z')
  expect(store.checksPassedSince(at, url)).toBeUndefined()
})

// #2229: the merge queue is the merge train. A pull request joins it when its checks first pass or its thread says READY TO
// MERGE, keeps its place while its checks run again after a push, and says whose required checks a merge would land in.
const pr = (number: number, repository = 'o/r') => `https://github.com/${repository}/pull/${number}`
it('keeps a train pull request in its place while its checks run again, and says whose required checks are running', () => {
  const queue = watcherMergeQueue([
    { target: target('a'), title: 'Model picker', open: [
      // Joined first, then pushed: its required checks run again, so it keeps its place and says they are running.
      { url: pr(1959), summary: { number: 1959, state: 'open', checks: 'pending' }, draft: false, head: 'b'.repeat(40), pending: { required: 2, optional: 1 },
        train: { since: '2026-11-01T04:00:00.000Z', ready: { head: 'a'.repeat(40), at: '2026-11-01T04:00:00.000Z' } } },
      // Only an optional check still runs: its required checks passed, though not every check has.
      { url: pr(1960), summary: { number: 1960, state: 'open', checks: 'pending' }, draft: false, pending: { required: 0, optional: 1 }, train: { since: '2026-11-01T04:30:00.000Z' } },
      // Running and never in the train: not listed.
      { url: pr(1961), summary: { number: 1961, state: 'open', checks: 'pending' }, draft: false, pending: { required: 3, optional: 0 } }] },
    { target: target('b'), title: 'Settings copy', open: [
      { url: pr(1949), summary: { number: 1949, state: 'open', checks: 'passed' }, draft: false, head: 'c'.repeat(40), checksPassedAt: '2026-11-01T04:20:00.000Z',
        train: { since: '2026-11-01T04:20:00.000Z', ready: { head: 'c'.repeat(40), at: '2026-11-01T04:21:00.000Z' } } }] },
  ])
  expect(queue.map(item => [item.pullRequest.number, item.requiredChecks])).toEqual([[1959, 'running'], [1949, 'passed'], [1960, 'passed']])
  expect(queue[0]).toMatchObject({ url: pr(1959), inTrainSince: '2026-11-01T04:00:00.000Z', head: 'b'.repeat(40), readyToMerge: { head: 'a'.repeat(40), onHead: false } })
  expect(queue[0]).not.toHaveProperty('checksPassedAt')
  expect(queue[1]).toMatchObject({ checksPassedAt: '2026-11-01T04:20:00.000Z', readyToMerge: { onHead: true } })
})

it('holds a GO MERGE while another train pull request of the same repository runs its required checks, or its base branch is red', () => {
  const queue = watcherMergeQueue([{ target: target('a'), title: 'Train', open: [
    { url: pr(1), summary: { number: 1, state: 'open', checks: 'passed' }, draft: false, checksPassedAt: '2026-11-01T04:00:00.000Z' },
    { url: pr(2), summary: { number: 2, state: 'open', checks: 'pending' }, draft: false, pending: { required: 1, optional: 0 }, train: { since: '2026-11-01T04:10:00.000Z' } },
    // Another repository's running checks hold nothing here.
    { url: pr(3, 'o/other'), summary: { number: 3, state: 'open', checks: 'pending' }, draft: false, train: { since: '2026-11-01T04:20:00.000Z' } },
    // A stale read is out of the train until Sotto reads it again, so it holds nothing (#2102).
    { url: pr(4), summary: { number: 4, state: 'open', checks: 'pending', stale: true }, draft: false, train: { since: '2026-11-01T04:30:00.000Z' } },
    // Unknown checks hold nothing either: Sotto cannot say they run.
    { url: pr(6), summary: { number: 6, state: 'open', checks: 'unknown' }, draft: false, train: { since: '2026-11-01T04:40:00.000Z' } }] }])
  expect(queue.map(item => [item.pullRequest.number, item.requiredChecks])).toEqual([[1, 'passed'], [2, 'running'], [3, 'running'], [6, 'unknown']])
  const green = { branch: 'main', head: 'd'.repeat(40), state: 'passed' as const }
  expect(mergeTurnHolds(queue, pr(1), green).running.map(item => item.pullRequest.number)).toEqual([2])
  // A pull request's own running checks never hold its own turn.
  expect(mergeTurnHolds(queue, pr(2), green).running).toEqual([])
  expect(mergeTurnHolds(queue, pr(2), { ...green, state: 'failed' })).toMatchObject({ running: [], baseFailed: { branch: 'main', state: 'failed' } })
  // Still running on main, or unread, is not red.
  expect(mergeTurnHolds(queue, pr(2), { ...green, state: 'pending' })).not.toHaveProperty('baseFailed')
  expect(mergeTurnHolds(queue, pr(2), undefined)).toEqual({ running: [] })
  // A check that failed early leaves required ones running, and those still hold the turn.
  const failedEarly = watcherMergeQueue([{ target: target('b'), title: 'Failing', open: [
    { url: pr(5), summary: { number: 5, state: 'open', checks: 'failed' }, draft: false, pending: { required: 2, optional: 0 }, train: { since: '2026-11-01T05:00:00.000Z' } }] }])
  expect(failedEarly[0]).toMatchObject({ requiredChecks: 'failed', checksRunning: { required: 2, optional: 0 } })
  expect(mergeTurnHolds(failedEarly, pr(1), green).running.map(item => item.pullRequest.number)).toEqual([5])
})

it('puts a pull request in the train at its first pass or READY TO MERGE, and keeps it there when its checks run again', () => {
  const store = new WatcherEvidenceStore(), url = pr(7), at = target('worker')
  const read = (head: string, checks: 'passed' | 'pending', observedAt: string) =>
    store.pullRequest(at, { url, head, observedAt, availability: 'available', checks, checkCount: 1, state: 'open' })
  read('e'.repeat(40), 'pending', '2026-11-01T09:00:00.000Z')
  expect(store.trainOf(at, url)).toBeUndefined()
  store.noteReady(at, url, 'e'.repeat(40), '2026-11-01T09:05:00.000Z')
  read('e'.repeat(40), 'passed', '2026-11-01T09:10:00.000Z')
  read('f'.repeat(40), 'pending', '2026-11-01T09:20:00.000Z')
  expect(store.trainOf(at, url)).toEqual({ since: '2026-11-01T09:05:00.000Z', ready: { head: 'e'.repeat(40), at: '2026-11-01T09:05:00.000Z' } })
  expect(store.headOf(at, url)).toBe('f'.repeat(40))
  // An older READY TO MERGE never replaces a newer one.
  store.noteReady(at, url, 'f'.repeat(40), '2026-11-01T09:25:00.000Z'); store.noteReady(at, url, 'e'.repeat(40), '2026-11-01T09:01:00.000Z')
  expect(store.trainOf(at, url)?.ready).toEqual({ head: 'f'.repeat(40), at: '2026-11-01T09:25:00.000Z' })
})

it('holds READY TO MERGE news that would not fit for the next wake-up, after the threads’ own messages, so none is cut', () => {
  const event = (index: number, kind: 'thread-told' | 'thread-ready'): WatcherEvent => ({ id: `${kind}-${index}`, kind, requestId: WATCHER_UNWATCHED_REQUEST_ID,
    target: target(`worker-${index}`), generation: 0, observedAt: '2026-11-05T10:00:00.000Z',
    ...kind === 'thread-told' ? { told: { words: 'w'.repeat(2_000), opened: false } } : { ready: { pullRequest: pr(index), head: 'a'.repeat(40) } } })
  const events = [...Array.from({ length: 40 }, (_, index) => event(index, 'thread-ready')), ...Array.from({ length: 3 }, (_, index) => event(index, 'thread-told'))]
  const later = toldEventsForLater(events)
  // The messages go first; the READY TO MERGE that fit go with them, and the rest wait rather than run out of room.
  expect(events.filter(item => item.kind === 'thread-told').every(item => !later.has(item.id))).toBe(true)
  const going = events.filter(item => item.kind === 'thread-ready' && !later.has(item.id))
  expect(going.length).toBeGreaterThan(0)
  expect(later.size).toBeGreaterThan(0)
  expect(going.map(item => item.id)).toEqual(events.filter(item => item.kind === 'thread-ready').slice(0, going.length).map(item => item.id))
})
