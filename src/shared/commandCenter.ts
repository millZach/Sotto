import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema } from './agents'
import { commandCenterGroupSchema, COMMAND_CENTER_GROUPS } from './commandCenterOverview'

export const COMMAND_CENTER_PROMPT_BYTES_MAX = 32 * 1_024
export const COMMAND_CENTER_READ_BYTES_MAX = 64 * 1_024
export const COMMAND_CENTER_TITLE_MAX = 512
export const COMMAND_CENTER_ROSTER_MAX = 100
export const COMMAND_CENTER_MESSAGES_MAX = 50
export const COMMAND_CENTER_TOOL_CALLS_MAX = 8
export const COMMAND_CENTER_PROMPTS_PER_THREAD = 4
export const COMMAND_CENTER_IN_FLIGHT_DEFAULT = 4

const id = z.string().min(1).max(512)
const entityId = z.string().min(1).max(6_144)
const time = z.string().datetime()
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const shortText = z.string().max(2_000)
const cursor = z.string().min(1).max(2_048)
const utf8 = (max: number) => z.string().max(max).refine(value => new TextEncoder().encode(value).byteLength <= max, 'Text exceeds the byte limit.')
const prompt = utf8(COMMAND_CENTER_PROMPT_BYTES_MAX).refine(value => value.trim().length > 0, 'A prompt is required.')
export const commandCenterProviderSchema = z.enum(['codex', 'claude', 'grok'])
export const commandCenterThreadTargetSchema = z.object({ hostId: z.uuid(), threadId: id }).strict()
export const commandCenterProjectTargetSchema = z.object({ hostId: z.uuid(), projectId: entityId }).strict()
export type CommandCenterThreadTarget = z.infer<typeof commandCenterThreadTargetSchema>
export type CommandCenterProjectTarget = z.infer<typeof commandCenterProjectTargetSchema>
export const commandCenterPositionSchema = z.object({ historyEpoch: id, afterPosition: counter }).strict()
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

export const COMMAND_CENTER_REFUSAL_CODES = [
  'NOT_CURRENT_COMMAND_CENTER', 'REQUEST_NOT_ACTIVE', 'UNKNOWN_TARGET', 'HOST_DISCONNECTED', 'HOST_FEATURE_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE', 'READ_ONLY_PROFILE_UNAVAILABLE', 'INVALID_INPUT', 'RETRY_KEY_CONFLICT', 'THREAD_TAKEN_OVER',
  'PENDING_USER_REQUEST', 'TARGET_CHANGED', 'DELIVERY_UNCERTAIN', 'IN_FLIGHT_LIMIT', 'PROMPT_LIMIT', 'PERMISSION_TOO_WIDE',
  'PERMISSION_NOT_COMPARABLE', 'RESERVED_THREAD', 'CURSOR_EXPIRED', 'HISTORY_RESET', 'HISTORY_UNAVAILABLE',
  'WORKING_COPY_UNAVAILABLE', 'WORKING_COPY_CHANGED', 'THREAD_BUSY', 'STEER_UNAVAILABLE', 'TURN_CHANGED',
  'BACKGROUND_WORK_RUNNING', 'PATH_OUTSIDE_PROJECT', 'UNSAFE_PATH', 'SENSITIVE_FILE', 'SCAN_LIMIT', 'SEARCH_TOO_BROAD',
  'BINARY_FILE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'UNKNOWN_OPERATION',
] as const
export const commandCenterRefusalCodeSchema = z.enum(COMMAND_CENTER_REFUSAL_CODES)
export const commandCenterDeliveryStateSchema = z.enum(['queued', 'dispatching', 'accepted', 'failed', 'uncertain'])
export const commandCenterLimitsSchema = z.object({ inFlight: counter, inFlightLimit: z.number().int().min(1).max(8),
  promptCount: z.number().int().min(0).max(COMMAND_CENTER_PROMPTS_PER_THREAD), promptLimit: z.literal(COMMAND_CENTER_PROMPTS_PER_THREAD) }).strict()
export const commandCenterDeliveryReceiptSchema = z.object({ operationId: z.uuid(), target: commandCenterThreadTargetSchema,
  requestId: z.uuid(), deliveryState: commandCenterDeliveryStateSchema, receiptId: id, cardId: id,
  draftId: z.uuid().optional(), messageId: id.optional(), itemId: id.optional() }).strict()
export const commandCenterRefusalSchema = z.object({ status: z.literal('refused'), code: commandCenterRefusalCodeSchema,
  message: shortText.min(1), retryable: z.boolean(), receipt: commandCenterDeliveryReceiptSchema.optional(),
  restartCursor: cursor.optional(), historyCursor: commandCenterPositionSchema.optional() }).strict()
