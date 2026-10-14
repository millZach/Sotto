// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/windowThreadShell.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { performance } from 'node:perf_hooks'
import { serialize, deserialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { agentStateSchema, type AgentState, type AgentStateBroadcast, type AgentWireBridge } from '../../src/shared/agents'
import { wrapAgentBridge } from '../../src/renderer/src/agents/agentStateCatalogs'
import { windowThreadShellFixture } from '../fixtures/windowThreadShell'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'


describe.skipIf(!PERF_BENCH)('desktop window thread shell (#991)', () => {
  it('reports cold and warm whole pipeline costs including encoding ownership', () => {
    const state = windowThreadShellFixture()
    expect(agentStateSchema.safeParse(state).success).toBe(true)
    expect([state.host.threads.length, state.host.projects.length, state.host.models.length]).toEqual([204, 43, 874])
    console.log(`window shell fixture: ${JSON.stringify({ threads: 204, projects: 43, models: 874,
      threadsJsonBytes: Buffer.byteLength(JSON.stringify(state.host.threads)), worktreeJsonBytes: Buffer.byteLength(JSON.stringify(state.host.threads.map(t => t.worktree))), usageJsonBytes: Buffer.byteLength(JSON.stringify(state.host.threads.map(t => t.usage))) })}`)
    // Before implementation both choices intentionally execute the existing path. Afterwards this same
    // fixture/schedule compares off/on; constructor options are discovered structurally for the baseline.
    for (const changed of [-1, 0, 1, 3, 6]) {
      for (const enabled of [false, true, false, true]) {
        const Constructor = AgentStateBroadcaster as unknown as new (options?: { streamingPublishCost?: boolean }) => AgentStateBroadcaster
        let broadcaster = new Constructor({ streamingPublishCost: enabled })
        const samples: number[] = [], encodeSamples: number[] = [], wireSamples: number[] = [], pageSamples: number[] = []
        let receive!: (payload: AgentStateBroadcast) => void
        let assembled!: AgentState
        const bridge = { get: async () => { throw new Error('Unexpected recovery') }, onState: (listener: typeof receive) => { receive = listener; return () => undefined } } as unknown as AgentWireBridge
        wrapAgentBridge(bridge).onState(value => { assembled = value })
        let bytes = 0
        broadcaster.send(state, payload => { receive(deserialize(serialize(payload))); return true })
        for (let iteration = 0; iteration < 220; iteration++) {
          if (changed < 0) broadcaster = new Constructor({ streamingPublishCost: enabled })
          for (let index = 0; index < Math.max(0, changed); index++) state.host.threads[index]!.summary!.lastAssistant!.text = `Synthetic progress ${iteration}`
          let payload!: AgentStateBroadcast
          const start = performance.now()
          broadcaster.send(state, value => { payload = value; return true })
          const encoded = performance.now()
          const wire = serialize(payload)
          const received = deserialize(wire) as AgentStateBroadcast
          const unpacked = performance.now()
          receive(received)
          const end = performance.now()
          bytes = wire.byteLength
          if (iteration >= 20) { samples.push(end - start); encodeSamples.push(encoded - start); wireSamples.push(unpacked - encoded); pageSamples.push(end - unpacked) }
        }
        expect(assembled.host.threads).toEqual(state.host.threads)
        console.log(`window shell (${changed < 0 ? 'cold/full' : `warm ${changed} changed`}, ${enabled ? 'on' : 'off'}): ${JSON.stringify({ bytes, totalMs: round(median(samples), 4), encodeMs: round(median(encodeSamples), 4), serializeDeserializeMs: round(median(wireSamples), 4), pageMs: round(median(pageSamples), 4) })}`)
      }
    }
  }, 120_000)
})
