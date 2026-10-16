// @vitest-environment node
/**
 * The count guard behind `tests/perf/watcherObservePass.perf.test.ts` (#1023). Timing benchmarks do not run in CI, so
 * this counts instead: how often one observation pass and one room state read copy the paired host's whole shell, list
 * the remote hosts and read the Watcher record. None of those may grow with the paired host's finished threads or with
 * Watcher's starts there; each pass reads them a fixed number of times, whatever the size.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WatcherService } from '../../../src/main/agents/watcher'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentState } from '../../../src/shared/agents'
import type { WatcherEvent } from '../../../src/shared/watcherNews'
import type { FollowupStore, WordWakeUp } from '../../../src/main/agents/followups'
import { isWatcherNews, queuedWakeUpText } from '../../../src/main/agents/wakeUp'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { workspaceFixture } from '../../fixtures/workspaceFixture'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A paired host with `size` finished, watched threads and one accepted Watcher start on each, and a way to count reads. */
async function pairedWatcher(size: number) {
  const workspace = await workspaceFixture(undefined, { history: false, watcherEnabled: true })
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => false, watcherEnabled: true, streamingPublishCost: true } })
  cleanups.push(async () => { await f.dispose(); await workspace.stop(); await workspace.remove() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' })
  const local = f.control.hostId()!, hostId = randomUUID(), requestId = randomUUID(), at = '2026-10-15T00:00:00.000Z'
  const template = f.control.watcherSnapshot().threads[0]!, ids = Array.from({ length: size }, (_, index) => `worker-${index}`)
  // Every paired thread has finished a turn its Watcher start began, so the pass reaches its finish, its work and its answer.
  const cached: AgentState = { ...f.control.shell(), host: { ...f.control.shell().host, hostId, connected: true,
    threads: ids.map((id, index) => ({ ...template, id, hostId, status: 'idle', lastTurn: { id: `turn-${index}`, status: 'completed', messageId: `brief-${index}` },
      lastUserMessageId: `brief-${index}`, messages: [{ id: `brief-${index}`, role: 'user', text: 'Synthetic brief', createdAt: at }] })) } }
  const tally = { shells: 0, hostLists: 0, records: 0 }
  let measuring = false
  const service = {
    // The socket service copies its whole cached shell on every read; each read here stands for one such copy.
    shell: () => { if (measuring) tally.shells++; return structuredClone(cached) },
    subscribe: () => () => undefined, command: async () => undefined,
    supportsWatcherReads: false, supportsWatcherControl: false, supportsWatcherWorkSettled: true, supportsWatcherOutcomes: true,
  } as unknown as DesktopHostConnection['service']
  const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, streamingPublishCost: true })
  cleanups.push(async () => { router.dispose() })
  router.add({ hostId, name: 'Paired', kind: 'remote', service, detail: () => null, preview: () => ({ ok: false }) as never })
  await f.control.updateWatcher(record => {
    record.current = { target: { hostId: local, threadId: 'master' }, projectId: 'project', provider: 'claude', creationOperationId: randomUUID(), createdAt: at }
    record.requests.push({ id: requestId, watcher: record.current.target, rootUserMessageId: 'prompt', state: 'active', createdAt: at, closedAt: null,
      participants: ids.map(threadId => ({ target: { hostId, threadId }, requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, promptCount: 1 })) })
    record.operations.push(...ids.map((threadId, index) => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: (index + 1).toString(16).padStart(64, '0'),
      action: 'start' as const, target: { hostId, threadId }, generation: 0, deliveryState: 'accepted' as const, createdAt: at, updatedAt: at,
      receiptId: `receipt-${index}`, cardId: `card-${index}`, messageId: `brief-${index}` })))
  })
  const watcher = new WatcherService({ directory: f.root, control: f.control, host: workspace.host, historyEnabled: () => false, limit: () => 8, streamingPublishCost: true })
  cleanups.push(async () => { watcher.close() })
  const remote = router.watcherHosts(), listHosts = remote.hosts.bind(remote)
  remote.hosts = () => { if (measuring) tally.hostLists++; return listHosts() }
  watcher.useRemoteHosts(remote)
  const readRecord = f.control.watcherRecord.bind(f.control)
  f.control.watcherRecord = () => { if (measuring) tally.records++; return readRecord() }
  watcher.wakes.start()
  const measure = async (read: () => unknown) => {
    for (const name of Object.keys(tally) as (keyof typeof tally)[]) tally[name] = 0
    measuring = true
    try { await read() } finally { measuring = false }
    return { ...tally }
  }
  return { f, watcher, local, measure }
}

