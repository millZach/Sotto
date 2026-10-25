import { z } from 'zod'

/**
 * A branch move: a committed branch carried from one of a desktop's machines to another as a Git bundle, over the host
 * socket the desktop already keeps (ADR-0082 as amended by ADR-0105 decision 8). It lands in an incoming ref of its own on
 * the receiving side, `refs/sotto/incoming/<move>/<branch>`, written once and never forced. An Owl feature
 * (`cross-machine-work`, ADR-0072): a host lists `branch-moves` only where its own Owl answer turns it on.
 */

/** The most one move carries (Zach, October 23, 2026). A bundle over it is refused in plain words and nothing moves. */
export const BRANCH_BUNDLE_MAX_BYTES = 256 * 1024 * 1024
/** Bytes per chunk on the socket: well inside the 16 MiB frame once base64 grows it, and short to parse on main. */
export const BRANCH_BUNDLE_CHUNK_BYTES = 1024 * 1024
/** The receiver's branch tips a sender may bundle against, newest first, so the bundle carries only what it lacks. */
export const BRANCH_TIPS_MAX = 256
/** Moves a machine stages at once, either way. */
export const BRANCH_TRANSFERS_MAX = 4
/** The untracked files a test-run snapshot's receipt names; the count says how many there were in all. */
export const SNAPSHOT_UNTRACKED_LISTED = 200

export const branchMoveIdSchema = z.uuid()
export const commitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
/**
 * A branch name a move carries: what `git check-ref-format --branch` takes, narrowed to plain characters so the incoming
 * ref it names is the same on every system. The receiving side checks the whole ref with Git too.
 */
export const branchNameSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/+@-]+$/u)
  .refine(name => !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock')
    && !name.includes('..') && !name.includes('//') && !name.includes('@{') && !name.split('/').some(part => part.startsWith('.')), 'Not a branch name.')
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const chunkData = z.string().max(Math.ceil(BRANCH_BUNDLE_CHUNK_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u)
const id = z.string().min(1).max(512)
/**
 * What a test-run snapshot carried beyond the branch's commit (ADR-0105 decision 8): the untracked files it took, by their
 * paths in the working copy, the first `SNAPSHOT_UNTRACKED_LISTED` of them, and how many there were.
 */
export const snapshotCarriedSchema = z.object({ untracked: z.array(z.string().min(1).max(4096)).max(SNAPSHOT_UNTRACKED_LISTED),
  untrackedCount: z.number().int().nonnegative() }).strict()
export type SnapshotCarried = z.infer<typeof snapshotCarriedSchema>

/** Where a move lands in the receiving repository. */
export const incomingRef = (moveId: string, branch: string): string => `refs/sotto/incoming/${moveId}/${branch}`
/** The ref a sender bundles, since `git bundle create` refuses a bare commit hash. It is removed once the bundle is written. */
export const outgoingRef = (moveId: string): string => `refs/sotto/outgoing/${moveId}`

/**
 * What a desktop asks of a host that lists `branch-moves` (`branch-move` on the socket). Receiving: `tips` reads the
 * receiving project's branch tips, then `receive-begin`, `receive-chunk` in order from offset 0, and `receive-finish`; or,
 * when those tips show the project already has the commit, `receive-ref` alone. Sending: `send-begin` checks a thread's
 * working copy and stages its branch, or answers `present` when the desktop's tips already hold its commit, and
 * `send-chunk` reads it. `end` discards
 * whatever the move staged, either way. Each step names its move; a retry of a finished move answers as done.
 * `copy` lands a thread's branch in a project on the same machine, for a worker started there from it, with nothing sent.
 * `snapshot`, on `send-begin` and `copy`, is a test run's (#1033, #1312): uncommitted work goes too, as a commit object
 * made from a temporary index, instead of being refused. `forget` removes the incoming ref a move landed in a project, for a
 * start the desktop knows never made its thread there, so no ref holds the branch for nothing.
 */
export const hostBranchMoveRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tips'), projectId: id }).strict(),
  z.object({ action: z.literal('receive-begin'), moveId: branchMoveIdSchema, projectId: id, branch: branchNameSchema, commit: commitIdSchema,
    size: z.number().int().positive().max(BRANCH_BUNDLE_MAX_BYTES), sha256: sha256Schema }).strict(),
  z.object({ action: z.literal('receive-chunk'), moveId: branchMoveIdSchema, offset: z.number().int().nonnegative().max(BRANCH_BUNDLE_MAX_BYTES), data: chunkData }).strict(),
  z.object({ action: z.literal('receive-finish'), moveId: branchMoveIdSchema }).strict(),
  z.object({ action: z.literal('receive-ref'), moveId: branchMoveIdSchema, projectId: id, branch: branchNameSchema, commit: commitIdSchema }).strict(),
  z.object({ action: z.literal('send-begin'), moveId: branchMoveIdSchema, threadId: id, bases: z.array(commitIdSchema).max(BRANCH_TIPS_MAX), snapshot: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('send-chunk'), moveId: branchMoveIdSchema, offset: z.number().int().nonnegative().max(BRANCH_BUNDLE_MAX_BYTES) }).strict(),
  z.object({ action: z.literal('end'), moveId: branchMoveIdSchema }).strict(),
  z.object({ action: z.literal('copy'), moveId: branchMoveIdSchema, threadId: id, projectId: id, snapshot: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('forget'), moveId: branchMoveIdSchema, projectId: id }).strict(),
])
export type HostBranchMoveRequest = z.infer<typeof hostBranchMoveRequestSchema>

