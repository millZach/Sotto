/**
 * What keeping the startup shell cache costs the window over one minute of agent state arriving four times a second, as
 * it did with three threads working on November 20, 2026 (#2733): how many times the shell is serialized for the cache,
 * and the milliseconds that took. Uses a copy of an explicitly selected Sotto data folder's `workspace.json`.
 *
 *   Set SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA=<folder with workspace.json>.
 *   npx vitest run tests/perf/shellCacheWrites.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadsStateFixture } from '../fixtures/agentState'
import { perfDataDirectory } from '../fixtures/perfWorkspace'
import { round } from '../fixtures/perfBench'
import { useAgentConnection } from '../../src/renderer/src/agents/AgentContext'
import { agentShell, defaultAgentConfiguration, type AgentBridge, type AgentHostSnapshot, type AgentState } from '../../src/shared/agents'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers() })

const ARRIVALS_PER_SECOND = 4
const SECONDS = 60

describe('shell cache writes', async () => {
  const dataDirectory = await perfDataDirectory()
  describe('requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json', () => {
    it.skipIf(dataDirectory === null)('reports a minute of the startup cache at the owner’s scale', async () => {
      const workspace = JSON.parse(await readFile(join(dataDirectory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const stateOf = (tick: number): AgentState => {
        const threads = workspace.snapshot.threads.map((thread, index) => index < 3 ? { ...thread, status: tick % 2 === 0 ? 'running' as const : 'idle' as const } : thread)
        return threadsStateFixture({ cloneOverrides: false, configuration: defaultAgentConfiguration(), host: { ...workspace.snapshot, threads },
          topLevel: { activeThreadId: threads[0]?.id ?? null, activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, secure: true }, historyEnabled: true } })
      }
      const listeners = new Set<(state: AgentState) => void>()
      const bridge: AgentBridge = { get: async () => agentShell(stateOf(0)), command: async () => agentShell(stateOf(0)),
        onState: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
      vi.useFakeTimers()
      // Every serialization of a whole shell is counted; the fake clock the throttle runs on cannot time one, so the last is
      // timed on the real clock afterwards.
      const stringify = JSON.stringify.bind(JSON)
      let writes = 0, last: unknown
      vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: never[]) => {
        if (typeof value === 'object' && value !== null && 'host' in value) { writes += 1; last = value }
        return stringify(value, ...rest)
      }) as typeof JSON.stringify)
      renderHook(() => useAgentConnection(bridge))
      await act(async () => {})
      for (let tick = 1; tick <= ARRIVALS_PER_SECOND * SECONDS; tick++) {
        act(() => { for (const listener of listeners) listener(agentShell(stateOf(tick))) })
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000 / ARRIVALS_PER_SECOND) })
      }
      vi.useRealTimers()
      const samples = Array.from({ length: 9 }, () => { const started = performance.now(); stringify(last); return performance.now() - started }).sort((a, b) => a - b)
      const msPerWrite = samples[4]!
      const report = { threads: workspace.snapshot.threads.length, shellChars: stringify(last).length, writesPerMinute: writes,
        msPerWrite: round(msPerWrite, 1), msPerMinute: round(writes * msPerWrite, 1) }
      console.info(`shell cache writes: ${JSON.stringify(report)}`)
      expect(writes).toBeGreaterThan(0)
    }, 600_000)
  })
})
