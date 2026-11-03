import { z } from 'zod'

/** That the user opened a tool whose reads run with or without them looking, so only the window can tell (ADR-0179). */
export const PRODUCT_EVENT_TOOL_OPENED = 'sotto:product-events:tool-opened'
export const productEventToolSchema = z.enum(['files', 'changes'])
export type ProductEventTool = z.infer<typeof productEventToolSchema>
/** What the window asks before it shows the notice or the switch: whether this build can send, and which variable turned it off. */
export const PRODUCT_EVENT_STATE = 'sotto:product-events:state'
export type ProductEventsOffBy = 'SOTTO_TELEMETRY_ENABLED' | 'DO_NOT_TRACK'
export interface ProductEventsState { readonly canSend: boolean; readonly offBy: ProductEventsOffBy | null }
/** The page that lists every event. */
export const PRODUCT_EVENTS_DOCS_URL = 'https://github.com/millZach/Sotto/blob/main/docs/product-events.md'
export interface ProductEventsBridge { toolOpened(tool: ProductEventTool): void; state(): Promise<ProductEventsState | null> }
