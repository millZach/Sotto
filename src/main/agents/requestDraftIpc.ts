import { z } from 'zod'
import { REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD, requestDraftSchema, requestDraftTargetSchema, requestDraftOwnerSchema, requestDraftDiscardSchema, type RequestDraftBridge } from '../../shared/requestDrafts'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

export function registerRequestDraftIpc(ipc: IpcMainAdapter, service: RequestDraftBridge, senders: () => readonly TrustedIpcSender[]): () => void {
  for (const [channel, schema, operation] of [
    [REQUEST_DRAFT_GET, requestDraftTargetSchema, (input: unknown) => service.get(requestDraftTargetSchema.parse(input))],
    [REQUEST_DRAFT_SAVE, requestDraftSchema, (input: unknown) => service.save(requestDraftSchema.parse(input))],
    [REQUEST_DRAFT_CHECK, requestDraftTargetSchema, (input: unknown) => service.check(requestDraftTargetSchema.parse(input))],
    [REQUEST_DRAFT_LIST, requestDraftOwnerSchema, (input: unknown) => service.list(requestDraftOwnerSchema.parse(input))],
    [REQUEST_DRAFT_DISCARD, requestDraftDiscardSchema, (input: unknown) => service.discard(requestDraftDiscardSchema.parse(input))],
  ] as const) ipc.handle(channel, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('REQUEST_DRAFT_MAIN_WINDOW_REQUIRED')
    const [input] = z.tuple([schema]).parse(args)
    return operation(input)
  })
  return () => { for (const channel of [REQUEST_DRAFT_GET, REQUEST_DRAFT_SAVE, REQUEST_DRAFT_CHECK, REQUEST_DRAFT_LIST, REQUEST_DRAFT_DISCARD]) ipc.removeHandler(channel) }
}
