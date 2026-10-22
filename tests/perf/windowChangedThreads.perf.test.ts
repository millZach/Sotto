// @vitest-environment node
/**
 * What one `AGENT_STATE` broadcast costs main and the window while threads stream at the owner's scale, with every
 * thread record on each broadcast and with only the records that changed (issue #1330). Main is built as
 * `src/main/index.ts` wires it on Owl and on stable (`tests/fixtures/ownerScalePipeline.ts`: about 250 threads on this computer and 40
 * on a connected remote host), three threads stream, and every state the desktop router publishes goes through main's
 * `AgentStateBroadcaster`, is serialized as Electron's structured clone serializes it (`node:v8`), and is read back by
 * the page's own `wrapAgentBridge` and state sharing, in order.
 *
 * The default run asserts what does not depend on the machine: every state the page rebuilds is the state main
 * published, and a streaming broadcast is a small fraction of the bytes the whole thread array was. With
 * `SOTTO_PERF_BENCH=1` it also reports the time each side spends per broadcast, on both encodings:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/windowChangedThreads.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * It reads only byte counts and durations; no thread content is reported.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { deserialize, serialize } from 'node:v8'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentStateBroadcaster, ThreadRecordsBroadcast } from '../../src/main/agents/agentStateBroadcast'
import { wrapAgentBridge } from '../../src/renderer/src/agents/agentStateCatalogs'
import { createStateSharing } from '../../src/renderer/src/agents/stateSharing'
import type { AgentState, AgentStateBroadcast, AgentWireBridge } from '../../src/shared/agents'
import { ownerScalePipeline, type OwnerScaleTrack } from '../fixtures/ownerScalePipeline'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const CHUNKS = 40
const STREAMS = 3
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface Sent {
  /** The state as published, copied when it was sent, to check the page's rebuild against. */
  readonly expected: AgentState
  readonly changed: Buffer
  readonly whole: Buffer
  /** Main's time to encode and serialize the broadcast, in ms, with only the changed records and with every one. */
  readonly changedMainMs: number
  readonly wholeMainMs: number
}

/** The page's side of a run of broadcasts: deserialize, rebuild through `wrapAgentBridge`, then share against the last state. */
function replay(buffers: readonly Buffer[]): { states: AgentState[]; ms: number[] } {
  let listener: ((raw: unknown) => void) | null = null
  const bridge = { get: () => Promise.reject(new Error('A broadcast of this run could not be put back.')), command: () => Promise.reject(new Error('unused')),
    onState: (next: (raw: unknown) => void) => { listener = next; return () => { listener = null } } } as unknown as AgentWireBridge
  const share = createStateSharing()
  const states: AgentState[] = [], ms: number[] = []
  let shown: AgentState | undefined, arrived: AgentState | undefined
  wrapAgentBridge(bridge).onState(state => { arrived = state })
  for (const buffer of buffers) {
    const started = performance.now()
    arrived = undefined
    listener!(deserialize(buffer))
    if (arrived === undefined) throw new Error('A broadcast of this run could not be put back.')
    shown = share(shown, arrived)
    ms.push(performance.now() - started)
    states.push(arrived)
  }
  return { states, ms }
}

/** The page's side as it was: every broadcast carried the whole thread array. */
function replayWhole(buffers: readonly Buffer[]): number[] {
  const share = createStateSharing()
  let shown: AgentState | undefined
  return buffers.map(buffer => {
    const started = performance.now()
    const raw = deserialize(buffer) as AgentStateBroadcast & { host: { threads: AgentState['host']['threads'] } }
    // The catalogs went by revision before this change too; the page's catalog cache is not what is measured here.
    shown = share(shown, { ...raw, host: { ...raw.host, models: [], clientHosts: raw.host.clientHosts?.map(client => ({ ...client, models: [] })) } } as unknown as AgentState)
    return performance.now() - started
  })
}

const roots: string[] = []
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })

