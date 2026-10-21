import { z } from 'zod'
import { watcherIdentitySchema, watcherOperationSchema, watcherParticipantSchema, watcherRefusalSchema,
  watcherRequestSchema, watcherProviderSchema, watcherThreadTargetSchema, watcherEvidenceSchema } from './watcher'
import { watcherEventSchema } from './watcherNews'
import { watcherAskSchema } from './watcherAsks'
import { agentRuntimeModeSchema, handoverCountsSchema, isVisualMessage, type AgentMessage } from './agents'
import { watcherKeptStateSchema, watcherOwnChangeSchema, watcherStandingWatchSchema, watcherStateThreadSchema, type WatcherThreadTarget } from './watcher'

/** Private desktop channels. A host may project the same state later without acquiring command authority. */
export const WATCHER_GET = 'sotto:watcher:get'
export const WATCHER_OPEN = 'sotto:watcher:open'
export const WATCHER_CHANGED = 'sotto:watcher:changed'
export const WATCHER_PREPARE_STOP_ALL = 'sotto:watcher:prepare-stop-all'
export const WATCHER_STOP_ALL = 'sotto:watcher:stop-all'
export const WATCHER_SET_PERMISSION = 'sotto:watcher:set-permission'
export const WATCHER_WATCH_THREAD = 'sotto:watcher:watch-thread'
export const WATCHER_UNWATCH_THREAD = 'sotto:watcher:unwatch-thread'
export const WATCHER_READ_HANDOVER = 'sotto:watcher:read-handover'
export const WATCHER_CONTINUE_HANDOVER = 'sotto:watcher:continue-handover'
export const WATCHER_DISMISS_HANDOVER = 'sotto:watcher:dismiss-handover'
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
  receipts: z.array(watcherOperationSchema), news: z.array(watcherEventSchema).max(400).optional(),
  recoveryNotice: z.string().nullable(), observedAt: timestamp,
  /**
   * The handover of the last Watcher offered to the current one after a provider change, until its first message goes
   * or the user puts the offer away (ADR-0073): where it comes from and what it carries, in counts. Never its words.
   */
  handover: z.object({ source: watcherThreadTargetSchema, provider: watcherProviderSchema, counts: handoverCountsSchema }).strict().nullable().optional(),
  /**
   * Where each of the current Watcher's receipts goes in its conversation (ADR-0073, receipt cards): the message it is
   * shown under, the last reply of the Watcher turn that took the action, or that turn's own message while no reply has
   * come. Found from the record's turn for the operation, never from anyone's words. A receipt with no entry is not shown
   * there: its turn is not in the conversation the window holds.
   */
  receiptReplies: z.array(z.object({ operationId: z.uuid(), messageId: z.string() }).strict()).optional(),
  /**
   * Watcher's conversation against the point where Sotto compacts it (#1189): its context in tokens as its provider last
   * reported it, null when unreported, whether its provider can compact it, and whether a compaction is under way.
   */
  context: z.object({ tokens: z.number().int().nonnegative().nullable(), compactAt: z.number().int().positive(),
    canCompact: z.boolean(), compacting: z.boolean() }).strict().nullable().optional(),
  /** Watcher's state, kept through compaction (#1189): what each watched thread waits on, and what Watcher kept. */
  // `unread` while a saved state could not be read: the lists are not what is kept, and the panel says so.
  state: z.object({ watching: z.array(watcherStateThreadSchema), kept: watcherKeptStateSchema, unread: z.literal(true).optional() }).strict().optional(),
  /**
   * The requests the current Watcher's wake-ups said waited on the user, oldest first, each with the message of its
   * conversation the request's card goes under (ADR-0073, answering in Watcher's conversation): the reply of the turn
   * the wake-up began, or the message before it while that turn has none. Identities alone, from the host's record of
   * each wake-up. The card itself is drawn from the thread's live request, never from here, and answers only as the
   * user's own answer from that card. A wake-up outside the window main holds places nothing.
   */
  asks: z.array(watcherAskSchema.extend({ messageId: z.string(), wakeUpMessageId: z.string() }).strict()).optional(),
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
export const watcherSetPermissionRequestSchema = z.object({ runtimeMode: agentRuntimeModeSchema }).strict()
export const watcherWatchThreadRequestSchema = z.object({ target: watcherThreadTargetSchema }).strict()
export type WatcherSetPermissionRequest = z.infer<typeof watcherSetPermissionRequestSchema>
/** Continue with the handover: the draft whose send carries it ahead of the user's words. */
export const watcherContinueHandoverRequestSchema = z.object({ draftId: z.uuid() }).strict()
export type WatcherContinueHandoverRequest = z.infer<typeof watcherContinueHandoverRequestSchema>
/** The offered handover's words, as the new Watcher would receive them, read only when the user asks to read it. */
export const watcherHandoverReadSchema = z.union([
  z.object({ status: z.literal('ok'), text: z.string(), counts: handoverCountsSchema }).strict(), watcherRefusalSchema,
])
export type WatcherHandoverRead = z.infer<typeof watcherHandoverReadSchema>
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
/**
 * A Watcher reply the transcript draws: an assistant message with words or attachments, never a visual (the
 * transcript's own rule for what it draws). Main places receipt cards by it and the window places takeover lines by it,
 * so both mean the same reply.
 */
