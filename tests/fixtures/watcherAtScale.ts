/**
 * Watcher at the owner's scale (October 20, 2026): a few hundred threads and a record that has grown over weeks of use,
 * mostly closed requests and answered operations, with a handful of standing watches still running. Counts only, and no
 * words: every text is a fixed placeholder. The real WatcherService and AgentControl run; only the coordinator's snapshot,
 * its send records and its host ID are supplied, as `watcherObservePerformance` does.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import type { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
import { EMPTY_AGENT_HOST, type AgentDelivery, type AgentFollowup, type AgentHostSnapshot } from '../../src/shared/agents'
import type { WatcherRecord } from '../../src/shared/watcher'
import { agentControlFixture } from './agentControlFixture'
import { centerHostId, centerTime, watcherRecordFixture } from './watcher'
import { workspaceFixture } from './workspaceFixture'
import { WATCHER_RECORD_FILE } from '../../src/main/agents/watcherRecordFile'

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

export interface ScaleShape {
  /** Threads in the snapshot besides Watcher's own: the owner had about 250. */
  threads: number
  /** Requests in Watcher's record, each with two participants: the owner's had 160, all but a few closed. */
  requests: number
  /** Watcher's starts and sends besides one per watched thread: the owner's record held 149 in all. */
  operations: number
  /** Standing watches: the owner had 5. */
  watches: number
}

export interface ScaleOptions {
  /**
   * Prompt turns nothing reads that the saved record holds when main loads it, besides the ones it reads, as a record
   * saved before turns were let go of does. The settled record is saved, then a second control starts from the file, so
   * what is loaded is what main reads at start, and the first pass after loading is the test's own.
   */
  savedPromptTurns?: number
}

/** Counts every read of a thread out of the snapshot's thread list while `on`: each loop step, search step and spread. */
export interface ThreadVisits { on: boolean; count: number }

/**
 * `observe()` is the pass main runs for every snapshot it accepts. `publish()` runs what main runs for Watcher on every
 * coordinator change, with a room listener attached so the room state is built, as the window's room bridge does.
 * `wakePass()` is the wake-up pass a publish runs at most every WATCHER_OBSERVE_MS.
 */
