import { z } from 'zod'
import { watcherIdentitySchema, watcherOperationSchema, watcherParticipantSchema, watcherRefusalSchema,
  watcherRequestSchema, watcherProviderSchema, watcherThreadTargetSchema, watcherEvidenceSchema } from './watcher'
import { watcherEventSchema } from './watcherNews'
import { agentRuntimeModeSchema } from './agents'
import { watcherOwnChangeSchema, watcherStandingWatchSchema } from './watcher'

/** Private desktop channels. A host may project the same state later without acquiring command authority. */
export const WATCHER_GET = 'sotto:watcher:get'
export const WATCHER_OPEN = 'sotto:watcher:open'
export const WATCHER_CHANGED = 'sotto:watcher:changed'
export const WATCHER_PREPARE_STOP_ALL = 'sotto:watcher:prepare-stop-all'
export const WATCHER_STOP_ALL = 'sotto:watcher:stop-all'
export const WATCHER_SET_LIMIT = 'sotto:watcher:set-limit'
export const WATCHER_SET_PERMISSION = 'sotto:watcher:set-permission'
export const WATCHER_WATCH_THREAD = 'sotto:watcher:watch-thread'
export const WATCHER_UNWATCH_THREAD = 'sotto:watcher:unwatch-thread'
export const WATCHER_RENDERER_ARGUMENT = '--sotto-watcher-enabled'
/** Retained previews per desktop room or authenticated paired phone, never a shared capacity. */
export const WATCHER_STOP_ALL_PREVIEW_LIMIT = 16

const timestamp = z.iso.datetime({ offset: true })
const pending = z.object({ id: z.string(), kind: z.enum(['question', 'permission']),
  openTarget: watcherThreadTargetSchema }).strict()
export const watcherRoomStateSchema = z.object({
  current: watcherIdentitySchema.nullable(),
  currentOptions: z.object({ modelId: z.string(), reasoningEffort: z.string().nullable(),
    runtimeMode: agentRuntimeModeSchema.optional(),
    status: z.enum(['idle', 'running', 'error']), connected: z.boolean() }).strict().nullable(),
  history: z.array(watcherIdentitySchema),
  runtimeMode: agentRuntimeModeSchema.optional(),
  standingWatches: z.array(watcherStandingWatchSchema).optional(), ownChanges: z.array(watcherOwnChangeSchema).optional(),
  requests: z.array(watcherRequestSchema),
  watchedThreads: z.array(z.object({ target: watcherThreadTargetSchema, title: z.string(),
    watched: z.boolean().optional(), paused: z.boolean().optional(),
    status: z.enum(['idle', 'running', 'error', 'unavailable']), connected: z.boolean(),
    settled: z.boolean(), backgroundWorkCount: z.number().int().nonnegative(),
    waitsOn: z.array(pending), participation: z.array(watcherParticipantSchema),
    evidence: z.array(watcherEvidenceSchema).max(100).optional(),
    observation: z.object({ observedAt: timestamp, fresh: z.boolean(), connectedAt: timestamp.optional(), lastProgressAt: timestamp.optional() }).strict().optional() }).strict()),
  inFlight: z.number().int().nonnegative(), inFlightLimit: z.number().int().min(1).max(8),
  receipts: z.array(watcherOperationSchema), news: z.array(watcherEventSchema).max(400).optional(),
  recoveryNotice: z.string().nullable(), observedAt: timestamp,
}).strict()
export const watcherOpenRequestSchema = z.object({ provider: watcherProviderSchema,
  modelId: z.string().min(1).max(512), reasoningEffort: z.string().min(1).max(64).optional() }).strict()
export const watcherRoomResultSchema = z.union([
  z.object({ status: z.literal('ok'), state: watcherRoomStateSchema }).strict(), watcherRefusalSchema,
])
export const watcherStopAllPreviewSchema = z.object({ status: z.literal('ok'), confirmationId: z.uuid(),
  targets: z.array(watcherThreadTargetSchema), expiresAt: timestamp }).strict()
