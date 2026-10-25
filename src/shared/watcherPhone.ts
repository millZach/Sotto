import { z } from 'zod'
import { agentAttachmentHandlesSchema, agentMessageSchema, agentRequestSchema, agentQuestionAnswersSchema, providerIdSchema, agentRuntimeModeSchema } from './agents'
import { watcherRefusalSchema, watcherThreadTargetSchema, watcherPhoneOriginSchema, watcherOwnChangeSchema, watcherStandingWatchSchema, watcherOutcomeSchema } from './watcher'
export { watcherPhoneOriginSchema } from './watcher'
import { watcherStopAllPreviewSchema } from './watcherRoom'

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
 * Photos for Watcher from the phone (October 23, 2026): a send may carry `images`, the handles `stage-attachment` answered,
 * with or without words, and `watcher-phone-preview` reads one of a Watcher message's photos, which the page marks.
 */
export const WATCHER_PHONE_PHOTOS_FEATURE = 'watcher-phone-photos' as const
/** How many of the user's follow-ups waiting for Watcher a phone's page carries, the first in line. */
export const WATCHER_PHONE_FOLLOWUPS_MAX = 50
export const watcherPhoneSetPermissionSchema = z.object({ runtimeMode: agentRuntimeModeSchema }).strict()
export const watcherPhoneWatchSchema = z.object({ target: watcherThreadTargetSchema }).strict()
export const watcherPhoneSendSchema = z.object({ origin: watcherPhoneOriginSchema, target: watcherThreadTargetSchema,
  draftId: z.uuid(), text: z.string().max(20_000),
  // Only from a phone offered WATCHER_PHONE_PHOTOS_FEATURE: the photos it staged, which go with the words.
  images: agentAttachmentHandlesSchema.min(1).optional(),
  // Only from a phone that negotiated WATCHER_PHONE_STEER_FEATURE: while Watcher works the message steers into its turn,
  // or goes next as its own turn when it cannot. Absent, a send while Watcher works is refused, as before (#1229).
  delivery: z.literal('steer').optional() }).strict()
  .refine(send => send.text.trim().length > 0 || send.images !== undefined, 'Send words, photos or both.')
/** One photo of a message in Watcher's conversation, for the phone to draw: Watcher's thread is never a phone's to read. */
export const watcherPhonePreviewSchema = z.object({ target: watcherThreadTargetSchema, messageId: z.string().min(1).max(512),
  attachmentId: z.string().min(1).max(512) }).strict()
/** Takes one of the user's follow-ups out of Watcher's queue, by its queue item ID, before it goes (#1229). */
export const watcherPhoneRemoveFollowupSchema = z.object({ target: watcherThreadTargetSchema, itemId: z.uuid() }).strict()
const id = z.string().min(1).max(512)
const answer = z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: z.string().max(20_000),
  approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional() }).strict()
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
export const watcherPhoneStateSchema = z.object({ hostId: z.uuid(),
  current: z.object({ target: watcherThreadTargetSchema, provider: providerIdSchema, modelId: z.string(),
    runtimeMode: agentRuntimeModeSchema.optional(),
    reasoningEffort: z.string().nullable(), status: z.enum(['idle', 'running', 'error']), connected: z.boolean(),
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
export type WatcherPhoneAnswer = z.infer<typeof watcherPhoneAnswerSchema>
export type WatcherPhoneResult = z.infer<typeof watcherPhoneResultSchema>
export type WatcherPhoneSendResult = z.infer<typeof watcherPhoneSendResultSchema>
export type WatcherPhoneStopResult = z.infer<typeof watcherPhoneStopResultSchema>
export type WatcherPhoneStopOutcome = z.infer<typeof watcherPhoneStopOutcomeSchema>
export type WatcherPhonePrepareStopResult = z.infer<typeof watcherPhonePrepareStopResultSchema>
