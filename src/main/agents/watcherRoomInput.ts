import { isThreadProviderConnected, parsePublicProviderEntityId, type AgentHostSnapshot } from '../../shared/agents'
import { isWorkspaceThreadSettled } from '../../shared/threadActivity'
import type { WatcherRoomThreadInput } from '../../shared/watcherHost'
import { threadUsesMuse } from './museGate'

/** An owned room input, without carrying a host shell or any provider body. */
export function watcherRoomInputs(host: AgentHostSnapshot, ids: readonly string[], museEnabled: boolean,
  hiddenMuseIds?: ReadonlyMap<string, string>): WatcherRoomThreadInput[] {
  const requested = new Set(ids)
  return host.threads.filter(thread => requested.has(thread.id)
    && (museEnabled || !hiddenMuseIds?.has(thread.id) && !threadUsesMuse(thread, host))).map(thread => {
    const project = host.projects.find(item => item.id === thread.projectId
      && (museEnabled || item.providerId !== 'muse' && parsePublicProviderEntityId(item.id)?.provider !== 'muse'))
    return { id: thread.id, title: thread.title, status: thread.status,
      connected: isThreadProviderConnected(host, thread) && thread.clientConnected !== false,
      settled: isWorkspaceThreadSettled(thread, project),
      backgroundWorkCount: (thread.backgroundWork?.length ?? 0) + (thread.monitoring?.length ?? 0),
      waitsOn: thread.requests.map(request => ({ id: request.id, kind: request.kind })) }
  })
}
