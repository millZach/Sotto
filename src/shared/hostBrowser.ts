import { z } from 'zod'
import { browserAnswerActionSchema, browserControlTaskSchema, browserCreateSchema, browserListingSchema, browserNavigateSchema, browserPageSchema, browserRequestSchema, browserShareSchema, browserTaskSchema } from './browser'
import { toolListRequestSchema, toolsResultSchema, toolTargetSchema } from './tools'

/**
 * Sotto's browser on a paired host, as a desktop drives it over the host protocol (`browser`, ADR-0198). Every request names
 * a page or thread by the host's own IDs; the desktop's router swaps its keys for them.
 */

const modifiers = z.number().int().min(0).max(15)
const point = { x: z.number().finite().min(0).max(8192), y: z.number().finite().min(0).max(8192) }
/** The user's own click, key, typed text or scroll in a pane, sent on to the page as Chromium's input events. */
export const hostPageInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mouse'), action: z.enum(['move', 'down', 'up']), ...point, button: z.enum(['none', 'left', 'middle', 'right']), clickCount: z.number().int().min(0).max(3), modifiers }).strict(),
  z.object({ type: z.literal('wheel'), ...point, deltaX: z.number().finite().min(-4096).max(4096), deltaY: z.number().finite().min(-4096).max(4096), modifiers }).strict(),
  z.object({ type: z.literal('key'), action: z.enum(['down', 'up']), key: z.string().min(1).max(32), code: z.string().max(32), keyCode: z.number().int().min(0).max(255), text: z.string().max(8).optional(), modifiers }).strict(),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }).strict(),
])
export type HostPageInputRequest = z.infer<typeof hostPageInputSchema>

/** The size a pane draws a page at, which the page lays out at and its pictures are drawn for. */
export const hostPageSizeSchema = z.object({ width: z.number().int().min(100).max(4096), height: z.number().int().min(100).max(4096) }).strict()
export const browserInputSchema = browserRequestSchema.extend({ input: hostPageInputSchema })
export const browserWatchSchema = browserRequestSchema.extend({ size: hostPageSizeSchema })
export const browserSettingSchema = z.object({ withoutAsking: z.boolean() }).strict()
export type BrowserInputRequest = z.infer<typeof browserInputSchema>
export type BrowserWatchRequest = z.infer<typeof browserWatchSchema>

/**
 * One request, by the `BrowserService` method it is on this computer. `input`, `watch` and `unwatch` exist only for a host's
 * page, which a pane draws from pictures; `setting` carries this computer's **Let agents use the browser without asking**.
 */
export const hostBrowserRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('list'), payload: toolListRequestSchema }).strict(),
  z.object({ method: z.literal('create'), payload: browserCreateSchema }).strict(),
  z.object({ method: z.literal('navigate'), payload: browserNavigateSchema }).strict(),
  z.object({ method: z.literal('back'), payload: browserRequestSchema }).strict(),
  z.object({ method: z.literal('forward'), payload: browserRequestSchema }).strict(),
  z.object({ method: z.literal('reload'), payload: browserRequestSchema }).strict(),
  z.object({ method: z.literal('close'), payload: browserRequestSchema }).strict(),
  z.object({ method: z.literal('tasks'), payload: toolListRequestSchema }).strict(),
  z.object({ method: z.literal('share'), payload: browserShareSchema }).strict(),
  z.object({ method: z.literal('controlTask'), payload: browserControlTaskSchema }).strict(),
  z.object({ method: z.literal('answerAction'), payload: browserAnswerActionSchema }).strict(),
  z.object({ method: z.literal('stopGrant'), payload: toolTargetSchema }).strict(),
  z.object({ method: z.literal('input'), payload: browserInputSchema }).strict(),
  z.object({ method: z.literal('watch'), payload: browserWatchSchema }).strict(),
  z.object({ method: z.literal('unwatch'), payload: browserRequestSchema }).strict(),
  z.object({ method: z.literal('setting'), payload: browserSettingSchema }).strict(),
])
export type HostBrowserRequest = z.infer<typeof hostBrowserRequestSchema>
export type HostBrowserMethod = HostBrowserRequest['method']
/** The requests that name a thread, and so go to the host that runs it. */
export type HostBrowserThreadRequest = Exclude<HostBrowserRequest, { method: 'setting' }>

/** A void answer reaches the desktop without its `value`, since JSON leaves out what is undefined; it is put back here. */
const voidResult = z.preprocess(value => value !== null && typeof value === 'object' && 'ok' in value && value.ok === true && !('value' in value) ? { ...value, value: undefined } : value,
  toolsResultSchema(z.undefined()))
const pageResult = toolsResultSchema(browserPageSchema)
const taskResult = toolsResultSchema(browserTaskSchema)
/** What each method answers, read by the desktop before anything reaches the window. */
export const hostBrowserResultSchemas = {
  list: toolsResultSchema(browserListingSchema), create: pageResult, navigate: pageResult, back: pageResult, forward: pageResult, reload: pageResult,
  close: voidResult, tasks: toolsResultSchema(z.array(browserTaskSchema).max(64)), share: pageResult, controlTask: taskResult, answerAction: taskResult,
  stopGrant: voidResult, input: voidResult, watch: voidResult, unwatch: voidResult, setting: voidResult,
} as const satisfies Record<HostBrowserMethod, z.ZodType>

export type HostBrowserResult<M extends HostBrowserMethod> = z.output<(typeof hostBrowserResultSchemas)[M]>

/** A host's pictures are JPEGs of a pane-sized page; one larger than this is dropped rather than sent. */
export const HOST_BROWSER_FRAME_MAX = 4 * 1024 * 1024
/** One picture of a host's page for a pane showing it: base64 JPEG, at the size it was drawn. Never logged or saved. */
export const hostBrowserFrameSchema = z.object({ pageId: z.uuid(), data: z.string().min(1).max(HOST_BROWSER_FRAME_MAX), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).strict()
export type HostBrowserFrame = z.infer<typeof hostBrowserFrameSchema>