async function streamAtOwnerScale(track: OwnerScaleTrack): Promise<{ sent: Sent[]; streamingFrom: number; threads: number }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-window-changed-threads-')); roots.push(root)
  const pipeline = await ownerScalePipeline(root, { threads: 1, history: 1 }, STREAMS, track)
  const broadcaster = new AgentStateBroadcaster()
  // The thread comparison on its own, timed apart so the encoding as it was can be costed without it.
  const probe = new ThreadRecordsBroadcast()
  const sent: Sent[] = []
  const off = pipeline.router.subscribe(state => {
    let payload: AgentStateBroadcast | undefined
    let started = performance.now()
    broadcaster.send(state, next => { payload = next; return true })
    const encodeMs = performance.now() - started
    started = performance.now()
    probe.encode(state.host.threads).commit()
    const compareMs = performance.now() - started
    started = performance.now()
    const changed = serialize(payload)
    const changedSerializeMs = performance.now() - started
    // The encoding as it was: the same catalog revisions, with every thread record on every broadcast.
    started = performance.now()
    const whole = serialize({ ...payload!, host: { ...payload!.host, threads: state.host.threads } })
    const wholeSerializeMs = performance.now() - started
    sent.push({ expected: structuredClone(state), changed, whole,
      changedMainMs: encodeMs + changedSerializeMs, wholeMainMs: Math.max(0, encodeMs - compareMs) + wholeSerializeMs })
  })
  try {
    await pause(1_000)
    const sessions = pipeline.streamSessions.slice(0, STREAMS)
    const at = new Date().toISOString()
    for (const session of sessions) {
      const thread = pipeline.adapter.state.threads.find(item => item.id === session)!
      pipeline.adapter.log.add(session, { id: 'prompt', role: 'user', text: 'Synthetic prompt', createdAt: at }); thread.status = 'running'
      pipeline.adapter.log.add(session, { id: 'reply', role: 'assistant', text: 'First', createdAt: at })
    }
    pipeline.adapter.publish(true)
    await pause(500)
    const streamingFrom = sent.length
    for (let chunk = 0; chunk < CHUNKS; chunk++) {
      for (const session of sessions) pipeline.adapter.log.appendText(session, 'reply', ` word${chunk}`)
      pipeline.adapter.publish(true)
      await pause(20)
    }
    await pause(500)
    return { sent, streamingFrom, threads: pipeline.router.shell().host.threads.length }
  } finally {
    off()
    await pipeline.stop()
  }
}

describe.each(['owl', 'stable'] as const)('the window broadcast carries only the thread records that changed on %s (#1330)', track => {
  it('rebuilds every state main published, from a fraction of the bytes, while three threads stream at the owner\'s scale', async () => {
    const { sent, streamingFrom, threads } = await streamAtOwnerScale(track)
    const streaming = sent.slice(streamingFrom)
    expect(threads).toBeGreaterThanOrEqual(250)
    expect(streaming.length).toBeGreaterThanOrEqual(10)
    const { states, ms } = replay(sent.map(item => item.changed))
    for (const [index, state] of states.entries()) expect(state).toEqual(sent[index]!.expected)

    const bytes = (pick: (item: Sent) => Buffer) => median(streaming.map(item => pick(item).length))
    const changedBytes = bytes(item => item.changed), wholeBytes = bytes(item => item.whole)
    // A streaming broadcast carries the threads that stream and the shell around them, not the other 280 records.
    expect(changedBytes).toBeLessThan(wholeBytes / 5)

    const wholeMs = replayWhole(sent.map(item => item.whole))
    const report = {
      track, threads, broadcasts: sent.length, streamingBroadcasts: streaming.length,
      medianStreamingBytes: { whole: wholeBytes, changed: changedBytes },
      medianMainMs: { whole: round(median(streaming.map(item => item.wholeMainMs)), 3), changed: round(median(streaming.map(item => item.changedMainMs)), 3) },
      medianPageMs: { whole: round(median(wholeMs.slice(streamingFrom)), 3), changed: round(median(ms.slice(streamingFrom)), 3) },
    }
    if (PERF_BENCH) console.info(`windowChangedThreads ${JSON.stringify(report)}`)
  }, 180_000)
})
