import { isThreadProviderConnected } from '../../shared/agents'
import { parseHostEntityKey } from '../../shared/clientIdentity'
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
    requests: structuredClone(thread.requests), ...(thread.kind === 'watcher' || thread.kind === 'watcher-history' ? { watcher: true } : {}), listed: true, ...recovery } : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
}
