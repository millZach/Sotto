import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema } from './agents'
import { watcherGroupSchema, WATCHER_GROUPS } from './watcherOverview'

export const WATCHER_PROMPT_BYTES_MAX = 32 * 1_024
export const WATCHER_READ_BYTES_MAX = 64 * 1_024
export const WATCHER_TITLE_MAX = 512
export const WATCHER_ROSTER_MAX = 100
export const WATCHER_MESSAGES_MAX = 50
export const WATCHER_TOOL_CALLS_MAX = 8
export const WATCHER_PROMPTS_PER_THREAD = 4
export const WATCHER_IN_FLIGHT_DEFAULT = 4

const id = z.string().min(1).max(512)
const entityId = z.string().min(1).max(6_144)
const time = z.string().datetime()
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const shortText = z.string().max(2_000)
const cursor = z.string().min(1).max(2_048)
const utf8 = (max: number) => z.string().max(max).refine(value => new TextEncoder().encode(value).byteLength <= max, 'Text exceeds the byte limit.')
const prompt = utf8(WATCHER_PROMPT_BYTES_MAX).refine(value => value.trim().length > 0, 'A prompt is required.')
export const watcherProviderSchema = z.enum(['codex', 'claude', 'grok'])
export const watcherThreadTargetSchema = z.object({ hostId: z.uuid(), threadId: id }).strict()
export const watcherProjectTargetSchema = z.object({ hostId: z.uuid(), projectId: entityId }).strict()
export type WatcherThreadTarget = z.infer<typeof watcherThreadTargetSchema>
export type WatcherProjectTarget = z.infer<typeof watcherProjectTargetSchema>
export const watcherPositionSchema = z.object({ historyEpoch: id, afterPosition: counter }).strict()
const permission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('runtime'), mode: agentRuntimeModeSchema }).strict(),
  z.object({ kind: z.literal('provider'), choiceId: entityId }).strict(),
])
const workingCopy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shared') }).strict(),
  z.object({ kind: z.literal('new-worktree') }).strict(),
  z.object({ kind: z.literal('existing-worktree'), choiceId: id }).strict(),
])
const choices = z.object({ modelId: entityId, reasoningEffort: z.string().min(1).max(64).nullable(), permission, workingCopy, baseRefChoiceId: id.optional() }).strict()

export const WATCHER_REFUSAL_CODES = [
  'NOT_CURRENT_WATCHER', 'REQUEST_NOT_ACTIVE', 'UNKNOWN_TARGET', 'HOST_DISCONNECTED', 'HOST_FEATURE_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE', 'READ_ONLY_PROFILE_UNAVAILABLE', 'INVALID_INPUT', 'RETRY_KEY_CONFLICT', 'THREAD_TAKEN_OVER',
  'PENDING_USER_REQUEST', 'TARGET_CHANGED', 'DELIVERY_UNCERTAIN', 'IN_FLIGHT_LIMIT', 'PROMPT_LIMIT', 'PERMISSION_TOO_WIDE',
  'PERMISSION_NOT_COMPARABLE', 'RESERVED_THREAD', 'CURSOR_EXPIRED', 'HISTORY_RESET', 'HISTORY_UNAVAILABLE',
  'WORKING_COPY_UNAVAILABLE', 'WORKING_COPY_CHANGED', 'THREAD_BUSY', 'STEER_UNAVAILABLE', 'TURN_CHANGED',
  'BACKGROUND_WORK_RUNNING', 'PATH_OUTSIDE_PROJECT', 'UNSAFE_PATH', 'SENSITIVE_FILE', 'SCAN_LIMIT', 'SEARCH_TOO_BROAD',
  'BINARY_FILE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'UNKNOWN_OPERATION',
] as const
export const watcherRefusalCodeSchema = z.enum(WATCHER_REFUSAL_CODES)
export const watcherDeliveryStateSchema = z.enum(['queued', 'dispatching', 'accepted', 'failed', 'uncertain'])
export const watcherLimitsSchema = z.object({ inFlight: counter, inFlightLimit: z.number().int().min(1).max(8),
  promptCount: z.number().int().min(0).max(WATCHER_PROMPTS_PER_THREAD), promptLimit: z.literal(WATCHER_PROMPTS_PER_THREAD) }).strict()
export const watcherDeliveryReceiptSchema = z.object({ operationId: z.uuid(), target: watcherThreadTargetSchema,
  requestId: z.uuid(), deliveryState: watcherDeliveryStateSchema, receiptId: id, cardId: id,
  draftId: z.uuid().optional(), messageId: id.optional(), itemId: id.optional() }).strict()