export type CommandCenterRefusal = z.infer<typeof commandCenterRefusalSchema>

const freshness = z.enum(['fresh', 'stale', 'unknown'])
const availability = z.enum(['available', 'unavailable', 'unsupported'])
const pending = z.object({ id, kind: z.enum(['question', 'permission']), label: shortText,
  openTarget: commandCenterThreadTargetSchema }).strict()
/** Evidence is sourced data. A worker's words remain messages, never an evidence source. */
export const commandCenterEvidenceSchema = z.object({ id, source: z.enum(['sotto-delivery', 'sotto-takeover', 'native-turn', 'github', 'checkpoint', 'working-copy']),
  observedAt: time, target: commandCenterThreadTargetSchema, freshness, availability,
  turnId: id.optional(), headId: id.optional(), checkpointId: id.optional(), referenceId: id.optional(),
  fact: z.enum(['turn-finished', 'turn-failed', 'checks-passed', 'checks-failed', 'review-approved', 'merge-observed', 'auto-merge-observed', 'landing-action', 'files-changed', 'delivery-changed', 'taken-over']),
  changedFiles: counter.optional(), insertions: counter.optional(), deletions: counter.optional() }).strict()
const takeover = z.object({ reason: z.enum(['user-send', 'native-user-send', 'user-stop', 'user-settle', 'user-reconfigure']), at: time }).strict()
const participation = z.object({ requestId: z.uuid(), startedBy: z.enum(['command-center', 'user']), generation: counter,
  state: z.enum(['participating', 'taken-over', 'relinquished']), takeover: takeover.optional() }).strict()
const pr = z.object({ number: z.number().int().positive(), url: z.string().max(2_048), title: z.string().max(512),
  state: z.enum(['open', 'closed', 'merged']), draft: z.boolean() }).strict()
const row = z.object({ target: commandCenterThreadTargetSchema, title: z.string().max(COMMAND_CENTER_TITLE_MAX), projectId: entityId,
  provider: providerIdSchema, modelId: entityId, reasoningEffort: z.string().max(64).optional(), status: z.enum(['idle', 'running', 'error']),
  group: commandCenterGroupSchema, waitsOn: z.array(pending).max(100), branch: z.string().max(512).nullable(),
  workingCopy: workingCopy.nullable(), pullRequests: z.array(pr).max(50), evidence: z.array(commandCenterEvidenceSchema).max(100),
  lastActivityAt: time.nullable(), observedAt: time.nullable(), connected: z.boolean(), freshness,
  userReadAt: time.nullable(), commandCenterReadAt: time.nullable(), participation: z.array(participation).max(100), protected: z.boolean() }).strict()
const staleHost = z.object({ hostId: z.uuid(), observedAt: time.nullable() }).strict()
const counts = z.object(Object.fromEntries(COMMAND_CENTER_GROUPS.map(group => [group, counter])) as Record<typeof COMMAND_CENTER_GROUPS[number], typeof counter>).strict()
const paging = { cursor: cursor.optional(), limit: z.number().int().min(1).max(COMMAND_CENTER_ROSTER_MAX).default(COMMAND_CENTER_ROSTER_MAX) }
const page = { nextCursor: cursor.nullable(), observedAt: time, staleHosts: z.array(staleHost).max(100) }
const mutation = { requestId: z.uuid(), retryKey: z.uuid() }
const deliveryMode = z.enum(['now', 'queue', 'steer'])
const operationState = z.object({ status: z.enum(['idle', 'running', 'error', 'unavailable']), stopped: z.boolean(), settled: z.boolean(),
  backgroundWorkCount: counter, observedAt: time.nullable(), freshness }).strict()
const receiptResult = { receipt: commandCenterDeliveryReceiptSchema, limits: commandCenterLimitsSchema }
const result = <S extends z.ZodRawShape>(shape: S) => z.union([z.object({ status: z.literal('ok'), ...shape }).strict(), commandCenterRefusalSchema])
const boundedRead = <S extends z.ZodType>(schema: S) => schema.refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= COMMAND_CENTER_READ_BYTES_MAX, 'Response exceeds the byte limit.')

