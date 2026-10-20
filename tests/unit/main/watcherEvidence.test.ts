// @vitest-environment node
import { expect, it } from 'vitest'
import { type AgentThread } from '../../../src/shared/agents'
import { WatcherEvidenceStore } from '../../../src/main/agents/watcherEvidence'
import { pullRequestObservation, type PullRequestFingerprint } from '../../../src/main/agents/githubBabysitReads'
import { centerTarget, centerTime } from '../../fixtures/watcher'

const url = 'https://github.com/o/r/pull/1'
const fingerprint: PullRequestFingerprint = { url, number: 1, title: 'private title', head: 'head-a', state: 'open', mergeable: 'unknown', base: 'main',
  status: 'private fingerprint', remarks: 'private remarks', checksRunning: false, reviewThreads: 0 }
it('publishes only sourced, bounded facts from GitHub and invalidates checks on a changed head or failed read', () => {
  const store = new WatcherEvidenceStore()
  const read = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null, requiredChecks: null, checksComplete: true,
    checks: [{ name: 'private check command', context: 'private check command', status: 'success', required: true, url: null }], remarks: [] }, centerTime)
  store.pullRequest(centerTarget, read)
  expect(store.read(centerTarget).find(item => item.checksState)).toMatchObject({ source: 'github', target: centerTarget, headId: 'head-a', fact: 'checks-passed', checkCount: 1 })
  store.pullRequest(centerTarget, pullRequestObservation({ ...fingerprint, head: 'head-b' }, null, centerTime, read))
  expect(store.read(centerTarget).find(item => item.checksState)).toMatchObject({ headId: 'head-b', fact: 'pull-request-observed', reason: 'checks-unavailable' })
  expect(store.read(centerTarget)[0]!.checkCount).toBeUndefined()
  store.pullRequest(centerTarget, { url, head: 'head-b', observedAt: centerTime, availability: 'unavailable', reason: 'rate-limited' })
  expect(store.read(centerTarget).every(item => item.freshness === 'stale' && item.availability === 'unavailable' && item.reason === 'rate-limited')).toBe(true)
  expect(JSON.stringify(store.read(centerTarget))).not.toMatch(/private/)
})
it('does not infer passing checks from a zero-check or refused result, or a review from worker words', () => {
  for (const checks of [null, []]) {
    const read = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null, requiredChecks: null, checksComplete: true, checks, remarks: [] }, centerTime)
    expect(read.checks).toBe('unknown')
  }
  const store = new WatcherEvidenceStore()
  const thread: AgentThread = { id: 'worker', projectId: 'project', title: 'Worker', modelId: 'model', status: 'idle', requests: [],
    messages: [{ id: 'claim', role: 'assistant', text: 'Tests passed, approved, merged', createdAt: centerTime }] }
  store.observeThread(thread, centerTarget, centerTime)
  expect(store.read(centerTarget)).toEqual([])
})
it('labels Git totals as working-copy facts and never attributes shared edits or unavailable captures to a turn', () => {
  const store = new WatcherEvidenceStore()
  const thread: AgentThread = { id: 'worker', projectId: 'project', modelId: 'model', title: 'Worker', status: 'error', requests: [], messages: [],
    lastTurn: { id: 'failed-turn', status: 'failed' }, activities: [{ id: 'native-error', turnId: 'wake-proof-turn', sequence: 0, kind: 'turn', status: 'failed', title: 'private provider body' }],
    worktree: { mode: 'shared', status: 'ready', branch: 'main', baseBranch: 'main', git: { isRepository: true, branch: 'main', upstream: null, hasRemote: false,
      defaultBranch: 'main', isDefaultBranch: true, dirty: true, changedFiles: 2, insertions: 4, deletions: 1, ahead: 0, behind: 0, aheadOfDefault: null,
      pullRequest: null, readAt: centerTime, fetchedAt: null } } }
  store.observeThread(thread, centerTarget, centerTime)
  const git = store.read(centerTarget).find(item => item.source === 'working-copy')!
  expect(git).toMatchObject({ changedFiles: 2, insertions: 4, deletions: 1 })
  expect(git.turnId).toBeUndefined()
  expect(store.read(centerTarget).find(item => item.source === 'native-turn')).toMatchObject({ failureCategory: 'provider-turn-failed', turnId: 'failed-turn' })
  store.checkpoint(centerTarget, { threadId: 'worker', checkpointId: 'checkpoint', observedAt: centerTime, turnId: 'failed-turn',
    changedFiles: 7, availability: 'unavailable', reason: 'shared-checkout' })
  expect(store.read(centerTarget).find(item => item.source === 'checkpoint')).toMatchObject({ availability: 'unavailable', reason: 'shared-checkout' })
  expect(store.read(centerTarget).find(item => item.source === 'checkpoint')!.changedFiles).toBeUndefined()
  expect(JSON.stringify(store.read(centerTarget))).not.toContain('private provider body')
  expect(store.read(centerTarget, false).every(item => item.availability === 'unavailable' && item.freshness === 'stale')).toBe(true)
})
it('bounds the retained projection and fingerprints facts rather than repeated read times', () => {
  const store = new WatcherEvidenceStore()
  expect(store.pullRequest(centerTarget, { url, head: 'a', observedAt: centerTime, availability: 'available', checks: 'unknown' })).toBe(true)
  expect(store.pullRequest(centerTarget, { url, head: 'a', observedAt: '2026-10-11T10:00:00Z', availability: 'available', checks: 'unknown' })).toBe(false)
  for (let n = 0; n < 200; n++) store.put(String(n), { source: 'checkpoint', target: centerTarget, observedAt: centerTime, freshness: 'fresh', availability: 'available', fact: 'files-changed' })
  expect(store.read(centerTarget)).toHaveLength(100)
})


