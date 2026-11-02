import { z } from 'zod'
import { agentAttachmentHandlesSchema, agentMessageSchema, agentRequestSchema, agentQuestionAnswersSchema, providerIdSchema, agentRuntimeModeSchema, agentSpeedSchema } from './agents'
import { watcherRefusalSchema, watcherThreadTargetSchema, watcherPhoneOriginSchema, watcherOwnChangeSchema, watcherStandingWatchSchema, watcherOutcomeSchema, watcherProviderSchema, WATCHER_MACHINES_MAX } from './watcher'
export { watcherPhoneOriginSchema } from './watcher'
import { watcherNextTurnOptionsSchema, watcherStopAllPreviewSchema } from './watcherRoom'

/** How many takeover lines a phone's page carries, the newest, as it carries the newest five hundred receipts. */
export const WATCHER_PHONE_TAKEOVERS_MAX = 500
/**
 * What the page sends as `inFlightLimit` since #1183 removed the Threads in flight limit: the highest an iPhone accepts.
 * Host protocol version 1 requires the field; it limits nothing.
 */
export const WATCHER_PHONE_LEGACY_LIMIT = 8
/** Optional host-v1 phone features, offered only by the Owl desktop running Watcher. */
export const WATCHER_PHONE_FEATURE = 'watcher-phone' as const
export const WATCHER_PHONE_STOP_FEATURE = 'watcher-phone-stop-all' as const
export const WATCHER_PHONE_MANAGE_FEATURE = 'watcher-phone-manage' as const
/**
 * The phone steers Watcher while it works (#1229): a send may say `delivery: 'steer'`, the page lists the user's follow-ups
 * waiting for Watcher, and `watcher-phone-remove-followup` takes one out of the queue.
 */
export const WATCHER_PHONE_STEER_FEATURE = 'watcher-phone-steer' as const
/**
 * The machines line on the phone (#1032, part of the Owl feature Work across machines): a phone that accepts it is sent
 * `machines` on its page, and may send `watcher-phone-read` with `machines: true` to have them read afresh, which it does
 * when the user opens a machine's numbers or Watcher has placed work. Offered only where Work across machines is on.
 */
export const WATCHER_PHONE_MACHINES_FEATURE = 'watcher-phone-machines' as const
/** How many working threads a machine's panel on the phone names; the rest are counted. */
export const WATCHER_PHONE_MACHINE_THREADS_MAX = 6
/**
 * Photos for Watcher from the phone (October 23, 2026): a send may carry `images`, the handles `stage-attachment` answered,
 * with or without words, and `watcher-phone-preview` reads one of a Watcher message's photos, which the page marks.
 */
export const WATCHER_PHONE_PHOTOS_FEATURE = 'watcher-phone-photos' as const
/** Files for Watcher from the phone (ADR-0131, October 28 amendment): a send's `images` may name staged files too. */
export const WATCHER_PHONE_FILES_FEATURE = 'watcher-phone-files' as const
/**
 * Watcher's box on the phone takes the thread box's line (Zach, October 31, 2026): `watcher-phone-open` changes Watcher's
 * model, effort or speed, another provider's model starting a new Watcher as the desktop's chip does; `watcher-phone-new`
 * is New Watcher; `watcher-phone-stop-turn` stops Watcher's own turn; `watcher-phone-dismiss-handover` puts the handover
 * offer away; and a send may say `handover: true`, so it carries the offered handover ahead of its words. Offered with
 * `watcher-phone-manage`, whose receipts its changes keep.
 */
export const WATCHER_PHONE_COMPOSER_FEATURE = 'watcher-phone-composer' as const
/**
 * Watcher's model, effort or speed can change while it works (November 1, 2026): `watcher-phone-open` on Watcher's own
 * provider is kept for its next turn instead of refused, and the page says what waits (`nextTurnOptions`). A phone holds
 * those chips while Watcher works only on a computer without it.
 */
