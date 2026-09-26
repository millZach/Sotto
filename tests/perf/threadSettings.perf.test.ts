// @vitest-environment node
/**
 * What one thread settings chip press costs through the whole host stack: thread reads, coordinator and adapter
 * writes, provider session starts and time to the reply, on a thread whose session is running and on one the
 * reaper stopped. The providers are the fake Claude and Codex clients the adapter contract uses, run as real
 * child processes, so the times include their start-up but no model or network. Counts and timers only:
 * nothing a thread says is read. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1`
 * (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadSettings.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { describe, expect, it } from 'vitest'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { threadSettingsStack } from '../fixtures/threadSettingsStack'

const PRESSES = 5
const impatient = { reaperSweepMs: 20, sessionIdleMs: 150 }
const modes: AgentRuntimeMode[] = ['full-access', 'auto-accept-edits']

describe.skipIf(!PERF_BENCH)('thread settings chip press', () => {
  it.each(['claude', 'codex'] as const)('%s: reports reads, writes, starts and time per press', async provider => {
    const native = provider === 'claude' ? await claudeFixture(undefined, undefined, undefined, impatient) : await codexFixture(undefined, false, undefined, impatient)
    const stack = await threadSettingsStack(provider, native)
    try {
      for (const state of ['running', 'reaped'] as const) {
        const presses = []
        for (let index = 0; index < PRESSES; index++) {
          if (state === 'reaped') await stack.reap(); else await stack.watch()
          const mode = modes[index % modes.length]!
          const press = await stack.press(mode)
          expect(press.error).toBeNull()
          expect(press.runtimeMode).toBe(mode)
          presses.push(press)
        }
        const last = presses.at(-1)!
        console.log(JSON.stringify({ provider, state, presses: PRESSES, medianMs: round(median(presses.map(press => press.elapsedMs))),
          reads: median(presses.map(press => press.reads)), coordinatorWrites: median(presses.map(press => press.coordinatorWrites)),
          aliasWrites: median(presses.map(press => press.aliasWrites)), starts: median(presses.map(press => press.starts)),
          methods: last.methods.filter(method => !['fixture/ownership-started'].includes(method)) }))
      }
    } finally { await stack.cleanup() }
  }, 120_000)
})