export async function watcherAtScale(shape: ScaleShape, options: ScaleOptions = {}) {
  const workspace = await workspaceFixture(undefined, { history: false, watcherEnabled: true })
  const cleanups: (() => Promise<unknown> | void)[] = [workspace.remove, workspace.stop]
  try {
    const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
      credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true, streamingPublishCost: true } })
    cleanups.push(() => f.dispose())
    const base = watcherRecordFixture(), source = structuredClone(base.operations[0]!), watcher = base.current!.target
    const record: WatcherRecord = { ...base, reservations: [], reads: [], operations: [], watches: [], requests: [] }
    const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerHostId,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true },
      projects: [{ id: 'project', title: 'Synthetic project', path: workspace.root }], threads: [] }
    snapshot.threads.push({ id: watcher.threadId, kind: 'watcher', providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Watcher',
      status: 'idle', clientConnected: true, lastUserMessageId: 'watcher-head', lastTurn: { id: 'watcher-turn', messageId: 'watcher-head', status: 'completed' },
      requests: [], messages: [{ id: 'watcher-head', role: 'user', text: 'Synthetic fixture text', createdAt: centerTime },
        { id: 'watcher-reply', role: 'assistant', text: 'Synthetic fixture text', createdAt: centerTime }] })
    const head = (index: number) => `head-${index}`
    for (let index = 0; index < shape.threads; index++) {
      // The watched threads stream; the rest finished long ago.
      const running = index < shape.watches
      snapshot.threads.push({ id: `worker-${index}`, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Synthetic worker',
        status: running ? 'running' : 'idle', clientConnected: true, lastUserMessageId: head(index),
        lastTurn: { id: `turn-${index}`, messageId: head(index), status: running ? 'running' : 'completed' }, requests: [],
        messages: [{ id: `older-${index}`, role: 'user', text: 'Synthetic fixture text', createdAt: centerTime },
          { id: head(index), role: 'user', text: 'Synthetic fixture text', createdAt: centerTime },
          { id: `reply-${index}`, role: 'assistant', text: 'Synthetic fixture text', createdAt: centerTime }] })
    }
    const target = (index: number) => ({ hostId: centerHostId, threadId: `worker-${index % shape.threads}` })
    for (let index = 0; index < shape.watches; index++) record.watches!.push({ id: uuid(10_000 + index), target: target(index), createdAt: centerTime,
      generation: 0, pausedByUserMessageId: null, lastUserMessageId: head(index) })
    // The newest few requests are still active; the rest are what weeks of use leave behind.
    for (let index = 0; index < shape.requests; index++) {
      const id = uuid(20_000 + index), active = index >= shape.requests - 3
      record.requests.push({ id, watcher, rootUserMessageId: `root-${index}`, state: active ? 'active' : 'closed', createdAt: centerTime,
        closedAt: active ? null : centerTime, participants: [0, 1].map(offset => {
          const at = (shape.watches + index * 2 + offset) % shape.threads
          return { target: target(at), requestId: id, startedBy: 'watcher' as const, generation: 0, promptCount: 1,
            ...active ? { state: 'participating' as const, lastUserMessageId: head(at) } : { state: 'relinquished' as const } }
        }) })
    }
    for (let index = 0; index < shape.operations; index++) {
      const request = record.requests[index % shape.requests]!, participant = request.participants[0]!
      const thread = Number(participant.target.threadId.slice('worker-'.length)), current = request.state === 'active'
      record.operations.push({ ...source, id: uuid(30_000 + index), retryKey: uuid(40_000 + index), draftId: uuid(50_000 + index), requestId: request.id,
        target: participant.target, deliveryState: 'accepted', messageId: current ? head(thread) : `sent-${index}`,
        outcome: current ? 'unknown' : 'answered', turnMessageId: current ? head(thread) : `sent-${index}`, nativeTurnId: current ? `turn-${thread}` : `sent-turn-${index}` })
    }
    // Each watched thread's head is Watcher's own send, as while it works a thread it watches.
    for (let index = 0; index < shape.watches; index++) record.operations.push({ ...source, id: uuid(60_000 + index), retryKey: uuid(70_000 + index),
      draftId: uuid(80_000 + index), requestId: record.requests.at(-1)!.id, target: target(index), deliveryState: 'accepted', messageId: head(index),
      outcome: 'unknown', turnMessageId: head(index), nativeTurnId: `turn-${index}` })
    // Every read of a thread out of the snapshot's list, counted only while a test asks.
    const threadVisits: ThreadVisits = { on: false, count: 0 }
    snapshot.threads = new Proxy(snapshot.threads, { get(target, property, receiver) {
      if (threadVisits.on && typeof property === 'string' && /^\d+$/u.test(property)) threadVisits.count++
      return Reflect.get(target, property, receiver)
    } })
    // What main's queue and delivery records say, which a test may change before a pass.
    const sends: { followups: AgentFollowup[]; deliveries: AgentDelivery[] } = {
      followups: [], deliveries: record.operations.map(operation => ({
        threadId: operation.target.threadId, draftId: operation.draftId!, status: 'accepted', createdAt: centerTime, updatedAt: centerTime })) }
    /**
     * Watcher on `control` as main runs it, recovered, with the first pass and publishes it makes on start behind it. A
     * restart of a record Watcher has already recovered and settled leaves its first pass to the test.
     */
    const attach = async (control: typeof f.control, restarted = false) => {
      const detach: (() => Promise<unknown> | void)[] = []
      const hostIdSpy = vi.spyOn(control, 'hostId').mockReturnValue(centerHostId)
      const snapshotSpy = vi.spyOn(control, 'watcherSnapshot').mockReturnValue(snapshot)
      const pendingSpy = vi.spyOn(control, 'hasPendingThreadWork').mockReturnValue(false)
      const sendsSpy = vi.spyOn(control, 'watcherSendRecords').mockImplementation(() => sends)
      // The coordinator listener Watcher adds, kept so a test can run it as main does on every change.
      let coordinatorChanged: (() => void) | undefined
      const subscribeSpy = vi.spyOn(control, 'subscribe').mockImplementationOnce(listener => {
        coordinatorChanged = () => listener(undefined as never)
        return () => { coordinatorChanged = undefined }
      })
      detach.push(() => { subscribeSpy.mockRestore(); sendsSpy.mockRestore(); pendingSpy.mockRestore(); snapshotSpy.mockRestore(); hostIdSpy.mockRestore() })
      const service = new WatcherService({ directory: workspace.root, host: workspace.host, control,
        historyEnabled: () => false, streamingPublishCost: true })
      detach.push(() => service.close())
      let rooms = 0
      const unsubscribeRoom = service.subscribe(() => { rooms++ })
      detach.push(() => { unsubscribeRoom() })
      cleanups.push(...detach)
      const observe = () => service.observe(snapshot, new Set())
      const publish = () => { if (!coordinatorChanged) throw new Error('Watcher did not subscribe to the coordinator'); coordinatorChanged() }
      // Recovery starts the wake-ups and runs the first pass; setup stays outside what a test counts.
      if (!restarted) { await service.recover(); observe(); publish(); publish() }
      return { service, observe, publish, rooms: () => rooms, detach: async () => { for (const step of detach.reverse()) { cleanups.splice(cleanups.indexOf(step), 1); await step() } } }
    }
    let control = f.control, loaded: Readonly<WatcherRecord> | undefined
    if (options.savedPromptTurns !== undefined) await control.start()
    control.mutateWatcher(next => Object.assign(next, record))
    let attached = await attach(control)
    if (options.savedPromptTurns !== undefined) {
      // Saved once Watcher has settled it, so the restart has nothing to change but the prompt turns it loads.
      await control.updateWatcher(() => undefined)
      await attached.detach()
      control.dispose()
      const path = join(workspace.root, WATCHER_RECORD_FILE), saved = JSON.parse(await readFile(path, 'utf8')) as { watcher: WatcherRecord }
      // Older turns nothing reads any more, before the ones Watcher's operations still count against.
      saved.watcher.promptTurns = [...Array.from({ length: options.savedPromptTurns }, (_, index) => ({ id: uuid(90_000 + index), watcher, createdAt: centerTime,
        rootUserMessageId: `turn-root-${index}` })), ...saved.watcher.promptTurns ?? []]
      await writeFile(path, JSON.stringify(saved), 'utf8')
      control = f.create()
      await control.start()
      loaded = control.watcherRecordView()
      attached = await attach(control, true)
    }
    const { service, observe, publish, rooms } = attached
    // The wake-up pass a publish runs at most every WATCHER_OBSERVE_MS, run now.
    const wakePass = () => (service as unknown as { wakes: WatcherWakeUp }).wakes.observe()
    return { service, control, snapshot, sends, threadVisits, loaded, observe, publish, wakePass, rooms,
      state: (): Readonly<WatcherRecord> => control.watcherRecordView(),
      close: async () => { const failures: unknown[] = []; for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } }
        if (failures.length) throw new AggregateError(failures, 'Scale fixture cleanup failed') } }
  } catch (error) {
    const failures: unknown[] = [error]
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch (failure) { failures.push(failure) } }
    throw new AggregateError(failures, 'Scale fixture setup failed', { cause: error })
  }
}
