import { z } from 'zod'
import { PRODUCT_EVENT_STATE, PRODUCT_EVENT_TOOL_OPENED, productEventToolSchema, type ProductEventsState, type ProductEventTool } from '../../shared/productEvents'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

const toolArguments = z.tuple([productEventToolSchema])

/** What the window tells product events, a name from a closed list, and what it asks: whether the notice and the switch can apply here. */
export function registerProductEventsIpc(ipc: IpcMainAdapter, events: { featureUsed(feature: ProductEventTool): void; readonly state: ProductEventsState }, senders: () => readonly TrustedIpcSender[]): () => void {
  ipc.handle(PRODUCT_EVENT_TOOL_OPENED, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) return
    const parsed = toolArguments.safeParse(args)
    if (parsed.success) events.featureUsed(parsed.data[0])
  })
  ipc.handle(PRODUCT_EVENT_STATE, event => isAuthorizedIpcSender(event, senders(), ['main']) ? events.state : null)
  return () => { ipc.removeHandler(PRODUCT_EVENT_TOOL_OPENED); ipc.removeHandler(PRODUCT_EVENT_STATE) }
}
