// @vitest-environment node
// What read_state works out from live data at each read (#1274): the merge queue, what holds a pending settle, and the
// kept notes that name something Sotto's records say is over.
import { expect, it } from 'vitest'
import { watcherMergeQueue, watcherSettlesWhen, watcherStaleNotes, type WatcherKnownThread } from '../../../src/main/agents/watcherComputedState'
import { WatcherEvidenceStore } from '../../../src/main/agents/watcherEvidence'

const target = (threadId: string) => ({ hostId: '11111111-1111-4111-8111-111111111111', threadId })
const nothing = { decisions: [], rules: [], issues: [] }

it('queues open pull requests that are not drafts and whose checks passed, oldest pass first', () => {
  const queue = watcherMergeQueue([
    { target: target('a'), title: 'Login fix', open: [
      { summary: { number: 12, state: 'open', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T10:05:00.000Z' },
      { summary: { number: 13, state: 'open', checks: 'pending' }, draft: false },
      { summary: { number: 14, state: 'open', checks: 'passed' }, draft: true, checksPassedAt: '2026-10-21T09:00:00.000Z' },
      // Read only from evidence, which does not say whether it is a draft: not queued.
      { summary: { number: 15, state: 'open', checks: 'passed' }, draft: undefined, checksPassedAt: '2026-10-21T08:30:00.000Z' }] },
    { target: target('b'), title: 'Docs pass', open: [
      { summary: { number: 9, state: 'open', checks: 'passed', approved: true }, draft: false, checksPassedAt: '2026-10-21T10:00:00.000Z' },
      { summary: { number: 8, state: 'open', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T10:05:00.000Z' },
      // Merged since its links were read: not open, so not queued.
      { summary: { number: 7, state: 'merged', checks: 'passed' }, draft: false, checksPassedAt: '2026-10-21T08:00:00.000Z' }] },
  ])
  expect(queue.map(item => [item.title, item.pullRequest.number])).toEqual([['Docs pass', 9], ['Docs pass', 8], ['Login fix', 12]])
  expect(queue[0]).toMatchObject({ target: target('b'), pullRequest: { approved: true }, checksPassedAt: '2026-10-21T10:00:00.000Z' })
})

it('says what holds a pending settle: its pull requests, else Watcher hearing its news and resting', () => {
  expect(watcherSettlesWhen({ pullRequests: ['https://github.com/o/r/pull/7'], unheard: false })).toBe('Its pull request #7 merges or closes.')
  expect(watcherSettlesWhen({ pullRequests: ['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/8', 'https://github.com/o/s/pull/2'], unheard: true }))
    .toBe('Its pull requests #7, #8 and #2 merge or close.')
  expect(watcherSettlesWhen({ pullRequests: [], unheard: true })).toBe('Watcher is told its news and rests.')
  expect(watcherSettlesWhen({ pullRequests: [], unheard: false })).toBe('Watcher’s turn ends and it rests.')
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
  const stale = watcherStaleNotes({
    decisions: ['Merge #40 once CI is green?', 'Ask about PR 41 and pull request #42', 'Merge https://github.com/o/r/pull/40/files after review'],
    rules: ['Leave the release notes draft alone', 'Thread 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb needs a look', 'Keep the Login timeout fix moving'],
    issues: ['#43 Watcher keeps stale notes', '#9999 not a pull request Sotto knows', 'Fix the new thread button',
      // Two links with one number name two pull requests: the merged one flags, whichever comes first.
      'Compare https://github.com/o/s/pull/43 with https://github.com/o/r/pull/43', 'Look at fix ci again'],
  }, threads, pullRequests)
  expect(stale).toEqual([
    { list: 'decisions', index: 0, reasons: ['Names pull request #40, which is merged.'] },
    { list: 'decisions', index: 1, reasons: ['Names pull request #41, which is closed.'] },
    { list: 'decisions', index: 2, reasons: ['Names pull request #40, which is merged.'] },
    { list: 'rules', index: 0, reasons: ['Names the thread “Release notes draft”, which is settled.'] },
    { list: 'rules', index: 1, reasons: ['Names the thread “Flaky e2e hunt”, which Watcher does not watch.'] },
    { list: 'issues', index: 3, reasons: ['Names pull request #43, which is merged.'] },
    { list: 'issues', index: 4, reasons: ['Names the thread “Fix CI”, which is settled.'] },
  ])
})

it('flags nothing when the kept notes name only what is live, or nothing at all', () => {
  expect(watcherStaleNotes(nothing, threads, pullRequests)).toEqual([])
  expect(watcherStaleNotes({ ...nothing, rules: ['Full test suites run in CI, not on the laptop.', 'Release notes drafting waits for Zach'] }, threads, pullRequests)).toEqual([])
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
