import { z } from 'zod'
import { agentMessageSchema, agentRequestSchema, agentQuestionAnswersSchema, providerIdSchema } from './agents'
import { watcherRefusalSchema, watcherThreadTargetSchema, watcherPhoneOriginSchema } from './watcher'
export { watcherPhoneOriginSchema } from './watcher'
import { watcherStopAllPreviewSchema } from './watcherRoom'

/** Optional host-v1 phone features, offered only by the Owl desktop running Watcher. */
export const WATCHER_PHONE_FEATURE = 'watcher-phone' as const
export const WATCHER_PHONE_STOP_FEATURE = 'watcher-phone-stop-all' as const
export const watcherPhoneSendSchema = z.object({ origin: watcherPhoneOriginSchema, target: watcherThreadTargetSchema,
  draftId: z.uuid(), text: z.string().min(1).max(20_000).refine(text => text.trim().length > 0) }).strict()
const id = z.string().min(1).max(512)
const answer = z.object({ type: z.literal('answer'), threadId: id, requestId: id, answer: z.string().max(20_000),
  approved: z.boolean().optional(), questionAnswers: agentQuestionAnswersSchema.optional(), permissionChoice: id.optional() }).strict()
export const watcherPhoneAnswerSchema = z.object({ target: watcherThreadTargetSchema,
  command: answer }).strict()
const receipt = z.object({ operationId: z.uuid(), target: watcherThreadTargetSchema, title: z.string(),
  provider: providerIdSchema.nullable(), action: z.enum(['start', 'send', 'stop', 'settle']),
  delivery: z.enum(['now', 'queue', 'steer']).optional(), deliveryState: z.enum(['queued', 'dispatching', 'accepted', 'failed', 'uncertain']),
  createdAt: z.string(), updatedAt: z.string(), refusalCode: z.string().optional() }).strict()
const requestCard = z.object({ target: watcherThreadTargetSchema, title: z.string(), provider: providerIdSchema.nullable(),
  request: agentRequestSchema, connected: z.boolean(), mayAnswer: z.boolean() }).strict()
export const watcherPhoneStateSchema = z.object({ hostId: z.uuid(),
  current: z.object({ target: watcherThreadTargetSchema, provider: providerIdSchema, modelId: z.string(),
    reasoningEffort: z.string().nullable(), status: z.enum(['idle', 'running', 'error']), connected: z.boolean() }).strict().nullable(),
  conversation: z.object({ messages: z.array(agentMessageSchema), earlierAvailable: z.boolean(), revision: z.number().int().nonnegative() }).strict(),
  receiptGroups: z.array(z.object({ replyMessageId: z.string().nullable(), requestId: z.uuid(), rows: z.array(receipt) }).strict()),
  watchedThreads: z.array(z.object({ target: watcherThreadTargetSchema, title: z.string(), provider: providerIdSchema.nullable(),
    status: z.enum(['idle', 'running', 'error', 'unavailable']), connected: z.boolean(), watched: z.boolean(),
    takenOver: z.boolean(), backgroundWorkCount: z.number().int().nonnegative() }).strict()),
  needsYou: z.array(requestCard), inFlight: z.number().int().nonnegative(), inFlightLimit: z.number().int().min(1).max(8),
  working: z.boolean(), recoveryNotice: z.string().nullable(), observedAt: z.string(),
  draftDeliveries: z.array(z.object({ draftId: z.uuid(), status: z.enum(['queued', 'submitting', 'accepted', 'uncertain', 'failed']) }).strict()).optional(),
}).strict()
export const watcherPhoneResultSchema = z.union([z.object({ status: z.literal('ok'), state: watcherPhoneStateSchema }).strict(), watcherRefusalSchema])
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
export type WatcherPhoneAnswer = z.infer<typeof watcherPhoneAnswerSchema>
export type WatcherPhoneResult = z.infer<typeof watcherPhoneResultSchema>
export type WatcherPhoneSendResult = z.infer<typeof watcherPhoneSendResultSchema>
export type WatcherPhoneStopResult = z.infer<typeof watcherPhoneStopResultSchema>
export type WatcherPhoneStopOutcome = z.infer<typeof watcherPhoneStopOutcomeSchema>
export type WatcherPhonePrepareStopResult = z.infer<typeof watcherPhonePrepareStopResultSchema>