export const BRANCH_MOVE_REFUSALS = ['uncommitted', 'not-on-branch', 'not-a-repository', 'unknown-project', 'unknown-thread', 'too-large',
  'move-differs', 'not-whole', 'cut-off', 'busy', 'unsupported', 'failed'] as const
export type BranchMoveRefusalReason = typeof BRANCH_MOVE_REFUSALS[number]
export const branchMoveRefusalSchema = z.object({ type: z.literal('refused'), reason: z.enum(BRANCH_MOVE_REFUSALS), message: z.string().min(1).max(1000) }).strict()
export type BranchMoveRefusal = z.infer<typeof branchMoveRefusalSchema>
/**
 * A move that landed: the branch, the commit Sotto checked, and the incoming ref that now names it. `snapshot` says the
 * commit is a test run's snapshot of uncommitted work, with what it carried, where the sender reports it.
 */
export const branchMovedSchema = z.object({ type: z.literal('moved'), moveId: branchMoveIdSchema, branch: branchNameSchema, commit: commitIdSchema, ref: z.string().min(1).max(400),
  snapshot: snapshotCarriedSchema.optional() }).strict()
export type BranchMoved = z.infer<typeof branchMovedSchema>
/** What a move ends in: landed, or refused with what happened, that nothing moved, and what to do next. */
export type BranchMoveReceipt = BranchMoved | BranchMoveRefusal

export const branchTipsAnswerSchema = z.union([z.object({ type: z.literal('tips'), tips: z.array(commitIdSchema).max(BRANCH_TIPS_MAX) }).strict(), branchMoveRefusalSchema])
export const branchReceiveBeginAnswerSchema = z.union([z.object({ type: z.literal('receiving') }).strict(), branchMovedSchema, branchMoveRefusalSchema])
export const branchReceiveChunkAnswerSchema = z.union([z.object({ type: z.literal('received'), bytes: z.number().int().nonnegative() }).strict(), branchMoveRefusalSchema])
export const branchReceiveFinishAnswerSchema = z.union([branchMovedSchema, branchMoveRefusalSchema])
export const branchReceiveRefAnswerSchema = branchReceiveFinishAnswerSchema
export const branchSendBeginAnswerSchema = z.union([z.object({ type: z.literal('sending'), branch: branchNameSchema, commit: commitIdSchema,
  size: z.number().int().positive().max(BRANCH_BUNDLE_MAX_BYTES), sha256: sha256Schema, snapshot: snapshotCarriedSchema.optional() }).strict(),
  z.object({ type: z.literal('present'), branch: branchNameSchema, commit: commitIdSchema, snapshot: snapshotCarriedSchema.optional() }).strict(), branchMoveRefusalSchema])
