import { z } from 'zod'

import { MAIN_CHECKOUT_CHANGES, MAIN_CHECKOUT_COMMAND, MAIN_CHECKOUT_READ, mainCheckoutChangesSchema, mainCheckoutCommandSchema, mainCheckoutStateSchema } from '../../shared/mainCheckout'
import { isAuthorizedIpcSender, type IpcInvocationEvent, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { MainCheckoutKeeper } from './mainCheckout'

/**
 * Keep main up to date's handlers (ADR-0123). Stable builds no keeper, so nothing is registered there. Only the main
 * window may ask, since only its Threads sidebar shows a project's line.
 */
export function registerMainCheckoutIpc(ipc: IpcMainAdapter, keeper: MainCheckoutKeeper | undefined, senders: () => readonly TrustedIpcSender[],
  openFolder: (path: string) => Promise<void>): () => void {
  if (keeper === undefined) return () => undefined
  const authorize = (event: IpcInvocationEvent): void => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('Open Threads in the main Sotto window.')
  }
  ipc.handle(MAIN_CHECKOUT_READ, (event, ...args) => {
    authorize(event)
    z.tuple([]).parse(args)
    return mainCheckoutStateSchema.parse(keeper.state())
  })
  ipc.handle(MAIN_CHECKOUT_CHANGES, async (event, ...args) => {
    authorize(event)
    const [projectId] = z.tuple([z.string().min(1).max(256)]).parse(args)
    return mainCheckoutChangesSchema.parse(await keeper.changes(projectId))
  })
  ipc.handle(MAIN_CHECKOUT_COMMAND, async (event, ...args) => {
    authorize(event)
    const [command] = z.tuple([mainCheckoutCommandSchema]).parse(args)
    if (command.type === 'dismiss-dependencies') return mainCheckoutStateSchema.parse(await keeper.dismissDependencies(command.projectId))
    const folder = keeper.projectFolder(command.projectId)
    if (folder === null) throw new Error('That project is no longer in Sotto.')
    await openFolder(folder)
    return mainCheckoutStateSchema.parse(keeper.state())
  })
  return () => { for (const channel of [MAIN_CHECKOUT_READ, MAIN_CHECKOUT_CHANGES, MAIN_CHECKOUT_COMMAND]) ipc.removeHandler(channel) }
}
