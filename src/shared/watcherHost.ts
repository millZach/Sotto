import { z } from 'zod'
import { agentRuntimeModeSchema, type AgentHostSnapshot, type AgentRuntimeMode } from './agents'
import { watcherIdentitySchema, type WatcherIdentity, watcherOperationSchema, watcherRequestSchema, watcherToolSchemas, watcherEvidenceSchema, watcherThreadTargetSchema, watcherStandingWatchSchema } from './watcher'
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
export const watcherHostReadSchema = z.object({ master: watcherHostScopeSchema,
  standingWatches: z.array(watcherStandingWatchSchema).optional(),
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
export const watcherHostProjectionSchema = z.object({ hostId: z.uuid(), master: watcherHostScopeSchema,
  standingWatches: z.array(watcherStandingWatchSchema).optional(),
  revision: z.string().min(1).max(512), observedAt: z.string().datetime(),
  requests: z.array(watcherRequestSchema).max(1_000), operations: z.array(watcherOperationSchema).max(1_000),
  evidence: z.array(watcherEvidenceSchema).max(1_000),
  progress: z.array(z.object({ target: watcherThreadTargetSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()).max(1_000).optional() }).strict()
export type WatcherHostControl = z.infer<typeof watcherHostControlSchema>
export type WatcherHostRead = z.infer<typeof watcherHostReadSchema>
export type WatcherHostProjection = z.infer<typeof watcherHostProjectionSchema>

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
   * computer may answer on it, Ask for approval where it may not.
   */
  hosts(): { hostId: string; name?: string; control: boolean; reads: boolean; standingWatch?: boolean; workSettled?: boolean; outcomes?: boolean; facts?: boolean; origins?: boolean; setUp?: boolean; checks?: boolean; checkStop?: boolean; swarms?: boolean; newOwner?: boolean; muse?: boolean; cursor?: boolean; connected: boolean; permissionCeiling: AgentRuntimeMode }[]
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
  /**
   * Settles a thread on a connected host the way the user's Settle does from this computer, for Settle finished threads
   * once Watcher has stopped watching it. Rejects when the host is out of reach or refuses.
   */
  settle?(hostId: string, threadId: string): Promise<void>
}