/** Only these named operations can cross the future sotto_threads boundary. None serve tools yet. */
export const commandCenterToolSchemas = {
  list_threads: {
    input: z.object({ hostId: z.uuid().optional(), project: commandCenterProjectTargetSchema.optional(), group: commandCenterGroupSchema.optional(),
      includeSettled: z.boolean().default(true), ...paging }).strict(),
    output: result({ rows: z.array(row).max(100), snapshotRevision: cursor, counts, ...page }),
  },
  read_thread: {
    input: z.object({ target: commandCenterThreadTargetSchema, position: commandCenterPositionSchema.optional(),
      limit: z.number().int().min(1).max(COMMAND_CENTER_MESSAGES_MAX).default(COMMAND_CENTER_MESSAGES_MAX), includeActivities: z.boolean().default(false) }).strict(),
    output: boundedRead(result({ target: commandCenterThreadTargetSchema, messages: z.array(z.object({ id, position: counter, role: z.enum(['user', 'assistant']),
      text: utf8(COMMAND_CENTER_READ_BYTES_MAX), createdAt: time }).strict()).max(COMMAND_CENTER_MESSAGES_MAX), waitsOn: z.array(pending).max(100),
      activities: z.array(z.object({ id, kind: z.enum(['turn', 'command', 'file-change', 'tool', 'reasoning', 'plan', 'subagent', 'status', 'compaction']),
        status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']), title: shortText, startedAt: time.optional(), completedAt: time.optional() }).strict()).max(100),
      evidence: z.array(commandCenterEvidenceSchema).max(100), historyEpoch: id, firstPosition: counter.nullable(), lastPosition: counter.nullable(),
      nextPosition: counter.nullable(), truncated: z.boolean(), earlierAvailable: z.boolean(), observedAt: time })),
  },
  start_thread: {
    input: z.object({ ...mutation, project: commandCenterProjectTargetSchema, modelId: entityId, reasoningEffort: z.string().min(1).max(64).optional(),
      permission: permission.optional(), workingCopy, baseRefChoiceId: id.optional(), title: z.string().min(1).max(COMMAND_CENTER_TITLE_MAX), firstPrompt: prompt }).strict(),
    output: result({ ...receiptResult, target: commandCenterThreadTargetSchema, effectiveChoices: choices, creationReceiptId: id, firstPromptReceiptId: id }),
  },
  send_to_thread: {
    input: z.object({ ...mutation, target: commandCenterThreadTargetSchema, text: prompt, delivery: deliveryMode,
      expectedLastUserMessageId: id.optional(), expectedTurnId: id.optional() }).strict(),
    output: result({ ...receiptResult, delivery: deliveryMode }),
  },
  stop_thread: {
    input: z.object({ ...mutation, target: commandCenterThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, stopRequested: z.boolean(), state: operationState }),
  },
  settle_thread: {
    input: z.object({ ...mutation, target: commandCenterThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, state: operationState }),
  },
  list_projects: {
    input: z.object({ hostId: z.uuid().optional(), ...paging }).strict(),
    output: result({ projects: z.array(z.object({ target: commandCenterProjectTargetSchema, title: z.string().max(512), displayRoot: z.string().max(4_096),
      workers: z.array(z.object({ provider: providerIdSchema, modelId: entityId, reasoningEfforts: z.array(z.string().max(64)).max(20),
        defaultPermission: permission.nullable(), permissionComparable: z.boolean() }).strict()).max(100),
      controlAvailable: z.boolean(), readsAvailable: z.boolean(), readOnlyProfileAvailable: z.boolean(), freshness }).strict()).max(100), ...page }),
  },
  list_working_copies: {
    input: z.object({ project: commandCenterProjectTargetSchema, ...paging }).strict(),
    output: result({ project: commandCenterProjectTargetSchema, revision: cursor, choices: z.array(z.object({ choiceId: id,
      kind: z.enum(['shared', 'new-worktree', 'existing-worktree']), branch: z.string().max(512).nullable(), occupied: z.boolean(), locked: z.boolean(),
      limitations: z.array(shortText).max(20) }).strict()).max(100), baseRefs: z.array(z.object({ choiceId: id, name: z.string().max(512) }).strict()).max(100), ...page }),
  },
  read_operation: {
    input: z.object({ operationId: z.uuid() }).strict(),
    output: result({ ...receiptResult, action: z.enum(['start', 'send', 'stop', 'settle']), state: operationState }),
  },
} as const
export type CommandCenterToolName = keyof typeof commandCenterToolSchemas
export type CommandCenterToolInput<N extends CommandCenterToolName> = z.infer<(typeof commandCenterToolSchemas)[N]['input']>
export type CommandCenterToolOutput<N extends CommandCenterToolName> = z.infer<(typeof commandCenterToolSchemas)[N]['output']>

/** Control records carry references only; prose belongs to the history-aware message/queue store. */
export const commandCenterIdentitySchema = z.object({ target: commandCenterThreadTargetSchema, projectId: entityId,
  provider: commandCenterProviderSchema, creationOperationId: z.uuid(), createdAt: time }).strict()
export const commandCenterParticipantSchema = participation.extend({ target: commandCenterThreadTargetSchema,
  promptCount: z.number().int().min(0).max(COMMAND_CENTER_PROMPTS_PER_THREAD) }).strict()
export const commandCenterRequestSchema = z.object({ id: z.uuid(), commandCenter: commandCenterThreadTargetSchema, rootUserMessageId: id,
  state: z.enum(['active', 'stopped', 'closed']), createdAt: time, closedAt: time.nullable(),
  participants: z.array(commandCenterParticipantSchema).max(1_000) }).strict()
export const commandCenterOperationSchema = z.object({ id: z.uuid(), requestId: z.uuid(), retryKey: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  action: z.enum(['start', 'send', 'stop', 'settle']), target: commandCenterThreadTargetSchema, generation: counter,
  delivery: deliveryMode.optional(), deliveryState: commandCenterDeliveryStateSchema, createdAt: time, updatedAt: time,
  receiptId: id, cardId: id, creationReceiptId: id.optional(), firstPromptReceiptId: id.optional(), commandId: id.optional(),
  draftId: z.uuid().optional(), messageId: id.optional(), itemId: id.optional(), anchorMessageId: id.optional(), toolCallId: id.optional(),
  refusalCode: commandCenterRefusalCodeSchema.optional() }).strict()
export const commandCenterRecordSchema = z.object({ version: z.literal(1), current: commandCenterIdentitySchema.nullable(),
  creation: z.object({ identity: commandCenterIdentitySchema, phase: z.enum(['intent', 'created', 'bound', 'ready']),
    replaces: commandCenterThreadTargetSchema.nullable() }).strict().nullable(),
  history: z.array(commandCenterIdentitySchema).max(1_000), requests: z.array(commandCenterRequestSchema).max(10_000),
  operations: z.array(commandCenterOperationSchema).max(40_000),
  reservations: z.array(z.object({ target: commandCenterThreadTargetSchema, requestId: z.uuid(), operationId: z.uuid(), generation: counter,
    reason: z.enum(['creation', 'active-turn', 'background-work', 'queued', 'dispatching', 'uncertain', 'needs-user']) }).strict()).max(8),
  reads: z.array(z.object({ target: commandCenterThreadTargetSchema, position: commandCenterPositionSchema, readAt: time,
    lastWakeEventId: id.optional() }).strict()).max(10_000),
}).strict().superRefine((record, context) => {
  const key = (target: CommandCenterThreadTarget) => JSON.stringify([target.hostId, target.threadId])
  const unique = (values: string[]) => new Set(values).size === values.length
  if (!unique(record.requests.map(request => request.id)) || !unique(record.operations.map(operation => operation.id))
    || !unique(record.requests.map(request => JSON.stringify([key(request.commandCenter), request.rootUserMessageId])))
    || !unique(record.operations.map(operation => `${operation.requestId}:${operation.retryKey}`))
    || !unique(record.history.map(identity => key(identity.target))) || !unique(record.reservations.map(reservation => key(reservation.target)))
    || record.history.some(identity => record.current && key(identity.target) === key(record.current.target))) {
    context.addIssue({ code: 'custom', message: 'Command-center identities must be unique.' })
  }
  if (record.creation) {
    // A replacement intent keeps the old current reference until the atomic handover can finish.
    const { identity, replaces } = record.creation
    const conflict = replaces ? !record.current || key(replaces) !== key(record.current.target) || key(identity.target) === key(replaces)
      : record.current && JSON.stringify(record.current) !== JSON.stringify(identity)
    if (conflict || record.history.some(previous => key(previous.target) === key(identity.target))) {
      context.addIssue({ code: 'custom', message: 'Creation must preserve the current command-center identity.' })
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
export type CommandCenterIdentity = z.infer<typeof commandCenterIdentitySchema>
export type CommandCenterRequest = z.infer<typeof commandCenterRequestSchema>
export type CommandCenterOperation = z.infer<typeof commandCenterOperationSchema>
export type CommandCenterRecord = z.infer<typeof commandCenterRecordSchema>
export function emptyCommandCenterRecord(): CommandCenterRecord {
  return { version: 1, current: null, creation: null, history: [], requests: [], operations: [], reservations: [], reads: [] }
}
