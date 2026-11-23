import { z } from 'zod'
import { type AgentThread } from './agents'
import { isThreadClosed, isUnsentThread } from './threadActivity'
import { WATCHER_OUTCOMES, WATCHER_REPLY_BYTES_MAX, watcherOutcomeSchema, type WatcherOutcome } from './watcher'

/**
 * Parent-to-parent thread coordination (ADR-0216): an eligible top-level parent thread discovers, reads,
 * and messages other eligible parent threads through the scoped `sotto_coordinate` MCP server.
 * All Zod schemas live at module scope so no call builds a parser at runtime (`zodSchemaSites.test.ts`).
 */
export const COORDINATE_MCP_SERVER = 'sotto_coordinate'
export const COORDINATE_LIST_THREADS_TOOL = 'list_threads'
export const COORDINATE_READ_THREAD_TOOL = 'read_thread'
export const COORDINATE_SEND_TOOL = 'send_to_thread'
export const COORDINATE_READ_EXCHANGE_TOOL = 'read_exchange'

/** Longest peer message body a thread may send, in characters. */
export const COORDINATION_MESSAGE_MAX = 16_000
/** Maximum UTF-8 bytes of message text returned in one `read_thread` call. */
export const COORDINATION_READ_BYTES_MAX = 24_000
/** Maximum UTF-8 bytes of a target thread's reply included in `read_exchange` or a reply wake-up. */
export const COORDINATION_REPLY_BYTES_MAX = WATCHER_REPLY_BYTES_MAX
/** Anti-ping-pong cap: maximum automated peer hops in one causal chain before a fresh user message is required. */
export const COORDINATION_HOP_MAX = 6
/** Maximum peer sends from one thread to the same target thread per turn root. */
export const COORDINATION_PROMPTS_PER_TARGET = 4
/** Maximum peer sends from one thread across all peers within `COORDINATION_RATE_WINDOW_MS`. */
export const COORDINATION_RATE_LIMIT = 6
export const COORDINATION_RATE_WINDOW_MS = 10 * 60_000
/** Longest blocking wait inside `send_to_thread`, in seconds. */
export const COORDINATION_WAIT_MAX_SECONDS = 300
export const COORDINATION_LIST_LIMIT_DEFAULT = 20
export const COORDINATION_LIST_LIMIT_MAX = 50
export const COORDINATION_READ_LIMIT_DEFAULT = 20
export const COORDINATION_READ_LIMIT_MAX = 50
export const COORDINATION_NEWS_MAX = 50

const id = z.string().min(1).max(512)

export const coordinateListThreadsInputSchema = z.object({
  project: z.string().min(1).max(512).optional().describe('Which project to list: "same" (default, this thread\'s project), "all" (every project on this machine), or a specific projectId.'),
  includeSettled: z.boolean().optional().describe('Include settled parent threads. False when left out.'),
  query: z.string().trim().min(1).max(200).optional().describe('Filter by text in the thread title or branch name.'),
  status: z.enum(['idle', 'running', 'needs-you', 'error']).optional().describe('Filter by current thread status.'),
  limit: z.number().int().min(1).max(COORDINATION_LIST_LIMIT_MAX).optional().describe(`Maximum threads to return (1 to ${COORDINATION_LIST_LIMIT_MAX}, default ${COORDINATION_LIST_LIMIT_DEFAULT}).`),
  cursor: z.number().int().min(0).max(100_000).optional().describe('Pagination offset from a previous list_threads call\'s nextCursor.'),
}).strict()
export type CoordinateListThreadsInput = z.infer<typeof coordinateListThreadsInputSchema>

export const coordinateReadThreadInputSchema = z.object({
  threadId: id.describe('The Sotto thread ID of the parent thread to read, from list_threads.'),
  view: z.enum(['messages', 'summary']).optional().describe('"messages" (default) returns metadata and recent messages; "summary" returns metadata and status only.'),
  beforePosition: z.number().int().min(0).max(1_000_000).optional().describe('Read messages older than this zero-based position (from earlierPosition).'),
  afterPosition: z.number().int().min(-1).max(1_000_000).optional().describe('Read messages newer than this zero-based position (-1 starts from the oldest message).'),
  limit: z.number().int().min(1).max(COORDINATION_READ_LIMIT_MAX).optional().describe(`Maximum messages to return (1 to ${COORDINATION_READ_LIMIT_MAX}, default ${COORDINATION_READ_LIMIT_DEFAULT}).`),
}).strict()
export type CoordinateReadThreadInput = z.infer<typeof coordinateReadThreadInputSchema>

export const coordinationDeliveryRequestSchema = z.enum(['queue', 'steer', 'auto'])
export type CoordinationDeliveryRequest = z.infer<typeof coordinationDeliveryRequestSchema>

