import { z } from 'zod'
import type { AgentProject, AgentThread } from './agents'

/**
 * Clearing settled threads (ADR-0140): what the commands, the confirmation and the automatic rule share. Main works out
 * every list and checks each thread again as it is deleted; the window only shows them.
 */

/** The ages Clear now offers, in days; 0 is any age. */
export const CLEAR_THREADS_AGES = [0, 7, 30, 90] as const
export const clearThreadsAgeSchema = z.union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
export type ClearThreadsAge = z.infer<typeof clearThreadsAgeSchema>
/** The ages Clear settled threads after offers, in days; null is Never. */
export const CLEAR_SETTLED_THREADS_AFTER_DAYS = [30, 90, 180] as const
export const clearSettledThreadsAfterDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(180)]).nullable()
export type ClearSettledThreadsAfterDays = z.infer<typeof clearSettledThreadsAfterDaysSchema>
/** How many threads one Clear names at most. */
export const THREAD_CLEAR_MAX = 1_000

/**
 * Why a settled thread is kept back (ADR-0140 decision 3), as a code the window words with `threadClearKeptWords` and the
 * log names as it is. `worktree-error` is a worktree Sotto tried to remove and could not, for a reason the other codes do
 * not cover: a folder with no branch checked out, or one Git refused.
 */
export const THREAD_CLEAR_KEPT_REASONS = ['working', 'waiting-on-you', 'queued', 'pull-request', 'delegated-working', 'babysitting', 'watched',
  'uncommitted', 'worktree-files', 'worktree-in-use', 'worktree-error', 'not-settled', 'hidden'] as const
export const threadClearKeptReasonSchema = z.enum(THREAD_CLEAR_KEPT_REASONS)
export type ThreadClearKeptReason = z.infer<typeof threadClearKeptReasonSchema>

const KEPT_WORDS: Readonly<Record<ThreadClearKeptReason, string>> = {
  working: 'still working',
  'waiting-on-you': 'waiting on you',
  queued: 'something is queued for it',
  'pull-request': 'pull request still open',
  'delegated-working': 'a thread it delegated to is still working',
  babysitting: 'being babysat',
  watched: 'Watcher is watching it',
  uncommitted: 'uncommitted changes in its worktree',
  'worktree-files': 'its worktree holds files Git ignores; delete it on its own to review them',
  'worktree-in-use': 'its worktree is in use',
  'worktree-error': 'its worktree could not be removed; delete it on its own to see why',
  'not-settled': 'not settled',
  hidden: 'hidden',
}
/** Why a thread is kept, as a short lower-case clause that reads after its title. */
export function threadClearKeptWords(reason: ThreadClearKeptReason): string { return KEPT_WORDS[reason] }

const threadIdSchema = z.string().min(1).max(512)
const titleSchema = z.string().max(512)
export const threadClearKeptSchema = z.object({ threadId: threadIdSchema, title: titleSchema, projectTitle: titleSchema, reason: threadClearKeptReasonSchema }).strict()
export type ThreadClearKept = z.infer<typeof threadClearKeptSchema>
/** What Clear settled threads lists: the threads that go, and the settled ones past the age that are kept, each with why. */
export const threadClearPreviewSchema = z.object({
  olderThanDays: clearThreadsAgeSchema,
  go: z.array(z.object({ threadId: threadIdSchema, title: titleSchema, projectTitle: titleSchema,
    /** When it went quiet: the later of its settle and its last activity. */
    quietSince: z.string().max(64),
    /** Whether its own worktree folder goes with it. */
    removesWorktree: z.boolean() }).strict()).max(THREAD_CLEAR_MAX),
  kept: z.array(threadClearKeptSchema).max(THREAD_CLEAR_MAX),
}).strict()
export type ThreadClearPreview = z.infer<typeof threadClearPreviewSchema>
export const threadClearResultSchema = z.object({ cleared: z.number().int().nonnegative(), kept: z.array(threadClearKeptSchema).max(THREAD_CLEAR_MAX) }).strict()
export type ThreadClearResult = z.infer<typeof threadClearResultSchema>

const timeOf = (value: string | null | undefined): number | undefined => {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}
/**
 * When a settled thread went quiet, in milliseconds (ADR-0140 decision 2): the later of the settle that applies, its own
 * or else its project's, and its last activity. Undefined for a thread that is not settled.
 */
export function threadQuietSince(thread: Pick<AgentThread, 'workspaceSettledAt' | 'updatedAt' | 'summary'>, project?: Pick<AgentProject, 'workspaceSettledAt'>): number | undefined {
  const settled = timeOf(thread.workspaceSettledAt) ?? timeOf(project?.workspaceSettledAt)
  if (settled === undefined) return undefined
  const active = Math.max(timeOf(thread.updatedAt) ?? 0, timeOf(thread.summary?.lastMessageAt) ?? 0)
  return Math.max(settled, active)
}
const DAY_MS = 86_400_000
/** Whether a thread quiet since `quietSince` is older than `days` at `now`; any age (0) takes every settled thread. */
export function quietLongerThan(quietSince: number, days: number, now: number): boolean {
  return days <= 0 || now - quietSince > days * DAY_MS
}
