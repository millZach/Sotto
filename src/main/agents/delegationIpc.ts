import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { DELEGATION_BRIEF_READ, DELEGATIONS_CHANGED, DELEGATIONS_READ, delegationBriefRequestSchema, delegationBriefSchema, delegationsChangedSchema, delegationsReadSchema, delegationsRequestSchema, type DelegatedView, type DelegationBrief, type DelegationsRead, type DelegationView } from '../../shared/delegation'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** What the window's read asks of delegation in main: its own record, never a snapshot (#1029). */
export interface DelegationViews {
  views(threadId: string): { readonly made: readonly DelegationView[]; readonly received: readonly DelegatedView[] }
  /** The newest brief the delegated thread was sent that Sotto still holds, its words alone. */
  brief(threadId: string): string | undefined
  onViewsChanged(listener: (threadIds: readonly string[]) => void): () => void
}

/**
 * The same reads of threads on other machines (#1310), by the window's keys for them: the router asks each thread's own
 * host, which runs delegation for its threads, and keeps what it last read there while the host is away.
 */
export interface RemoteDelegationViews {
  delegationViews(threadKey: string): Promise<DelegationsRead>
  delegationBrief(threadKey: string): Promise<DelegationBrief>
  subscribeDelegationViews(listener: (threadKeys: readonly string[]) => void): () => void
}

/**
 * The main window's read of a thread's delegations, and main's word that some changed (#1029, ADR-0081). The Owl
 * list's startup answer decides whether the handler exists: stable registers nothing, and no renderer can turn it on.
 * The window names threads by their host-qualified IDs. This computer's own delegations are read from its record, and
 * every ID in such an answer is this computer's, qualified the way the window names it. A thread on another host is read
 * on that host through `remote` only where Work across machines is on (#1310); without it, it has none.
 */
export function registerDelegationIpc(ipc: IpcMainAdapter, delegation: DelegationViews | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void, remote?: RemoteDelegationViews): () => void {
  if (!delegation && !remote) return () => undefined
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)
  // Synchronous for this computer's threads, so a refusal throws as the window asks; a remote read answers when its host does.
  ipc.handle(DELEGATIONS_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open delegations in the main Sotto window.`)
    const [request] = z.tuple([delegationsRequestSchema]).parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) {
      return remote ? remote.delegationViews(request.threadId).then(read => delegationsReadSchema.parse(read)) : delegationsReadSchema.parse({ threadId: request.threadId, delegations: [], received: [] })
    }
    if (!delegation) return delegationsReadSchema.parse({ threadId: request.threadId, delegations: [], received: [] })
    const { made, received } = delegation.views(key?.id ?? request.threadId)
    // A refused start names no thread: nothing was started.
    const named = <View extends DelegationView>(view: View): View => view.thread === undefined || !key ? view : { ...view, thread: windowId(view.thread) }
    return delegationsReadSchema.parse({ threadId: request.threadId, delegations: made.map(named), received: received.map(named) })
  })
  ipc.handle(DELEGATION_BRIEF_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open delegations in the main Sotto window.`)
    const [request] = z.tuple([delegationBriefRequestSchema]).parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) return remote ? remote.delegationBrief(request.threadId).then(brief => delegationBriefSchema.parse(brief)) : null
    const text = delegation?.brief(key?.id ?? request.threadId)
    return delegationBriefSchema.parse(text === undefined ? null : { threadId: request.threadId, text })
  })
  const stop = delegation?.onViewsChanged(threadIds => { send(DELEGATIONS_CHANGED, delegationsChangedSchema.parse({ threadIds: threadIds.map(windowId) })) })
  const stopRemote = remote?.subscribeDelegationViews(threadKeys => { send(DELEGATIONS_CHANGED, delegationsChangedSchema.parse({ threadIds: threadKeys })) })
  return () => { stop?.(); stopRemote?.(); ipc.removeHandler(DELEGATIONS_READ); ipc.removeHandler(DELEGATION_BRIEF_READ) }
}
