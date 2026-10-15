import { z } from 'zod'
import { agentRuntimeModeSchema, type AgentHostSnapshot, type AgentRuntimeMode } from './agents'
import { watcherIdentitySchema, type WatcherIdentity, watcherOperationSchema, watcherRequestSchema, watcherToolSchemas, watcherEvidenceSchema, watcherThreadTargetSchema, watcherStandingWatchSchema } from './watcher'

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
  ]).optional() }).strict()
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
export interface WatcherRemoteHosts {
  hosts(): { hostId: string; control: boolean; reads: boolean; standingWatch?: boolean; workSettled?: boolean; connected: boolean; permissionCeiling: AgentRuntimeMode }[]
  read(hostId: string, request: WatcherHostRead): Promise<unknown>
  control(hostId: string, request: WatcherHostControl): Promise<unknown>
  snapshot(hostId: string): AgentHostSnapshot | undefined
  projection?(hostId: string, master: WatcherIdentity): WatcherHostProjection | undefined
  subscribe(listener: (hostId?: string, force?: boolean) => void): () => void
}
