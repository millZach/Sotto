import { isThreadProviderConnected, type AgentHostSnapshot } from '../../shared/agents'
import type { HeldProviders } from '../../shared/heldProviders'
import { isWorkspaceThreadSettled } from '../../shared/threadActivity'
import type { WatcherRoomThreadInput } from '../../shared/watcherHost'
import { heldProviderOfProject, heldProviderOfThread, type DormantProviderThreads } from './heldProviderGate'

/** An owned room input, without carrying a host shell or any provider body. Held providers' threads are not in it. */
export function watcherRoomInputs(host: AgentHostSnapshot, ids: readonly string[], held: HeldProviders,
  hiddenIds?: DormantProviderThreads): WatcherRoomThreadInput[] {
  const requested = new Set(ids)
  return host.threads.filter(thread => requested.has(thread.id)
    && (!held.size || !hiddenIds?.has(thread.id) && heldProviderOfThread(thread, host, held) === undefined)).map(thread => {
    const project = host.projects.find(item => item.id === thread.projectId && heldProviderOfProject(item, held) === undefined)
    return { id: thread.id, title: thread.title, status: thread.status,
      connected: isThreadProviderConnected(host, thread) && thread.clientConnected !== false,
      settled: isWorkspaceThreadSettled(thread, project),
      backgroundWorkCount: (thread.backgroundWork?.length ?? 0) + (thread.monitoring?.length ?? 0),
      waitsOn: thread.requests.map(request => ({ id: request.id, kind: request.kind })) }
  })
}
