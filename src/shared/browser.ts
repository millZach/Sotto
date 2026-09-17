import { z } from 'zod'
import { fileWorkspaceSchema } from './files'
import { toolTargetSchema, type ToolsResult } from './tools'

export const BROWSER_CHANNEL = 'sotto:browser:'
export const BROWSER_EVENT = `${BROWSER_CHANNEL}event`
export function safeBrowserUrl(input: string): string | null {
  // eslint-disable-next-line no-control-regex -- Reject display spoofing and URL parser control stripping.
  if (/[\x00-\x20\x7f\u202a-\u202e\u2066-\u2069]/.test(input) || input.length > 8192) return null
  try {
    const url = new URL(input)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
const browserUrlSchema = z.string().refine(value => safeBrowserUrl(value) !== null, 'Use a complete HTTP or HTTPS URL without credentials.').transform(value => safeBrowserUrl(value)!)
export const browserCreateSchema = toolTargetSchema.extend({ url: browserUrlSchema })
export const browserRequestSchema = toolTargetSchema.extend({ pageId: z.string().uuid() })
export const browserNavigateSchema = browserRequestSchema.extend({ url: browserUrlSchema })
export const browserBoundsSchema = z.object({ x: z.number().finite().min(0).max(32768), y: z.number().finite().min(0).max(32768), width: z.number().finite().positive().max(32768), height: z.number().finite().positive().max(32768) }).strict()
export const browserMountSchema = browserRequestSchema.extend({ bounds: browserBoundsSchema.nullable() })
export const browserOpenLinkSchema = z.object({ url: browserUrlSchema, destination: z.enum(['external', 'embedded']).optional(), target: toolTargetSchema.optional() }).strict()
export const browserPageSchema = z.object({ id: z.string().uuid(), workspace: fileWorkspaceSchema, url: browserUrlSchema, title: z.string().max(512), status: z.enum(['loading', 'ready', 'unavailable']), error: z.string().max(2000).nullable(), canGoBack: z.boolean(), canGoForward: z.boolean() }).strict()
export const browserListingSchema = z.object({ workspace: fileWorkspaceSchema, pages: z.array(browserPageSchema).max(32) }).strict()
export const browserOpenResultSchema = z.object({ destination: z.enum(['external', 'embedded']), page: browserPageSchema.optional() }).strict()
export const browserEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('page'), page: browserPageSchema }).strict(), z.object({ type: z.literal('closed'), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid() }).strict()])
export type BrowserPage = z.infer<typeof browserPageSchema>
export type BrowserEvent = z.infer<typeof browserEventSchema>
export type BrowserBounds = z.infer<typeof browserBoundsSchema>
export interface BrowserBridge {
  list(request: { threadId: string }): Promise<ToolsResult<z.infer<typeof browserListingSchema>>>
  create(request: z.infer<typeof browserCreateSchema>): Promise<ToolsResult<BrowserPage>>
  navigate(request: z.infer<typeof browserNavigateSchema>): Promise<ToolsResult<BrowserPage>>
  back(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  forward(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  reload(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<BrowserPage>>
  close(request: z.infer<typeof browserRequestSchema>): Promise<ToolsResult<void>>
  mount(request: z.infer<typeof browserMountSchema>): Promise<ToolsResult<void>>
  openLink(request: z.infer<typeof browserOpenLinkSchema>): Promise<ToolsResult<z.infer<typeof browserOpenResultSchema>>>
  onEvent(listener: (event: BrowserEvent) => void): () => void
}
