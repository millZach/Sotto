import { z } from 'zod'
import { workerKindSchema } from './workerRoles'

/** Counts are angle workers. The lead is separate, and never consumes an angle's place. */
export const SWARM_ANGLES_MAX = Number.MAX_SAFE_INTEGER
export const swarmCountSchema = z.number().int().min(1).max(SWARM_ANGLES_MAX)
export const swarmMemberStateSchema = z.enum(['planned', 'queued', 'working', 'background', 'answered', 'failed', 'stopped', 'paused', 'unknown', 'refused'])
export type SwarmMemberState = z.infer<typeof swarmMemberStateSchema>
const id = z.string().min(1).max(512)
export const swarmMemberSchema = z.object({ index: z.number().int().nonnegative(), key: z.uuid(),
  threadId: id.optional(), delegationId: z.uuid().optional(), state: swarmMemberStateSchema }).strict()
export const workerSwarmSchema = z.object({
  id: z.uuid(), ownerThreadId: id, rootUserMessageId: id, retryKey: z.uuid(), digest: z.string().length(64),
  work: workerKindSchema, count: swarmCountSchema, usual: swarmCountSchema, upTo: swarmCountSchema,
  effort: z.string().nullable(), createdAt: z.iso.datetime(), leadKey: z.uuid(), leadThreadId: id.optional(), leadDelegationId: z.uuid().optional(),
  members: z.array(swarmMemberSchema).max(SWARM_ANGLES_MAX), planned: z.boolean(), stopped: z.boolean().optional(),
  /** The accepted angle plan's digest makes a retry harmless without retaining any brief text. */
  planDigest: z.string().length(64).optional(), completionSent: z.boolean().optional(), synthesisStarted: z.boolean().optional(),
  synthesisAfterMessageId: id.optional(), synthesisMessageId: id.optional(), synthesisDone: z.boolean().optional(),
}).strict()
export type WorkerSwarm = z.infer<typeof workerSwarmSchema>
export const swarmReceiptSchema = z.object({
  swarmId: z.uuid(), lead: z.object({ thread: id, delegation: z.uuid().optional() }).strict(),
  receipts: z.array(z.object({ index: z.number().int().nonnegative(), state: swarmMemberStateSchema,
    thread: id.optional(), delegation: z.uuid().optional() }).strict()).max(SWARM_ANGLES_MAX),
  queued: z.number().int().nonnegative(), done: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  role: z.object({ usual: swarmCountSchema, upTo: swarmCountSchema }).strict(),
  costShape: z.object({ angles: swarmCountSchema, lead: z.literal(1), effort: z.string().nullable() }).strict(),
  note: z.string(),
}).strict()
export type SwarmReceipt = z.infer<typeof swarmReceiptSchema>
export interface SwarmThreadView {
  readonly threadId: string
  readonly id: string
  readonly leadThreadId: string
  readonly index?: number
  readonly count: number
  readonly done: number
  readonly failed: number
  readonly queued: number
  readonly synthesisDone: boolean
  readonly state?: SwarmMemberState
}
export const swarmMemberTerminal = (state: SwarmMemberState): boolean =>
  state === 'answered' || state === 'failed' || state === 'stopped' || state === 'refused'
