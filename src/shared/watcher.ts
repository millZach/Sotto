import { z } from 'zod'
import { agentRuntimeModeSchema, handoverCountsSchema, providerIdSchema } from './agents'
import { worktreeMadeFromSchema } from './bringChangesBack'
import { watcherGroupSchema, WATCHER_GROUPS } from './watcherOverview'
import { hostFactsSchema, hostLoadSchema, hostOsSchema } from './hostFacts'
import { workerKindSchema } from './workerRoles'
import { newWorkersStartSchema, workerPlacementReceiptSchema, workerSystemSchema } from './workerMachine'
import { branchStartReceiptSchema } from './branchMoves'
export { watcherOwnChangeSchema, type WatcherOwnChange } from './watcherChanges'

export const WATCHER_PROMPT_BYTES_MAX = 32 * 1_024
export const WATCHER_READ_BYTES_MAX = 64 * 1_024
export const WATCHER_TITLE_MAX = 512
export const WATCHER_ROSTER_MAX = 100
export const WATCHER_PARTICIPATION_HISTORY_MAX = 100
export const WATCHER_MESSAGES_MAX = 50
export const WATCHER_TOOL_CALLS_MAX = 8
export const WATCHER_PROMPTS_PER_THREAD = 4

const id = z.string().min(1).max(512)
const entityId = z.string().min(1).max(6_144)
const time = z.string().datetime()
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const shortText = z.string().max(2_000)
const cursor = z.string().min(1).max(2_048)
const utf8 = (max: number) => z.string().max(max).refine(value => new TextEncoder().encode(value).byteLength <= max, 'Text exceeds the byte limit.')
const prompt = utf8(WATCHER_PROMPT_BYTES_MAX).refine(value => value.trim().length > 0, 'A prompt is required.')
export const watcherProviderSchema = z.enum(['codex', 'claude', 'grok', 'muse', 'cursor'])
export const watcherThreadTargetSchema = z.object({ hostId: z.uuid(), threadId: id }).strict()
export const watcherPhoneOriginSchema = z.object({ kind: z.literal('phone'), hostId: z.uuid(), clientId: id }).strict()
export const watcherProjectTargetSchema = z.object({ hostId: z.uuid(), projectId: entityId }).strict()
export type WatcherThreadTarget = z.infer<typeof watcherThreadTargetSchema>
export type WatcherProjectTarget = z.infer<typeof watcherProjectTargetSchema>
/** Durable assignment, independent of any one request. Contains no user or provider prose. */
/** The paired master desktop a standing watch, or its withdrawal fence, came from on the owning host. */
const watcherWatchOriginSchema = z.object({ clientId: id, masterHostId: z.uuid(), masterCreationOperationId: z.uuid().optional(), masterCreatedAt: time.optional() }).strict()
export const watcherStandingWatchSchema = z.object({ id: z.uuid(), target: watcherThreadTargetSchema,
  createdAt: time, generation: counter, pausedByUserMessageId: id.nullable().optional(), lastUserMessageId: id.nullable().optional(),
  remoteOrigin: watcherWatchOriginSchema.optional() }).strict()
export type WatcherStandingWatch = z.infer<typeof watcherStandingWatchSchema>
export const watcherPositionSchema = z.object({ historyEpoch: id, afterPosition: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER) }).strict()
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
  'BINARY_FILE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'UNKNOWN_OPERATION', 'OPERATION_NOT_RECORDED', 'STATE_FULL', 'SLASH_COMMAND',
] as const
export const watcherRefusalCodeSchema = z.enum(WATCHER_REFUSAL_CODES)
export const watcherDeliveryStateSchema = z.enum(['queued', 'dispatching', 'accepted', 'failed', 'uncertain'])
/**
 * Where one delegation (a start or send) stands, as Sotto observed it (CONTEXT.md, **Outcome**). `background`: its turn
 * ended with background work still running. `paused`: the user's own turn in that thread holds it. `unknown`: Sotto cannot
 * prove what happened, as after a restart mid-turn; never guessed as answered.
 */
export const WATCHER_OUTCOMES = ['working', 'background', 'answered', 'failed', 'stopped', 'paused', 'unknown'] as const
export const watcherOutcomeSchema = z.enum(WATCHER_OUTCOMES)
export type WatcherOutcome = z.infer<typeof watcherOutcomeSchema>
/** A reply read back for a delegation is cut to this, so a whole operation read stays inside the read bound. */
export const WATCHER_REPLY_BYTES_MAX = 32 * 1_024
/**
 * Text-free: the thread, the turn that answers the delegation (the Sotto user message it began with and, when the provider
 * proves it, the provider's own turn ID) and that turn's final reply message.
 */
export const watcherOutcomeReferenceSchema = z.object({ target: watcherThreadTargetSchema, turnMessageId: id.optional(),
  nativeTurnId: id.optional(), replyMessageId: id.optional() }).strict()
