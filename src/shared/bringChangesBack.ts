import { z } from 'zod'
import type { AgentThread } from './agents'
import { hostEntityKey, parseHostEntityKey } from './clientIdentity'

/**
 * Bringing a thread's commits back to the branch of the thread it began from (#1030, the ADR-0027 amendment of
 * October 23, 2026). A delegated, continued or forked thread, or a worker started from a thread's branch, in a new
 * worktree made from that thread's branch offers "Bring changes to <that branch>": Git fast-forwards the branch when it
 * can, and otherwise makes a merge commit once the user says yes. Uncommitted work and conflicts are refused in Git's own
 * words; nothing is resolved, rebased, switched or forced. A child on another machine than the thread it began from
 * sends its branch there first, as a branch move (ADR-0105). Part of Work across machines (`cross-machine-work`, ADR-0072).
 */

const sha = z.string().regex(/^[0-9a-f]{7,64}$/u)

/**
 * What the last press did on the thread whose commits it brings, as the host that ran Git says. Sotto's record on the
 * thread, never saved: a restart forgets it, as it forgets the question it may hold. Absent from older hosts.
 */
export const bringBackSchema = z.object({
  /** The press this answers, which the window minted. */
  actionId: z.uuid(),
  /** `asks` holds the merge-commit question; `done` and `refused` are outcomes. Nothing changed for `asks` or `refused`. */
  status: z.enum(['asks', 'done', 'refused']),
  /** The branch the commits go to: the branch of the thread this one began from. */
  target: z.string().min(1).max(512),
  /** This thread's own branch, whose commits go. */
  branch: z.string().min(1).max(512),
  /** How it went once done: Git fast-forwarded the target, made a merge commit on it, or there was nothing to bring. */
  how: z.enum(['fast-forward', 'merge-commit', 'nothing']).optional(),
  /** Commits on `branch` that `target` lacked. */
  commits: z.number().int().nonnegative().optional(),
  /** Commits on `target` that `branch` lacks: why Git can't fast-forward and Sotto asks first. */
  targetCommits: z.number().int().nonnegative().optional(),
  /** The target's new tip: the branch's own tip after a fast-forward, or the merge commit. */
  head: sha.optional(),
  /** The merge commit's subject. */
  subject: z.string().max(600).optional(),
  /** Where the target is checked out: the project folder or the worktree the thread it began from works in. */
  checkedOut: z.enum(['project', 'worktree', 'none']).optional(),
  /**
   * Why nothing was brought: uncommitted work here or where the target is checked out, a conflict, a branch that moved
   * since the question, this worktree off its branch, the target gone, a folder busy with other work, Git refusing, the
   * thread it began from no longer on the target, a check's snapshot of uncommitted changes in the branch, or files the
   * target would gain that its folder already has as ignored files (`message` says which).
   */
  refusal: z.enum(['uncommitted', 'target-uncommitted', 'conflict', 'moved', 'detached', 'gone', 'busy', 'git', 'parent-moved', 'snapshot', 'ignored']).optional(),
  /** How many files hold the uncommitted work that refused it. */
  files: z.number().int().nonnegative().optional(),
  /** Sotto's own sentence for a refusal that has no plainer one: a busy folder, or why Git could not start. */
  message: z.string().max(1_000).optional(),
  /** What Git said when it refused, in its own words, a few lines at most. */
  gitSaid: z.string().max(2_000).optional(),
  /**
   * The thread on another machine whose commits these were, as the desktop that asked names it, on a record kept on the
   * thread the commits went to (`broughtBack`). Absent on a thread's own record.
   */
  from: z.string().min(1).max(600).optional(),
  at: z.string().datetime(),
}).strict()
export type BringBack = z.infer<typeof bringBackSchema>

/**
 * Where a thread's worktree was made from, when that was a branch Sotto moved for it (#1033): the thread whose branch it
 * was, by its Sotto thread ID on its own machine, and that machine as the desktop that started the worker names it when it
 * is not this thread's own. With `host`, `by` is the host ID of that desktop's own computer: only the desktop that started a
 * worker brings it back across machines (Zach, October 23), and a record without `by` is brought back by none. On the
 * worktree record, saved with it.
 */
export const worktreeMadeFromSchema = z.object({ thread: z.string().min(1).max(512), host: z.uuid().optional(), by: z.uuid().optional() }).strict()
export type WorktreeMadeFrom = z.infer<typeof worktreeMadeFromSchema>

/**
 * What the desktop tells the host of the thread the commits go to, for a child on another machine: the move that put the
 * child's branch in that host's project, the child as the desktop names it, and the branch the child's worktree was made
 * from, which that thread must still be on.
 */
export const bringBackAwaySchema = z.object({ moveId: z.uuid(), from: z.string().min(1).max(600), target: z.string().min(1).max(512) }).strict()
export type BringBackAway = z.infer<typeof bringBackAwaySchema>

/** The most of Git's own words a refusal carries. */
export const BRING_BACK_GIT_SAID_MAX = 2_000

/** A test-run snapshot's author and committer (#1033): a commit by it holds someone's uncommitted work, never brought back. */
export const SNAPSHOT_AUTHOR = { name: 'Sotto', email: 'sotto@localhost' } as const
/**
 * Who a merge commit is by when the machine's Git has no identity of its own (a headless host with no user.name or
 * user.email): Sotto, at an address of its own, so the merge is never taken for a check snapshot (`SNAPSHOT_AUTHOR`).
 */
export const MERGE_FALLBACK_AUTHOR = { name: 'Sotto', email: 'sotto-merge@localhost' } as const

