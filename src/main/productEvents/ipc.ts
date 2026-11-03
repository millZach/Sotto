import { z } from 'zod'
import { PRODUCT_EVENT_TOOL_OPENED, productEventToolSchema, type ProductEventTool } from '../../shared/productEvents'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

const toolArguments = z.tuple([productEventToolSchema])

/** The one thing the window tells product events. It carries a name from a closed list, and nothing goes back. */
export function registerProductEventsIpc(ipc: IpcMainAdapter, events: { featureUsed(feature: ProductEventTool): void }, senders: () => readonly TrustedIpcSender[]): () => void {
  ipc.handle(PRODUCT_EVENT_TOOL_OPENED, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) return
    const parsed = toolArguments.safeParse(args)
    if (parsed.success) events.featureUsed(parsed.data[0])
  })
  return () => ipc.removeHandler(PRODUCT_EVENT_TOOL_OPENED)
}
