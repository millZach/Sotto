// @vitest-environment node
import { expect, it } from 'vitest'
import { keptChanges, keptCounts, openKept, WatcherStateChanges, type WatcherStateLists } from '../../../src/main/agents/watcherStateChanges'
import type { WatcherKeptState } from '../../../src/shared/watcher'

const AT = '2026-11-05T10:00:00.000Z', LATER = '2026-11-05T11:00:00.000Z'
const target = (threadId: string) => ({ hostId: 'synthetic-host', threadId })
const state = (lines: Partial<WatcherKeptState>): WatcherKeptState => ({ decisions: [], rules: [], issues: [], updatedAt: AT, ...lines })

// #2231: keep_state gives back only what it changed.
it('names each line a keep_state added, edited, touched, closed or removed, and nothing it left alone', () => {
  const before = state({ decisions: [{ id: 'd1', text: 'Merge #4?', touchedAt: AT }, { id: 'd2', text: 'Which icon?', touchedAt: AT }],
    rules: [{ id: 'r3', text: 'Suites run in CI.', touchedAt: AT }, { id: 'r4', text: 'Do not merge #9.', touchedAt: AT }],
    issues: [{ id: 'i5', text: '#1490', touchedAt: AT, closedAt: AT }] })
  const after = state({ decisions: [{ id: 'd1', text: 'Merge #4 after #7?', touchedAt: LATER }, { id: 'd2', text: 'Which icon?', touchedAt: AT, closedAt: LATER, closedNote: 'owl' }],
    rules: [{ id: 'r3', text: 'Suites run in CI.', touchedAt: LATER }, { id: 'r6', text: 'Ask before each release.', touchedAt: LATER }], issues: [] })
  expect(keptChanges(before, after)).toEqual([{ list: 'decisions', id: 'd1', change: 'edited' }, { list: 'decisions', id: 'd2', change: 'closed' },
    { list: 'rules', id: 'r3', change: 'touched' }, { list: 'rules', id: 'r6', change: 'added', text: 'Ask before each release.' },
    { list: 'rules', id: 'r4', change: 'removed' }, { list: 'issues', id: 'i5', change: 'removed' }])
  expect(keptChanges(after, after)).toEqual([])
  expect(keptCounts(after)).toEqual({ decisions: { open: 1, closed: 1 }, rules: { open: 2, closed: 0 }, issues: { open: 0, closed: 0 } })
  expect(openKept(after).decisions.map(line => line.id)).toEqual(['d1'])
})

const lists = (over: Partial<WatcherStateLists> = {}): WatcherStateLists => ({
  watching: [{ target: target('a'), title: 'A', waitsOn: 'Its turn to finish.', pullRequests: [{ number: 5, state: 'open', checks: 'pending' }] },
    { target: target('b'), title: 'B', waitsOn: 'Nothing. It is at rest.', pullRequests: [] }],
  mergeQueue: [{ target: target('b'), title: 'B', pullRequest: { number: 6, url: 'https://github.com/synthetic/project/pull/6', state: 'open', checks: 'passed' }, inTrainSince: AT, checksPassedAt: AT, requiredChecks: 'passed' }],
  waitingOnUser: [{ target: target('a'), title: 'A', waitsFor: 'question', requestCardId: 'card-1' }],
  kept: state({ rules: [{ id: 'r1', text: 'Suites run in CI.', touchedAt: AT }, { id: 'r2', text: 'Do not merge #9.', touchedAt: AT }] }),
  staleNotes: [{ list: 'rules', id: 'r2', reasons: ['Names pull request #9, which is merged.'] }],
  ...over,
})

// #2231: a repeat read_state gives only what changed since the read its cursor names.
it('gives only what changed since a read, counts what it left out and names what is gone', () => {
  const changes = new WatcherStateChanges(), first = lists(), cursor = changes.remember(first)
  expect(changes.since(cursor, first)).toEqual({ lists: { watching: [], mergeQueue: [], waitingOnUser: [], staleNotes: [], kept: state({}) },
    unchanged: { watching: 2, mergeQueue: 1, waitingOnUser: 1, kept: 2, staleNotes: 1 }, gone: {} })
  const next = lists({
    watching: [{ ...first.watching[0]!, pullRequests: [{ number: 5, state: 'open', checks: 'passed' }] }],
    mergeQueue: [], waitingOnUser: [],
    kept: state({ rules: [first.kept.rules[0]!, { id: 'r2', text: 'Do not merge #9.', touchedAt: AT, closedAt: LATER, closedNote: 'done' }] }), staleNotes: [] })
  const since = changes.since(cursor, next)!
  expect(since.lists.watching.map(row => row.target.threadId)).toEqual(['a'])
  expect(since.lists.kept.rules.map(line => line.id)).toEqual(['r2'])
  expect(since.unchanged).toEqual({ watching: 0, mergeQueue: 0, waitingOnUser: 0, kept: 1, staleNotes: 0 })
  expect(since.gone).toEqual({ watching: [target('b')], mergeQueue: [{ target: target('b'), pullRequest: { number: 6, url: 'https://github.com/synthetic/project/pull/6' } }],
    waitingOnUser: [first.waitingOnUser[0]], staleNotes: ['r2'] })
})

it('holds only the last few reads, in memory, and knows no cursor it did not give', () => {
  const changes = new WatcherStateChanges(), first = changes.remember(lists())
  expect(changes.since('not-a-cursor', lists())).toBeUndefined()
  for (let at = 0; at < 8; at++) changes.remember(lists())
  expect(changes.since(first, lists())).toBeUndefined()
})
