/**
 * What keeping the startup shell cache costs the window over one minute of agent state arriving four times a second, as
 * it did with three threads working on November 20, 2026 (#2733): how many times the cache serializes the shell, and the
 * milliseconds one whole write takes (preparing the cached shell, serializing it and handing it to the store), so their
 * product is the minute's cost. Uses a copy of an explicitly selected Sotto data folder's `workspace.json`, whose threads
 * carry no histories: the window's live shell, whose summaries main fills from them, is larger (4.08 MB against 3.1 MB here
 * for the owner's), so this understates both columns alike.
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
import { upperMedian as median } from './support/statistics.mjs'
import { writeShellCache } from '../../src/renderer/src/agents/shellCache'
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
      // Every serialization of a whole shell is counted; the fake clock the throttle runs on cannot time one, so a whole write
      // is timed on the real clock afterwards.
      const stringify = JSON.stringify.bind(JSON)
      let serializations = 0, chars = 0
      vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: never[]) => {
        const text = stringify(value, ...rest)
        if (typeof value === 'object' && value !== null && 'host' in value) { serializations += 1; chars = text.length }
        return text
      }) as typeof JSON.stringify)
      renderHook(() => useAgentConnection(bridge))
      await act(async () => {})
      for (let tick = 1; tick <= ARRIVALS_PER_SECOND * SECONDS; tick++) {
        act(() => { for (const listener of listeners) listener(agentShell(stateOf(tick))) })
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000 / ARRIVALS_PER_SECOND) })
      }
      vi.restoreAllMocks()
      vi.useRealTimers()
      const final = stateOf(ARRIVALS_PER_SECOND * SECONDS)
      const store = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
      const msPerSerialization = median(Array.from({ length: 9 }, () => { const started = performance.now(); writeShellCache(final, store); return performance.now() - started }))
      const report = { threads: workspace.snapshot.threads.length, cachedShellChars: chars, serializationsPerMinute: serializations,
        msPerSerialization: round(msPerSerialization, 1), msPerMinute: round(serializations * msPerSerialization, 1) }
      console.info(`shell cache writes: ${JSON.stringify(report)}`)
      expect(serializations).toBeGreaterThan(0)
    }, 600_000)
  })
})