export const watcherLimitsSchema = z.object({
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
  fact: z.enum(['turn-finished', 'turn-failed', 'checks-passed', 'checks-failed', 'review-approved', 'merge-observed', 'auto-merge-observed', 'landing-action', 'files-changed', 'delivery-changed', 'taken-over', 'pull-request-observed']),
  changedFiles: counter.optional(), insertions: counter.optional(), deletions: counter.optional(),
  reason: z.enum(['disconnected', 'read-failed', 'rate-limited', 'checks-unavailable', 'capture-unavailable', 'shared-checkout', 'unsupported']).optional(),
  failureCategory: z.literal('provider-turn-failed').optional(), url: z.string().url().max(2_048).optional(),
  branch: z.string().max(512).nullable().optional(), ahead: counter.optional(), behind: counter.optional(), fetchedAt: time.nullable().optional(),
  pullRequestState: z.enum(['open', 'closed', 'merged']).optional(), checkCount: counter.optional(),
  checksState: z.enum(['passed', 'failed', 'pending', 'unknown']).optional(), githubReviewApproved: z.boolean().optional(), githubAutoMergeEnabled: z.boolean().optional() }).strict()
export type WatcherEvidence = z.infer<typeof watcherEvidenceSchema>
const takeover = z.object({ reason: z.enum(['user-send', 'native-user-send', 'user-stop', 'user-settle', 'user-reconfigure']), at: time }).strict()
const participation = z.object({ requestId: z.uuid(), startedBy: z.enum(['watcher', 'user']), generation: counter,
  state: z.enum(['participating', 'taken-over', 'relinquished']), takeover: takeover.optional(), automationStopped: z.literal(true).optional() }).strict()
const pr = z.object({ number: z.number().int().positive(), url: z.string().max(2_048), title: z.string().max(512),
  state: z.enum(['open', 'closed', 'merged']), draft: z.boolean() }).strict()
const row = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX), projectId: entityId,
  standingWatch: watcherStandingWatchSchema.omit({ remoteOrigin: true }).optional(),
  provider: providerIdSchema, modelId: entityId, reasoningEffort: z.string().max(64).optional(), status: z.enum(['idle', 'running', 'error']),
  group: watcherGroupSchema, waitsOn: z.array(pending).max(100), branch: z.string().max(512).nullable(),
  workingCopy: workingCopy.nullable(), pullRequests: z.array(pr).max(50), evidence: z.array(watcherEvidenceSchema).max(100),
  lastActivityAt: time.nullable(), observedAt: time.nullable(), connected: z.boolean(), freshness,
  userReadAt: time.nullable(), watcherReadAt: time.nullable(), participation: z.array(participation).max(WATCHER_PARTICIPATION_HISTORY_MAX), protected: z.boolean(),
  // The desktop's alone (#1191): whether Watcher watches the thread, as a slim row says. A paired host never sends it.
  watched: z.boolean().optional(),
  // The desktop's alone too (ADR-0108): a prototype the thread made waits for the user's review, from the thread itself.
  prototypeReady: z.literal(true).optional() }).strict()
/**
 * A pull request as a slim read gives it (#1191): its number, or its address when that has none, and what it says now,
 * instead of every evidence fact. A fact GitHub has not been read for is left out rather than guessed, and approval,
 * auto-merge and staleness are said only when true.
 */
export const watcherPullRequestSummarySchema = z.object({ number: z.number().int().positive().optional(), url: z.string().max(2_048).optional(),
  state: z.enum(['open', 'closed', 'merged']).optional(), checks: z.enum(['passed', 'failed', 'pending', 'unknown']).optional(),
  approved: z.literal(true).optional(), autoMerge: z.literal(true).optional(), stale: z.literal(true).optional() }).strict()
export type WatcherPullRequestSummary = z.infer<typeof watcherPullRequestSummarySchema>
/** A roster row in list_threads' slim detail, its default (#1191): who it is, where it stands and what it waits on. */
const slimRow = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX), projectId: entityId, status: z.enum(['idle', 'running', 'error']),
  group: watcherGroupSchema, waitsOn: z.array(pending).max(100), watched: z.boolean(), standingWatchId: z.uuid().optional(), connected: z.boolean(),
  // Why it needs the user or is not watched, said only when true: its newest turn failed, its user took it over, or its
  // automation was stopped.
  turnFailed: z.literal(true).optional(), takenOver: z.literal(true).optional(), automationStopped: z.literal(true).optional(),
  // A prototype the thread made waits for the user's review (ADR-0108): only the user can open it.
  prototypeReady: z.literal(true).optional(),
  protected: z.literal(true).optional(), pullRequests: z.array(watcherPullRequestSummarySchema).max(50),
  // Open pull requests only (#1147): how many of the thread's others are merged or closed, said only when there are any.
  mergedPullRequests: counter.optional(), closedPullRequests: counter.optional() }).strict()
/** How much list_threads and read_thread say of each thread's evidence (#1191). */
export const watcherDetailSchema = z.enum(['slim', 'full'])
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

/**
 * Host protocol version 1 carried two more numbers in every receipt's `limits`, a Threads in flight count and its limit of
 * one to eight, until #1183 removed the limit. A desktop from before then still requires them in a paired host's reply, so
 * a host adds these harmless values to what it answers a desktop, and a desktop takes them off a host's reply before
 * reading it. Neither number means anything now, and no Watcher result shows them.
 */