it('reuses checks only for unrequested same-URL same-head details and never for refused or mismatched reads', () => {
  const previous = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null, requiredChecks: null, checksComplete: true,
    checks: [{ name: 'build', context: 'build', status: 'success', required: true, url: null }], remarks: [] }, centerTime)
  const remarksOnly = { head: 'head-a', rateLimit: null, requiredChecks: null, checksComplete: true, checks: null, remarks: [] }
  expect(pullRequestObservation(fingerprint, remarksOnly, centerTime, previous, false)).toMatchObject({ checks: 'passed', checkCount: 1 })
  for (const read of [
    pullRequestObservation(fingerprint, remarksOnly, centerTime, previous, true),
    pullRequestObservation(fingerprint, { ...remarksOnly, head: 'other-head' }, centerTime, previous, false),
    pullRequestObservation(fingerprint, remarksOnly, centerTime, { ...previous, url: 'https://github.com/o/r/pull/2' }, false),
    pullRequestObservation(fingerprint, remarksOnly, centerTime, { ...previous, availability: 'unavailable' }, false),
  ]) {
    expect(read.checks).toBe('unknown')
    expect(read.checkCount).toBeUndefined()
  }
})

it('refreshes Git read and fetch times without changing fact identity', () => {
  const store = new WatcherEvidenceStore()
  const thread: AgentThread = { id: 'worker', projectId: 'project', modelId: 'model', title: 'Worker', status: 'running', requests: [], messages: [],
    worktree: { mode: 'shared', status: 'ready', branch: 'main', baseBranch: 'main', git: { isRepository: true, branch: 'main', upstream: null, hasRemote: false,
    defaultBranch: 'main', isDefaultBranch: true, dirty: true, changedFiles: 2, insertions: 4, deletions: 1,
    ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, readAt: centerTime, fetchedAt: null } } }
  expect(store.observeThread(thread, centerTarget, centerTime)).toBe(true)
  const id = store.read(centerTarget)[0]!.id
  const stamp = '2026-10-12T10:00:00.000Z'
  thread.worktree!.git!.readAt = stamp
  thread.worktree!.git!.fetchedAt = stamp
  expect(store.observeThread(thread, centerTarget, stamp)).toBe(false)
  expect(store.read(centerTarget, true, Date.parse(stamp))).toMatchObject([{ id, observedAt: stamp, fetchedAt: stamp, freshness: 'fresh' }])
})

it('keeps approval and auto-merge evidence at their own time across checks-only readers', () => {
  const store = new WatcherEvidenceStore(), initial = '2026-10-12T10:00:00.000Z', later = '2026-10-12T10:06:00.000Z'
  store.pullRequest(centerTarget, { url, head: 'same-head', observedAt: initial, availability: 'available', state: 'open',
    checks: 'passed', checkCount: 1, reviewApproved: true, autoMerge: true })
  const ids = store.read(centerTarget).map(item => item.id).sort()
  expect(store.pullRequest(centerTarget, { url, head: 'same-head', observedAt: later, availability: 'available', state: 'open',
    checks: 'passed', checkCount: 1 })).toBe(false)
  const facts = store.read(centerTarget, true, Date.parse(later))
  expect(facts.find(item => item.githubReviewApproved === true)).toMatchObject({ observedAt: initial, freshness: 'stale' })
  expect(facts.find(item => item.fact === 'auto-merge-observed')).toMatchObject({ observedAt: initial, freshness: 'stale' })
  expect(facts.find(item => item.checksState === 'passed')).toMatchObject({ observedAt: later, freshness: 'fresh' })
  expect(facts.map(item => item.id).sort()).toEqual(ids)
  expect(store.pullRequest(centerTarget, { url, head: 'same-head', observedAt: later, availability: 'available', state: 'open',
    checks: 'passed', checkCount: 1, reviewApproved: true, autoMerge: true })).toBe(false)
  expect(store.pullRequest(centerTarget, { url, head: 'next-head', observedAt: later, availability: 'available', checks: 'pending' })).toBe(true)
  expect(store.read(centerTarget).some(item => item.githubReviewApproved !== undefined || item.fact === 'auto-merge-observed')).toBe(false)
})

