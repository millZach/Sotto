// @vitest-environment node
/**
 * What a streamed word costs the coordinator's detail stream on a long thread, counted rather than timed (#1248). A thread
 * with 2,000 activity records cost main 2.35 ms of detail work per chunk against 0.15 ms for a short one, because once a
 * thread's records came back under new identities with the same content, as a store read gives them back, every later
 * publish compared each record by signature again, for every long thread on screen and for the window's held copy. It
 * counts the signatures the detail stream works out per streamed chunk, with 200 and with 2,000 records on each of three
 * observed threads, after their records were replaced by equal copies, and fails when any chunk works one out for a record
 * that did not change. It counts, never times, so it runs in the default suite.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { immutableActivities } from '../../src/main/agents/activitySnapshots'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThreadDetailUpdate } from '../../src/shared/agents'
import { ownerScalePipeline } from '../fixtures/ownerScalePipeline'

const turn = globalThis.setImmediate
const fileWorkInFlight = (): boolean => process.getActiveResourcesInfo().some(name => /^(FSReq|FileHandle|CloseReq)/u.test(name))
async function settled(): Promise<void> {
  for (let quiet = 0; quiet < 3;) { await new Promise<void>(resolve => { turn(resolve) }); quiet = fileWorkInFlight() ? 0 : quiet + 1 }
}
async function pass(ms: number): Promise<void> { for (let elapsed = 0; elapsed < ms; elapsed += 5) { await vi.advanceTimersByTimeAsync(5); await settled() } }
async function until<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(() => { done = true }, () => { done = true })
  await settled()
  while (!done) { await vi.advanceTimersByTimeAsync(5); await settled() }
  return work
}

const roots: string[] = []
beforeAll(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }) })
afterAll(async () => { vi.useRealTimers(); for (const root of roots) await rm(root, { recursive: true, force: true }) })

const CHUNKS = 10

/** Signatures worked out per streamed chunk, and the detail updates the window was sent, with `records` on each long thread. */
async function streamed(records: number): Promise<{ signaturesPerChunk: number[]; updates: AgentThreadDetailUpdate[]; added: boolean }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-long-detail-')); roots.push(root)
  const p = await until(ownerScalePipeline(root, { threads: 0.25, history: 1 }, 3, 'owl'))
  try {
    await pass(1_000)
    const at = new Date().toISOString()
    for (const session of p.streamSessions) {
      for (let turnIndex = 0; turnIndex < 40; turnIndex++) {
        p.adapter.log.add(session, { id: `${session}-u${turnIndex}`, role: 'user', text: `Synthetic question ${turnIndex}`, createdAt: at })
        p.adapter.log.add(session, { id: `${session}-r${turnIndex}`, role: 'assistant', text: `Synthetic answer ${turnIndex}`, createdAt: at })
      }
      p.adapter.state.threads.find(item => item.id === session)!.activities = Array.from({ length: records }, (_, position): AgentActivity => ({ id: `${session}-a${position}`,
        turnId: `${session}-t${Math.floor(position / 4)}`, sequence: position, kind: 'command', status: 'completed', title: `Synthetic command ${position}`, output: `output ${position}` }))
      p.adapter.mark(session)
    }
    p.adapter.publish(false)
    await pass(1_000)
    // The same records come back under new identities, as a read of the thread store gives them.
    for (const session of p.streamSessions) {
      const thread = p.adapter.state.threads.find(item => item.id === session)!
      thread.activities = immutableActivities(structuredClone(thread.activities!))
      p.adapter.mark(session)
    }
    p.adapter.publish(false)
    await pass(1_000)
    const session = p.streamSessions[0]!
    const thread = p.adapter.state.threads.find(item => item.id === session)!
    thread.status = 'running'
    p.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: new Date().toISOString() })
    p.adapter.mark(session); p.adapter.publish(true)
    await pass(1_000)
    const control = p.control as unknown as { certifiedActivitySignature: (record: AgentActivity) => string }
    const native = control.certifiedActivitySignature
    let signatures = 0
    control.certifiedActivitySignature = record => { signatures++; return native(record) }
    const updates: AgentThreadDetailUpdate[] = []
    const off = p.control.subscribeThreadDetail(update => { updates.push(update) })
    const signaturesPerChunk: number[] = []
    try {
      for (let chunk = 0; chunk < CHUNKS; chunk++) {
        signatures = 0
        p.adapter.log.appendText(session, 'reply', ` word${chunk}`)
        // A record that does change, halfway: it must still reach the window.
        if (chunk === CHUNKS / 2) thread.activities = immutableActivities([...thread.activities!, { id: `${session}-new`, turnId: `${session}-t-new`,
          sequence: records, kind: 'command', status: 'running', title: 'Synthetic new command' }])
        p.adapter.mark(session); p.adapter.publish(true)
        await pass(50)
        signaturesPerChunk.push(signatures)
      }
    } finally { off(); control.certifiedActivitySignature = native }
    const added = updates.some(update => 'activityDeltas' in update && update.activityDeltas.some(item => 'record' in item && item.record.id === `${session}-new`))
    return { signaturesPerChunk, updates, added }
  } finally { await until(p.stop()); vi.clearAllTimers() }
}

it('works out no signature on a streamed word for records that did not change, however long the thread', async () => {
  const short = await streamed(200)
  const long = await streamed(2_000)
  for (const run of [short, long]) {
    expect(run.updates.length).toBeGreaterThanOrEqual(CHUNKS)
    expect(run.added).toBe(true)
  }
  // No chunk works out an unchanged record's signature; the chunk that brings the new record works out a few, the same few
  // however many records the thread holds (before: every record of each of the three threads, on every chunk).
  for (const run of [short, long]) {
    expect(run.signaturesPerChunk.filter((_, chunk) => chunk !== CHUNKS / 2)).toEqual(Array.from({ length: CHUNKS - 1 }, () => 0))
    expect(run.signaturesPerChunk[CHUNKS / 2]).toBeLessThanOrEqual(4)
  }
}, 300_000)
