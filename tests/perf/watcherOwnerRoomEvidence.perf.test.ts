// @vitest-environment node
/**
 * What Watcher's room costs to build with the owner's own record (`watcherOwnerRecord.ts`, November 13, 2026) and the
 * evidence Sotto holds for its threads. The room is built again for every publish, which on that day ran about 730 times
 * a minute, and each build made every thread's evidence again: about 2 ms of a 6.9 ms build in that day's recording, and
 * the part that grew most since the Owl before.
 *
 * The first test runs in the default suite: a room built again with nothing changed hands out every thread's evidence as
 * the build before did, the same lists, and a change to one thread's evidence makes that thread's list again and no other.
 * The second times builds and prints JSON; it runs only under `SOTTO_PERF_BENCH=1`
 * (`docs/perf/2026-11-13-watcher-room-evidence.md`).
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherOwnerRoomEvidence.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import type { WatcherEvidence, WatcherThreadTarget } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { ownerWatcherRecord } from '../fixtures/watcherOwnerRecord'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const PAIRED = '00000000-0000-4000-8000-0000000000a2'

/** The evidence a thread with one pull request holds: its link, state and checks, its working copy and its last turn. */
function threadEvidence(target: WatcherThreadTarget, index: number, observedAt: string): [string, Omit<WatcherEvidence, 'id'>][] {
  const url = `https://github.com/owner/repository/pull/${1_000 + index}`, pr = `github.com/owner/repository/pull/${1_000 + index}`
  const github = { target, source: 'github' as const, observedAt, freshness: 'fresh' as const, availability: 'available' as const, url, headId: `head-${index}` }
  return [
    [`pr:${pr}`, { ...github, fact: 'pull-request-observed' }],
    [`pr:${pr}:state`, { ...github, fact: 'pull-request-observed', pullRequestState: 'open' }],
    [`pr:${pr}:checks`, { ...github, fact: 'checks-passed', checksState: 'passed', checkCount: 12 }],
    ['working-copy', { target, source: 'working-copy', observedAt, freshness: 'fresh', availability: 'available', fact: 'files-changed', branch: `feat/branch-${index}`, changedFiles: 4, insertions: 120, deletions: 30, ahead: 1, behind: 0 }],
    ['turn', { target, source: 'native-turn', observedAt, freshness: 'fresh', availability: 'available', fact: 'turn-finished', turnId: `turn-${index}` }],
  ]
}

/** A desktop's Watcher holding the owner's record, with the evidence above for every thread the record names. */
async function ownerRoom() {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true } })
  const watcher = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => false })
  cleanups.push(async () => { watcher.close(); await f.dispose(); await workspace.stop(); await workspace.remove() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const native = f.control.watcherSnapshot().threads[0]!, local = f.control.hostId()!
  const record = ownerWatcherRecord(local, PAIRED), owner = record.current!.target.threadId
  const retarget = (target: { hostId: string; threadId: string }) => { if (target.hostId === local && target.threadId === owner) target.threadId = native.id }
  record.current!.target.threadId = native.id
  for (const request of record.requests) retarget(request.watcher)
  for (const turn of record.promptTurns ?? []) retarget(turn.watcher)
  await f.control.watcherRecords.update(next => Object.assign(next, record))
  const targets = new Map<string, WatcherThreadTarget>()
  for (const request of record.requests) for (const participant of request.participants) targets.set(JSON.stringify([participant.target.hostId, participant.target.threadId]), participant.target)
  for (const watch of record.watches ?? []) targets.set(JSON.stringify([watch.target.hostId, watch.target.threadId]), watch.target)
  // Read a minute ago, so nothing turns stale while the builds run.
  const observedAt = new Date(Date.now() - 60_000).toISOString()
  ;[...targets.values()].forEach((target, index) => { for (const [slot, input] of threadEvidence(target, index, observedAt)) watcher.wakes.evidence.put(slot, input) })
  return { watcher, targets: [...targets.values()], observedAt }
}

it('hands out each thread\'s evidence again until that thread\'s evidence changes', async () => {
  const room = await ownerRoom()
  const first = room.watcher.state(), second = room.watcher.state()
  // Every thread the owner's record names: 405 of them.
  expect(first.watchedThreads.length).toBeGreaterThan(400)
  expect(first.watchedThreads.every(thread => thread.evidence?.length === 5)).toBe(true)
  second.watchedThreads.forEach((thread, index) => expect(thread.evidence).toBe(first.watchedThreads[index]!.evidence))
  // A fact that changes on one thread makes its list again, with the fact, and leaves every other thread's as it was.
  const changed = room.targets[7]!
  room.watcher.wakes.evidence.put('turn', { target: changed, source: 'native-turn', observedAt: new Date().toISOString(), freshness: 'fresh', availability: 'available', fact: 'turn-failed', turnId: 'turn-new', failureCategory: 'provider-turn-failed' })
  const third = room.watcher.state(), key = (target: WatcherThreadTarget) => `${target.hostId}\n${target.threadId}`
  for (const [index, thread] of third.watchedThreads.entries()) {
    if (key(thread.target) === key(changed)) {
      expect(thread.evidence).not.toBe(second.watchedThreads[index]!.evidence)
      expect(thread.evidence?.some(item => item.turnId === 'turn-new')).toBe(true)
    } else expect(thread.evidence).toBe(second.watchedThreads[index]!.evidence)
  }
}, 60_000)

it.skipIf(!PERF_BENCH)('measures a room build with the owner\'s record and its threads\' evidence', async () => {
  const room = await ownerRoom()
  for (let build = 0; build < 10; build++) room.watcher.state()
  const times: number[] = [], evidence: number[] = []
  for (let build = 0; build < 60; build++) {
    const start = performance.now(); room.watcher.state(); times.push(performance.now() - start)
    const read = performance.now(); for (const target of room.targets) room.watcher.wakes.evidence.read(target, true); evidence.push(performance.now() - read)
  }
  console.log(`OWNER-ROOM ${JSON.stringify({ threads: room.targets.length, roomMedianMs: round(median(times), 2), roomMinMs: round(Math.min(...times), 2),
    evidenceReadsMedianMs: round(median(evidence), 3) })}`)
}, 120_000)
