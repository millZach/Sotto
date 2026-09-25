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
export const browserPageSchema = z.object({ id: z.string().uuid(), workspace: fileWorkspaceSchema, url: browserUrlSchema, title: z.string().max(512), status: z.enum(['loading', 'ready', 'unavailable']), error: z.string().max(2000).nullable(), canGoBack: z.boolean(), canGoForward: z.boolean(), sharedOrigin: z.string().nullable().optional(), viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional() }).strict()
/** What the renderer may know of a thread's browser grant (ADR-0029): that it is live, since when, and where it came from. */
export const browserGrantSchema = z.object({ grantedAt: z.number(), source: z.enum(['settings', 'user']) }).strict()
export const browserListingSchema = z.object({ workspace: fileWorkspaceSchema, pages: z.array(browserPageSchema).max(32), grant: browserGrantSchema.nullable().optional() }).strict()
export const browserOpenResultSchema = z.object({ destination: z.enum(['external', 'embedded']), page: browserPageSchema.optional() }).strict()
const coordinate = z.number().finite().min(0).max(8192)
export const browserPointSchema = z.object({ x: coordinate, y: coordinate }).strict()
const viewportShape = { width: z.number().int().min(240).max(2560), height: z.number().int().min(240).max(2560) }
export const browserViewportSchema = browserRequestSchema.extend(viewportShape).or(browserRequestSchema.extend({ reset: z.literal(true) }))
export const browserShareSchema = browserRequestSchema.extend({ enabled: z.boolean() })
export const browserCaptureSchema = browserRequestSchema.extend({ point: browserPointSchema.optional(), region: browserBoundsSchema.optional(), captureId: z.string().uuid().optional() })
export const browserCaptureResultSchema = z.object({ captureId: z.string().uuid().optional(), image: z.string().max(16_000_000), url: browserUrlSchema, width: z.number(), height: z.number(), element: z.object({ tag: z.string(), role: z.string(), name: z.string(), text: z.string(), selector: z.string() }).nullable() }).strict()
export const browserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect') }).strict(), z.object({ type: z.literal('screenshot') }).strict(),
  z.object({ type: z.literal('navigate'), url: browserUrlSchema }).strict(),
  z.object({ type: z.literal('click'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }).strict(),
  z.object({ type: z.literal('scroll'), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-4096).max(4096), deltaY: z.number().finite().min(-4096).max(4096) }).strict(),
  z.object({ type: z.literal('viewport'), ...viewportShape }).strict(),
])
export const browserTaskRequestSchema = browserRequestSchema.extend({ taskId: z.string().uuid() })
export const browserStartTaskSchema = browserRequestSchema.extend({ description: z.string().min(1).max(300) })
export const browserAgentOpenSchema = browserCreateSchema.extend({ description: z.string().min(1).max(300) })
export const browserAgentActionSchema = browserTaskRequestSchema.extend({ action: browserActionSchema })
export const browserControlTaskSchema = browserTaskRequestSchema.extend({ control: z.enum(['pause', 'resume']) })
/** `forThread` answers with a browser grant (ADR-0029) for the rest of the session, not just this once. */
export const browserAnswerActionSchema = browserTaskRequestSchema.extend({ actionId: z.string().uuid(), allow: z.boolean(), forThread: z.literal(true).optional() })
export const browserFinishTaskSchema = browserTaskRequestSchema.extend({ status: z.enum(['completed', 'failed']), summary: z.string().max(2000), unchecked: z.array(z.string().max(500)).max(20) })
export const browserTaskSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid(),
  status: z.enum(['working', 'paused', 'completed', 'failed']), description: z.string().max(300), updatedAt: z.number(),
  steps: z.array(z.object({ id: z.string(), action: z.string(), status: z.enum(['completed', 'failed']), at: z.number(), detail: z.string().max(2000), url: z.string().optional(), viewport: z.object({ width: z.number(), height: z.number() }).nullable().optional() })).max(40),
  thumbnail: z.string().nullable(), summary: z.string().nullable(), unchecked: z.array(z.string()),
  pendingAction: z.object({ id: z.string().uuid(), action: browserActionSchema, description: z.string(), expiresAt: z.number() }).nullable(),
  output: z.string().max(200_000).nullable(),
  evidence: z.array(z.object({ id: z.string(), at: z.number(), url: z.string(), viewport: z.object({ width: z.number(), height: z.number() }).nullable(), image: z.string().max(2_000_000), width: z.number(), height: z.number() })).max(3).optional(),
}).strict()
export const browserAgentResultSchema = z.object({ task: browserTaskSchema, output: z.string().max(200_000).optional(), image: z.string().max(16_000_000).optional(), approvalRequired: z.boolean() }).strict()
export const browserEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('page'), page: browserPageSchema }).strict(), z.object({ type: z.literal('closed'), threadId: z.string(), workspaceId: z.string(), pageId: z.string().uuid() }).strict(), z.object({ type: z.literal('task'), task: browserTaskSchema }).strict(), z.object({ type: z.literal('browser-grant'), threadId: z.string(), grant: browserGrantSchema.nullable() }).strict()])
export type BrowserTask = z.infer<typeof browserTaskSchema>
export type BrowserAction = z.infer<typeof browserActionSchema>
export type BrowserAgentResult = z.infer<typeof browserAgentResultSchema>
export type BrowserCapture = z.infer<typeof browserCaptureResultSchema>
export type BrowserPage = z.infer<typeof browserPageSchema>
export type BrowserEvent = z.infer<typeof browserEventSchema>
export type BrowserBounds = z.infer<typeof browserBoundsSchema>
export type BrowserGrantView = z.infer<typeof browserGrantSchema>
export interface BrowserBridge {
  tasks(request: { threadId: string }): Promise<ToolsResult<BrowserTask[]>>
  share(request: z.infer<typeof browserShareSchema>): Promise<ToolsResult<BrowserPage>>
  controlTask(request: z.infer<typeof browserControlTaskSchema>): Promise<ToolsResult<BrowserTask>>
  answerAction(request: z.infer<typeof browserAnswerActionSchema>): Promise<ToolsResult<BrowserTask>>
  /** The user's Stop: ends the thread's browser grant, so it asks again (ADR-0029). */
  stopGrant(request: z.infer<typeof toolTargetSchema>): Promise<ToolsResult<void>>
  viewport(request: z.infer<typeof browserViewportSchema>): Promise<ToolsResult<BrowserPage>>
  capture(request: z.infer<typeof browserCaptureSchema>): Promise<ToolsResult<BrowserCapture>>
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
