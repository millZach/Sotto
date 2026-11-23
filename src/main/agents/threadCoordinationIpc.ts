import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { COORDINATION_CHANGED, COORDINATION_READ, COORDINATION_REPLY_READ, coordinationChangedSchema, coordinationReadRequestSchema, coordinationReadSchema,
  coordinationReplyRequestSchema, coordinationReplySchema, type CoordinationExchangeView, type CoordinationRead, type CoordinationReply } from '../../shared/threadCoordination'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Argument tuple schemas built once at module scope (`zodSchemaSites.test.ts`). */
const coordinationReadArguments = z.tuple([coordinationReadRequestSchema])
const coordinationReplyArguments = z.tuple([coordinationReplyRequestSchema])

/** Read-only view surface asked of `ThreadCoordinationService` by main-window IPC (ADR-0216, Slices 2 & 3). */
export interface ThreadCoordinationViews {
  views(threadId: string): { readonly sent: readonly CoordinationExchangeView[]; readonly received: readonly CoordinationExchangeView[] }
  reply(threadId: string, exchangeId: string): { readonly text: string; readonly truncated: boolean } | undefined
  replyAsync?(threadId: string, exchangeId: string): Promise<{ readonly text: string; readonly truncated: boolean } | undefined>
  onViewsChanged(listener: (threadIds: readonly string[]) => void): () => void
}

/** Remote-host coordination view surface exposed by `DesktopHostRouter` (ADR-0216, Slice 3). */
export interface RemoteCoordinationViews {
  coordinationViews(threadKey: string): Promise<CoordinationRead>
  coordinationReply(threadKey: string, exchangeId: string): Promise<CoordinationReply>
  subscribeCoordinationViews(listener: (threadIds: readonly string[]) => void): () => void
}

/**
 * Main-window IPC for parent-to-parent thread coordination views (ADR-0216, Slices 2 & 3).
 * Registered only while `parent-thread-coordination` is enabled on Owl; stable registers nothing.
 */
export function registerThreadCoordinationIpc(
  ipc: IpcMainAdapter,
  coordination: ThreadCoordinationViews | undefined,
  senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined,
  send: (channel: string, payload: unknown) => void,
  remote?: RemoteCoordinationViews,
): () => void {
  if (!coordination) return () => undefined
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)

  ipc.handle(COORDINATION_READ, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open parent-thread coordination in the main Sotto window.`)
    const [request] = coordinationReadArguments.parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) {
      const read = remote ? await remote.coordinationViews(request.threadId) : { threadId: request.threadId, sent: [], received: [] }
      return coordinationReadSchema.parse(read)
    }
    const { sent, received } = coordination.views(key?.id ?? request.threadId)
    const qualify = (view: CoordinationExchangeView): CoordinationExchangeView => {
      if (view.peerHostId) return { ...view, peerThreadId: hostEntityKey(view.peerHostId, view.peerThreadId) }
      return !key ? view : { ...view, peerThreadId: windowId(view.peerThreadId) }
    }
    return coordinationReadSchema.parse({
      threadId: request.threadId,
      sent: sent.map(qualify),
      received: received.map(qualify),
    })
  })

  ipc.handle(COORDINATION_REPLY_READ, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open parent-thread coordination in the main Sotto window.`)
    const [request] = coordinationReplyArguments.parse(args)
    const key = parseHostEntityKey(request.threadId)
    if (key && key.hostId !== localHostId()) {
      const remoteReply = remote ? await remote.coordinationReply(request.threadId, request.exchangeId) : null
      return coordinationReplySchema.parse(remoteReply)
    }
    const rawId = key?.id ?? request.threadId
    const reply = coordination.replyAsync
      ? await coordination.replyAsync(rawId, request.exchangeId)
      : coordination.reply(rawId, request.exchangeId)
    return coordinationReplySchema.parse(reply === undefined ? null : { exchangeId: request.exchangeId, text: reply.text, truncated: reply.truncated })
  })

  const stopLocal = coordination.onViewsChanged(threadIds => {
    if (!threadIds.length) return
    send(COORDINATION_CHANGED, coordinationChangedSchema.parse({ threadIds: threadIds.map(windowId) }))
  })
  const stopRemote = remote?.subscribeCoordinationViews(threadIds => {
    if (!threadIds.length) return
    send(COORDINATION_CHANGED, coordinationChangedSchema.parse({ threadIds }))
  })

  return () => {
    stopLocal()
    stopRemote?.()
    ipc.removeHandler(COORDINATION_READ)
    ipc.removeHandler(COORDINATION_REPLY_READ)
  }
}