export const WATCHER_PHONE_SETTINGS_LATER_FEATURE = 'watcher-phone-settings-later' as const
/** How many of the user's follow-ups waiting for Watcher a phone's page carries, the first in line. */
export const WATCHER_PHONE_FOLLOWUPS_MAX = 50
export const watcherPhoneSetPermissionSchema = z.object({ runtimeMode: agentRuntimeModeSchema }).strict()
export const watcherPhoneWatchSchema = z.object({ target: watcherThreadTargetSchema }).strict()
/** A change to the current Watcher itself, named by its target so a change meant for one Watcher never reaches the next. */
export const watcherPhoneCurrentSchema = z.object({ target: watcherThreadTargetSchema }).strict()
/** Watcher's model, effort or speed from the phone, as the desktop's chips choose them (`watcherOpenRequestSchema`). */
export const watcherPhoneOpenSchema = z.object({ target: watcherThreadTargetSchema, provider: watcherProviderSchema,
  modelId: z.string().min(1).max(512), reasoningEffort: z.string().min(1).max(64).optional(), speed: agentSpeedSchema.nullable().optional() }).strict()
export const watcherPhoneSendSchema = z.object({ origin: watcherPhoneOriginSchema, target: watcherThreadTargetSchema,
  draftId: z.uuid(), text: z.string().max(20_000),
  // Only from a phone offered WATCHER_PHONE_PHOTOS_FEATURE: the photos it staged, which go with the words, and with
  // WATCHER_PHONE_FILES_FEATURE its staged files too.
  images: agentAttachmentHandlesSchema.min(1).optional(),
  // Only from a phone that negotiated WATCHER_PHONE_STEER_FEATURE: while Watcher works the message steers into its turn,
  // or goes next as its own turn when it cannot. A pending user card queues either version; otherwise,
  // absent delivery, a send while Watcher works is refused, as before (#1229).
  delivery: z.literal('steer').optional(),
  // Only from a phone offered WATCHER_PHONE_COMPOSER_FEATURE, while the page offers a handover: the send carries it.
  handover: z.literal(true).optional() }).strict()
  .refine(send => send.text.trim().length > 0 || send.images !== undefined, 'Send words, photos or both.')
/** One photo of a message in Watcher's conversation, for the phone to draw: Watcher's thread is never a phone's to read. */
export const watcherPhonePreviewSchema = z.object({ target: watcherThreadTargetSchema, messageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(512) }).strict()
/** Takes one of the user's follow-ups out of Watcher's queue, by its queue item ID, before it goes (#1229). */
export const watcherPhoneRemoveFollowupSchema = z.object({ target: watcherThreadTargetSchema, itemId: z.uuid() }).strict()
const id = z.string().min(1).max(512)
const answer = z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: z.string().max(20_000),
  approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional(), skipped: z.literal(true).optional() }).strict()
export const watcherPhoneAnswerSchema = z.object({ target: watcherThreadTargetSchema,
  command: answer }).strict()
const receipt = z.object({ operationId: z.uuid(), target: watcherThreadTargetSchema, title: z.string(),
  provider: providerIdSchema.nullable(), action: z.enum(['start', 'send', 'stop', 'settle']),
  delivery: z.enum(['now', 'queue', 'steer']).optional(), deliveryState: z.enum(['queued', 'dispatching', 'accepted', 'failed', 'uncertain']),
  createdAt: z.string(), updatedAt: z.string(), refusalCode: z.string().optional(),
  // Optional for older phones, which ignore it: where a start or send stands (ADR-0073, October 14, 2026: outcomes).
  outcome: watcherOutcomeSchema.optional() }).strict()
const requestCard = z.object({ target: watcherThreadTargetSchema, title: z.string(), provider: providerIdSchema.nullable(),
  request: agentRequestSchema, connected: z.boolean(), mayAnswer: z.boolean() }).strict()
