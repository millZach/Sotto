import { z } from 'zod'
import { agentRuntimeModeSchema } from './agents'
import { DELEGATION_LEVELS_MAX, DELEGATION_NEWS_MAX, DELEGATION_WAIT_MAX_SECONDS, delegationNewsSchema, delegationWorkSchema } from './delegation'
import { WATCHER_REPLY_BYTES_MAX } from './watcher'
import { workerSystemSchema } from './workerMachine'
import { branchNameSchema, snapshotCarriedSchema } from './branchMoves'
import { worktreeMadeFromSchema } from './bringChangesBack'

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
/** The longest time of day a snapshot's words carry, as a machine writes it ("14:02", "2:02 PM"). */
export const DELEGATION_TAKEN_AT_MAX = 32

/**
 * The `delegate` arguments a relayed start carries: never a machine or a system. `from_my_branch` and `test_run` only to a
 * desktop whose hello accepted `delegation-branch-starts` (#1316 part 2).
 */
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
    waitMs: z.number().int().min(0).max(DELEGATION_RELAY_WAIT_MAX_MS),
    /**
     * With `from_my_branch` and `test_run` (`delegation-branch-starts`): the check snapshot the host took of its thread's
     * working copy as the thread asked, pinned there for the desktop's move to send, and when it was taken, as the host's
     * own computer writes the time, which the snapshot's words say.
     */
    pinned: z.uuid().optional(),
    takenAt: z.string().trim().min(1).max(DELEGATION_TAKEN_AT_MAX).optional() }).strict(),
  /**
   * Send another brief to a thread this host's thread delegated to through the relay (#1316 part 2), named in `input.thread`
   * as the desktop named it, charged on the desktop against the same four briefs per thread per user message as any brief.
   * Pushed only to a desktop whose hello accepted `delegation-relay-send`.
   */
  z.object({ type: z.literal('send'), relayId: z.uuid(), threadId: id, levels: z.number().int().min(0).max(DELEGATION_LEVELS_MAX - 1),
    rootUserMessageId: id, callerMessageId: id.optional(), runtimeMode: agentRuntimeModeSchema, projectId: id, input: relayedInputSchema,
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
 * An answered relayed delegation's reply, sent with its news (ADR-0105 decision 6), cut as `read_delegation` cuts it:
 * the delegated thread's own words, which the host labels as such in the wake-up and never keeps on disk.
 */
export const relayedReplySchema = z.object({ delegationId: z.uuid(), messageId: id, text: z.string().max(WATCHER_REPLY_BYTES_MAX), truncated: z.boolean() }).strict()
export type RelayedReply = z.infer<typeof relayedReplySchema>
export const relayedRepliesSchema = z.array(relayedReplySchema).max(DELEGATION_NEWS_MAX)

/**
 * The words a thread on a host is told when the desktop is not connected, so nothing can start there (Zach, October 23,
 * 2026). Nothing is queued. `here` is the host's own name, as its machine calls itself.
 */
export const relayAwayWords = (here: string): string =>
  `This computer isn't connected to ${here}, so nothing was started there. Start it on ${here} instead, or try again when this computer is back.`

/**
 * A delegating thread's branch the desktop already landed in the host project's incoming ref for a start there
 * (`delegation-branch-starts`, #1316 part 2): the move, the branch, what a check's snapshot carried and when it was taken,
 * as the delegating thread's own computer writes it, and the thread it came from, which the new worktree keeps so only the
 * desktop that started it brings its changes back (#1030).
 */
export const remoteLandedBranchSchema = z.object({ moveId: z.uuid(), branch: branchNameSchema, snapshot: snapshotCarriedSchema.optional(),
  takenAt: z.string().trim().min(1).max(DELEGATION_TAKEN_AT_MAX).optional(), madeFrom: worktreeMadeFromSchema }).strict()
export type RemoteLandedBranch = z.infer<typeof remoteLandedBranchSchema>

/** The longest name a desktop gives a delegating thread in a `delegation-remote-ask`, so the host's key for it stays inside its record's bound. */
export const DELEGATION_REMOTE_CALLER_MAX = 400
const callerId = z.string().min(1).max(DELEGATION_REMOTE_CALLER_MAX)
/**
 * A delegation on a paired host for a thread on another machine (#1316 part 2, ADR-0105 decision 1, Owl `cross-machine-work`):
 * the desktop asks a host that lists `delegation-remote` with `delegation-remote-ask`, and the host admits it with its own
 * delegation, as one of its own threads' would be, held to the desktop defaults it was sent (#1310). `caller` is the
 * desktop's name for the delegating thread: one of its own, or a thread on a third machine that asked through the relay
 * (`host:<hostId>:<threadId>`). The host keys it under the asking desktop's client, so a desktop can only address its own.
 */
export const delegationRemoteAskSchema = z.discriminatedUnion('type', [
  /**
   * A `delegate` call for `caller`: a new thread in `projectId`, the host's own copy of the project, or with `input.thread`
   * another brief to a thread it started for that caller. `levels`, `runtimeMode` and the turn's root are the desktop's word,
   * which can only narrow what the host admits. `input.retry_key` is always the desktop's, so a read after a lost answer
   * finds what it made.
   */
  z.object({ type: z.literal('delegate'), caller: callerId, levels: z.number().int().min(0).max(DELEGATION_LEVELS_MAX - 1), rootUserMessageId: id,
    callerMessageId: id.optional(), runtimeMode: agentRuntimeModeSchema, projectId: id, input: relayedInputSchema,
    waitMs: z.number().int().min(0).max(DELEGATION_RELAY_WAIT_MAX_MS),
    /** A start from the caller's branch, already landed here (`delegation-branch-starts`): its new worktree is made from it. */
    branch: remoteLandedBranchSchema.optional(),
    /** A check's place in this host's queue, reserved by `reserve` before its branch moved (`delegation-branch-starts`): it takes that place. */
    reservation: z.uuid().optional() }).strict(),
  /**
   * Holds a place at the end of this host's check queue for a check the desktop is about to start here (`delegation-branch-starts`,
   * #1316 part 2), before its branch or snapshot moves, so the queue keeps the order checks were asked in. The `delegate` that
   * names it takes the place; `release`, the desktop's socket closing, or 15 minutes unclaimed let it go.
   */
  z.object({ type: z.literal('reserve'), caller: callerId, reservation: z.uuid(), work: delegationWorkSchema }).strict(),
  z.object({ type: z.literal('release'), caller: callerId, reservation: z.uuid() }).strict(),
  /** Read one exactly, by the host's delegation ID, or by the retry key it was asked under when the answer was lost. */
  z.object({ type: z.literal('read'), caller: callerId, delegation: z.uuid().optional(), retryKey: z.uuid().optional() }).strict(),
  /** Cancel one, as `cancel_delegation` does on the host. */
  z.object({ type: z.literal('cancel'), caller: callerId, delegation: z.uuid() }).strict(),
])
export type DelegationRemoteAsk = z.infer<typeof delegationRemoteAskSchema>
