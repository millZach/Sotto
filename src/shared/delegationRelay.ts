import { z } from 'zod'
import { agentRuntimeModeSchema } from './agents'
import { DELEGATION_LEVELS_MAX, DELEGATION_WAIT_MAX_SECONDS, delegationNewsSchema } from './delegation'
import { workerSystemSchema } from './workerMachine'

/**
 * The desktop relay (#1316, ADR-0105 decisions 1 and 6, Owl `cross-machine-work`): a thread on a headless host delegates to
 * a thread on another machine by asking the desktop, over the connection the desktop already keeps to that host. The host
 * pushes an ask (`delegation-relay-ask`) to a recorded desktop whose hello accepted `delegation-relay`; the desktop admits
 * it under its own rules and answers with `delegation-relay-answer`. Outcome changes come back as `delegation-relay-news`,
 * which the host turns into the delegating thread's hidden wake-up. The desktop is the relay's only caller; host links
 * (ADR-0105 decisions 2 to 5) add a second caller of the same asks later.
 *
 * Nothing here is a grant: the desktop starts a relayed thread no wider than the narrower of the delegating thread's own
 * permission, as the host says it, and the desktop's own new-thread default, so a host's claim can only narrow a start.
 */

const id = z.string().min(1).max(512)
/** The longest a relayed start may wait for its outcome in the desktop's `delegate`, in milliseconds. */
export const DELEGATION_RELAY_WAIT_MAX_MS = DELEGATION_WAIT_MAX_SECONDS * 1000
/** How long a host waits for the desktop's answer beyond the wait it asked for, before it treats the answer as lost. */
export const DELEGATION_RELAY_ANSWER_GRACE_MS = 20_000
/** How long a host waits for an answer to a read, a cancel or a machine list. */
export const DELEGATION_RELAY_READ_MS = 15_000
/** The largest answer the host takes: a `delegate` result with a reply cut to 32 KiB fits many times over. */
export const DELEGATION_RELAY_ANSWER_BYTES_MAX = 512 * 1024
/** The open relayed delegations a host keeps, newest kept, so a busy host's record stays bounded. */
export const DELEGATION_RELAY_RECORDS_MAX = 500

/** The `delegate` arguments a relayed start carries: never a machine, a system, or a branch to start from (part 1 of #1316). */
export const relayedInputSchema = z.record(z.string().max(64), z.unknown())

export const delegationRelayAskSchema = z.discriminatedUnion('type', [
  /**
   * Start a delegated thread elsewhere for one of the host's threads. `relayId` is the host's own name for the ask, so a
   * read after a lost answer can find what it made. `levels` is how many threads delegated above the calling one on the
   * host, `runtimeMode` the calling thread's own permission, and `projectId` its project there, which the desktop finds on
   * the target machine by its GitHub origin.
   */
  z.object({ type: z.literal('start'), relayId: z.uuid(), threadId: id, levels: z.number().int().min(0).max(DELEGATION_LEVELS_MAX - 1),
    rootUserMessageId: id, callerMessageId: id.optional(), runtimeMode: agentRuntimeModeSchema, projectId: id,
    machine: z.uuid().optional(), os: workerSystemSchema.optional(), input: relayedInputSchema,
    waitMs: z.number().int().min(0).max(DELEGATION_RELAY_WAIT_MAX_MS) }).strict(),
  /** Read one relayed delegation exactly, by the desktop's delegation ID, or by the host's `relayId` when the answer to its start was lost. */
  z.object({ type: z.literal('read'), threadId: id, delegation: z.uuid().optional(), relayId: z.uuid().optional() }).strict(),
  /** Cancel one relayed delegation, as `cancel_delegation` does on the desktop. */
  z.object({ type: z.literal('cancel'), threadId: id, delegation: z.uuid() }).strict(),
  /** The machines a thread on the host could name, as the desktop lists them. */
  z.object({ type: z.literal('machines') }).strict(),
])
export type DelegationRelayAsk = z.infer<typeof delegationRelayAskSchema>
export const delegationRelayNewsSchema = delegationNewsSchema

/**
 * The words a thread on a host is told when the desktop is not connected, so nothing can start there (Zach, October 23,
 * 2026). Nothing is queued. `here` is the host's own name, as its machine calls itself.
 */
export const relayAwayWords = (here: string): string =>
  `This computer isn't connected to ${here}, so nothing was started there. Start it on ${here} instead, or try again when this computer is back.`
