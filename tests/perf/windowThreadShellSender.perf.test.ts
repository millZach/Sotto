// @vitest-environment node
// SOTTO_PERF_BENCH=1; optional SOTTO_STEP4_SHELL_FIXTURE is an explicitly generated projected shell.
import { readFile } from 'node:fs/promises'
import { serialize } from 'node:v8'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { agentStateSchema, type AgentState } from '../../src/shared/agents'
import { windowThreadShellFixture } from '../fixtures/windowThreadShell'
import { median, PERF_BENCH } from '../fixtures/perfBench'

describe.skipIf(!PERF_BENCH)('desktop thread sender ownership and comparison (#991)', () => {
  it('reports unchanged and changed snapshots with alternating and reversed pairs', async () => {
    const source: AgentState = process.env.SOTTO_STEP4_SHELL_FIXTURE
      ? agentStateSchema.parse(JSON.parse(await readFile(process.env.SOTTO_STEP4_SHELL_FIXTURE, 'utf8')))
      : windowThreadShellFixture()
    for (const changed of [0, 1, 3, 6]) {
      const values = new Map<boolean, number[]>()
      for (const enabled of [false, true, true, false, true, false, false, true]) {
        const state = structuredClone(source)
        for (const thread of state.host.threads.slice(0, changed)) {
          thread.summary ??= { messageCount: 2, activityCount: 0 }
          thread.summary.lastAssistant = { id: `synthetic-${thread.id}`, text: 'Initial synthetic progress', createdAt: '2026-10-13T12:00:00.000Z' }
        }
        const broadcaster = new AgentStateBroadcaster({ streamingPublishCost: enabled })
        broadcaster.send(state, () => true)
        const wall: number[] = [], encode: number[] = [], wire: number[] = []
        let bodies = 0, bytes = 0
        const cpu = process.threadCpuUsage()
        for (let i = 0; i < 400; i++) {
          for (const thread of state.host.threads.slice(0, changed)) thread.summary!.lastAssistant!.text = `Synthetic progress ${i}`
          const start = performance.now()
          broadcaster.send(state, payload => {
            const encoded = performance.now()
            bytes = serialize(payload).length
            if (!Array.isArray(payload.host.threads)) bodies += payload.host.threads.changed.length
            encode.push(encoded - start); wire.push(performance.now() - encoded)
            return true
          })
          wall.push(performance.now() - start)
        }
        const used = process.threadCpuUsage(cpu), ms = median(wall.slice(40))
        values.set(enabled, [...(values.get(enabled) ?? []), ms])
        if (enabled) expect(bodies).toBe(changed * 400)
        console.log(`desktop thread sender: ${JSON.stringify({ enabled, changed, bytes, wallMs: ms, encodeMs: median(encode.slice(40)), serializeMs: median(wire.slice(40)), threadCpuMs: (used.user + used.system) / 1000 / 400 })}`)
      }
      if (process.env.SOTTO_PERF_ASSERT === '1') expect(median(values.get(true)!)).toBeLessThan(median(values.get(false)!))
    }
  }, 120_000)
})
