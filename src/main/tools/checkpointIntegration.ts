import { join } from 'node:path'
import { isThreadProviderConnected, threadSummaryOf } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import type { AgentControl } from '../agents/control'
import type { WorkspaceHost } from '../agents/workspace'
import type { ThreadRegistry } from '../agents/threads'
import type { FilesService } from '../files/service'
import { CheckpointService } from './checkpoints'
import { threadsInCheckout } from '../agents/checkoutCandidates'

export function connectCheckpoints(options: { files: FilesService; directory: string; host: WorkspaceHost; control: AgentControl; registry: ThreadRegistry | null; historyEnabled?: () => boolean; report: (message: string) => void }) {
  const { host, control } = options
  const sharedThreads = async (threadId: string, destinationFolder?: string) => {
    const snapshot = host.workspaceSnapshot()
    const destination = destinationFolder ? { ...snapshot, threads: snapshot.threads.map(thread => thread.id === threadId
      ? { ...thread, worktree: undefined, workingDirectory: destinationFolder } : thread) } : snapshot
    return threadsInCheckout(destination, threadId, thread => resolveThreadWorkingDirectory(thread, destination.projects.find(project => project.id === thread.projectId)))
  }
  const pending = async (threadId: string, destinationFolder?: string): Promise<boolean> => (await sharedThreads(threadId, destinationFolder)).some(thread => thread.status === 'running' || thread.requests.length > 0
    || thread.historyStatus === 'loading' || thread.historyStatus === 'error' || control.hasPendingThreadWork(thread.id))
  const checkpoints = new CheckpointService({ report: options.report, ...(options.historyEnabled ? { historyEnabled: options.historyEnabled } : {}), files: options.files, directory: join(options.directory, 'checkpoints'),
    resolveThread: async (threadId, held) => {
      const snapshot = host.workspaceSnapshot(), thread = snapshot.threads.find(item => item.id === threadId)
      if (!thread?.providerId) return null
      const capability = host.rollbackCapability(threadId)
      const binding = options.registry?.byThread(threadId)
      const connected = isThreadProviderConnected(snapshot, thread)
      return { threadId, providerId: thread.providerId, bindingId: `${thread.providerId}:${binding?.sessionId ?? threadId}`,
        userMessageIds: thread.messages.filter(message => message.role === 'user').map(message => message.id),
        running: !connected || thread.status === 'running' || thread.historyStatus === 'loading' || thread.historyStatus === 'error',
        ...(held?.historyOnly ? {} : { busy: !connected || await pending(threadId) || !held?.mutationHeld && await host.isCheckoutMutating(threadId) }),
        rollbackSupported: capability.supported, ...(capability.reason ? { unsupportedReason: capability.reason } : {}),
      }
    },
    acquireRead: threadId => host.acquireCheckoutRead(threadId),
    acquireMutation: threadId => host.acquireCheckoutMutation(threadId, { kind: 'checkpoint-revert' }),
    rollback: (threadId, count, expected) => host.rollbackThread(threadId, count, expected),
    refresh: async threadId => { await host.refreshThread(threadId) },
  })
  const ready = checkpoints.initialize()
  void ready.catch(error => options.report(error instanceof Error ? error.message : 'Checkpoint storage could not be read. Restore access to local storage and try again.'))
  /** No folder to read yet: a first send before setup allocates one, or a reclaimed worktree the next send puts back (ADR-0041). */
  const unallocated = (threadId: string): boolean => {
    const thread = host.workspaceSnapshot().threads.find(item => item.id === threadId)
    return thread?.worktree?.mode === 'independent' && (thread.nativeSessionStarted === false && !thread.worktree.path || Boolean(thread.worktree.reclaimedAt))
  }
  const blocked = async (threadId: string): Promise<boolean> => {
    await checkpoints.initialize()
    // A first send has no folder yet. Honor any thread recovery record, then let setup allocate it.
    return unallocated(threadId) ? checkpoints.isBlocked(threadId) : checkpoints.isWorkspaceBlocked(threadId)
  }
  let historyEnabled = options.historyEnabled?.()
  host.setCheckpointHooks({
    privacyChanged: async () => {
      const next = options.historyEnabled?.()
      if (next === historyEnabled) return
      await checkpoints.privacyChanged()
      historyEnabled = next
    },
    isBlocked: async threadId => await blocked(threadId) || !unallocated(threadId) && await host.isCheckoutMutating(threadId),
    // The coordinator read the thread just before this send, so the workspace already holds its user messages.
    // `beforeTurn` settles the previous turn's checkpoint itself before taking this one.
    beforeTurn: async threadId => {
      await checkpoints.initialize()
      await checkpoints.beforeTurn(threadId)
    },
  })
  const completions = new Map<string, string>()
  let threadIds = new Set(host.workspaceSnapshot().threads.map(thread => thread.id))
  const unsubscribe = control.subscribe(state => {
    const nextIds = new Set(state.host.threads.map(thread => thread.id))
    for (const id of threadIds) if (!nextIds.has(id)) void checkpoints.forgetThread(id).catch(() => options.report('Thread checkpoints could not be removed. Check access to local storage.'))
    threadIds = nextIds
    for (const thread of state.host.threads) {
      if (!isThreadProviderConnected(state.host, thread) || thread.status === 'running' || !thread.lastTurn || thread.lastTurn.status === 'running') continue
      // The published state is the shell, so a thread's message count comes from its summary.
      const key = `${thread.lastTurn.id}:${thread.lastTurn.status}:${threadSummaryOf(thread).messageCount}`
      if (completions.get(thread.id) === key) continue
      completions.set(thread.id, key)
      void checkpoints.initialize().then(() => checkpoints.afterTurn(thread.id)).catch(() => options.report('A completed turn checkpoint could not be saved. Check the Changes panel before attempting a revert.'))
    }
  })
  return { checkpoints,
    canMutate: async (threadId: string, destinationFolder?: string): Promise<boolean> => destinationFolder
      ? !await checkpoints.isWorkspaceBlocked(threadId, destinationFolder) && !await pending(threadId, destinationFolder)
      : !unallocated(threadId) && !await blocked(threadId) && !await pending(threadId),
    dispose: (): void => { unsubscribe(); checkpoints.dispose() },
  }
}