export const branchCopyAnswerSchema = z.union([branchMovedSchema, branchMoveRefusalSchema])
export const branchSendChunkAnswerSchema = z.union([z.object({ type: z.literal('chunk'), data: chunkData }).strict(), branchMoveRefusalSchema])

const MIB = 1024 * 1024
const mib = (bytes: number): string => `${Math.max(1, Math.ceil(bytes / MIB))} MiB`
/** The words each refusal says: what happened, that nothing moved or changed, and what to do next. */
export const branchMoveWords = {
  uncommitted: 'This thread has uncommitted changes. Commit them first, then move the branch. Nothing was moved.',
  notOnBranch: 'This thread is not on a branch. Check out a branch first, then move it. Nothing was moved.',
  branchName: 'This branch\'s name has characters a move cannot carry. Rename the branch, then move it. Nothing was moved.',
  notARepository: 'This project\'s folder is not a Git repository, so no branch can move into it. Nothing was changed.',
  unknownProject: 'That project is not on this machine. Nothing was moved.',
  unknownThread: 'That thread is not on this machine. Nothing was moved.',
  tooLarge: (bytes: number, max = BRANCH_BUNDLE_MAX_BYTES): string => `This branch needs ${mib(bytes)} to move, and one move carries at most ${mib(max)}. Nothing was moved.`,
  moveDiffers: 'A different commit already arrived for this move. Nothing was changed. Start the move again.',
  notWhole: 'The branch did not arrive whole, so what arrived was discarded. Nothing was changed. Try the move again.',
  cutOff: 'The connection dropped while the branch was moving, so what arrived was discarded. Nothing was changed. Try the move again.',
  busy: 'This machine is already moving as many branches as it can. Wait for one to finish, then try again. Nothing was moved.',
  failed: 'Git could not move the branch. Nothing was changed. Try the move again.',
  outgoingRefChanged: 'Something other than Sotto changed this project\'s refs/sotto folder, so the branch can\'t move safely. Nothing was moved.',
  submoduleChanges: 'A submodule in this thread has uncommitted changes, and a check can\'t carry them. Commit them inside the submodule first, then start again. Nothing was started.',
  olderHost: (name: string): string => `${name} needs a newer Sotto to move branches. Update it from the Threads page, then try again. Nothing was moved.`,
  notConnected: (name: string): string => `${name} isn't connected, so nothing can move there now. Connect it, then try again. Nothing was moved.`,
} as const
/**
 * Where a worker started from a thread's branch began (#1033), as its start's receipt gives it: the machine by host ID and
 * name, the branch, what a test run's snapshot carried, and Sotto's sentence saying so (`branchStartWords`). In memory only,
 * as a start's placement is.
 */
export const branchStartReceiptSchema = z.object({ hostId: z.string().min(1).max(512), name: z.string().min(1).max(200), branch: branchNameSchema,
  snapshot: snapshotCarriedSchema.optional(), note: z.string().min(1).max(2_000) }).strict()
export type BranchStartReceipt = z.infer<typeof branchStartReceiptSchema>

/**
 * A worker started from a thread's branch says where it started and from what (Zach, October 23, 2026): "Started on forge
 * from feat/x", and for a test run that carried uncommitted work, "with your uncommitted changes", counting the untracked
 * files it took.
 */
export function branchStartWords(machine: string, branch: string, snapshot?: SnapshotCarried): string {
  if (!snapshot) return `Started on ${machine} from ${branch}.`
  const count = snapshot.untrackedCount
  return `Started on ${machine} from ${branch} with your uncommitted changes${count ? ` (${count} untracked file${count === 1 ? '' : 's'})` : ''}.`
}
export function branchMoveRefusal(reason: BranchMoveRefusalReason, message: string): BranchMoveRefusal { return { type: 'refused', reason, message } }