export const watcherPrepareStopAllResultSchema = z.union([watcherStopAllPreviewSchema, watcherRefusalSchema])
export const watcherStopAllRequestSchema = z.object({ confirmationId: z.uuid() }).strict()
export const watcherStopAllResultSchema = z.union([
  z.object({ status: z.literal('ok'), state: watcherRoomStateSchema,
    results: z.array(z.object({ target: watcherThreadTargetSchema, status: z.enum(['stopped', 'requested', 'refused', 'uncertain']),
      message: z.string() }).strict()) }).strict(), watcherRefusalSchema,
])
export const watcherSetLimitRequestSchema = z.object({ limit: z.number().int().min(1).max(8) }).strict()
export const watcherSetPermissionRequestSchema = z.object({ runtimeMode: agentRuntimeModeSchema }).strict()
export const watcherWatchThreadRequestSchema = z.object({ target: watcherThreadTargetSchema }).strict()
export type WatcherSetPermissionRequest = z.infer<typeof watcherSetPermissionRequestSchema>
export type WatcherWatchThreadRequest = z.infer<typeof watcherWatchThreadRequestSchema>

export type WatcherRoomState = z.infer<typeof watcherRoomStateSchema>
type WatcherRoomRow = WatcherRoomState['watchedThreads'][number]

/**
 * Whether Watcher takes part in a thread through one of `activeRequestIds`, and neither the user has taken the thread
 * over nor Watcher stopped. With a standing watch, this is what makes a thread watched.
 */
export function takesPartInActiveRequest(participation: WatcherRoomRow['participation'], activeRequestIds: ReadonlySet<string>): boolean {
  return participation.some(part => activeRequestIds.has(part.requestId) && part.state === 'participating' && !part.automationStopped)
}

/**
 * Whether Watcher watches a row's thread. Main marks every row `watched`: under a standing watch, or taking part in an
 * active Watcher request. A projection from before standing watches has no mark, and there participation decides.
 * The room, the Threads page and the iPhone's projection all ask this, so there is one answer.
 */
export function isWatchedRow(row: WatcherRoomRow, requests: WatcherRoomState['requests']): boolean {
  return row.watched ?? takesPartInActiveRequest(row.participation, new Set(requests.filter(request => request.state === 'active').map(request => request.id)))
}
export type WatcherOpenRequest = z.infer<typeof watcherOpenRequestSchema>
export type WatcherRoomResult = z.infer<typeof watcherRoomResultSchema>
export type WatcherPrepareStopAllResult = z.infer<typeof watcherPrepareStopAllResultSchema>
export type WatcherStopAllRequest = z.infer<typeof watcherStopAllRequestSchema>
export type WatcherStopAllResult = z.infer<typeof watcherStopAllResultSchema>
export type WatcherSetLimitRequest = z.infer<typeof watcherSetLimitRequestSchema>

/** Absent in stable builds. Opening/creating Watcher never selects a project or thread. */
export interface WatcherBridge {
  get(): Promise<WatcherRoomResult>
  open(request: WatcherOpenRequest): Promise<WatcherRoomResult>
  prepareStopAll(): Promise<WatcherPrepareStopAllResult>
  stopAll(request: WatcherStopAllRequest): Promise<WatcherStopAllResult>
  setLimit(request: WatcherSetLimitRequest): Promise<WatcherRoomResult>
  /** Older room stand-ins omit management. The real Owl preload supplies all three methods. */
  setPermission?(request: WatcherSetPermissionRequest): Promise<WatcherRoomResult>
  watchThread?(request: WatcherWatchThreadRequest): Promise<WatcherRoomResult>
  unwatchThread?(request: WatcherWatchThreadRequest): Promise<WatcherRoomResult>
  onChanged(listener: (state: WatcherRoomState) => void): () => void
}
