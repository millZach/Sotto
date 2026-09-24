import { z } from 'zod'

const id = z.string().min(1).max(512)
const line = z.string().max(2_000)

/** The three ways GitHub merges a pull request, in T3's order and words (ADR-0027). */
export const gitPullRequestMergeMethodSchema = z.enum(['merge', 'squash', 'rebase'])
export type GitPullRequestMergeMethod = z.infer<typeof gitPullRequestMergeMethodSchema>
export const GIT_PULL_REQUEST_MERGE_METHOD_LABELS: Record<GitPullRequestMergeMethod, string> = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }

/** What a press on the Pull request surface asks GitHub to do, each through `gh` on the user's own sign-in. */
export const gitPullRequestActionSchema = z.enum(['merge', 'ready', 'draft', 'close', 'reopen', 'update-branch', 'enable-auto-merge', 'disable-auto-merge'])
export type GitPullRequestAction = z.infer<typeof gitPullRequestActionSchema>

/** A GitHub pull request URL, the only kind Sotto links or acts on (ADR-0027: GitHub only). */
export const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/\s?#]+)\/([^/\s?#]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/iu
export const gitPullRequestUrlSchema = z.string().max(2_048).regex(GITHUB_PULL_REQUEST_URL, 'Use a GitHub pull request URL.')
const gitHubUrlSchema = z.string().max(2_048).regex(/^https:\/\/github\.com\//iu)

/**
 * A pull request linked to a thread, kept on the thread's record so every client lists the same ones: the
 * one the Git action created, one the user linked with Link pull request, one checked out from the branch
 * picker. `title`, `state` and `draft` are what GitHub said when the host last read it.
 */
export const gitPullRequestLinkSchema = z.object({
  number: z.number().int().positive(),
  url: gitPullRequestUrlSchema,
  title: z.string().max(500),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  source: z.enum(['created', 'linked', 'checkout']),
  linkedAt: z.string(),
}).strict()
export type GitPullRequestLink = z.infer<typeof gitPullRequestLinkSchema>
export type GitPullRequestLinkSource = GitPullRequestLink['source']
export const GIT_PULL_REQUEST_LINKS_MAX = 50

/** One check on the pull request's head, named, with T3's reading of its state. */
export const gitPullRequestCheckSchema = z.object({
  name: z.string().max(500),
  status: z.enum(['success', 'failure', 'cancelled', 'pending', 'action-required', 'skipped', 'neutral']),
  url: z.string().max(2_048).nullable(),
  description: line.nullable(),
}).strict()
export type GitPullRequestCheck = z.infer<typeof gitPullRequestCheckSchema>

/**
 * A reviewer's latest review that took a side, approving or asking for changes, as GitHub keeps one per
 * reviewer: who, which side, and where the review is on GitHub. Comments that took no side are not listed.
 */
export const gitPullRequestReviewSchema = z.object({
  author: z.string().max(100),
  state: z.enum(['approved', 'changes_requested']),
  url: gitHubUrlSchema.nullable(),
}).strict()
export type GitPullRequestReview = z.infer<typeof gitPullRequestReviewSchema>

/**
 * What the Pull request surface's merge checklist is read from, through `gh` when the surface opens or is
 * refreshed: each check, the review decision and the reviews behind it, whether it merges cleanly, how far the
 * branch is behind its base, the merge methods the repository allows, an armed auto-merge, and the
 * description. Never pushed with the state; the record carries only the link.
 */
export const gitPullRequestDetailSchema = z.object({
  number: z.number().int().positive(),
  url: gitPullRequestUrlSchema,
  title: z.string().max(500),
  body: z.string().max(65_536),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  baseBranch: z.string().max(512),
  headBranch: z.string().max(512),
  /** The pull request comes from another repository (a fork). */
  crossRepository: z.boolean(),
  /** GitHub's decision; null where the repository does not require a review. */
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
  /** Each reviewer's latest approving or changes-requested review, oldest first; empty when GitHub did not say. */
  // A paired host on an earlier build answers without these two; its read still stands, naming no reviewer and no merge time.
  reviews: z.array(gitPullRequestReviewSchema).max(50).default([]),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  checks: z.array(gitPullRequestCheckSchema).max(200),
  /** The methods this repository allows; all three when GitHub did not say, and a press is left to GitHub to refuse. */
  mergeMethods: z.array(gitPullRequestMergeMethodSchema).max(3),
  /** Whether the repository allows auto-merge; true when GitHub did not say, and a press is left to GitHub to refuse. */
  autoMergeAllowed: z.boolean(),
  /** An armed auto-merge and the method it will use, or null when none is armed. */
  autoMerge: z.object({ method: gitPullRequestMergeMethodSchema.nullable() }).strict().nullable(),
  /** When it merged, as GitHub records it; null until it has. */
  mergedAt: z.string().max(64).nullable().default(null),
  /** Commits the base has that the head lacks; null when GitHub could not compare them. */
  behindBy: z.number().int().nonnegative().nullable(),
  /** Whether this viewer may update the branch from its base. */
  canUpdateBranch: z.boolean(),
  /** Whether this pull request is linked to the thread, and how; null when it is not. */
  linked: z.enum(['created', 'linked', 'checkout']).nullable(),
  /** Whether this is the pull request of the branch the thread's folder is on. */
  branch: z.boolean(),
}).strict()
export type GitPullRequestDetail = z.infer<typeof gitPullRequestDetailSchema>

/**
 * What the Pull request surface, the Link pull request dialog and the Checkout pull request dialog ask of
 * the host: one thread's pull request by a reference (a GitHub URL, `#42`, `42` or a `gh pr checkout` line),
 * or, with none, the branch's own or the one last linked. Answered with the detail, or null when the thread
 * has none to show.
 */
export const gitPullRequestRequestSchema = z.object({ threadId: id, reference: z.string().min(1).max(2_048).optional() }).strict()
export type GitPullRequestRequest = z.infer<typeof gitPullRequestRequestSchema>
export const gitPullRequestResultSchema = gitPullRequestDetailSchema.nullable()
export const AGENT_GIT_PULL_REQUEST = 'sotto:agents:git-pull-request'

/** The URL of the pull request on the branch a thread's folder is on, as the host last read it. */
export function branchPullRequestUrl(thread: { readonly worktree?: { readonly git?: { readonly pullRequest?: { readonly url: string } | null } | undefined } | undefined }): string | undefined {
  return thread.worktree?.git?.pullRequest?.url
}

/**
 * A pull request reference as T3 reads one (`parsePullRequestReference`): a `gh pr checkout` line, a GitHub
 * pull request URL, `#42` or `42`. Returns the URL or the bare number, or null for anything else.
 */
export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const normalized = /^gh\s+pr\s+checkout\s+(.+)$/iu.exec(trimmed)?.[1]?.trim() ?? trimmed
  if (!normalized) return null
  if (GITHUB_PULL_REQUEST_URL.test(normalized)) return normalized
  const number = /^#?(\d{1,9})$/u.exec(normalized)?.[1]
  return number && Number(number) > 0 ? String(Number(number)) : null
}
