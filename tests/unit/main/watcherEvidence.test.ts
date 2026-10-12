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
  const read = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null,
    checks: [{ name: 'private check command', status: 'success', required: true, url: null }], remarks: [] }, centerTime)
  store.pullRequest(centerTarget, read)
  expect(store.read(centerTarget)).toMatchObject([{ source: 'github', target: centerTarget, headId: 'head-a', fact: 'checks-passed', checkCount: 1 }])
  store.pullRequest(centerTarget, pullRequestObservation({ ...fingerprint, head: 'head-b' }, null, centerTime, read))
  expect(store.read(centerTarget)).toMatchObject([{ headId: 'head-b', fact: 'pull-request-observed', reason: 'checks-unavailable' }])
  expect(store.read(centerTarget)[0]!.checkCount).toBeUndefined()
  store.pullRequest(centerTarget, { url, head: 'head-b', observedAt: centerTime, availability: 'unavailable', reason: 'rate-limited' })
  expect(store.read(centerTarget)).toMatchObject([{ freshness: 'stale', availability: 'unavailable', reason: 'rate-limited' }])
  expect(JSON.stringify(store.read(centerTarget))).not.toMatch(/private/)
})
it('does not infer passing checks from a zero-check or refused result, or a review from worker words', () => {
  for (const checks of [null, []]) {
    const read = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null, checks, remarks: [] }, centerTime)
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
  const previous = pullRequestObservation(fingerprint, { head: 'head-a', rateLimit: null,
    checks: [{ name: 'build', status: 'success', required: true, url: null }], remarks: [] }, centerTime)
  const remarksOnly = { head: 'head-a', rateLimit: null, checks: null, remarks: [] }
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
