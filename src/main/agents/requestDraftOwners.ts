import { isThreadProviderConnected } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { requestDraftProvider, type RequestDraftOwner } from '../../shared/requestDrafts'
import type { AgentControl } from './control'
import type { RequestDraftOwnerState } from './requestDrafts'

/**
 * A saved answer's thread as its own host sees it now: the router answers for a thread on another host,
 * this computer's coordinator for one of its own.
 */
export function requestDraftOwnerState(owner: RequestDraftOwner, local: Pick<AgentControl, 'hostId' | 'requestDraftView' | 'requestAnswerRecovery'>,
  router: { requestDraftState(owner: RequestDraftOwner): RequestDraftOwnerState | undefined }): RequestDraftOwnerState | undefined {
  if (owner.kind !== 'thread') return undefined
  const key = parseHostEntityKey(owner.ownerId)
  const remote = key !== null && key.hostId !== local.hostId()
  if (remote) return router.requestDraftState(owner)
  // Read in place: the draft store asks this for every owner it knows on every save of an answer being typed, and a
  // whole-shell copy for each froze main. Only the requests handed back are copied.
  const { host, provider } = local.requestDraftView()
  const id = key?.id ?? owner.ownerId
  const thread = host.threads.find(item => item.id === id && requestDraftProvider(host, item, provider) === owner.providerId)
  const recovery = local.requestAnswerRecovery(id, owner.providerId)
  return thread ? { connected: isThreadProviderConnected(host, thread), ready: thread.historyStatus !== 'loading' && thread.historyStatus !== 'error',
    requests: structuredClone(thread.requests), ...(thread.kind === 'watcher' || thread.kind === 'watcher-history' ? { watcher: true } : {}), ...recovery } : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
}

/**
 * Every owner ID whose thread `requestDraftOwnerState` could now find to be Watcher, or main's dormant check could keep:
 * this computer's Watcher and dormant threads, under both IDs a saved owner of one may carry, and each remote host's. The
 * answer store looks up only these among the owners of answers it already retired, rather than every one on every save
 * (#1230). It reads each thread's kind in place.
 */
export function requestDraftWatcherOwnerIds(local: Pick<AgentControl, 'hostId' | 'requestDraftView'>, dormant: () => readonly string[] | undefined,
  router: { requestDraftWatcherOwnerIds(): Iterable<string> }): string[] {
  const hostId = local.hostId()
  const ids: string[] = []
  const add = (id: string): void => { ids.push(id); if (hostId !== undefined) ids.push(hostEntityKey(hostId, id)) }
  for (const thread of local.requestDraftView().host.threads) if (thread.kind === 'watcher' || thread.kind === 'watcher-history') add(thread.id)
  for (const id of dormant() ?? []) add(id)
  for (const id of router.requestDraftWatcherOwnerIds()) ids.push(id)
  return ids
}
