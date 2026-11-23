import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema } from './agents'
import { COORDINATION_HOP_MAX, COORDINATION_NEWS_MAX, COORDINATION_REPLY_BYTES_MAX, COORDINATION_WAIT_MAX_SECONDS,
  coordinateListThreadsInputSchema, coordinateReadThreadInputSchema, coordinateSendInputSchema, coordinationExchangeViewSchema,
  coordinationNewsSchema } from './threadCoordination'

/**
 * Cross-machine parent-to-parent coordination relay schemas (ADR-0216, Slice 3).
 * All Zod schemas live at module scope so no call builds a parser at runtime (`zodSchemaSites.test.ts`).
 */
const id = z.string().min(1).max(512)

/** Default timeout for fast cross-machine reads (`list_threads`, `read_thread`, `read_exchange`). */
export const COORDINATION_RELAY_READ_TIMEOUT_MS = 15_000
/** Maximum timeout for a cross-machine `send_to_thread` carrying `wait_seconds`. */
export const COORDINATION_RELAY_SEND_TIMEOUT_MS = (COORDINATION_WAIT_MAX_SECONDS + 30) * 1000

/** Verified metadata describing the remote calling parent thread; target hosts clamp `runtimeMode` by their own grant. */
export const coordinationRemoteCallerSchema = z.object({
  threadId: id,
  hostId: id,
  machineName: z.string().max(128).optional(),
  title: z.string().max(512),
  projectId: id,
  provider: providerIdSchema.optional(),
  runtimeMode: agentRuntimeModeSchema.optional(),
  chainId: z.uuid().optional(),
  hopCount: z.number().int().min(1).max(COORDINATION_HOP_MAX + 1).optional(),
  rootUserMessageId: id.optional(),
  anchorMessageId: id.optional(),
}).strict()
export type CoordinationRemoteCaller = z.infer<typeof coordinationRemoteCallerSchema>

/** Request sent from the desktop to a paired host (`coordination-remote-ask`) to serve a peer coordination call there. */
export const coordinationRemoteAskSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('list'),
    caller: coordinationRemoteCallerSchema,
    input: coordinateListThreadsInputSchema,
  }).strict(),
  z.object({
    type: z.literal('read'),
    caller: coordinationRemoteCallerSchema,
    input: coordinateReadThreadInputSchema,
  }).strict(),
  z.object({
    type: z.literal('send'),
    exchangeId: z.uuid(),
    caller: coordinationRemoteCallerSchema,
    input: coordinateSendInputSchema,
  }).strict(),
  z.object({
    type: z.literal('read-exchange'),
    caller: coordinationRemoteCallerSchema,
    exchangeId: z.uuid(),
  }).strict(),
])
export type CoordinationRemoteAsk = z.infer<typeof coordinationRemoteAskSchema>

/** Request pushed from a paired host to the desktop relay (`coordination-relay-ask`) to reach the desktop or another paired host. */
export const coordinationRelayAskSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('list'),
    targetHostId: z.string().min(1).max(128),
    caller: coordinationRemoteCallerSchema,
    input: coordinateListThreadsInputSchema,
  }).strict(),
  z.object({
    type: z.literal('read'),
    targetHostId: id,
    caller: coordinationRemoteCallerSchema,
    input: coordinateReadThreadInputSchema,
  }).strict(),
  z.object({
    type: z.literal('send'),
    targetHostId: id,
    exchangeId: z.uuid(),
    caller: coordinationRemoteCallerSchema,
    input: coordinateSendInputSchema,
  }).strict(),
  z.object({
    type: z.literal('read-exchange'),
    targetHostId: id,
    caller: coordinationRemoteCallerSchema,
    exchangeId: z.uuid(),
  }).strict(),
])
export type CoordinationRelayAsk = z.infer<typeof coordinationRelayAskSchema>

/** Reply text carried in memory across the relay for wake-up dispatch (never persisted in `followups.json` or `thread-coordination.json`). */
export const coordinationRelayedReplySchema = z.object({
  exchangeId: z.uuid(),
  messageId: id,
  text: z.string().max(COORDINATION_REPLY_BYTES_MAX),
  truncated: z.boolean(),
}).strict()
export type CoordinationRelayedReply = z.infer<typeof coordinationRelayedReplySchema>

export const coordinationRelayedRepliesSchema = z.array(coordinationRelayedReplySchema).max(COORDINATION_NEWS_MAX)

/** Outcome push from a target paired host back to the asking desktop (`coordination-remote-news`). */
export const coordinationRemoteNewsSchema = z.object({
  callerThreadId: id,
  callerHostId: id,
  news: coordinationNewsSchema,
  replies: coordinationRelayedRepliesSchema.optional(),
  exchange: coordinationExchangeViewSchema.optional(),
}).strict()
export type CoordinationRemoteNews = z.infer<typeof coordinationRemoteNewsSchema>
