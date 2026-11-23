import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { COORDINATION_CHANGED, COORDINATION_READ, COORDINATION_REPLY_READ, coordinationChangedSchema, coordinationReadRequestSchema, coordinationReadSchema,
  coordinationReplyRequestSchema, coordinationReplySchema, type CoordinationExchangeView } from '../../shared/threadCoordination'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Argument tuple schemas built once at module scope (`zodSchemaSites.test.ts`). */
const coordinationReadArguments = z.tuple([coordinationReadRequestSchema])
const coordinationReplyArguments = z.tuple([coordinationReplyRequestSchema])

/** Read-only view surface asked of `ThreadCoordinationService` by main-window IPC (ADR-0216, Slice 2). */
export interface ThreadCoordinationViews {
  views(threadId: string): { readonly sent: readonly CoordinationExchangeView[]; readonly received: readonly CoordinationExchangeView[] }
  reply(threadId: string, exchangeId: string): { readonly text: string; readonly truncated: boolean } | undefined
  onViewsChanged(listener: (threadIds: readonly string[]) => void): () => void
}

/**
 * Main-window IPC for parent-to-parent thread coordination views (ADR-0216, Slice 2).
 * Registered only while `parent-thread-coordination` is enabled on Owl; stable registers nothing.
 */
export function registerThreadCoordinationIpc(
  ipc: IpcMainAdapter,
  coordination: ThreadCoordinationViews | undefined,
  senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined,
  send: (channel: string, payload: unknown) => void,
): () => void {
  if (!coordination) return () => undefined
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)

  ipc.handle(COORDINATION_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open parent-thread coordination in the main Sotto window.`)
    const [request] = coordinationReadArguments.parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) {
      return coordinationReadSchema.parse({ threadId: request.threadId, sent: [], received: [] })
    }
    const { sent, received } = coordination.views(key?.id ?? request.threadId)
    const qualify = (view: CoordinationExchangeView): CoordinationExchangeView =>
      !key ? view : { ...view, peerThreadId: windowId(view.peerThreadId) }
    return coordinationReadSchema.parse({
      threadId: request.threadId,
      sent: sent.map(qualify),
      received: received.map(qualify),
    })
  })

  ipc.handle(COORDINATION_REPLY_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open parent-thread coordination in the main Sotto window.`)
    const [request] = coordinationReplyArguments.parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) return null
    const reply = coordination.reply(key?.id ?? request.threadId, request.exchangeId)
    return coordinationReplySchema.parse(reply === undefined ? null : { exchangeId: request.exchangeId, text: reply.text, truncated: reply.truncated })
  })

  const stop = coordination.onViewsChanged(threadIds => {
    if (!threadIds.length) return
    send(COORDINATION_CHANGED, coordinationChangedSchema.parse({ threadIds: threadIds.map(windowId) }))
  })

  return () => {
    stop()
    ipc.removeHandler(COORDINATION_READ)
    ipc.removeHandler(COORDINATION_REPLY_READ)
  }
}
