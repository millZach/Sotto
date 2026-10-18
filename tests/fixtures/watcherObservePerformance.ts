/**
 * Real WatcherService.observe and AgentControl.mutateWatcher/schema; no provider process or live state.
 * The snapshot seam replaces only the input ordinarily supplied by AgentControl.acceptSnapshot.
 */
import { vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../src/shared/agents'
import type { WatcherRecord } from '../../src/shared/watcher'
import { agentControlFixture } from './agentControlFixture'
import { centerHostId, centerRequestId, centerTime, watcherRecordFixture } from './watcher'
import { workspaceFixture } from './workspaceFixture'

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
export interface ObserveShape {
  watches: number
  olderMessages: number
  retainedTakeovers: number
  /** false keeps old history but omits new private metadata, as on the parent revision. */
  includeTakeoverMetadata: boolean
  /** unknown is a retained restart outcome; working includes the existing outcome observation work. */
  operationOutcome: 'unknown' | 'working'
  countMessageReads?: boolean
}

export async function watcherObservePerformance(shape: ObserveShape) {
  const workspace = await workspaceFixture(undefined, { history: false, watcherEnabled: true })
  const cleanups: (() => Promise<unknown> | void)[] = [workspace.remove, workspace.stop]
  try {
    const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
      credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true, streamingPublishCost: true } })
    cleanups.push(() => f.dispose())
    const record = watcherRecordFixture(), source = structuredClone(record.operations[0]!)
    record.reservations = []; record.reads = []; record.operations = []; record.watches = []
    record.requests[0]!.participants = []
    const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerHostId,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true },
      projects: [{ id: 'project', title: 'Synthetic project', path: workspace.root }], threads: [] }
    const reads = { id: 0, role: 0 }
    const message = (id: string, role: AgentMessage['role']): AgentMessage => {
      const value: AgentMessage = { id, role, text: 'Synthetic fixture text', createdAt: centerTime }
      if (shape.countMessageReads) {
        Object.defineProperty(value, 'id', { enumerable: true, get: () => { reads.id++; return id } })
        Object.defineProperty(value, 'role', { enumerable: true, get: () => { reads.role++; return role } })
      }
      return value
    }
    for (let index = 0; index < shape.watches; index++) {
      const target = { hostId: centerHostId, threadId: `worker-${index}` }, head = `machine-${index}`
      const draftId = uuid(100 + index)
      const thread: AgentThread = { id: target.threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Synthetic worker',
        status: 'running', clientConnected: true, lastUserMessageId: head,
        lastTurn: { id: `native-turn-${index}`, messageId: head, status: 'running' }, requests: [],
        messages: [...Array.from({ length: shape.olderMessages }, (_, position) => message(`old-${index}-${position}`, position % 2 ? 'assistant' : 'user')),
          message(head, 'user'), message(`reply-${index}`, 'assistant')] }
      snapshot.threads.push(thread)
      record.watches.push({ id: uuid(200 + index), target, createdAt: centerTime, generation: 0, pausedByUserMessageId: null, lastUserMessageId: head })
      record.requests[0]!.participants.push({ target, requestId: centerRequestId, startedBy: 'watcher', generation: 0,
        state: 'participating', promptCount: 1, lastUserMessageId: head })
      record.operations.push({ ...source, id: uuid(300 + index), retryKey: uuid(400 + index), target, draftId, messageId: head,
        deliveryState: 'accepted', outcome: shape.operationOutcome, turnMessageId: head, nativeTurnId: thread.lastTurn!.id })
    }
    if (shape.retainedTakeovers) {
      const requestId = uuid(500), targets = Array.from({ length: shape.retainedTakeovers }, (_, index) => ({ hostId: centerHostId, threadId: `retired-worker-${index}` }))
      record.requests.push({ id: requestId, watcher: record.current!.target, rootUserMessageId: 'old-request-root', state: 'closed', createdAt: centerTime,
        closedAt: centerTime, participants: targets.map(target => ({ target, requestId, startedBy: 'watcher', generation: 1, promptCount: 1,
          state: 'taken-over', takeover: { reason: 'user-send', at: centerTime } })) })
      if (shape.includeTakeoverMetadata) record.localTakeovers = targets.map((target, index) => ({ target, at: centerTime, lastRequestId: requestId,
        userDrafts: [{ draftId: uuid(1_000 + index), digest: 'f'.repeat(64), messageId: `old-user-${index}` }] }))
    }
    f.control.mutateWatcher(next => Object.assign(next, record))
    const hostIdSpy = vi.spyOn(f.control, 'hostId').mockReturnValue(centerHostId)
    const snapshotSpy = vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue(snapshot)
    const pendingSpy = vi.spyOn(f.control, 'hasPendingThreadWork').mockReturnValue(false)
    // A reconciled accepted receipt prevents the old receipt scan from obscuring the takeover guard's work.
    // There is a corresponding real operation/draft for each accepted delivery; no authority is fabricated.
    const deliveries: ReturnType<typeof f.control.watcherSendRecords>['deliveries'] = record.operations.map(operation => ({
      threadId: operation.target.threadId, draftId: operation.draftId!, status: 'accepted',
      createdAt: centerTime, updatedAt: centerTime,
    }))
    const sendsSpy = vi.spyOn(f.control, 'watcherSendRecords').mockReturnValue({ followups: [], deliveries })
    cleanups.push(() => { sendsSpy.mockRestore(); pendingSpy.mockRestore(); snapshotSpy.mockRestore(); hostIdSpy.mockRestore() })
    const watcher = new WatcherService({ directory: workspace.root, host: workspace.host, control: f.control,
      historyEnabled: () => false, streamingPublishCost: true, limit: () => 8 })
    cleanups.push(() => watcher.close())
    const resetReads = () => { reads.id = 0; reads.role = 0 }
    const observe = () => watcher.observe(snapshot, new Set())
    const state = (): Readonly<WatcherRecord> => f.control.watcherRecordView()
    // Snapshot setup, schema setup and initial observation are excluded from timed/counted passes.
    observe(); resetReads()
    return { watcher, control: f.control, snapshot, observe, state, reads, resetReads,
      newerHuman: () => { for (const [index, thread] of snapshot.threads.entries()) thread.messages.push(message(`new-human-${index}`, 'user')) },
      close: async () => { const failures: unknown[] = []; for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } }
        if (failures.length) throw new AggregateError(failures, 'Observe fixture cleanup failed') } }
  } catch (error) {
    const failures: unknown[] = [error]
    for (const cleanup of cleanups.reverse()) { try { await cleanup() } catch (failure) { failures.push(failure) } }
    throw new AggregateError(failures, 'Observe fixture setup failed', { cause: error })
  }
}