export const watcherRefusalSchema = z.object({ status: z.literal('refused'), code: watcherRefusalCodeSchema,
  message: shortText.min(1), retryable: z.boolean(), receipt: watcherDeliveryReceiptSchema.optional(),
  restartCursor: cursor.optional(), historyCursor: watcherPositionSchema.optional() }).strict()
export type WatcherRefusal = z.infer<typeof watcherRefusalSchema>

const freshness = z.enum(['fresh', 'stale', 'unknown'])
const availability = z.enum(['available', 'unavailable', 'unsupported'])
const pending = z.object({ id, kind: z.enum(['question', 'permission']), label: shortText,
  openTarget: watcherThreadTargetSchema }).strict()
/** Evidence is sourced data. A worker's words remain messages, never an evidence source. */
export const watcherEvidenceSchema = z.object({ id, source: z.enum(['sotto-delivery', 'sotto-takeover', 'native-turn', 'github', 'checkpoint', 'working-copy']),
  observedAt: time, target: watcherThreadTargetSchema, freshness, availability,
  turnId: id.optional(), headId: id.optional(), checkpointId: id.optional(), referenceId: id.optional(),
  fact: z.enum(['turn-finished', 'turn-failed', 'checks-passed', 'checks-failed', 'review-approved', 'merge-observed', 'auto-merge-observed', 'landing-action', 'files-changed', 'delivery-changed', 'taken-over']),
  changedFiles: counter.optional(), insertions: counter.optional(), deletions: counter.optional() }).strict()
const takeover = z.object({ reason: z.enum(['user-send', 'native-user-send', 'user-stop', 'user-settle', 'user-reconfigure']), at: time }).strict()
const participation = z.object({ requestId: z.uuid(), startedBy: z.enum(['watcher', 'user']), generation: counter,
  state: z.enum(['participating', 'taken-over', 'relinquished']), takeover: takeover.optional() }).strict()
const pr = z.object({ number: z.number().int().positive(), url: z.string().max(2_048), title: z.string().max(512),
  state: z.enum(['open', 'closed', 'merged']), draft: z.boolean() }).strict()
const row = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX), projectId: entityId,
  provider: providerIdSchema, modelId: entityId, reasoningEffort: z.string().max(64).optional(), status: z.enum(['idle', 'running', 'error']),
  group: watcherGroupSchema, waitsOn: z.array(pending).max(100), branch: z.string().max(512).nullable(),
  workingCopy: workingCopy.nullable(), pullRequests: z.array(pr).max(50), evidence: z.array(watcherEvidenceSchema).max(100),
  lastActivityAt: time.nullable(), observedAt: time.nullable(), connected: z.boolean(), freshness,
  userReadAt: time.nullable(), watcherReadAt: time.nullable(), participation: z.array(participation).max(100), protected: z.boolean() }).strict()
const staleHost = z.object({ hostId: z.uuid(), observedAt: time.nullable() }).strict()
const counts = z.object(Object.fromEntries(WATCHER_GROUPS.map(group => [group, counter])) as Record<typeof WATCHER_GROUPS[number], typeof counter>).strict()
const paging = { cursor: cursor.optional(), limit: z.number().int().min(1).max(WATCHER_ROSTER_MAX).default(WATCHER_ROSTER_MAX) }
const page = { nextCursor: cursor.nullable(), observedAt: time, staleHosts: z.array(staleHost).max(100) }
const mutation = { requestId: z.uuid(), retryKey: z.uuid() }
const deliveryMode = z.enum(['now', 'queue', 'steer'])
const operationState = z.object({ status: z.enum(['idle', 'running', 'error', 'unavailable']), stopped: z.boolean(), settled: z.boolean(),
  backgroundWorkCount: counter, observedAt: time.nullable(), freshness }).strict()
const receiptResult = { receipt: watcherDeliveryReceiptSchema, limits: watcherLimitsSchema }
const result = <S extends z.ZodRawShape>(shape: S) => z.union([z.object({ status: z.literal('ok'), ...shape }).strict(), watcherRefusalSchema])
const boundedRead = <S extends z.ZodType>(schema: S) => schema.refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= WATCHER_READ_BYTES_MAX, 'Response exceeds the byte limit.')

