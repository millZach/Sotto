import { z } from 'zod'
import { toolTargetSchema, type ToolsResult } from './tools'

/**
 * The cloud iPhone (ADR-0047): a run.cloud iOS simulator session one thread starts, after the user answers, to test
 * a native build. Everything outside the run.cloud adapter names a session by its Sotto ID and its thread, never by
 * run.cloud's own IDs, so another service could replace it.
 */
export const CLOUD_IPHONE_CHANNEL = 'sotto:cloud-iphone:'
export const CLOUD_IPHONE_EVENT = `${CLOUD_IPHONE_CHANNEL}event`

/** What a session costs, as the request says it. */
export const CLOUD_IPHONE_PRICE_PER_MINUTE_USD = 0.02
/** How long a session's request waits for the user before it lapses, as a browser request does. */
export const CLOUD_IPHONE_REQUEST_MS = 5 * 60_000
/** The largest build Sotto uploads. run.cloud names no limit; this keeps a wrong path from sending a disk image. */
export const CLOUD_IPHONE_MAX_BUILD_BYTES = 2 * 1024 ** 3
/** The builds a simulator can run: an `.app` folder zipped or tarred, or a simulator `.ipa`. */
export const CLOUD_IPHONE_BUILD_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.ipa'] as const

/**
 * - `asking`: waiting for the user's Start or Deny; nothing has been uploaded.
 * - `starting`: the user pressed Start; the build is uploading and the simulator starting.
 * - `active`: running and billed; the agent and the user can use it.
 * - `ended`: released, by the agent, the user, the idle time, the cap, the thread going or Sotto quitting.
 * - `denied`: the user said no, or the request lapsed.
 * - `refused`: Sotto would not ask, because the month's minutes are used or no key is saved.
 * - `failed`: the upload or the start did not work.
 */
export const cloudSessionStatusSchema = z.enum(['asking', 'starting', 'active', 'ended', 'denied', 'refused', 'failed'])
export type CloudSessionStatus = z.infer<typeof cloudSessionStatusSchema>
/** Why a session ended, in a word the UI turns into a sentence. */
export const cloudEndReasonSchema = z.enum(['finished', 'user', 'idle', 'cap', 'thread', 'quit', 'lost'])

export const cloudStepSchema = z.object({
  id: z.string(), action: z.string().max(40), status: z.enum(['completed', 'failed']), at: z.number(), detail: z.string().max(2000),
}).strict()

export const cloudSessionSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), workspaceId: z.string(),
  status: cloudSessionStatusSchema,
  /** What the agent said it will check. */
  description: z.string().max(300),
  /** The build's path inside the thread's working copy, as the agent gave it, and its size. */
  buildPath: z.string().max(4096), buildBytes: z.number().int().nonnegative(),
  /** The simulator, once run.cloud says which: "iPhone 16 · iOS 18.2". */
  device: z.string().max(200).nullable(),
  /** When the request lapses while `asking`. */
  expiresAt: z.number().nullable(),
  startedAt: z.number().nullable(), endedAt: z.number().nullable(),
  endReason: cloudEndReasonSchema.nullable(),
  /** Whole minutes billed so far, rounded up as run.cloud bills them. */
  minutes: z.number().int().nonnegative(),
  /** Plain words for a refusal or failure: what happened, whether anything was uploaded, what to do next. */
  problem: z.string().max(2000).nullable(),
  steps: z.array(cloudStepSchema).max(60),
  summary: z.string().max(2000).nullable(), unchecked: z.array(z.string().max(500)).max(20),
}).strict()
export type CloudSession = z.infer<typeof cloudSessionSchema>

/** Settings > Cloud iPhone: whether a key is saved, this month's minutes against the cap, and recent sessions. */
export const cloudIphoneStatusSchema = z.object({
  keySaved: z.boolean(),
  /** `YYYY-MM`, in the computer's own time zone. */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  monthMinutes: z.number().int().nonnegative(),
  capMinutes: z.number().int().positive(),
  recent: z.array(z.object({ threadId: z.string(), threadTitle: z.string().max(300), startedAt: z.number(), minutes: z.number().int().nonnegative() }).strict()).max(20),
}).strict()
export type CloudIphoneStatus = z.infer<typeof cloudIphoneStatusSchema>

