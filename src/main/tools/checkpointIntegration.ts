import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isThreadProviderConnected, threadSummaryOf } from '../../shared/agents'
import { resolveThreadWorkingDirectory } from '../../shared/threadWorkingDirectory'
import type { AgentControl } from '../agents/control'
import type { WorkspaceHost } from '../agents/workspace'
import type { ThreadRegistry } from '../agents/threads'
import type { FilesService } from '../files/service'
import { CheckpointService } from './checkpoints'
import type { GitChangesService } from './gitChanges'

export function connectCheckpoints(options: { files: FilesService; directory: string; host: WorkspaceHost; control: AgentControl; registry: ThreadRegistry | null; git: () => GitChangesService; report: (message: string) => void }) {
  const { host, control } = options
  const canonical = async (path: string): Promise<string> => {
    const value = await realpath(path)
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  const sharedThreads = async (threadId: string) => {
    const snapshot = host.workspaceSnapshot(), target = snapshot.threads.find(thread => thread.id === threadId)
    if (!target) return []
    const path = await canonical(resolveThreadWorkingDirectory(target, snapshot.projects.find(project => project.id === target.projectId)))
    const candidates = await Promise.all(snapshot.threads.map(async thread => ({ thread,
      path: await canonical(resolveThreadWorkingDirectory(thread, snapshot.projects.find(project => project.id === thread.projectId))).catch(() => null),
    })))
    return candidates.filter(candidate => candidate.path === path).map(candidate => candidate.thread)
  }
  const pending = async (threadId: string): Promise<boolean> => (await sharedThreads(threadId)).some(thread => thread.status === 'running' || thread.requests.length > 0
    || thread.historyStatus === 'loading' || thread.historyStatus === 'error' || control.hasPendingThreadWork(thread.id))
  const checkpoints = new CheckpointService({ files: options.files, directory: join(options.directory, 'checkpoints'),
    resolveThread: async threadId => {
      const snapshot = host.workspaceSnapshot(), thread = snapshot.threads.find(item => item.id === threadId)
      if (!thread?.providerId) return null
      const capability = host.rollbackCapability(threadId)
      const binding = options.registry?.byThread(threadId)
      const connected = isThreadProviderConnected(snapshot, thread)
      return { threadId, providerId: thread.providerId, bindingId: `${thread.providerId}:${binding?.sessionId ?? threadId}`,
        userMessageIds: thread.messages.filter(message => message.role === 'user').map(message => message.id),
        running: !connected || thread.status === 'running' || thread.historyStatus === 'loading' || thread.historyStatus === 'error',
        busy: !connected || await pending(threadId) || await options.git().isMutating(threadId),
        rollbackSupported: capability.supported, ...(capability.reason ? { unsupportedReason: capability.reason } : {}),
      }
    },
    rollback: (threadId, count, expected) => host.rollbackThread(threadId, count, expected),
    refresh: async threadId => { await host.refreshThread(threadId) },
  })
  const ready = checkpoints.initialize()
  void ready.catch(() => options.report('Checkpoint recovery storage could not be read. Thread mutations are blocked until it is repaired.'))
  const blocked = async (threadId: string): Promise<boolean> => {
    await ready
    return checkpoints.isWorkspaceBlocked(threadId)
  }
  host.setCheckpointHooks({
    isBlocked: async threadId => await blocked(threadId) || await options.git().isMutating(threadId),
    beforeTurn: async threadId => {
      await ready
      await host.refreshThread(threadId)
      await checkpoints.afterTurn(threadId)
      await checkpoints.beforeTurn(threadId)
    },
  })
  const completions = new Map<string, string>()
  const unsubscribe = control.subscribe(state => {
    for (const thread of state.host.threads) {
      if (!isThreadProviderConnected(state.host, thread) || thread.status === 'running' || !thread.lastTurn || thread.lastTurn.status === 'running') continue
      // The published state is the shell, so a thread's message count comes from its summary.
      const key = `${thread.lastTurn.id}:${thread.lastTurn.status}:${threadSummaryOf(thread).messageCount}`
      if (completions.get(thread.id) === key) continue
      completions.set(thread.id, key)
      void ready.then(() => checkpoints.afterTurn(thread.id)).catch(() => options.report('A completed turn checkpoint could not be saved. Check the Changes panel before attempting a revert.'))
    }
  })
  return { checkpoints,
    canMutate: async (threadId: string): Promise<boolean> => !await blocked(threadId) && !await pending(threadId),
    dispose: (): void => { unsubscribe(); checkpoints.dispose() },
  }
}
