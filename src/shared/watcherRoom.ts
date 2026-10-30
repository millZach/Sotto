import { z } from 'zod'
import { watcherIdentitySchema, watcherOperationSchema, watcherParticipantSchema, watcherRefusalSchema,
  watcherRequestSchema, watcherProviderSchema, watcherThreadTargetSchema, watcherEvidenceSchema, watcherToolSchemas } from './watcher'
import { workerPlacementReceiptSchema } from './workerMachine'
import { watcherEventSchema } from './watcherNews'
import { watcherAskSchema } from './watcherAsks'
import { agentRuntimeModeSchema, agentSpeedSchema, handoverCountsSchema, isVisualMessage, type AgentMessage } from './agents'
import { watcherKeptStateSchema, watcherOwnChangeSchema, watcherStandingWatchSchema, watcherStateThreadSchema, watcherWaitingOnUserSchema, type WatcherThreadTarget } from './watcher'

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
/** New Watcher: a new conversation on the current Watcher's own provider, model, effort and permissions (ADR-0073). */
export const WATCHER_START_NEW = 'sotto:watcher:start-new'
export const WATCHER_RENDERER_ARGUMENT = '--sotto-watcher-enabled'
/**
 * The machines for the room's machines line and Settings, under Watcher (#1032, Owl `cross-machine-work`): Watcher's own
 * list_machines, read when asked, never pushed with the room's state. Registered, and offered by the preload, only while
 * Work across machines is on, which `WATCHER_MACHINES_RENDERER_ARGUMENT` tells the window.
 */
export const WATCHER_READ_MACHINES = 'sotto:watcher:read-machines'
export const WATCHER_MACHINES_RENDERER_ARGUMENT = '--sotto-watcher-machines-enabled'
/** Retained previews per desktop room or authenticated paired phone, never a shared capacity. */
export const WATCHER_STOP_ALL_PREVIEW_LIMIT = 16

const timestamp = z.iso.datetime({ offset: true })
const pending = z.object({ id: z.string(), kind: z.enum(['question', 'permission']),
  openTarget: watcherThreadTargetSchema }).strict()
