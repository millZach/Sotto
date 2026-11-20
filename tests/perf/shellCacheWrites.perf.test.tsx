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
      // Every serialization of a whole shell, timed on the real clock: what the cache spends.
      const stringify = JSON.stringify.bind(JSON)
      let writes = 0, ms = 0, chars = 0
      vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: never[]) => {
        if (typeof value !== 'object' || value === null || !('host' in value)) return stringify(value, ...rest)
        const started = performance.now()
        const text = stringify(value, ...rest)
        writes += 1; ms += performance.now() - started; chars = text.length
        return text
      }) as typeof JSON.stringify)
      renderHook(() => useAgentConnection(bridge))
      await act(async () => {})
      for (let tick = 1; tick <= ARRIVALS_PER_SECOND * SECONDS; tick++) {
        act(() => { for (const listener of listeners) listener(agentShell(stateOf(tick))) })
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000 / ARRIVALS_PER_SECOND) })
      }
      const report = { threads: workspace.snapshot.threads.length, shellChars: chars, writesPerMinute: writes, msPerMinute: round(ms, 1), msPerWrite: round(ms / Math.max(1, writes), 1) }
      console.info(`shell cache writes: ${JSON.stringify(report)}`)
      expect(writes).toBeGreaterThan(0)
    }, 600_000)
  })
})