const HOST_V1_LIMITS = { inFlight: 0, inFlightLimit: 8 } as const
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/**
 * A Watcher control or read result as a host sends it to a desktop: the old limit numbers added, and the working threads
 * warning taken off, since it speaks for this computer alone and an older desktop refuses a key it does not know.
 */
export function watcherResultForHostV1(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const { warning: _warning, ...rest } = value
  void _warning
  return isPlainObject(rest.limits) ? { ...rest, limits: { ...rest.limits, ...HOST_V1_LIMITS } } : rest
}
/** A paired host's Watcher result as a desktop reads it: the old limit numbers, from any host, taken off. */
export function watcherResultFromHostV1(value: unknown): unknown {
  if (!isPlainObject(value) || !isPlainObject(value.limits)) return value
  const { inFlight: _inFlight, inFlightLimit: _inFlightLimit, ...limits } = value.limits
  void _inFlight; void _inFlightLimit
  return { ...value, limits }
}

/**
 * One machine as list_machines shows it (#1031): This computer or a connected host, its host facts when it reported them,
 * and how many of its threads are running a turn. `factsState` says why there are none: `unknown` for a host that does not
 * report them or could not be read, `not-connected` for one that is not connected now. Never guessed. Its live load and work
 * placed but not started (#1311) are null where the host does not report them, and `memoryState` and `cpuState` are what
 * that load says against `MACHINE_LOAD_THRESHOLDS`, unknown when it is missing or over a minute old.
 */
export const WATCHER_MACHINES_MAX = 100
/** Why a machine in list_machines has no facts: the words Watcher reads, which the room tells apart by them (#1032). */
export const MACHINE_FACTS_OLDER = 'This machine’s host does not report what kind of machine it is. Update Sotto on it to see.'
export const MACHINE_FACTS_UNREAD = 'This machine’s facts could not be read just now. Nothing was changed. Ask again.'
export const MACHINE_NOT_CONNECTED = 'This machine is not connected. Connect it from the Threads page to see its facts.'

/**
 * Watcher's state (#1189): what it must not lose when its conversation is compacted. Watcher keeps the user's pending
 * decisions, the standing rules the user gave and the issues it filed, with keep_state; Sotto adds the watched threads
 * and what each waits on from its own records. read_state gives the whole of it back.
 *
 * Each kept line has an ID, so Watcher adds, edits, closes or drops one line at a time (October 24, 2026). A list holds
 * WATCHER_KEPT_ITEMS_MAX open lines; adding past that is refused, never made room for. A closed line says how it ended
 * and stays, out of that count, until Sotto clears it WATCHER_KEPT_CLOSED_MS after it was closed.
 */
export const WATCHER_KEPT_ITEMS_MAX = 30
export const WATCHER_KEPT_ITEM_MAX = 300
/** Closed lines a list keeps until they clear; past this the oldest closed clear at once. */
export const WATCHER_KEPT_CLOSED_MAX = 30
/** How long a closed line stays before Sotto clears it: about a day. */
export const WATCHER_KEPT_CLOSED_MS = 24 * 60 * 60 * 1_000
/** How long an open line may go without being added or edited before read_state flags it for review. */
export const WATCHER_KEPT_UNTOUCHED_MS = 3 * 24 * 60 * 60 * 1_000
export const WATCHER_KEPT_LISTS = ['decisions', 'rules', 'issues'] as const
export type WatcherKeptList = typeof WATCHER_KEPT_LISTS[number]
const keptText = z.string().trim().min(1).max(WATCHER_KEPT_ITEM_MAX)
/** A line's ID: its list's letter and a number Sotto gives it, as `d3`, `r1` or `i12`. Never given twice. */
const keptId = z.string().regex(/^[dri][1-9]\d{0,8}$/u)
/** One kept line: its words, when Watcher last added or edited it, and, once closed, when and how it ended. */
export const watcherKeptItemSchema = z.object({ id: keptId, text: keptText, touchedAt: time,
  closedAt: time.optional(), closedNote: keptText.optional() }).strict()
export type WatcherKeptItem = z.infer<typeof watcherKeptItemSchema>
const keptLines = z.array(watcherKeptItemSchema).max(WATCHER_KEPT_ITEMS_MAX + WATCHER_KEPT_CLOSED_MAX)
export const watcherKeptStateSchema = z.object({ decisions: keptLines, rules: keptLines, issues: keptLines, updatedAt: time.nullable() }).strict()
export type WatcherKeptState = z.infer<typeof watcherKeptStateSchema>
/** What `watcher-state.json` holds: the lists and the next line number. */
export const watcherKeptRecordSchema = watcherKeptStateSchema.extend({ nextId: z.number().int().positive().max(999_999_999) }).strict()
export type WatcherKeptRecord = z.infer<typeof watcherKeptRecordSchema>
/** The file as builds before line IDs saved it: three lists of words. Read once, and given IDs as it is read. */
export const watcherKeptLegacySchema = z.object({ decisions: z.array(keptText).max(20), rules: z.array(keptText).max(20),
  issues: z.array(keptText).max(20), updatedAt: time.nullable() }).strict()