export const watcherRoomStateSchema = z.object({
  current: watcherIdentitySchema.nullable(),
  currentOptions: z.object({ modelId: z.string(), reasoningEffort: z.string().nullable(), speed: agentSpeedSchema.nullable().optional(),
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
   * Which build of the room this is: main numbers every room it builds, counting up, so of two rooms the higher is the
   * newer even when both were read in the same millisecond (#1450). The window orders rooms by it and keeps `observedAt`
   * for what it shows. Absent from rooms main did not build, such as the e2e stand-in's; they are ordered by time.
   */
  sequence: z.number().int().nonnegative().optional(),
  /**
   * The handover of the last Watcher offered to the current one after a provider change or New Watcher, until its first message goes
   * or the user puts the offer away (ADR-0073): where it comes from and what it carries, in counts. Never its words.
   */
  handover: z.object({ source: watcherThreadTargetSchema, provider: watcherProviderSchema, counts: handoverCountsSchema }).strict().nullable().optional(),
  /**
   * Whether the current Watcher's creation stopped part-way and nothing is finishing it now: its thread may not exist, so
   * the room says so and offers to try again, which finishes it with the choice it was saved with. Absent from older hosts.
   */
  creationStopped: z.boolean().optional(),
  /**
   * What New Watcher would answer now, by main's own conditions: unavailable while Watcher's own turn runs, unless that turn
   * waits on a card of Watcher's (#1735), or while its conversation has said nothing.
   * Absent with no Watcher thread, and from older hosts; a press still asks main. A word rather than an object, so a
   * publish makes nothing new for it (ownerScaleWorkBudget).
   */
  newWatcher: z.enum(['available', 'busy', 'empty']).optional(),
  /**
   * What the replacement that made the current Watcher carried over (#1735), for the new Watcher's note while it has said
   * nothing: whether the last one's card was closed, how many of the user's messages moved to its queue paused, whether the
   * user's last message to the last one went unconfirmed, whether what the user left in its message box moved to the new
   * one's, and the threads it cannot direct on a computer whose Sotto is older, by computer, named. Absent when there is nothing to say; made once per replacement, never per publish.
   */
  carried: z.object({ questionClosed: z.boolean(), questionOpen: z.literal(true).optional(), moved: z.number().int().min(0).max(100), unconfirmed: z.boolean(), draftMoved: z.boolean().optional(),
    cannotStop: z.array(z.object({ host: z.string().min(1).max(200), count: z.number().int().min(1).max(1_000),
      titles: z.array(z.string().min(1).max(200)).max(20).optional() }).strict()).max(100) }).strict().optional(),
  /**
   * Where each of the current Watcher's receipts goes in its conversation (ADR-0073, receipt cards): the message it is
   * shown under, the last reply of the Watcher turn that took the action, or that turn's own message while no reply has
   * come. Found from the record's turn for the operation, never from anyone's words. A receipt with no entry is not shown
   * there: its turn is not in the conversation the window holds.
   */
  receiptReplies: z.array(z.object({ operationId: z.uuid(), messageId: z.string() }).strict()).optional(),
  /**
   * Where each start Watcher made this run was placed (#1032, Owl `cross-machine-work`): the machine, whether it is away from
   * where new workers start, and Sotto's sentence saying why when it chose itself. Kept in memory as the receipt's
   * `placement` is, so a restart has none. Absent while Work across machines is off and from older hosts.
   */
  receiptPlacements: z.array(z.object({ operationId: z.uuid(), placement: workerPlacementReceiptSchema }).strict()).max(1_000).optional(),
  /**
   * Watcher's conversation against the point where Sotto compacts it (#1189): its context in tokens as its provider last
   * reported it, null when unreported, whether its provider can compact it, and whether a compaction is under way.
   */
  context: z.object({ tokens: z.number().int().nonnegative().nullable(), compactAt: z.number().int().positive(),
    canCompact: z.boolean(), compacting: z.boolean() }).strict().nullable().optional(),
  /**
   * Watcher's state (#1189): what each watched thread waits on, what waits on the user among them, worked out live
   * (October 24, 2026), and what Watcher kept.
   */
  // `unread` while a saved state could not be read: the lists are not what is kept, and the panel says so.
  state: z.object({ watching: z.array(watcherStateThreadSchema), waitingOnUser: z.array(watcherWaitingOnUserSchema), kept: watcherKeptStateSchema,
    unread: z.literal(true).optional() }).strict().optional(),
  /**
   * The requests the current Watcher's wake-ups said waited on the user, oldest first, each with the message of its
   * conversation the request's card goes under (ADR-0073, answering in Watcher's conversation): the reply of the turn
   * the wake-up began, or the message before it while that turn has none. Identities alone, from the host's record of
   * each wake-up. The card itself is drawn from the thread's live request, never from here, and answers only as the
   * user's own answer from that card. A wake-up outside the window main holds places nothing.
   */
  asks: z.array(watcherAskSchema.extend({ messageId: z.string(), wakeUpMessageId: z.string() }).strict()).optional(),
  /**
   * The archived work Watcher's conversation, shown back past what the record keeps, read back from Watcher's archive
   * (#1759): its receipts, where each goes, its requests and where this run placed its starts. Kept apart from the
   * record's own lists and the same object until another read back, so an update carries none of it again and a room
   * build copies none of it. A reader joins the two with `watcherRoomWork`, the record's winning. Absent while nothing
   * was read back, and from older hosts.
   */
  recalled: z.object({ receipts: z.array(watcherOperationSchema), receiptReplies: z.array(z.object({ operationId: z.uuid(), messageId: z.string() }).strict()),
    requests: z.array(watcherRequestSchema), receiptPlacements: z.array(z.object({ operationId: z.uuid(), placement: workerPlacementReceiptSchema }).strict()).optional() }).strict().optional(),
}).strict()
export const watcherOpenRequestSchema = z.object({ provider: watcherProviderSchema,
  modelId: z.string().min(1).max(512), reasoningEffort: z.string().min(1).max(64).optional(), speed: agentSpeedSchema.nullable().optional(),
  // First entry may keep a speed chosen before switching models. Main checks that the source model offered it.
  speedSourceModelId: z.string().min(1).max(512).optional() }).strict()
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
/** What the machines line and Settings read (#1032): list_machines as Watcher gets it, `newWorkersStart` included. */
export const watcherMachinesReadSchema = watcherToolSchemas.list_machines.output
export type WatcherMachinesRead = z.infer<typeof watcherMachinesReadSchema>
export type WatcherMachine = Extract<WatcherMachinesRead, { status: 'ok' }>['machines'][number]
export type WatcherWatchThreadRequest = z.infer<typeof watcherWatchThreadRequestSchema>

export type WatcherRoomState = z.infer<typeof watcherRoomStateSchema>
/** What the room shows of Watcher's work: the record's receipts, their places, requests and start placements. */
export interface WatcherRoomWork {
  readonly receipts: WatcherRoomState['receipts']
  readonly receiptReplies: NonNullable<WatcherRoomState['receiptReplies']>
  readonly requests: WatcherRoomState['requests']
  readonly receiptPlacements: NonNullable<WatcherRoomState['receiptPlacements']>
}
/**
 * The room's work with what its conversation shown back recalled (`recalled`, #1759) ahead of it: one entry for each
 * operation and request, the record's wherever both hold it, so a card is never shown twice.
 */
export function watcherRoomWork(room: Pick<WatcherRoomState, 'receipts' | 'receiptReplies' | 'requests' | 'receiptPlacements' | 'recalled'>): WatcherRoomWork {
  const live: WatcherRoomWork = { receipts: room.receipts, receiptReplies: room.receiptReplies ?? [], requests: room.requests, receiptPlacements: room.receiptPlacements ?? [] }
  const recalled = room.recalled
  if (!recalled) return live
  const join = <T>(older: readonly T[], own: readonly T[], id: (item: T) => string): T[] => {
    const held = new Set(own.map(id))
    return [...older.filter(item => !held.has(id(item))), ...own]
  }
  return { receipts: join(recalled.receipts, live.receipts, item => item.id), receiptReplies: join(recalled.receiptReplies, live.receiptReplies, item => item.operationId),
    requests: join(recalled.requests, live.requests, item => item.id), receiptPlacements: join(recalled.receiptPlacements ?? [], live.receiptPlacements, item => item.operationId) }
}
type WatcherRoomRow = WatcherRoomState['watchedThreads'][number]

/**
 * A list of the room's that changed, as a room update carries it (#1450): its length now, each entry that differs from
 * the entry at the same place in the room the update is measured from, whole in `at` or, when both are records, as what
 * changed in it in `patch`. Entries past the old length are always whole. A request, receipt or participation that did
 * not change does not ride, nor does the rest of a watched thread's row when only its status changed.
 */
export interface WatcherRoomListChange {
  readonly length: number
  readonly at: readonly (readonly [number, unknown])[]
  readonly patch?: readonly (readonly [number, WatcherRoomPatch])[]
}
/** What changed in one record of a list: the fields set, the fields that went and the lists that changed, the same way. */
export interface WatcherRoomPatch {
  readonly set?: Readonly<Record<string, unknown>>
  readonly removed?: readonly string[]
  readonly lists?: Readonly<Record<string, WatcherRoomListChange>>
}
/**
 * What crosses `WATCHER_CHANGED` to the window while the streaming-publish-cost answer is on (#1450): the room whole, or
 * only what changed since the room the window was last sent. Without that answer main sends the room itself, as before.
 * `base` names the update the changes are measured from, or is null when `room` is the whole room. Otherwise `room`
 * holds each field that changed other than a list, `lists` each list that changed, and `removed` the fields the room
 * no longer has. Like the room itself, nothing parses this shape: the preload checks its outline and hands it to the
 * page as it came, the page puts the whole room back (`watcherRoomChanges`, #1759), and a window that holds another
 * base reads `WATCHER_GET`, which also tells main to send the next update whole.
 */
export interface WatcherRoomUpdate {
  /** Names this update, for the next one to be measured from. Main's counter only advances. */
  readonly revision: number
  readonly base: number | null
  readonly room: Partial<WatcherRoomState>
  readonly lists?: Readonly<Partial<Record<keyof WatcherRoomState, WatcherRoomListChange>>>
  readonly removed?: readonly (keyof WatcherRoomState)[]
}
/**
 * The newer of two rooms, for a window that receives rooms from updates, reads and command replies in any order: the
 * higher build number when both carry one, and otherwise the later read, with a tie going to `next` (#1450).
 */
export function newerWatcherRoom(current: WatcherRoomState | null, next: WatcherRoomState): WatcherRoomState {
  if (current === null) return next
  if (current.sequence !== undefined && next.sequence !== undefined) return current.sequence > next.sequence ? current : next
  return Date.parse(current.observedAt) > Date.parse(next.observedAt) ? current : next
}
/** What `WATCHER_CHANGED` carries: the room itself, or an update to the room the window was last sent. */
export type WatcherRoomChange = WatcherRoomState | WatcherRoomUpdate
/** The room a window holds, with the update it came from. */
export interface WatcherRoomHeld { readonly revision: number; readonly room: WatcherRoomState }

const isPlace = (value: unknown, length: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < length
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** The list `change` makes of `before`, or null when it would leave a gap or patch what is not a record. */
function applyListChange(before: unknown, change: WatcherRoomListChange): unknown[] | null {
  if (!isRecord(change) || !Number.isInteger(change.length) || change.length < 0 || !Array.isArray(change.at)) return null
  const list: unknown[] = Array.isArray(before) ? before.slice(0, change.length) : []
  const known = list.length
  let filled = 0
  for (const entry of change.at) {
    if (!Array.isArray(entry) || !isPlace(entry[0], change.length)) return null
    if (entry[0] >= known && !(entry[0] in list)) filled++
    list[entry[0]] = entry[1]
  }
  if (known + filled !== change.length) return null
  if (change.patch !== undefined && !Array.isArray(change.patch)) return null
  for (const entry of change.patch ?? []) {
    if (!Array.isArray(entry) || !isPlace(entry[0], list.length)) return null
    const patched = applyPatch(list[entry[0]], entry[1])
    if (patched === null) return null
    list[entry[0]] = patched
  }
  return list
}
/** The record `patch` makes of `before`, a new record sharing every field it did not name, or null when it cannot. */
function applyPatch(before: unknown, patch: WatcherRoomPatch): Record<string, unknown> | null {
  if (!isRecord(before) || typeof patch !== 'object' || patch === null || patch.removed !== undefined && !Array.isArray(patch.removed)) return null
  const after: Record<string, unknown> = { ...before, ...patch.set }
  for (const key of patch.removed ?? []) delete after[key]
  for (const [key, change] of Object.entries(patch.lists ?? {})) {
    const list = applyListChange(before[key], change)
    if (list === null) return null
    after[key] = list
  }
  return after
}
/**
 * The room `update` makes of `held`, or null when it cannot be applied: it is measured from another update, or a list
 * would be left with a gap. A list, record or field the update does not name is the very one `held` had, so a reader
 * that compares by identity sees only what changed.
 */
export function applyWatcherRoomUpdate(held: WatcherRoomHeld | null, update: WatcherRoomUpdate): WatcherRoomHeld | null {
  if (update.base === null) return { revision: update.revision, room: update.room as WatcherRoomState }
  if (held === null || held.revision !== update.base) return null
  const room = applyPatch(held.room, { set: update.room as Record<string, unknown>, ...update.removed ? { removed: update.removed } : {},
    ...update.lists ? { lists: update.lists as Record<string, WatcherRoomListChange> } : {} })
  return room === null ? null : { revision: update.revision, room: room as WatcherRoomState }
}

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
  /** The handover after a provider change or New Watcher (ADR-0073). Older stand-ins omit them; the real Owl preload supplies all three. */
  readHandover?(): Promise<WatcherHandoverRead>
  continueWithHandover?(request: WatcherContinueHandoverRequest): Promise<WatcherRoomResult>
  dismissHandover?(): Promise<WatcherRoomResult>
  /**
   * New Watcher: starts a new Watcher on the current one's provider, model, effort and permissions, which main reads from
   * the current Watcher itself, and offers the last one's handover. Older stand-ins omit it; the real Owl preload supplies it.
   */
  startNew?(): Promise<WatcherRoomResult>
  /** Each machine's facts, load and work placed but not started (#1032). Only while Work across machines is on. */
  readMachines?(): Promise<WatcherMachinesRead>
  /**
   * Each change main sends, as it sent it: a whole room, or only what changed (#1759). Crossing the context bridge copies
   * all it carries, so the page puts the room together on its own side (`watcherRoomChanges`) and only the change crosses.
   */
  onChanged(listener: (change: WatcherRoomChange) => void): () => void
}
