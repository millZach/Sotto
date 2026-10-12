/** Synthetic archive only. Bundle with scripts/archive-startup-bench.mjs and run in a fresh --expose-gc process. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { EMPTY_AGENT_HOST, type AgentMessage, type AgentThread } from '../../src/shared/agents'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { loadHostIdentity, stampHostSnapshot } from '../../src/main/agents/hostIdentity'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

class EventHost extends FakeProviderHost {
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { void listener; return () => undefined }
}

const threadCount = Number(process.argv[2])
const instrument = process.argv[3] === 'reads'
if (![1, 50, 200].includes(threadCount) || !global.gc) throw new Error('Use the benchmark runner with --expose-gc and a controlled archive size.')
const directory = await mkdtemp(join(tmpdir(), 'sotto-archive-startup-'))
let host: WorkspaceHost | undefined
try {
  // All payloads are generated here. No provider, account, native transcript or user profile is opened.
  await seed(directory, threadCount)
  const counts = { messageCalls: 0, activityCalls: 0, messageRows: 0, activityRows: 0, logicalMessageBytes: 0, logicalActivityBytes: 0 }
  const messages = ThreadStore.prototype.readMessages
  const activities = ThreadStore.prototype.readActivities
  if (instrument) {
    ThreadStore.prototype.readMessages = function (...args) {
      const result = messages.apply(this, args)
      counts.messageCalls++; counts.messageRows += result.messages.length
      counts.logicalMessageBytes += Buffer.byteLength(JSON.stringify(result.messages))
      return result
    }
    ThreadStore.prototype.readActivities = function (...args) {
      const result = activities.apply(this, args)
      counts.activityCalls++; counts.activityRows += result.length
      counts.logicalActivityBytes += Buffer.byteLength(JSON.stringify(result))
      return result
    }
  }
  host = new WorkspaceHost(new EventHost({ ...EMPTY_AGENT_HOST, projects: [], models: [], threads: [] }), directory)
  global.gc()
  const heapBefore = process.memoryUsage().heapUsed
  const start = performance.now()
  await host.initialize()
  const initializeMs = performance.now() - start
  global.gc()
  const heapAfterInitialize = process.memoryUsage().heapUsed
  const loaded = host.workspaceSnapshot()
  if (loaded.threads.length !== threadCount || loaded.threads.some(thread => thread.summary?.messageCount !== 80)) throw new Error('The synthetic archive did not restore its thread summaries.')
  // The snapshot's payload references must be released before retained heap is sampled again.
  loaded.threads.length = 0
  host.observeThreads([])
  global.gc()
  const heapAfterObservation = process.memoryUsage().heapUsed
  process.stdout.write(JSON.stringify({ threadCount, mode: instrument ? 'logical-reads' : 'timing-and-heap', initializeMs,
    retainedHeapAfterInitialize: heapAfterInitialize - heapBefore, retainedHeapAfterEmptyObservation: heapAfterObservation - heapBefore,
    ...counts }) + '\n')
} finally {
  host?.dispose()
  await removeFixture(directory)
}

async function removeFixture(directory: string): Promise<void> {
  if (resolve(dirname(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-archive-startup-')) throw new Error('Unexpected benchmark directory')
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
}

async function seed(root: string, count: number): Promise<void> {
  const store = new ThreadStore(join(root, 'threads.sqlite'))
  store.open()
  const threads: AgentThread[] = []
  try {
    for (let i = 0; i < count; i++) {
      const id = `archive-${i}`
      const messages: AgentMessage[] = Array.from({ length: 80 }, (_, position) => ({
        id: `${id}-m${position}`, role: position % 2 ? 'assistant' : 'user', text: `${id}:${position}:` + 'synthetic '.repeat(100),
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, position)).toISOString(),
      }))
      const activities: AgentActivity[] = Array.from({ length: 100 }, (_, position) => ({
        id: `${id}-a${position}`, turnId: `${id}-t${Math.floor(position / 3)}`, sequence: position,
        kind: 'command', status: 'completed', title: 'Synthetic command', output: 'synthetic output '.repeat(64),
        afterMessageId: `${id}-m${Math.min(79, position)}`,
      }))
      store.replaceThreadMessages(id, messages, 'generation-1')
      store.syncActivities(id, activities, 'generation-1')
      threads.push({ id, title: `Archive ${i}`, projectId: 'project', modelId: 'fake:model', status: 'idle', messages: [], requests: [],
        historyEpoch: 'generation-1', workspaceSettledAt: '2026-09-01T00:00:00.000Z' })
    }
    // An archive an earlier start has already read whole once: from then on a start reads no record (#918).
    store.markSubagentWordsMoved()
  } finally { store.close() }
  const hostId = await loadHostIdentity(root)
  const snapshot = stampHostSnapshot({ ...EMPTY_AGENT_HOST, projects: [{ id: 'project', title: 'Synthetic project', path: root }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: false }], threads }, hostId)
  await writeFile(join(root, 'workspace.json'), JSON.stringify({ snapshot, creations: [], projectAliases: [] }))
}