/** Only these named operations can cross the future sotto_threads boundary. None serve tools yet. */
export const watcherToolSchemas = {
  list_threads: {
    input: z.object({ hostId: z.uuid().optional(), project: watcherProjectTargetSchema.optional(), group: watcherGroupSchema.optional(),
      includeSettled: z.boolean().default(true), ...paging }).strict(),
    output: result({ rows: z.array(row).max(100), snapshotRevision: cursor, counts, ...page }),
  },
  read_thread: {
    input: z.object({ target: watcherThreadTargetSchema, position: watcherPositionSchema.optional(),
      limit: z.number().int().min(1).max(WATCHER_MESSAGES_MAX).default(WATCHER_MESSAGES_MAX), includeActivities: z.boolean().default(false) }).strict(),
    output: boundedRead(result({ target: watcherThreadTargetSchema, messages: z.array(z.object({ id, position: counter, role: z.enum(['user', 'assistant']),
      text: utf8(WATCHER_READ_BYTES_MAX), createdAt: time }).strict()).max(WATCHER_MESSAGES_MAX), waitsOn: z.array(pending).max(100),
      activities: z.array(z.object({ id, kind: z.enum(['turn', 'command', 'file-change', 'tool', 'reasoning', 'plan', 'subagent', 'status', 'compaction']),
        status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']), title: shortText, startedAt: time.optional(), completedAt: time.optional() }).strict()).max(100),
      evidence: z.array(watcherEvidenceSchema).max(100), historyEpoch: id, firstPosition: counter.nullable(), lastPosition: counter.nullable(),
      nextPosition: counter.nullable(), truncated: z.boolean(), earlierAvailable: z.boolean(), observedAt: time })),
  },
  start_thread: {
    input: z.object({ ...mutation, project: watcherProjectTargetSchema, modelId: entityId, reasoningEffort: z.string().min(1).max(64).optional(),
      permission: permission.optional(), workingCopy, baseRefChoiceId: id.optional(), title: z.string().min(1).max(WATCHER_TITLE_MAX), firstPrompt: prompt }).strict(),
    output: result({ ...receiptResult, target: watcherThreadTargetSchema, effectiveChoices: choices, creationReceiptId: id, firstPromptReceiptId: id }),
  },
  send_to_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema, text: prompt, delivery: deliveryMode,
      expectedLastUserMessageId: id.optional(), expectedTurnId: id.optional() }).strict(),
    output: result({ ...receiptResult, delivery: deliveryMode }),
  },
  stop_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, stopRequested: z.boolean(), state: operationState }),
  },
  settle_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, state: operationState }),
  },
  list_projects: {
    input: z.object({ hostId: z.uuid().optional(), ...paging }).strict(),
    output: result({ projects: z.array(z.object({ target: watcherProjectTargetSchema, title: z.string().max(512), displayRoot: z.string().max(4_096),
      workers: z.array(z.object({ provider: providerIdSchema, modelId: entityId, reasoningEfforts: z.array(z.string().max(64)).max(20),
        defaultPermission: permission.nullable(), permissionComparable: z.boolean() }).strict()).max(100),
      controlAvailable: z.boolean(), readsAvailable: z.boolean(), readOnlyProfileAvailable: z.boolean(), freshness }).strict()).max(100), ...page }),
  },
  list_working_copies: {
    input: z.object({ project: watcherProjectTargetSchema, ...paging }).strict(),
    output: result({ project: watcherProjectTargetSchema, revision: cursor, choices: z.array(z.object({ choiceId: id,
      kind: z.enum(['shared', 'new-worktree', 'existing-worktree']), branch: z.string().max(512).nullable(), occupied: z.boolean(), locked: z.boolean(),
      limitations: z.array(shortText).max(20) }).strict()).max(100), baseRefs: z.array(z.object({ choiceId: id, name: z.string().max(512) }).strict()).max(100), ...page }),
  },
  read_operation: {
    input: z.object({ operationId: z.uuid() }).strict(),
    output: result({ ...receiptResult, action: z.enum(['start', 'send', 'stop', 'settle']), state: operationState }),
  },
} as const
export type WatcherToolName = keyof typeof watcherToolSchemas
export type WatcherToolInput<N extends WatcherToolName> = z.infer<(typeof watcherToolSchemas)[N]['input']>
export type WatcherToolOutput<N extends WatcherToolName> = z.infer<(typeof watcherToolSchemas)[N]['output']>

/** Control records carry references only; prose belongs to the history-aware message/queue store. */
export const watcherIdentitySchema = z.object({ target: watcherThreadTargetSchema, projectId: entityId,
  provider: watcherProviderSchema, creationOperationId: z.uuid(), createdAt: time }).strict()
export const watcherParticipantSchema = participation.extend({ target: watcherThreadTargetSchema,
  promptCount: z.number().int().min(0).max(WATCHER_PROMPTS_PER_THREAD) }).strict()