export const coordinateSendInputSchema = z.object({
  threadId: id.describe('The Sotto thread ID of the target parent thread, from list_threads.'),
  message: z.string().trim().min(1).max(COORDINATION_MESSAGE_MAX).describe('Plain-text coordination message for the target parent thread. Cannot be a slash command.'),
  delivery: coordinationDeliveryRequestSchema.optional().describe('"queue" (default: starts idle thread or queues after a running turn), "steer" (mid-turn steer if supported, else queues), or "auto" (starts idle or queues).'),
  expect_reply: z.boolean().optional().describe('When true (default), Sotto tracks the target\'s turn and wakes this thread with its reply once done.'),
  wait_seconds: z.number().int().min(0).max(COORDINATION_WAIT_MAX_SECONDS).optional().describe(`Seconds to wait in this call for the target to finish (0 to ${COORDINATION_WAIT_MAX_SECONDS}, default 0). When 0 or when the wait ends first, Sotto wakes this thread when the target finishes.`),
  retry_key: z.uuid().optional().describe('A UUID of your own. Calling again with the same key returns the original exchange receipt without sending twice.'),
}).strict()
export type CoordinateSendInput = z.infer<typeof coordinateSendInputSchema>

export const coordinateReadExchangeInputSchema = z.object({
  exchangeId: z.uuid().optional().describe('The exchange ID returned by send_to_thread. Leave out to list this thread\'s recent exchanges and remaining budgets.'),
}).strict()
export type CoordinateReadExchangeInput = z.infer<typeof coordinateReadExchangeInputSchema>

export const coordinationDeliverySchema = z.enum(['started', 'queued', 'steered'])
export type CoordinationDelivery = z.infer<typeof coordinationDeliverySchema>

export const coordinationRefusalCodeSchema = z.enum([
  'INVALID_INPUT',
  'NOT_ADMITTED',
  'UNKNOWN_THREAD',
  'SELF_TARGET',
  'INELIGIBLE_TARGET',
  'THREAD_CLOSED',
  'PROVIDER_UNAVAILABLE',
  'PERMISSION_NOT_COMPARABLE',
  'PERMISSION_TOO_WIDE',
  'SLASH_COMMAND_FORBIDDEN',
  'LOOP_LIMIT',
  'PROMPT_LIMIT',
  'RATE_LIMIT',
  'PENDING_USER_REQUEST',
  'QUEUE_HELD',
  'USER_TYPING',
  'TARGET_CHANGED',
  'RETRY_KEY_CONFLICT',
  'UNKNOWN_EXCHANGE',
  'STOPPING',
  'PAUSED',
])
export type CoordinationRefusalCode = z.infer<typeof coordinationRefusalCodeSchema>

export interface CoordinationRefusal {
  readonly status: 'refused'
  readonly code: CoordinationRefusalCode
  readonly message: string
}

export const COORDINATION_OUTCOMES = WATCHER_OUTCOMES
export const coordinationOutcomeSchema = watcherOutcomeSchema
export type CoordinationOutcome = WatcherOutcome

/** News of a peer parent-thread exchange kept in the follow-up queue: identities and outcome only, never prose. */
export const coordinationNewsSchema = z.object({
  source: z.literal('coordination'),
  items: z.array(z.object({
    exchangeId: z.uuid(),
    threadId: id,
    outcome: coordinationOutcomeSchema,
    turnMessageId: id.optional(),
  }).strict()).min(1).max(COORDINATION_NEWS_MAX),
}).strict()
export type CoordinationNews = z.infer<typeof coordinationNewsSchema>

/** RE2-safe check for slash commands (`/compact`, `/logout`, etc.), which peer sends may never run (ADR-0216). */
const SLASH_COMMAND_PATTERN = /^\/[a-zA-Z][\w-]*(?:\s|$)/u
export function isCoordinationSlashCommand(text: string): boolean {
  return SLASH_COMMAND_PATTERN.test(text.trimStart())
}

/**
 * Whether a thread is an eligible local top-level parent thread for Slice 1 parent-to-parent coordination (ADR-0216).
 * Excludes Watcher, Watcher history, owlets, Council judges, delegated child threads, remote-host threads,
 * archived threads, and unsent threads.
 */
export function isEligibleParentThread(thread: AgentThread): boolean {
  const unsent = isUnsentThread(thread)
    || (thread.nativeSessionStarted === false && (thread.summary?.messageCount ?? thread.messages.length) === 0)
  return (thread.kind ?? 'project') === 'project'
    && thread.delegatedBy === undefined
    && thread.owlet === undefined
    && thread.councilJudge !== true
    && thread.remoteHost !== true
    && !isThreadClosed(thread)
    && !unsent
}
