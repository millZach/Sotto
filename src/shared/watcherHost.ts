import { z } from 'zod'
import { agentRuntimeModeSchema, type AgentHostSnapshot, type AgentRuntimeMode } from './agents'
import { watcherIdentitySchema, type WatcherIdentity, watcherOperationSchema, watcherRequestSchema, watcherToolSchemas, watcherEvidenceSchema, watcherThreadTargetSchema, watcherStandingWatchSchema, type WatcherThreadTarget } from './watcher'
import type { WatcherRoomState } from './watcherRoom'
import type { HostMachineReport } from './hostFacts'
import type { ProjectOrigins, ProjectSetupRequest, ProjectSetupResult } from './workerMachine'
import type { HostBranchMoveRequest } from './branchMoves'
import type { ThreadMoveHost } from './threadMoves'

/** Text-free attribution, bound by the host to its authenticated SSH-recorded desktop. No local tool token travels. */
export const watcherHostScopeSchema = watcherIdentitySchema
export const watcherHostControlSchema = z.object({ master: watcherHostScopeSchema,
  request: watcherRequestSchema.pick({ id: true, watcher: true, rootUserMessageId: true, createdAt: true, standingWatchId: true }),
  ceiling: agentRuntimeModeSchema, operation: watcherOperationSchema,
  call: z.discriminatedUnion('name', [
    z.object({ name: z.literal('start_thread'), input: watcherToolSchemas.start_thread.input }).strict(),
    z.object({ name: z.literal('send_to_thread'), input: watcherToolSchemas.send_to_thread.input }).strict(),
    z.object({ name: z.literal('stop_thread'), input: watcherToolSchemas.stop_thread.input }).strict(),
    z.object({ name: z.literal('settle_thread'), input: watcherToolSchemas.settle_thread.input }).strict(),
  ]) }).strict()
/**
 * At most this many standing watches on one host in a read (#2273). A 16 MiB frame holds at most about 98,700 of the
 * smallest, so this bounds the list without adding a limit of its own: Watcher still watches any number of threads.
 */
export const WATCHER_STANDING_WATCHES_MAX = 100_000
export const watcherHostReadSchema = z.object({ master: watcherHostScopeSchema,
  standingWatches: z.array(watcherStandingWatchSchema).max(WATCHER_STANDING_WATCHES_MAX).optional(),
  stoppedRequests: z.array(z.object({ request: watcherRequestSchema.pick({ id: true, watcher: true, rootUserMessageId: true, createdAt: true }), ceiling: agentRuntimeModeSchema }).strict()).max(1_000).optional(),
  call: z.discriminatedUnion('name', [
    z.object({ name: z.literal('list_threads'), input: watcherToolSchemas.list_threads.input }).strict(),
    z.object({ name: z.literal('list_projects'), input: watcherToolSchemas.list_projects.input }).strict(),
    z.object({ name: z.literal('list_working_copies'), input: watcherToolSchemas.list_working_copies.input }).strict(),
    z.object({ name: z.literal('read_thread'), input: watcherToolSchemas.read_thread.input }).strict(),
    z.object({ name: z.literal('read_operation'), input: watcherToolSchemas.read_operation.input }).strict(),
  ]).optional(),
  // Sent only to a host that lists watcher-outcomes: its read_operation then carries the delegation's outcome and reply.
  outcomes: z.literal(true).optional(),
  // Sent only to a host that lists watcher-new-owner, on every read: before it answers, the host moves the requests an older
  // Watcher of the same desktop made there to this one (#1735).
  adopt: z.literal(true).optional() }).strict()