export const cloudKeySchema = z.object({ value: z.string().max(16_384) }).strict()
/** The key check's answer: saved and accepted by run.cloud, or why not. A rejected key is not saved. */
export const cloudKeyResultSchema = z.object({ saved: z.boolean(), problem: z.string().max(2000).nullable() }).strict()

export const cloudSessionRequestSchema = toolTargetSchema.extend({ sessionId: z.string().uuid() })
/** The user's answer in the thread's card. Start covers this session and nothing after it (ADR-0047). */
export const cloudAnswerSchema = cloudSessionRequestSchema.extend({ allow: z.boolean() })
const boundsSchema = z.object({ x: z.number().finite().min(0).max(32768), y: z.number().finite().min(0).max(32768), width: z.number().finite().positive().max(32768), height: z.number().finite().positive().max(32768) }).strict()
/** Where the phone player draws the session's live view, or null to take it off the window. */
export const cloudMountSchema = cloudSessionRequestSchema.extend({ bounds: boundsSchema.nullable() })

/** The keys an agent can press, in run.cloud's names' plain form. */
export const CLOUD_KEYS = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const
/** The hardware buttons an agent can press. Lock is the power button. */
export const CLOUD_BUTTONS = ['home', 'appSwitcher', 'lock', 'volumeUp', 'volumeDown'] as const
/** Coordinates are iOS points, as the accessibility tree gives them; Sotto turns them into run.cloud's fractions. */
const point = z.number().finite().min(0).max(4096)
export const cloudActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inspect') }).strict(),
  z.object({ type: z.literal('screenshot') }).strict(),
  z.object({ type: z.literal('tap'), x: point, y: point }).strict(),
  z.object({ type: z.literal('swipe'), x: point, y: point, toX: point, toY: point }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(CLOUD_KEYS) }).strict(),
  z.object({ type: z.literal('button'), button: z.enum(CLOUD_BUTTONS) }).strict(),
  z.object({ type: z.literal('openUrl'), url: z.string().min(1).max(4096) }).strict(),
])
export type CloudAction = z.infer<typeof cloudActionSchema>

/** The agent's requests. The thread comes from the tool endpoint's token, never from the agent. */
export const cloudAgentOpenSchema = toolTargetSchema.extend({ buildPath: z.string().min(1).max(4096), description: z.string().min(1).max(300) })
export const cloudAgentActionSchema = toolTargetSchema.extend({ action: cloudActionSchema })
export const cloudAgentFinishSchema = toolTargetSchema.extend({ status: z.enum(['completed', 'failed']), summary: z.string().max(2000), unchecked: z.array(z.string().max(500)).max(20) })
/** What an agent's call returns: the session as it stands, a text observation, and a PNG data URL for a screenshot. */
export const cloudAgentResultSchema = z.object({ session: cloudSessionSchema, output: z.string().max(200_000).optional(), image: z.string().max(16_000_000).optional() }).strict()
export type CloudAgentResult = z.infer<typeof cloudAgentResultSchema>

export const cloudEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), session: cloudSessionSchema }).strict(),
  z.object({ type: z.literal('status'), status: cloudIphoneStatusSchema }).strict(),
])
export type CloudEvent = z.infer<typeof cloudEventSchema>

/** `window.sotto.cloudIphone`: the main window's view of cloud sessions. It never carries the key or the viewer's URL. */
export interface CloudIphoneBridge {
  status(): Promise<ToolsResult<CloudIphoneStatus>>
  /** Checks the key with run.cloud and saves it only if accepted. An empty value removes the saved key. */
  setKey(request: z.infer<typeof cloudKeySchema>): Promise<ToolsResult<z.infer<typeof cloudKeyResultSchema>>>
  sessions(request: { threadId: string }): Promise<ToolsResult<CloudSession[]>>
  answer(request: z.infer<typeof cloudAnswerSchema>): Promise<ToolsResult<CloudSession>>
  /** The user's End session. */
  end(request: z.infer<typeof cloudSessionRequestSchema>): Promise<ToolsResult<CloudSession>>
  mount(request: z.infer<typeof cloudMountSchema>): Promise<ToolsResult<void>>
  onEvent(listener: (event: CloudEvent) => void): () => void
}
