/**
 * A usage store for the start benchmarks (`usageLoadBench.ts`, `usageLedgerLoad.perf.test.ts`): it answers a
 * `UsageService` as the usage store's worker does, after a structured clone of each flush as posting it there makes, and
 * keeps the threads' visit marks in a file of the folder's, so the next start in another process finds them. Synthetic
 * usage only; what main does is what is measured.
 */
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import type { AgentHost } from '../../src/main/agents/host'
import type { NativeUsage } from '../../src/main/agents/nativeUsage'
import { UsageService } from '../../src/main/agents/usageService'
import type { UsageStoreClient } from '../../src/main/agents/usageStoreClient'

interface Request { kind: string; flush?: { tokens: unknown[]; prompts: unknown[]; seed: boolean; visits?: { threadId: string; mark: string }[] } }

export function benchUsageStore(root: string): { client: UsageStoreClient; saved: () => number; written: () => Promise<void> } {
  const path = join(root, 'bench-visit-marks.json')
  let marks: Record<string, string> = {}
  try { marks = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> } catch { /* No start before this one kept marks. */ }
  let saved = 0
  let writing = Promise.resolve()
  const request = (asked: Request): Promise<unknown> => {
    if (asked.kind === 'open') return Promise.resolve({ startedAt: '2026-10-31T00:00:00.000Z', revision: 0, generation: 0, legacySeedCompleted: false })
    if (asked.kind === 'visit-marks') return Promise.resolve(Object.entries(marks).map(([threadId, mark]) => ({ threadId, mark })))
    if (asked.kind !== 'flush' || !asked.flush) return Promise.reject(new Error('Not asked for in this benchmark'))
    structuredClone(asked)
    const { tokens, prompts, seed, visits } = asked.flush
    saved += tokens.length
    if (visits?.length) {
      for (const { threadId, mark } of visits) marks[threadId] = mark
      const text = JSON.stringify(marks)
      writing = writing.then(() => writeFile(path, text))
    }
    return Promise.resolve({ tokens: tokens.length, prompts: prompts.length, ...(visits?.length ? { visits: visits.length } : {}), seed })
  }
  return { client: { takesHistory: false, close: () => undefined, request } as unknown as UsageStoreClient, saved: () => saved, written: () => writing }
}

/**
 * Usage over `native`, as main wires it, once Claude connects: `publish` hands it every thread as the host shows it, with
 * the thread's usage, and `queued` says how many threads it has still to read, queued, being read or mid-visit (none on a
 * source that reads them at once).
 */
export function connectUsage(native: NativeUsage, root: string, ids: readonly string[]) {
  const store = benchUsageStore(root)
  let listener: ((snapshot: AgentHostSnapshot) => void) | undefined
  const host = { subscribe: (next: (snapshot: AgentHostSnapshot) => void) => { listener = next; return () => { listener = undefined } },
    visitUsage: (id: string, visitor: Parameters<NativeUsage['visitUsage']>[1]) => native.visitUsage(id, visitor),
    subscribeUsage: (next: Parameters<NativeUsage['subscribeUsage']>[0]) => native.subscribeUsage(next) } as unknown as AgentHost
  const service = new UsageService({ directory: root, host, client: store.client })
  service.start()
  const publish = (): void => listener!({ connected: true, providers: [{ id: 'claude', connection: 'connected' }], models: [],
    threads: ids.map(id => ({ id, providerId: 'claude', usage: native.get(id) })) } as unknown as AgentHostSnapshot)
  const queued = (): number => {
    const state = service as unknown as { visits?: Map<string, unknown>; pendingVisits?: Map<string, unknown>; active?: unknown }
    return (state.visits?.size ?? 0) + (state.pendingVisits?.size ?? 0) + (state.active ? 1 : 0)
  }
  return { service, store, publish, queued }
}