const keptWords = z.array(keptText).max(WATCHER_KEPT_ITEMS_MAX)
/**
 * keep_state's input. A list given whole replaces that list's open lines, as before line IDs: a line whose words are
 * unchanged keeps its ID and when it was touched. `add`, `edit`, `close` and `drop` change one line each, by its ID.
 */
export const watcherKeepStateInputSchema = z.object({ decisions: keptWords.optional(), rules: keptWords.optional(), issues: keptWords.optional(),
  add: z.array(z.object({ list: z.enum(WATCHER_KEPT_LISTS), text: keptText }).strict()).min(1).max(WATCHER_KEPT_ITEMS_MAX).optional(),
  edit: z.array(z.object({ id: keptId, text: keptText }).strict()).min(1).max(WATCHER_KEPT_ITEMS_MAX).optional(),
  close: z.array(z.object({ id: keptId, note: keptText.optional() }).strict()).min(1).max(WATCHER_KEPT_ITEMS_MAX).optional(),
  drop: z.array(keptId).min(1).max(WATCHER_KEPT_ITEMS_MAX).optional() }).strict()
export type WatcherKeepStateInput = z.infer<typeof watcherKeepStateInputSchema>
/** A watched thread as Watcher's state gives it: who it is and, in Sotto's words, what it waits on. */
export const watcherStateThreadSchema = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX),
  waitsOn: z.string().min(1).max(200) }).strict()
export type WatcherStateThread = z.infer<typeof watcherStateThreadSchema>
/**
 * What read_state computes from live data each time it is read (#1274), so none of it can go stale the way notes Watcher
 * kept by hand did after a compaction: each watched thread's open pull requests, the merge queue, the watched threads
 * Settle finished threads is waiting to settle and what holds each, and the kept notes that name a settled or unwatched
 * thread or a merged or closed pull request.
 */
export const WATCHER_STATE_COMPUTED_MAX = 100
const sottoSentence = z.string().min(1).max(300)
const watcherStateWatchingSchema = watcherStateThreadSchema.extend({ pullRequests: z.array(watcherPullRequestSummarySchema).max(50) }).strict()
/** A pull request in the merge queue: open, not a draft, its checks passed, oldest pass first. */
export const watcherMergeQueueItemSchema = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX),
  pullRequest: watcherPullRequestSummarySchema, checksPassedAt: time }).strict()
export const watcherPendingSettleSchema = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX), settlesWhen: sottoSentence }).strict()
export const watcherStaleNoteSchema = z.object({ list: z.enum(WATCHER_KEPT_LISTS), id: keptId, reasons: z.array(sottoSentence).min(1).max(6) }).strict()
/**
 * One thing that waits on the user among the watched threads, worked out from live data at each read: an open question or
 * permission card, on the thread or on a thread it delegated to (`delegatedThreadId`), or a prototype waiting for review.
 */
export const watcherWaitingOnUserSchema = z.object({ target: watcherThreadTargetSchema, title: z.string().max(WATCHER_TITLE_MAX),
  waitsFor: z.enum(['question', 'permission', 'prototype-review']), requestCardId: id.optional(), delegatedThreadId: id.optional() }).strict()
export type WatcherWaitingOnUser = z.infer<typeof watcherWaitingOnUserSchema>
/** What waits on the user, a hundred to a page with the watched threads. */
export const WATCHER_WAITING_ON_USER_MAX = 100
export type WatcherMergeQueueItem = z.infer<typeof watcherMergeQueueItemSchema>
export type WatcherPendingSettle = z.infer<typeof watcherPendingSettleSchema>
export type WatcherStaleNote = z.infer<typeof watcherStaleNoteSchema>
// Strict here, as every Watcher result is: the host's own report was already read leniently, so nothing extra remains.
const machineFacts = hostFactsSchema.extend({ os: hostOsSchema.strict() }).strict()
const machineShape = { hostId: id, name: z.string().min(1).max(200), thisComputer: z.boolean(), connected: z.boolean(),
  factsState: z.enum(['reported', 'unknown', 'not-connected']), facts: machineFacts.nullable(), note: shortText.min(1).optional(),
  runningThreads: counter.nullable() }
// Live load (#1311) is part of the Owl feature Work across machines: present on every machine while it is on, on none while off.
const machine = z.object({ ...machineShape, load: hostLoadSchema.strict().nullable().optional(), placedNotStarted: counter.nullable().optional(),
  memoryState: z.enum(['short', 'enough', 'unknown']).optional(), cpuState: z.enum(['busy', 'not-busy', 'unknown']).optional() }).strict()
/** list_machines as Watcher is offered it with Work across machines off: no live load, as before #1311. */
export const watcherMachinesWithoutLoadOutput = result({ machines: z.array(z.object(machineShape).strict()).max(WATCHER_MACHINES_MAX), observedAt: time })