/** How far one watched thread has got: its target and an opaque fingerprint from the shared progress classifier. */
const watcherProgressEntrySchema = z.object({ target: watcherThreadTargetSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export const watcherHostProjectionSchema = z.object({ hostId: z.uuid(), master: watcherHostScopeSchema,
  standingWatches: z.array(watcherStandingWatchSchema).optional(),
  revision: z.string().min(1).max(512), observedAt: z.string().datetime(),
  requests: z.array(watcherRequestSchema).max(1_000), operations: z.array(watcherOperationSchema).max(1_000),
  evidence: z.array(watcherEvidenceSchema).max(1_000),
  progress: z.array(watcherProgressEntrySchema).max(1_000).optional() }).strict()
/**
 * A **progress push** (`watcher-progress`, ADR-0073's November 10, 2026 amendment): what a projection's `progress` gained,
 * changed and lost since the projection last written to that connection, `baseRevision`, when nothing else in it moved.
 * `revision` and `observedAt` are the new projection's. `changed` holds each entry that is new or carries another
 * fingerprint, and `removed` the targets whose entries went. With `whole`, `changed` is the whole list in order instead.
 */
export const watcherHostProgressSchema = z.object({ baseRevision: z.string().min(1).max(512), revision: z.string().min(1).max(512),
  observedAt: z.string().datetime(), changed: z.array(watcherProgressEntrySchema).max(1_000),
  removed: z.array(watcherThreadTargetSchema).max(1_000).optional(), whole: z.literal(true).optional() }).strict()
export type WatcherHostControl = z.infer<typeof watcherHostControlSchema>
export type WatcherHostRead = z.infer<typeof watcherHostReadSchema>
export type WatcherHostProjection = z.infer<typeof watcherHostProjectionSchema>
export type WatcherHostProgress = z.infer<typeof watcherHostProgressSchema>
type WatcherProgressEntry = z.infer<typeof watcherProgressEntrySchema>
type WatcherProgressChange = Pick<WatcherHostProgress, 'changed' | 'removed' | 'whole'>

/** A target as one string. A host ID is a UUID, so the separator cannot occur in it. */
const progressKey = (target: WatcherThreadTarget): string => `${target.hostId}\u0000${target.threadId}`
/**
 * A progress list with a progress push's changes put in: an entry `changed` names takes the place of the one for its
 * target, one for a target the list did not hold goes last, and a target `removed` names goes. `whole` replaces the list.
 */
function progressWith(held: readonly WatcherProgressEntry[], change: WatcherProgressChange): WatcherProgressEntry[] {
  if (change.whole) return [...change.changed]
  const gone = new Set((change.removed ?? []).map(progressKey))
  const changed = new Map(change.changed.map(entry => [progressKey(entry.target), entry] as const))
  const result: WatcherProgressEntry[] = [], placed = new Set<string>()
  for (const entry of held) {
    const key = progressKey(entry.target), next = changed.get(key)
    if (gone.has(key)) continue
    result.push(next ?? entry)
    if (next) placed.add(key)
  }
  for (const [key, entry] of changed) if (!placed.has(key)) result.push(entry)
  return result
}
/**
 * What a host's progress push carries to take a connection from the progress list it was last written, `held`, to
 * `next`. When putting those changes in would not give `next` in its order, as when a new watched thread sits above
 * older ones, it carries the whole list.
 */
export function watcherProgressChange(held: readonly WatcherProgressEntry[], next: readonly WatcherProgressEntry[]): WatcherProgressChange {
  const was = new Map(held.map(entry => [progressKey(entry.target), entry.fingerprint] as const))
  const now = new Set(next.map(entry => progressKey(entry.target)))
  const removed = held.filter(entry => !now.has(progressKey(entry.target))).map(entry => entry.target)
  const change: WatcherProgressChange = { changed: next.filter(entry => was.get(progressKey(entry.target)) !== entry.fingerprint), ...removed.length ? { removed } : {} }
  const rebuilt = progressWith(held, change)
  const same = rebuilt.length === next.length && rebuilt.every((entry, index) => progressKey(entry.target) === progressKey(next[index]!.target) && entry.fingerprint === next[index]!.fingerprint)
  return same ? change : { changed: [...next], whole: true }
}
/**
 * The projection a desktop holds with a progress push put in: its record part, evidence and standing watches as they
 * were, and the push's progress, revision and time. The caller checks that it holds the push's `baseRevision` first.
 */
export function withWatcherProgress(projection: WatcherHostProjection, push: WatcherHostProgress): WatcherHostProjection {
  return { ...projection, revision: push.revision, observedAt: push.observedAt, progress: progressWith(projection.progress ?? [], push) }
}

/** Main-only routing seam. All IDs are owning-host IDs, never client UI keys. */
export type WatcherRoomThreadInput = Pick<WatcherRoomState['watchedThreads'][number],
  'title' | 'status' | 'connected' | 'settled' | 'backgroundWorkCount'> & {
  id: string; waitsOn: { id: string; kind: 'question' | 'permission' }[]
}

export interface WatcherRemoteHosts {
  /**
   * `name` is the machine's name as this computer saved it; `facts` says whether the host lists `host-facts` (#1031), and
   * `origins` whether it lists `project-origins` (#1032), and `setUp` whether it lists `project-setup` (#1690).
   * `permissionCeiling` is the widest mode the host lets this computer give a thread there: Full access where this
   * computer may answer on it, Ask for approval where it may not. `clientId` is the client ID the host knows this computer
   * by, which names this computer's threads in its delegation links (`relay:<client>:<caller>`, #1217).
   */
  hosts(): { hostId: string; name?: string; clientId?: string; control: boolean; reads: boolean; standingWatch?: boolean; workSettled?: boolean; outcomes?: boolean; facts?: boolean; origins?: boolean; setUp?: boolean; checks?: boolean; checkStop?: boolean; swarms?: boolean; newOwner?: boolean; muse?: boolean; cursor?: boolean; connected: boolean; permissionCeiling: AgentRuntimeMode }[]
  read(hostId: string, request: WatcherHostRead): Promise<unknown>
  control(hostId: string, request: WatcherHostControl): Promise<unknown>
  snapshot(hostId: string): AgentHostSnapshot | undefined
  roomThreads?(hostId: string, threadIds: readonly string[]): WatcherRoomThreadInput[] | undefined
  projection?(hostId: string, master: WatcherIdentity): WatcherHostProjection | undefined
  subscribe(listener: (hostId?: string, force?: boolean) => void): () => void
  /**
   * Tells `listener` when the user's answer to a card on a connected host's thread goes from this computer, so Watcher's
   * news of the card closing says the user answered it. Never the answer's words. The listener's undo is called when the
   * answer did not go.
   */
  answering?(listener: (hostId: string, threadId: string, requestId: string) => () => void): () => void
  /** A connected host's machine facts and running threads, or undefined when it does not report them (#1031). */
  machineFacts?(hostId: string): Promise<HostMachineReport | undefined>
  /** A connected host's projects' GitHub origins, or undefined when it does not report them (#1032). */
  projectOrigins?(hostId: string): Promise<ProjectOrigins | undefined>
  /**
   * Sets up a copy of a repository on a connected host for a worker placed there (#1690), or undefined when it does not
   * list `project-setup`. Rejects when the host is out of reach; a setup that cannot finish answers in plain words.
   */
  setUpProject?(hostId: string, request: ProjectSetupRequest): Promise<ProjectSetupResult | undefined>
  /**
   * A connected host's socket for moving a branch (#1033), whatever it lists, or undefined when it is not connected. The
   * mover says in plain words when the host does not list `branch-moves`.
   */
  branchMoves?(hostId: string): { readonly supportsBranchMoves: boolean; branchMove(request: HostBranchMoveRequest): Promise<unknown> } | undefined
  /**
   * A connected host's socket for a thread moved to it (#1178), whatever it lists, or undefined when it is not connected.
   * The move says in plain words when the host does not list `thread-move`.
   */
  threadMoves?(hostId: string): ThreadMoveHost | undefined
}
