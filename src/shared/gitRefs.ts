import { z } from 'zod'

const id = z.string().min(1).max(512)
export const GIT_REFS_MAX_LIMIT = 200

/** One branch the picker can offer: a local one, or a remote one no local branch already stands for. */
export const gitRefSchema = z.object({
  /** `main`, or `origin/feature` for a remote ref. */
  name: z.string(),
  /** The remote's name for a remote ref; absent for a local branch. */
  remote: z.string().optional(),
  /** Checked out in the folder the request was about. */
  current: z.boolean(),
  /** The repository's default branch (`origin/HEAD`), or a local `main` or `master` without a remote. */
  isDefault: z.boolean(),
  /** Where a local branch is checked out when it is another worktree of the same repository; null otherwise. */
  worktreePath: z.string().nullable(),
}).strict()
export type GitRef = z.infer<typeof gitRefSchema>

/** A page of a working copy's branches, the way T3's `listRefs` answers: a query, a cursor and a cap. */
export const gitRefsRequestSchema = z.object({
  threadId: id,
  query: z.string().max(256).optional(),
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(GIT_REFS_MAX_LIMIT).optional(),
  /** Whether a remote ref is listed even when a local branch of the same name exists. */
  includeMatchingRemoteRefs: z.boolean().optional(),
  /** Read the repository again rather than the two-minute cache. */
  refresh: z.boolean().optional(),
}).strict()
export type GitRefsRequest = z.infer<typeof gitRefsRequestSchema>

export const gitRefsPageSchema = z.object({
  refs: z.array(gitRefSchema).max(GIT_REFS_MAX_LIMIT),
  isRepository: z.boolean(),
  hasRemote: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
}).strict()
export type GitRefsPage = z.infer<typeof gitRefsPageSchema>

export const AGENT_GIT_REFS = 'sotto:agents:git-refs'
