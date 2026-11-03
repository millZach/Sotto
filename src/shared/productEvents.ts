import { z } from 'zod'

/** That the user opened a tool whose reads run with or without them looking, so only the window can tell (ADR-0179). */
export const PRODUCT_EVENT_TOOL_OPENED = 'sotto:product-events:tool-opened'
export const productEventToolSchema = z.enum(['files', 'changes'])
export type ProductEventTool = z.infer<typeof productEventToolSchema>
export interface ProductEventsBridge { toolOpened(tool: ProductEventTool): void }