/** Only these named operations can cross the future sotto_threads boundary. None serve tools yet. */
export const watcherToolSchemas = {
  watch_thread: {
    input: z.object({ target: watcherThreadTargetSchema }).strict(),
    output: result({ watch: watcherStandingWatchSchema }),
  },
  unwatch_thread: {
    input: z.object({ target: watcherThreadTargetSchema }).strict(),
    output: result({ target: watcherThreadTargetSchema, watched: z.literal(false) }),
  },
  list_threads: {
    // `detail` and `watchedOnly` are the desktop's alone (#1191): a paired host is never sent them and answers in full.
    input: z.object({ hostId: z.uuid().optional(), project: watcherProjectTargetSchema.optional(), group: watcherGroupSchema.optional(),
      includeSettled: z.boolean().default(true), watchedOnly: z.boolean().optional(), detail: watcherDetailSchema.optional(), ...paging }).strict(),
    output: result({ rows: z.union([z.array(row).max(100), z.array(slimRow).max(100)]), snapshotRevision: cursor, counts, ...page }),
  },
  read_thread: {
    // `evidence` is the desktop's alone (#1191): slim, its default, gives each pull request's summary instead of every fact.
    input: z.object({ target: watcherThreadTargetSchema, position: watcherPositionSchema.optional(),
      limit: z.number().int().min(1).max(WATCHER_MESSAGES_MAX).default(WATCHER_MESSAGES_MAX), includeActivities: z.boolean().default(false),
      evidence: watcherDetailSchema.optional() }).strict(),
    output: boundedRead(result({ target: watcherThreadTargetSchema, messages: z.array(z.object({ id, position: counter, role: z.enum(['user', 'assistant']),
      text: utf8(WATCHER_READ_BYTES_MAX), createdAt: time }).strict()).max(WATCHER_MESSAGES_MAX), waitsOn: z.array(pending).max(100),
      // The desktop's alone, from the thread itself (ADR-0108): a prototype it made waits for the user's review.
      prototypeReady: z.literal(true).optional(),
      activities: z.array(z.object({ id, kind: z.enum(['turn', 'command', 'file-change', 'tool', 'reasoning', 'plan', 'subagent', 'status', 'compaction']),
        status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']), title: shortText, startedAt: time.optional(), completedAt: time.optional() }).strict()).max(100),
      evidence: z.array(watcherEvidenceSchema).max(100), pullRequests: z.array(watcherPullRequestSummarySchema).max(50).optional(),
      // The desktop's alone (#1147): how many merged or closed pull requests a slim read's summaries leave out, since
      // Watcher's last read of the thread already gave them so, or they were so before it first read the thread.
      mergedPullRequests: counter.optional(), closedPullRequests: counter.optional(),
      historyEpoch: id, firstPosition: counter.nullable(), lastPosition: counter.nullable(),
      nextPosition: counter.nullable(), truncated: z.boolean(), earlierAvailable: z.boolean(), observedAt: time,
      // The desktop's alone (#1552): this read gave Watcher nothing its last read of the thread had not, since that time.
      unchangedSince: time.optional() })),
  },
  start_thread: {
    // A start names its worker role, its model, or both (#1041). Main fills the rest from the role before admission, and
    // never sends `role` to a paired host: an older one refuses keys it does not know. `machine` and `os` say where it
    // starts (#1032, Owl `cross-machine-work`); main places the start before admission and sends neither to a paired host.
    // `fromThread` starts it from that thread's branch, and `testRun` says the start is a test run, whose uncommitted work
    // goes too as a snapshot (#1033, #1312): main takes both off before admission and puts `fromMove` in their place, the
    // move it makes just before the start, which is all a paired host is sent. Watcher never names a move itself.
    input: z.object({ ...mutation, project: watcherProjectTargetSchema, machine: z.uuid().optional(), os: workerSystemSchema.optional(), role: workerKindSchema.optional(), modelId: entityId.optional(), reasoningEffort: z.string().min(1).max(64).optional(),
      permission: permission.optional(), workingCopy, baseRefChoiceId: id.optional(), title: z.string().min(1).max(WATCHER_TITLE_MAX), firstPrompt: prompt,
      fromThread: watcherThreadTargetSchema.optional(), testRun: z.boolean().optional(), fromMove: z.uuid().optional(),
      // With `fromMove`, the thread whose branch it was, which the worker's worktree keeps so its commits can be brought back
      // there (#1030): `host` only when that thread is on another machine than the worker. Sotto's, like the move.
      madeFrom: worktreeMadeFromSchema.optional() }).strict(),
    output: result({ ...receiptResult, target: watcherThreadTargetSchema, effectiveChoices: choices, creationReceiptId: id, firstPromptReceiptId: id,
      // Where a start from a thread's branch began and from which branch, with what a test run's snapshot carried (#1033).
      // In memory only, as `placement` is.
      startedFrom: branchStartReceiptSchema.optional(),
      // What the start's worker role gave it and what the request named in its place. In memory only: a retry after a restart has none.
      role: z.object({ id: workerKindSchema, named: z.array(z.enum(['model', 'effort', 'permission'])).max(3), note: shortText.min(1) }).strict().optional(),
      // Where the start was placed (#1032): the machine, whether it is somewhere other than where new workers start, and
      // why when Sotto placed it itself. In memory only, as `role` is; never from a paired host, which places nothing.
      placement: workerPlacementReceiptSchema.optional(),
      // The working threads warning (#1183), when more than ten threads are working on the machine the start went to,
      // counting it. A paired host never sends one: the desktop counts that machine's threads itself (#1032).
      warning: shortText.min(1).optional() }),
  },
  send_to_thread: {
    // `mergeTurn` is the desktop's alone (#1339): it marks the send that gives a thread its merge turn, for Watcher's
    // picture. Main takes it off before the send is admitted, so it changes nothing about the send, its digest or its
    // retry, and a paired host is never sent it. A send that names no `delivery` steers (ADR-0130): main picks the mode
    // from the thread before admission, and a paired host is sent the one it picked.
    input: z.object({ ...mutation, target: watcherThreadTargetSchema, text: prompt, delivery: deliveryMode.optional(),
      expectedLastUserMessageId: id.optional(), expectedTurnId: id.optional(),
      mergeTurn: z.object({ pullRequest: z.number().int().positive() }).strict().optional() }).strict(),
    // `note` is the desktop's alone: what a send that asked to steer did instead, when it went now or queued (ADR-0130).
    output: result({ ...receiptResult, delivery: deliveryMode, note: shortText.min(1).optional() }),
  },
  stop_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, stopRequested: z.boolean(), state: operationState }),
  },
  settle_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema }).strict(),
    output: result({ ...receiptResult, state: operationState }),
  },
  // Restoring changes nothing a second time, so it keeps no operation and its result needs no receipt (October 23, 2026).
  unsettle_thread: {
    input: z.object({ ...mutation, target: watcherThreadTargetSchema }).strict(),
    output: result({ target: watcherThreadTargetSchema, settled: z.literal(false) }),
  },
  list_projects: {
    // `projectId`, `query` and `includeModels` are the desktop's alone (#1191): a paired host is never sent them.
    input: z.object({ hostId: z.uuid().optional(), projectId: entityId.optional(), query: z.string().min(1).max(200).optional(),
      includeModels: z.boolean().optional(), ...paging }).strict(),
    output: result({ projects: z.array(z.object({ target: watcherProjectTargetSchema, title: z.string().max(512), displayRoot: z.string().max(4_096),
      // Left out unless includeModels: every project on a computer offers the same models.
      workers: z.array(z.object({ provider: providerIdSchema, modelId: entityId, reasoningEfforts: z.array(z.string().max(64)).max(20),
        defaultPermission: permission.nullable(), permissionComparable: z.boolean() }).strict()).max(100).optional(),
      controlAvailable: z.boolean(), readsAvailable: z.boolean(), readOnlyProfileAvailable: z.boolean(), freshness }).strict()).max(100), ...page }),
  },
  keep_state: {
    // A list given whole replaces that list's open lines; add, edit, close and drop change one line each, by its ID.
    input: watcherKeepStateInputSchema,
    output: result({ kept: watcherKeptStateSchema }),
  },
  read_state: {
    // A hundred watched threads to a page; nextCursor reads the rest.
    input: z.object({ cursor: cursor.optional() }).strict(),
    // Computed from live data at each read (#1274). The merge queue and pending settles page with the watched threads, a
    // hundred of each to a page, and so does waitingOnUser; staleNotes is whole on every page.
    output: result({ watching: z.array(watcherStateWatchingSchema).max(100), nextCursor: cursor.nullable(),
      mergeQueue: z.array(watcherMergeQueueItemSchema).max(WATCHER_STATE_COMPUTED_MAX), settlesFinishedThreads: z.boolean(),
      pendingSettles: z.array(watcherPendingSettleSchema).max(WATCHER_STATE_COMPUTED_MAX),
      waitingOnUser: z.array(watcherWaitingOnUserSchema).max(WATCHER_WAITING_ON_USER_MAX), kept: watcherKeptStateSchema,
      staleNotes: z.array(watcherStaleNoteSchema).max(WATCHER_KEPT_ITEMS_MAX * 3), contextTokens: counter.nullable(), compactAtTokens: counter }),
  },
  list_machines: {
    input: z.object({}).strict(),
    // `newWorkersStart` says where a start that names no machine goes (#1032), only while Work across machines is on.
    output: result({ machines: z.array(machine).max(WATCHER_MACHINES_MAX), observedAt: time, newWorkersStart: newWorkersStartSchema.optional() }),
  },
  list_working_copies: {
    input: z.object({ project: watcherProjectTargetSchema, ...paging }).strict(),
    output: result({ project: watcherProjectTargetSchema, revision: cursor, choices: z.array(z.object({ choiceId: id,
      kind: z.enum(['shared', 'new-worktree', 'existing-worktree']), branch: z.string().max(512).nullable(), occupied: z.boolean(), locked: z.boolean(),
      limitations: z.array(shortText).max(20) }).strict()).max(100), baseRefs: z.array(z.object({ choiceId: id, name: z.string().max(512) }).strict()).max(100), ...page }),
  },
  read_operation: {
    input: z.object({ operationId: z.uuid() }).strict(),
    // The outcome fields are optional: stop and settle carry none, and an older owning host sends none.
    output: boundedRead(result({ ...receiptResult, action: z.enum(['start', 'send', 'stop', 'settle']), state: operationState,
      outcome: watcherOutcomeSchema.optional(), reference: watcherOutcomeReferenceSchema.optional(), outcomeNote: shortText.min(1).optional(),
      // The worker's own words for the turn that answered, never Sotto's evidence.
      reply: z.object({ from: z.literal('worker'), messageId: id, text: utf8(WATCHER_REPLY_BYTES_MAX), createdAt: time, truncated: z.boolean() }).strict().optional(),
      replyUnavailable: z.object({ reason: z.enum(['history-off', 'not-retained']), message: shortText.min(1) }).strict().optional(),
      evidence: z.array(watcherEvidenceSchema).max(100).optional() })),
  },
} as const
export type WatcherToolName = keyof typeof watcherToolSchemas
export type WatcherToolInput<N extends WatcherToolName> = z.infer<(typeof watcherToolSchemas)[N]['input']>
export type WatcherToolOutput<N extends WatcherToolName> = z.infer<(typeof watcherToolSchemas)[N]['output']>

