import { z } from 'zod'

/** The branch's pull request as the host last heard from GitHub, through `gh` on the user's own sign-in. */
export const gitPullRequestSummarySchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string(),
  state: z.enum(['open', 'closed', 'merged']), draft: z.boolean(),
}).strict()
export type GitPullRequestSummary = z.infer<typeof gitPullRequestSummarySchema>

/**
 * What the host knows about a working copy's Git state: the branch and its distance from its upstream
 * and from the default branch, whether the tree is dirty, and the branch's pull request. It is read the
 * way T3 Code reads it (`status --porcelain=2 --branch`, `diff --numstat`, a background fetch under the
 * Git fetch interval setting, `gh pr list --head`), lives on the thread's worktree record, and reaches
 * every client through the state stream. Counts are against the local tracking ref; `fetchedAt` says
 * how current that ref is, and is null when nothing has fetched.
 */
export const gitStatusSchema = z.object({
  isRepository: z.boolean(),
  /** The checked-out branch; null for a detached HEAD or a folder that is not a repository. */
  branch: z.string().nullable(),
  /** The tracking ref, such as `origin/main`; null when the branch has none. */
  upstream: z.string().nullable(),
  /** Whether the repository has an `origin` remote. */
  hasRemote: z.boolean(),
  /** The remote's default branch (`origin/HEAD`), else a local `main` or `master`; null when there is none. */
  defaultBranch: z.string().nullable(),
  isDefaultBranch: z.boolean(),
  dirty: z.boolean(),
  changedFiles: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** Commits on this branch that the default branch lacks; null on the default branch or without one. */
  aheadOfDefault: z.number().int().nonnegative().nullable(),
  pullRequest: gitPullRequestSummarySchema.nullable(),
  /** When the remote was last fetched successfully, or null when it never was (or fetching is off). */
  fetchedAt: z.string().nullable(),
  readAt: z.string(),
}).strict()
export type GitStatus = z.infer<typeof gitStatusSchema>

/** The parts of a status two reads compare, so a re-read that found nothing new publishes nothing. */
export function gitStatusFingerprint(status: GitStatus | undefined): string {
  if (!status) return ''
  return JSON.stringify({ ...status, readAt: undefined })
}