export function isShownReply(message: Pick<AgentMessage, 'id' | 'role' | 'text' | 'attachments' | 'visual'>): boolean {
  return message.role === 'assistant' && !isVisualMessage(message) && (message.text.length > 0 || Boolean(message.attachments?.length))
}

/** One takeover line (CONTEXT.md): the user sent in a thread the current Watcher was driving, and when. */
export interface WatcherTakeover { readonly target: WatcherThreadTarget; readonly at: string }

/**
 * The takeover lines for Watcher's conversation, oldest first: each thread the user took over by sending there while
 * the current Watcher drove it for one of its requests. A standing watch is paused by such a send, not taken over, so
 * it has no line; nor has a stop, a settle or a change of options, which take a thread over without a send. One send
 * that ended several requests' work on a thread is one line.
 */
export function watcherTakeovers(room: Pick<WatcherRoomState, 'current' | 'requests'>): WatcherTakeover[] {
  const watcher = room.current?.target
  if (!watcher) return []
  const lines = new Map<string, WatcherTakeover>()
  for (const request of room.requests) {
    if (request.standingWatchId !== undefined || request.watcher.hostId !== watcher.hostId || request.watcher.threadId !== watcher.threadId) continue
    for (const participant of request.participants) {
      const takeover = participant.takeover
      if (participant.state !== 'taken-over' || !takeover || (takeover.reason !== 'user-send' && takeover.reason !== 'native-user-send')) continue
      lines.set(JSON.stringify([participant.target.hostId, participant.target.threadId, takeover.at]), { target: participant.target, at: takeover.at })
    }
  }
  return [...lines.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/**
 * The threads Stop all is offered for: started by Watcher for a request that is still active, still Watcher's (not
 * taken over or let go), and running now, a turn or work it left in the background. Main's own preview decides what a
 * press stops; this decides only whether the room offers it.
 */
export function stopAllRunning(room: Pick<WatcherRoomState, 'requests' | 'watchedThreads'>): WatcherThreadTarget[] {
  const running = new Map(room.watchedThreads.filter(row => row.status === 'running' || row.backgroundWorkCount > 0)
    .map(row => [JSON.stringify([row.target.hostId, row.target.threadId]), row.target] as const))
  const found = new Map<string, WatcherThreadTarget>()
  for (const request of room.requests) {
    if (request.state !== 'active') continue
    for (const participant of request.participants) {
      const key = JSON.stringify([participant.target.hostId, participant.target.threadId])
      if (participant.startedBy === 'watcher' && participant.state === 'participating' && running.has(key)) found.set(key, running.get(key)!)
    }
  }
  return [...found.values()]
}
export type WatcherOpenRequest = z.infer<typeof watcherOpenRequestSchema>
export type WatcherRoomResult = z.infer<typeof watcherRoomResultSchema>
export type WatcherPrepareStopAllResult = z.infer<typeof watcherPrepareStopAllResultSchema>
export type WatcherStopAllRequest = z.infer<typeof watcherStopAllRequestSchema>
export type WatcherStopAllResult = z.infer<typeof watcherStopAllResultSchema>

/** Absent in stable builds. Opening/creating Watcher never selects a project or thread. */
export interface WatcherBridge {
  get(): Promise<WatcherRoomResult>
  open(request: WatcherOpenRequest): Promise<WatcherRoomResult>
  prepareStopAll(): Promise<WatcherPrepareStopAllResult>
  stopAll(request: WatcherStopAllRequest): Promise<WatcherStopAllResult>
  /** Older room stand-ins omit management. The real Owl preload supplies all three methods. */
  setPermission?(request: WatcherSetPermissionRequest): Promise<WatcherRoomResult>
  watchThread?(request: WatcherWatchThreadRequest): Promise<WatcherRoomResult>
  unwatchThread?(request: WatcherWatchThreadRequest): Promise<WatcherRoomResult>
  /** The handover after a provider change (ADR-0073). Older stand-ins omit them; the real Owl preload supplies all three. */
  readHandover?(): Promise<WatcherHandoverRead>
  continueWithHandover?(request: WatcherContinueHandoverRequest): Promise<WatcherRoomResult>
  dismissHandover?(): Promise<WatcherRoomResult>
  onChanged(listener: (state: WatcherRoomState) => void): () => void
}