const count = z.number().int().nonnegative()
/** One machine on the phone's machines line and in its panel: the desktop's own words where they are sentences. */
const phoneMachine = z.object({ hostId: z.string().min(1).max(512), name: z.string().max(200), thisComputer: z.boolean(), connected: z.boolean(),
  working: count, starting: count, isDefault: z.boolean(),
  // Null while the machine has not been read, which says nothing of its load.
  cpuState: z.enum(['busy', 'not-busy', 'unknown']).nullable(), memoryState: z.enum(['short', 'enough', 'unknown']).nullable(),
  system: z.string().max(200).nullable(), logicalCpuCount: count.nullable(), totalMemoryBytes: z.number().nonnegative().nullable(),
  cpuBusyPercent: z.number().min(0).max(100).nullable(), windowMs: z.number().nonnegative().nullable(), availableMemoryBytes: z.number().nonnegative().nullable(),
  loadObservedAt: z.string().nullable(), unknownWhy: z.string().max(500).nullable(),
  threads: z.array(z.object({ title: z.string(), who: z.string() }).strict()).max(WATCHER_PHONE_MACHINE_THREADS_MAX) }).strict()
export const watcherPhoneMachinesSchema = z.object({ readAt: z.string().nullable(), rows: z.array(phoneMachine).max(WATCHER_MACHINES_MAX) }).strict()
export type WatcherPhoneMachines = z.infer<typeof watcherPhoneMachinesSchema>
export const watcherPhoneStateSchema = z.object({ hostId: z.uuid(),
  current: z.object({ target: watcherThreadTargetSchema, provider: providerIdSchema, modelId: z.string(),
    runtimeMode: agentRuntimeModeSchema.optional(),
    reasoningEffort: z.string().nullable(), status: z.enum(['idle', 'running', 'error']), connected: z.boolean(),
    // Watcher's speed, null at Standard; absent from older computers (WATCHER_PHONE_COMPOSER_FEATURE).
    speed: agentSpeedSchema.nullable().optional(),
    // For a phone that negotiated steering: whether Watcher's provider takes a steer into its running turn (#1229).
    steers: z.boolean().optional() }).strict().nullable(),
  conversation: z.object({ messages: z.array(agentMessageSchema), earlierAvailable: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  runtimeMode: agentRuntimeModeSchema.optional(), standingWatches: z.array(watcherStandingWatchSchema).optional(),
  ownChanges: z.array(watcherOwnChangeSchema).optional(),
  receiptGroups: z.array(z.object({ replyMessageId: z.string().nullable(), requestId: z.uuid(), rows: z.array(receipt) }).strict()),
  watchedThreads: z.array(z.object({ target: watcherThreadTargetSchema, title: z.string(), provider: providerIdSchema.nullable(),
    status: z.enum(['idle', 'running', 'error', 'unavailable']), connected: z.boolean(), watched: z.boolean(),
    paused: z.boolean().optional(),
    takenOver: z.boolean(), backgroundWorkCount: z.number().int().nonnegative() }).strict()),
  // Kept for host protocol version 1, which requires both: Watcher's starts still working, at most seven, and WATCHER_PHONE_LEGACY_LIMIT.
  needsYou: z.array(requestCard), inFlight: z.number().int().nonnegative(), inFlightLimit: z.number().int().min(1).max(8),
  working: z.boolean(), recoveryNotice: z.string().nullable(), observedAt: z.string(),
  draftDeliveries: z.array(z.object({ draftId: z.uuid(), status: z.enum(['queued', 'submitting', 'accepted', 'uncertain', 'failed']) }).strict()).optional(),
  /**
   * Takeover lines (CONTEXT.md), oldest first: each thread the user took over from the current Watcher by sending there,
   * its title as the room shows it and when. Optional for older phones, which ignore it (protocol version 1, additive).
   */
  takeovers: z.array(z.object({ target: watcherThreadTargetSchema, title: z.string(), at: z.string() }).strict()).max(WATCHER_PHONE_TAKEOVERS_MAX).optional(),
  /**
   * The user's own follow-ups waiting in Watcher's queue, from this phone or the desktop, first in line first: what goes
   * next, after Watcher's turn. Never a wake-up or Sotto's news. Only for a phone that negotiated steering (#1229).
   */
  followups: z.array(z.object({ itemId: z.uuid(), draftId: z.uuid(), text: z.string(),
    status: z.enum(['queued', 'dispatching', 'uncertain', 'failed', 'paused']) }).strict()).max(WATCHER_PHONE_FOLLOWUPS_MAX).optional(),
  /** Each machine and what works on it, for a phone that accepted WATCHER_PHONE_MACHINES_FEATURE (#1032). Older phones ignore it. */
  machines: watcherPhoneMachinesSchema.optional(),
  /**
   * For Watcher's box (WATCHER_PHONE_COMPOSER_FEATURE), absent from older computers: what New Watcher would answer now, as
   * the room says it; whether a handover of the last Watcher is offered to this one; and whether this Watcher replaced
   * an earlier conversation, for the note its empty conversation shows.
   */
  newWatcher: z.enum(['available', 'busy', 'empty']).optional(),
  handoverOffered: z.boolean().optional(),
  replaced: z.boolean().optional(),
  /**
   * Watcher's model, effort or speed chosen while it worked, which its next turn starts on, as the room says it. Sent from
   * computers that list WATCHER_PHONE_SETTINGS_LATER_FEATURE; older phones ignore it.
   */
  nextTurnOptions: watcherNextTurnOptionsSchema.optional(),
}).strict()
export const watcherPhoneResultSchema = z.union([z.object({ status: z.literal('ok'), state: watcherPhoneStateSchema }).strict(), watcherRefusalSchema])
export const watcherPhoneManageOutcomeSchema = z.union([z.object({ status: z.literal('ok') }).strict(), watcherRefusalSchema])
export type WatcherPhoneManageOutcome = z.infer<typeof watcherPhoneManageOutcomeSchema>
export const watcherPhoneSendResultSchema = z.union([z.object({ status: z.literal('ok'), draftId: z.uuid(), state: watcherPhoneStateSchema }).strict(), watcherRefusalSchema])
const stoppedTargets = z.array(z.object({ target: watcherThreadTargetSchema,
  status: z.enum(['stopped', 'requested', 'refused', 'uncertain']), message: z.string() }).strict())
/** A retained mutation outcome has no stale page snapshot; consumers read fresh state separately. */
export const watcherPhoneStopOutcomeSchema = z.union([z.object({ status: z.literal('ok'), results: stoppedTargets }).strict(), watcherRefusalSchema])
export const watcherPhoneStopResultSchema = z.union([z.object({ status: z.literal('ok'), state: watcherPhoneStateSchema,
  results: stoppedTargets }).strict(), watcherRefusalSchema])
export const watcherPhoneStopPreviewSchema = watcherStopAllPreviewSchema.extend({ targets: z.array(z.object({
  hostId: z.uuid(), threadId: z.string(), title: z.string(), provider: providerIdSchema.nullable() }).strict()) })
export const watcherPhonePrepareStopResultSchema = z.union([watcherPhoneStopPreviewSchema, watcherRefusalSchema])
export type WatcherPhoneState = z.infer<typeof watcherPhoneStateSchema>
export type WatcherPhoneOrigin = z.infer<typeof watcherPhoneOriginSchema>
export type WatcherPhoneSend = z.infer<typeof watcherPhoneSendSchema>
export type WatcherPhonePreview = z.infer<typeof watcherPhonePreviewSchema>
export type WatcherPhoneRemoveFollowup = z.infer<typeof watcherPhoneRemoveFollowupSchema>
export type WatcherPhoneOpen = z.infer<typeof watcherPhoneOpenSchema>
export type WatcherPhoneCurrent = z.infer<typeof watcherPhoneCurrentSchema>
export type WatcherPhoneAnswer = z.infer<typeof watcherPhoneAnswerSchema>
export type WatcherPhoneResult = z.infer<typeof watcherPhoneResultSchema>
export type WatcherPhoneSendResult = z.infer<typeof watcherPhoneSendResultSchema>
export type WatcherPhoneStopResult = z.infer<typeof watcherPhoneStopResultSchema>
export type WatcherPhoneStopOutcome = z.infer<typeof watcherPhoneStopOutcomeSchema>
export type WatcherPhonePrepareStopResult = z.infer<typeof watcherPhonePrepareStopResultSchema>