export const watcherRequestSchema = z.object({ id: z.uuid(), watcher: watcherThreadTargetSchema, rootUserMessageId: id,
  state: z.enum(['active', 'stopped', 'closed']), createdAt: time, closedAt: time.nullable(),
  participants: z.array(watcherParticipantSchema).max(1_000) }).strict()
export const watcherOperationSchema = z.object({ id: z.uuid(), requestId: z.uuid(), retryKey: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.enum(['start', 'send', 'stop', 'settle']), target: watcherThreadTargetSchema, generation: counter,
  delivery: deliveryMode.optional(), deliveryState: watcherDeliveryStateSchema, createdAt: time, updatedAt: time,
  receiptId: id, cardId: id, creationReceiptId: id.optional(), firstPromptReceiptId: id.optional(), commandId: id.optional(),
  draftId: z.uuid().optional(), messageId: id.optional(), itemId: id.optional(), anchorMessageId: id.optional(), toolCallId: id.optional(),
  refusalCode: watcherRefusalCodeSchema.optional() }).strict()
export const watcherRecordSchema = z.object({ version: z.literal(1), current: watcherIdentitySchema.nullable(),
  creation: z.object({ identity: watcherIdentitySchema, phase: z.enum(['intent', 'created', 'bound', 'ready']),
    replaces: watcherThreadTargetSchema.nullable() }).strict().nullable(),
  history: z.array(watcherIdentitySchema).max(1_000), requests: z.array(watcherRequestSchema).max(10_000),
  operations: z.array(watcherOperationSchema).max(40_000),
  reservations: z.array(z.object({ target: watcherThreadTargetSchema, requestId: z.uuid(), operationId: z.uuid(), generation: counter,
    reason: z.enum(['creation', 'active-turn', 'background-work', 'queued', 'dispatching', 'uncertain', 'needs-user']) }).strict()).max(8),
  reads: z.array(z.object({ target: watcherThreadTargetSchema, position: watcherPositionSchema, readAt: time,
    lastWakeEventId: id.optional() }).strict()).max(10_000),
}).strict().superRefine((record, context) => {
  const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
  const unique = (values: string[]) => new Set(values).size === values.length
  if (!unique(record.requests.map(request => request.id)) || !unique(record.operations.map(operation => operation.id))
    || !unique(record.requests.map(request => JSON.stringify([key(request.watcher), request.rootUserMessageId])))
    || !unique(record.operations.map(operation => `${operation.requestId}:${operation.retryKey}`))
    || !unique(record.history.map(identity => key(identity.target))) || !unique(record.reservations.map(reservation => key(reservation.target)))
    || record.history.some(identity => record.current && key(identity.target) === key(record.current.target))) {
    context.addIssue({ code: 'custom', message: 'watcher identities must be unique.' })
  }
  if (record.creation) {
    // A replacement intent keeps the old current reference until the atomic handover can finish.
    const { identity, replaces } = record.creation
    const conflict = replaces ? !record.current || key(replaces) !== key(record.current.target) || key(identity.target) === key(replaces)
      : record.current && JSON.stringify(record.current) !== JSON.stringify(identity)
    if (conflict || record.history.some(previous => key(previous.target) === key(identity.target))) {
      context.addIssue({ code: 'custom', message: 'Creation must preserve the current watcher identity.' })
    }
  }
  if (record.requests.some(request => (request.state === 'active') !== (request.closedAt === null)
    || !unique(request.participants.map(participant => key(participant.target)))
    || request.participants.some(participant => participant.requestId !== request.id
      || (participant.state === 'taken-over') !== (participant.takeover !== undefined)))) {
    context.addIssue({ code: 'custom', message: 'Request state and participation must agree with their retained fences.' })
  }
  const requests = new Set(record.requests.map(request => request.id))
  const operations = new Set(record.operations.map(operation => operation.id))
  if (record.operations.some(operation => !requests.has(operation.requestId))
    || record.reservations.some(reservation => !requests.has(reservation.requestId) || !operations.has(reservation.operationId))) {
    context.addIssue({ code: 'custom', message: 'Control references must name retained requests and operations.' })
  }
})
export type WatcherIdentity = z.infer<typeof watcherIdentitySchema>
export type WatcherRequest = z.infer<typeof watcherRequestSchema>
export type WatcherOperation = z.infer<typeof watcherOperationSchema>
export type WatcherRecord = z.infer<typeof watcherRecordSchema>
export function emptyWatcherRecord(): WatcherRecord {
  return { version: 1, current: null, creation: null, history: [], requests: [], operations: [], reservations: [], reads: [] }
}
