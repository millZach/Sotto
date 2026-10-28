import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { CONTINUE_READ, CONTINUE_START, continueReadSchema, continueStartSchema, type ContinueRead, type ContinueStart } from '../../shared/continueThread'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const oneArgument = z.tuple([z.unknown()])

/** What the window's bridge asks of continuing in main: a read of what would be handed over, and the start itself. */
export interface ContinueCalls {
  read(request: unknown): ContinueRead
  start(request: unknown): Promise<ContinueStart>
}

/**
 * The main window's bridge for continuing a thread on another provider (ADR-0089). The Owl list's startup answer
 * decides whether the handlers exist: stable registers nothing, and no renderer can turn it on. Each answer is checked
 * against its schema on the way out, as every bridge's is.
 */
export function registerContinueIpc(ipc: IpcMainAdapter, calls: ContinueCalls | undefined, senders: () => readonly TrustedIpcSender[]): () => void {
  if (!calls) return () => undefined
  ipc.handle(CONTINUE_READ, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Continue a thread from the main Sotto window.`)
    const [request] = oneArgument.parse(args)
    return continueReadSchema.parse(calls.read(request))
  })
  ipc.handle(CONTINUE_START, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Continue a thread from the main Sotto window.`)
    const [request] = oneArgument.parse(args)
    return continueStartSchema.parse(await calls.start(request))
  })
  return () => { ipc.removeHandler(CONTINUE_READ); ipc.removeHandler(CONTINUE_START) }
}