/** Control records carry references only; prose belongs to the history-aware message/queue store. */
export const watcherIdentitySchema = z.object({ target: watcherThreadTargetSchema, projectId: entityId,
  provider: watcherProviderSchema, creationOperationId: z.uuid(), createdAt: time }).strict()
export const watcherParticipantSchema = participation.extend({ target: watcherThreadTargetSchema,
  lastUserMessageId: id.nullable().optional(),
  promptCount: z.number().int().min(0).max(WATCHER_PROMPTS_PER_THREAD) }).strict()
/** Text-free proof of the user's boundary in the exact native message Sotto sent. */
export const watcherDisplayPromptSchema = z.object({ originalLength: counter,
  wireDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export type WatcherDisplayPrompt = z.infer<typeof watcherDisplayPromptSchema>
/**
 * Text-free proof that a request's root message began with a handover of an earlier Watcher (ADR-0073): how many
 * characters of the sent message it took and their digest, which conversation it came from, and what it carried and
 * left out, in counts. The user's words follow it in the same message.
 */
export const watcherHandoverProvenanceSchema = z.object({ prefixLength: counter, prefixDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  source: watcherThreadTargetSchema, provider: watcherProviderSchema, counts: handoverCountsSchema }).strict()
export type WatcherHandoverProvenance = z.infer<typeof watcherHandoverProvenanceSchema>
export const watcherRequestSchema = z.object({ id: z.uuid(), watcher: watcherThreadTargetSchema, rootUserMessageId: id,
  standingWatchId: z.uuid().optional(),
  displayPrompt: watcherDisplayPromptSchema.optional(),
  handover: watcherHandoverProvenanceSchema.optional(),
  phoneOrigin: watcherPhoneOriginSchema.optional(),
  pairedPermissionCeiling: agentRuntimeModeSchema.optional(),
  remoteOrigin: z.object({ clientId: id, master: watcherIdentitySchema, creationOperationId: z.uuid(), ceiling: agentRuntimeModeSchema }).strict().optional(),
  state: z.enum(['active', 'stopped', 'closed']), createdAt: time, closedAt: time.nullable(),
  // `afterTakeover`: queued after a user takeover fenced this request. Its first delivery starts a fresh request instead.
  userFollowups: z.array(z.object({ draftId: z.uuid(), messageId: id.optional(), displayPrompt: watcherDisplayPromptSchema.optional(),
    afterTakeover: z.literal(true).optional() }).strict()).max(1_000).optional(),
  participants: z.array(watcherParticipantSchema).max(1_000) }).strict()
export const watcherPromptTurnSchema = z.object({ id: z.uuid(), watcher: watcherThreadTargetSchema, createdAt: time,
  rootUserMessageId: id.optional(), nativeTurnId: id.optional(), previousNativeTurnId: id.optional() }).strict()
export const watcherOperationSchema = z.object({ id: z.uuid(), requestId: z.uuid(), retryKey: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  promptTurnId: z.uuid().optional(), promptRefunded: z.literal(true).optional(),
  standingWatchId: z.uuid().optional(),
  // The caller's original choices, before fitting defaults. Retries never resolve new defaults or dispatch again.
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  action: z.enum(['start', 'send', 'stop', 'settle']), target: watcherThreadTargetSchema, generation: counter,
  delivery: deliveryMode.optional(), deliveryState: watcherDeliveryStateSchema, createdAt: time, updatedAt: time,
  receiptId: id, cardId: id, creationReceiptId: id.optional(), firstPromptReceiptId: id.optional(), commandId: id.optional(),
  draftId: z.uuid().optional(), messageId: id.optional(), itemId: id.optional(), expectedTurnId: id.optional(), expectedLastUserMessageId: id.optional(), anchorMessageId: id.optional(), toolCallId: id.optional(),
  confirmedStop: z.literal(true).optional(),
  creationUncertain: z.literal(true).optional(), refusalCode: watcherRefusalCodeSchema.optional(),
  // The owning host's observed outcome of an accepted start or send, and its text-free result reference. Never sent to
  // another host: each host observes its own threads, and a paired desktop copies them from exact operation reads.
  outcome: watcherOutcomeSchema.optional(), outcomeAt: time.optional(), turnMessageId: id.optional(), nativeTurnId: id.optional(),
  replyMessageId: id.optional() }).strict().refine(item => !item.confirmedStop || item.action === 'stop', 'Only an explicit confirmed Stop can carry this marker.')
export const watcherRecordSchema = z.object({ version: z.literal(1), current: watcherIdentitySchema.nullable(),
  promptTurns: z.array(watcherPromptTurnSchema).max(10_000).optional(),
  lastRuntimeMode: agentRuntimeModeSchema.optional(), watches: z.array(watcherStandingWatchSchema).optional(),
  watchFences: z.array(z.object({ id: z.uuid(), target: watcherThreadTargetSchema.optional(), remoteOrigin: watcherWatchOriginSchema.optional() }).strict()).optional(),
  // The threads the user stopped watching and has not handed back. Watcher's own watch_thread needs a newer user message
  // to Watcher than `watcherHead`, the newest one when the user stopped it; Watch hands one back at once.
  userUnwatches: z.array(z.object({ target: watcherThreadTargetSchema, watcherHead: id.nullable(), at: time }).strict()).max(10_000).optional(),
  // This host's latest takeover or renewed assignment: the last local user request already present at that boundary.
  // Private to this record, never a paired-host grant. Request insertion order, not wall-clock time, fences old work.
  localTakeovers: z.array(z.object({ target: watcherThreadTargetSchema, at: time, lastRequestId: z.uuid().nullable(),
    userDrafts: z.array(z.object({ draftId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u), messageId: id.optional() }).strict()).optional() }).strict()).optional(),
  remoteMasters: z.array(z.object({ clientId: id, masterHostId: z.uuid(), creationOperationId: z.uuid(), createdAt: time }).strict()).max(1_000).optional(),
  creation: z.object({ identity: watcherIdentitySchema, modelId: entityId.optional(), reasoningEffort: z.string().max(64).optional(), phase: z.enum(['intent', 'created', 'bound', 'ready']),
    replaces: watcherThreadTargetSchema.nullable() }).strict().nullable(),
  history: z.array(watcherIdentitySchema).max(1_000), requests: z.array(watcherRequestSchema).max(10_000),
  operations: z.array(watcherOperationSchema).max(40_000),
  // One per thread Watcher has work in flight on, counting its starts still working. The limit that kept these to eight
  // went in #1183, so the live record holds more; agents.json still holds at most eight, which older builds require
  // (watcherRecordForDisk), and recovery rebuilds the rest (rebuildReservations).
  reservations: z.array(z.object({ target: watcherThreadTargetSchema, requestId: z.uuid(), operationId: z.uuid(), generation: counter,
    reason: z.enum(['creation', 'active-turn', 'background-work', 'queued', 'dispatching', 'uncertain', 'needs-user']) }).strict()).max(1_000),
  reads: z.array(z.object({ target: watcherThreadTargetSchema, position: watcherPositionSchema, readAt: time,
    lastWakeEventId: id.optional() }).strict()).max(10_000),
  // Exact negative reads fence late admission. These are scoped identities only, never protocol bodies.
  remoteAbsences: z.array(z.object({ operationId: z.uuid(), master: watcherIdentitySchema, clientId: id, observedAt: time }).strict()).max(1_000).optional(),
  wakeEventIds: z.array(id).max(1_000).optional(),
}).strict().superRefine((record, context) => {
  const key = (target: WatcherThreadTarget) => JSON.stringify([target.hostId, target.threadId])
  const unique = (values: string[]) => new Set(values).size === values.length
  if (!unique(record.requests.map(request => request.id)) || !unique(record.operations.map(operation => operation.id))
    || !unique((record.promptTurns ?? []).map(turn => turn.id))
    || !unique((record.watches ?? []).map(watch => key(watch.target))) || !unique((record.watches ?? []).map(watch => watch.id))
    || !unique((record.localTakeovers ?? []).map(takeover => key(takeover.target)))
    || (record.localTakeovers ?? []).some(takeover => !unique((takeover.userDrafts ?? []).map(draft => draft.draftId)))
    || !unique((record.remoteMasters ?? []).map(master => JSON.stringify([master.clientId, master.masterHostId])))
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
  const promptTurns = new Set((record.promptTurns ?? []).map(turn => turn.id))
  const operations = new Set(record.operations.map(operation => operation.id))
  if (record.operations.some(operation => !requests.has(operation.requestId))
    || record.operations.some(operation => operation.promptTurnId && !promptTurns.has(operation.promptTurnId))
    || record.reservations.some(reservation => !requests.has(reservation.requestId) || !operations.has(reservation.operationId))) {
    context.addIssue({ code: 'custom', message: 'Control references must name retained requests and operations.' })
  }
})
export type WatcherIdentity = z.infer<typeof watcherIdentitySchema>
export type WatcherRequest = z.infer<typeof watcherRequestSchema>
export type WatcherPromptTurn = z.infer<typeof watcherPromptTurnSchema>
export type WatcherOperation = z.infer<typeof watcherOperationSchema>
export type WatcherRecord = z.infer<typeof watcherRecordSchema>
export function emptyWatcherRecord(): WatcherRecord {
  return { version: 1, current: null, creation: null, history: [], requests: [], operations: [], reservations: [], reads: [] }
}
