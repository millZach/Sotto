// @vitest-environment node
/**
 * From a reply's first streamed chunk to the window's bridge (#771). The chain is main's own, with real timers:
 * an event-sourced provider using the adapters' message log and snapshot publisher, the workspace host, the
 * coordinator, and the desktop's shell publisher and per-thread detail lane wired as `src/main/index.ts` wires them
 * (the held shell goes just ahead of a detail that opens a message), whose sends stand for the window's bridge.
 *
 * Each trial lets every window close, publishes a prompt's echo the way an adapter does (an event and an immediate
 * snapshot), waits `gap` ms, then publishes the first chunk of the reply (a message-added event and a streamed
 * snapshot). It times the chunk to the first send that carries the reply, and how much of that came after the
 * chunk's own task had returned (time spent waiting on a timer rather than working), then streams 40 more chunks
 * 2 ms apart and counts the sends they became.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/firstWordsBridge.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { testCredentials } from '../fixtures/testCredentials'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import type { AgentThreadDetailUpdate } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const TRIALS = 15
const GAPS = [0, 5, 10, 30] as const
const FOLLOWING_CHUNKS = 40

/** A provider that records through the adapters' own log and publishes through their own publisher. */
class StreamingProvider extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly publisher = new ProviderSnapshotPublisher(() => super.emit(), () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
}

const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const carries = (update: AgentThreadDetailUpdate, id: string): boolean => 'messageDeltas' in update
  ? update.messageDeltas.some(item => ('message' in item ? item.message.id : item.id) === id)
  : update.messages.some(message => message.id === id)

const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-first-words-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(!PERF_BENCH)("first streamed chunk to the window’s bridge (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  it('reports the wait for the first chunk and the sends the rest became', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-first-words-')); roots.push(root)
    const provider = new StreamingProvider()
    const workspace = new WorkspaceHost(provider, root)
    const credentials = await testCredentials(root, { mode: 'unavailable' })
    const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner })
    await control.start(); await control.command({ type: 'connect' })
    const threadId = provider.state.threads[0]!.id
    await control.command({ type: 'observe-threads', threadIds: [threadId] })
    const sends: { at: number; update: AgentThreadDetailUpdate }[] = []
    const shell = coalesceAgentStatePublishes(() => undefined)
    const bridge = coalesceAgentThreadDetailPublishes(update => sends.push({ at: performance.now(), update }), { beforeOpening: () => shell.flush() })
    const unsubscribeShell = control.subscribe(state => shell.publish(state))
    const unsubscribe = control.subscribeThreadDetail(update => bridge.publish(update))
    control.threadDetail(threadId)

    const results: Record<string, unknown> = {}
    let turn = 0
    for (const gap of GAPS) {
      const waits: number[] = []
      const timed: number[] = []
      const following: number[] = []
      for (let trial = 0; trial < TRIALS; trial++) {
        turn += 1
        await sleep(120)
        const at = new Date().toISOString()
        provider.log.add(threadId, { id: `prompt-${turn}`, role: 'user', text: `Prompt ${turn}`, createdAt: at })
        provider.publish(false)
        if (gap > 0) await sleep(gap)
        const reply = `reply-${turn}`
        const started = performance.now()
        provider.log.add(threadId, { id: reply, role: 'assistant', text: 'First', createdAt: at })
        provider.publish(true)
        // Work done inside the chunk's own task (writing its event, copying the snapshot) is not a wait on a timer.
        const returned = performance.now()
        while (!sends.some(send => send.at >= started && carries(send.update, reply))) await sleep(0)
        const reached = sends.find(send => send.at >= started && carries(send.update, reply))!.at
        waits.push(reached - started)
        timed.push(Math.max(0, reached - returned))
        const before = sends.length
        for (let chunk = 0; chunk < FOLLOWING_CHUNKS; chunk++) {
          provider.log.appendText(threadId, reply, ` w${chunk}`)
          provider.publish(true)
          await sleep(2)
        }
        await sleep(120)
        following.push(sends.length - before)
      }
      results[`gap ${gap} ms`] = { firstChunkToBridgeMs: { median: round(median(waits), 2), max: round(Math.max(...waits), 2) },
        afterTheChunksOwnTaskMs: { median: round(median(timed), 2), max: round(Math.max(...timed), 2) },
        sendsFor40Chunks: { median: median(following), max: Math.max(...following) } }
    }
    console.log(`first words to bridge: ${JSON.stringify(results)}`)
    expect(Object.keys(results)).toHaveLength(GAPS.length)
    unsubscribe(); unsubscribeShell(); bridge.dispose(); shell.dispose(); control.dispose(); workspace.dispose()
  }, 180_000)
})