/** Counts per call for a paired host with `size` finished, watched threads and one accepted Watcher start on each. */
async function counts(size: number) {
  const { watcher, measure } = await pairedWatcher(size)
  const observe = await measure(() => watcher.wakes.observe())
  const state = await measure(() => { expect(watcher.state().receipts.filter(item => item.outcome === 'working')).toHaveLength(size) })
  // The pass did reach the finishes: each paired thread's finish is news, named for the start it answers.
  expect((watcher.state().news ?? []).filter(event => event.kind === 'turn-finished' && event.operationId)).toHaveLength(size)
  return { observe, state }
}

it('reads the paired shell, the host list and the Watcher record a fixed number of times per pass, whatever the size', async () => {
  const small = await counts(2), large = await counts(24)
  expect(large).toEqual(small)
  // A pass reads the merged snapshot and the record once; a state read copies the shell once for the room's inputs and
  // once for the news it checks, and lists the hosts once for outcomes and once for the news.
  expect(small.observe).toMatchObject({ shells: 1, records: 1 })
  expect(small.state.shells).toBeLessThanOrEqual(2)
  expect(small.state.hostLists).toBeLessThanOrEqual(2)
}, 120_000)

/**
 * Counts for one prune of queued Watcher wake-ups (#1070): `wakeUps` waiting wake-ups, each holding the paired host's
 * `size` finishes, which are still due, and one event that is not, so every wake-up is pruned to its due news.
 */
async function pruneCounts(size: number, wakeUps: number) {
  const { f, watcher, local, measure } = await pairedWatcher(size)
  const due = watcher.wakes.news()
  expect(due.length).toBeGreaterThanOrEqual(size)
  const outdated: WatcherEvent = { ...due[0]!, id: 'synthetic-outdated', requestId: randomUUID() }
  const store = (f.control as unknown as { followupStore: FollowupStore }).followupStore
  const word: WordWakeUp = news => queuedWakeUpText(news, { tool: false })
  // Watcher news waits in the queue while its thread is busy; a thread this computer does not have keeps it waiting here.
  for (let index = 0; index < wakeUps; index++) await store.queueWakeUp(`watcher-${index}`,
    { source: 'watcher', watcher: { hostId: local, threadId: `watcher-${index}` }, events: [...due, outdated], omitted: 0 }, word)
  const prune = await measure(() => f.control.pruneWatcherWakeUps())
  // The same wake-ups stay, each with exactly the news still due.
  const kept = store.peek().items.filter(item => item.wakeUp)
  expect(kept).toHaveLength(wakeUps)
  for (const item of kept) expect(item.news?.flatMap(news => isWatcherNews(news) ? news.events.map(event => event.id) : [])).toEqual(due.map(event => event.id))
  return prune
}

it('reads the paired shell and the Watcher record a fixed number of times per prune of queued wake-ups, however much is queued', async () => {
  const small = await pruneCounts(2, 1), large = await pruneCounts(24, 4)
  expect(large).toEqual(small)
  // The prune asks once which queued events may still go and once more as the store prunes them; the publish after it
  // runs one observation pass. Asked event by event, a prune of 4 wake-ups of 24 finishes read the shell hundreds of times.
  expect(small.shells).toBeLessThanOrEqual(3)
}, 120_000)