/** Where a thread's commits would go: the thread it began from, that thread's branch, and this thread's branch. */
export interface BringBackTarget {
  /** The thread this one began from, named as the caller names threads. */
  readonly parentId: string
  /** The parent's branch, which this thread's worktree was made from. */
  readonly target: string
  /** This thread's own branch. */
  readonly branch: string
  /** Where the parent works, so where the target is checked out as the records say: the project folder or a worktree. */
  readonly where: 'project' | 'worktree'
  /** The parent is on another machine: the branch goes there first, as a branch move, and Git runs there. */
  readonly away: boolean
}

type Linked = Pick<AgentThread, 'id' | 'hostId' | 'worktree' | 'delegatedBy' | 'continuedFrom' | 'startedFrom'>

/** The branch a move landed in an incoming ref, `refs/sotto/incoming/<move>/<branch>`, or undefined for any other ref. */
export function incomingRefBranch(ref: string | undefined): string | undefined {
  return ref ? /^refs\/sotto\/incoming\/[0-9a-f-]{36}\/(.+)$/u.exec(ref)?.[1] : undefined
}

/**
 * The thread a thread began from, named as `thread` is: the one whose branch its worktree was made from, the one that
 * delegated to it, the one it continues, or the one it was started from. A client names threads with host keys, so a
 * thread on another machine is named by its own; a host names its own threads, and has none from another machine.
 */
export function bringBackParentId(thread: Linked): string | undefined {
  const made = thread.worktree?.madeFrom
  if (made) {
    const own = parseHostEntityKey(thread.id)
    if (own) return hostEntityKey(made.host ?? own.hostId, made.thread)
    return made.host === undefined ? made.thread : undefined
  }
  return thread.delegatedBy ?? thread.continuedFrom?.threadId ?? thread.startedFrom?.threadId
}

/** A worktree record's branch: what the host last read, else what the worktree record says. Null for a detached HEAD. */
function branchOf(worktree: AgentThread['worktree']): string | null {
  if (!worktree) return null
  return worktree.git ? worktree.git.branch : worktree.branch ?? null
}

/**
 * Where this thread's commits would go, from the records alone, with no Git run: only for a thread in a new worktree of
 * its own, made from the branch of the thread it began from, which that thread is still on. A worktree used again, a pull
 * request's checkout, one made from another branch or not made yet answers null, and so does a parent whose record is not
 * in `threads`. A child on another machine than its parent is offered only on `desktop`, the host ID of the computer this
 * window runs on, when that desktop started it.
 */
export function bringBackTarget(thread: Linked, threads: readonly Linked[], desktop?: string): BringBackTarget | null {
  const worktree = thread.worktree
  if (!worktree || worktree.mode !== 'independent' || worktree.status !== 'ready' || !worktree.path || worktree.reclaimedAt
    || worktree.reused || worktree.existingWorktreePath || worktree.checkoutBranch) return null
  const made = worktree.baseBranch ?? incomingRefBranch(worktree.incomingRef)
  if (!made) return null
  const parentId = bringBackParentId(thread)
  if (parentId === undefined || parentId === thread.id) return null
  const parent = threads.find(item => item.id === parentId)
  // A delegation, continuation or fork links threads of one host; only a worker started from a branch names another.
  if (!parent || !worktree.madeFrom && parent.hostId !== thread.hostId) return null
  const target = branchOf(parent.worktree)
  if (!target || target !== made) return null
  const branch = branchOf(worktree)
  const away = (parseHostEntityKey(parentId)?.hostId ?? null) !== (parseHostEntityKey(thread.id)?.hostId ?? null)
  // One name is one branch only within one repository. A child on another machine is in another clone, where a branch
  // may well have the parent's name (a laptop's feat/x starting a forge worker on feat/x), and it is offered.
  if (!branch || !away && branch === target) return null
  if (away && (desktop === undefined || worktree.madeFrom?.by !== desktop)) return null
  return { parentId, target, branch, where: parent.worktree?.mode === 'independent' ? 'worktree' : 'project', away }
}

/** A host whose Sotto predates bringing changes back. */
export const BRING_BACK_UNSUPPORTED = 'This host can’t bring changes back yet, and nothing changed. Update Sotto on the host, then try again.'
/** Bringing changes back is part of Work across machines, an Owl feature (ADR-0072): a host without it says so. */
export const BRING_BACK_OFF = 'Bringing changes back is available in Sotto Owl, and nothing changed.'
/** A thread that was not made from its parent's branch, or whose parent moved to another branch. */
export const BRING_BACK_NO_TARGET = 'This thread’s worktree wasn’t made from the branch of the thread it began from, or that thread is on another branch now, so there is nothing to bring back. Nothing changed.'
/** A Yes to a merge-commit question that is no longer the one the host holds. */
export const BRING_BACK_QUESTION_GONE = 'That question is out of date, so Sotto made no merge commit. Press Bring changes again to be asked again.'
/** A child on another machine, pressed somewhere other than the desktop that moves branches. */
export const BRING_BACK_FROM_DESKTOP = 'This thread began from a thread on another machine, so its changes are brought back from Sotto on your desktop. Nothing changed.'
/** A child on another machine that another desktop started, or whose record does not say which desktop did. */
export const BRING_BACK_OTHER_DESKTOP = 'Sotto on another desktop started this thread, and only that desktop can bring its changes back. Bring them back from there. Nothing changed.'
/** The machine of the thread it began from is not connected now. */
export const bringBackNotConnected = (machine: string): string => `${machine} isn’t connected, so nothing was brought back. Connect it, then try again. Nothing changed.`