it('does not refresh check freshness when babysitting carries unrequested known checks forward', () => {
  const initial = pullRequestObservation(fingerprint, { head: fingerprint.head, rateLimit: null, requiredChecks: null, checksComplete: true,
    checks: [{ name: 'build', context: 'build', status: 'success', required: true, url: null }], remarks: [] }, centerTime)
  const later = '2026-10-12T10:00:00.000Z'
  const read = pullRequestObservation(fingerprint, { head: fingerprint.head, rateLimit: null, requiredChecks: null, checksComplete: true, checks: null, remarks: [] }, later, initial, false)
  const store = new WatcherEvidenceStore()
  store.pullRequest(centerTarget, initial); store.pullRequest(centerTarget, read)
  expect(store.read(centerTarget, true, Date.parse(later)).find(item => item.checksState === 'passed'))
    .toMatchObject({ observedAt: centerTime, freshness: 'stale' })
})

it('keeps explicit GitHub revocations and rejects late facts for an older head or field', () => {
  const store = new WatcherEvidenceStore(), initial = '2026-10-12T10:00:00.000Z', later = '2026-10-12T10:06:00.000Z'
  const full = { url, head: 'head-a', observedAt: initial, availability: 'available' as const, reviewApproved: true, autoMerge: true }
  store.pullRequest(centerTarget, full)
  expect(store.pullRequest(centerTarget, { ...full, observedAt: later, reviewApproved: false, autoMerge: false })).toBe(true)
  expect(store.pullRequest(centerTarget, full)).toBe(false)
  expect(store.read(centerTarget).find(item => item.githubReviewApproved !== undefined)).toMatchObject({ githubReviewApproved: false, observedAt: later })
  expect(store.read(centerTarget).find(item => item.githubAutoMergeEnabled !== undefined)).toMatchObject({ githubAutoMergeEnabled: false, observedAt: later })
  expect(store.pullRequest(centerTarget, { url, observedAt: later, head: 'head-b', availability: 'available' })).toBe(true)
  expect(store.pullRequest(centerTarget, full)).toBe(false)
  expect(store.read(centerTarget).every(item => item.headId === 'head-b')).toBe(true)
})

it('uses the same GitHub fact identities for equivalent URL spelling', () => {
  const store = new WatcherEvidenceStore()
  const read = { url, head: 'head-a', observedAt: centerTime, availability: 'available' as const, reviewApproved: true, autoMerge: true, checks: 'passed' as const }
  store.pullRequest(centerTarget, read)
  expect(store.pullRequest(centerTarget, { ...read, url: 'https://github.com/O/R/pull/1' })).toBe(false)
})

it('keeps fifty PRs quiet on identical reads while bounding the projection and surfacing real changes', () => {
  const store = new WatcherEvidenceStore()
  const read = (number: number) => ({ url: 'https://github.com/o/r/pull/' + number, head: 'head', observedAt: centerTime,
    availability: 'available' as const, state: 'open' as const, checks: 'passed' as const, checkCount: 1, reviewApproved: true, autoMerge: true })
  for (let n = 1; n <= 50; n++) store.pullRequest(centerTarget, read(n))
  const ids = store.read(centerTarget).map(item => item.id)
  for (let n = 1; n <= 50; n++) expect(store.pullRequest(centerTarget, { ...read(n), observedAt: '2026-10-12T12:00:00.000Z' })).toBe(false)
  expect(store.read(centerTarget).map(item => item.id)).toEqual(ids)
  expect(store.read(centerTarget)).toHaveLength(100)
  expect(store.pullRequest(centerTarget, { ...read(1), observedAt: '2026-10-12T12:01:00.000Z', checks: 'failed' })).toBe(true)
  expect(store.read(centerTarget).find(item => item.url === read(1).url && item.fact === 'checks-failed')).toBeDefined()
  expect(store.read(centerTarget)).toHaveLength(100)
})

it('never reads all checks as passed from a read that holds only some of them, though one failing still counts', () => {
  const check = (status: 'success' | 'failure') => ({ name: 'check', context: 'check', status, required: false, url: null })
  const partial = (status: 'success' | 'failure') => pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null, requiredChecks: null,
    checksComplete: false, checks: [check(status)], remarks: [] }, centerTime)
  expect(partial('success').checks).toBe('pending')
  expect(partial('failure').checks).toBe('failed')
})
