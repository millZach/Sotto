import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { DELEGATIONS_CHANGED, DELEGATIONS_READ, delegationsChangedSchema, delegationsReadSchema, delegationsRequestSchema, type DelegatedView, type DelegationView } from '../../shared/delegation'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** What the window's read asks of delegation in main: its own record, never a snapshot (#1029). */
export interface DelegationViews {
  views(threadId: string): { readonly made: readonly DelegationView[]; readonly received: readonly DelegatedView[] }
  onViewsChanged(listener: (threadIds: readonly string[]) => void): () => void
}

/**
 * The main window's read of a thread's delegations, and main's word that some changed (#1029, ADR-0081). The Owl
 * list's startup answer decides whether the handler exists: stable registers nothing, and no renderer can turn it on.
 * The window names threads by their host-qualified IDs; delegation runs on this computer alone, so a thread on another
 * host has none, and every ID in an answer is this computer's, qualified the way the window names it.
 */
export function registerDelegationIpc(ipc: IpcMainAdapter, delegation: DelegationViews | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void): () => void {
  if (!delegation) return () => undefined
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)
  ipc.handle(DELEGATIONS_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open delegations in the main Sotto window.')
    const [request] = z.tuple([delegationsRequestSchema]).parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) return delegationsReadSchema.parse({ threadId: request.threadId, delegations: [], received: [] })
    const { made, received } = delegation.views(key?.id ?? request.threadId)
    // A refused start names no thread: nothing was started.
    const named = <View extends DelegationView>(view: View): View => view.thread === undefined || !key ? view : { ...view, thread: windowId(view.thread) }
    return delegationsReadSchema.parse({ threadId: request.threadId, delegations: made.map(named), received: received.map(named) })
  })
  const stop = delegation.onViewsChanged(threadIds => { send(DELEGATIONS_CHANGED, delegationsChangedSchema.parse({ threadIds: threadIds.map(windowId) })) })
  return () => { stop(); ipc.removeHandler(DELEGATIONS_READ) }
}
