import { z } from 'zod'
import { fileRelativePathSchema, fileWorkspaceSchema, type FilePath } from './files'
import { toolTargetSchema, toolListRequestSchema, type ToolsResult } from './tools'
import type { CheckpointBridge } from './checkpoints'

export const GIT_CHANGES_CHANNEL = 'sotto:git-changes:'
export const GIT_CHANGES_EVENT = `${GIT_CHANGES_CHANNEL}changed`
/** One file's patch past this is not shown as text. */
export const GIT_MAX_PATCH = 512 * 1024
/** A whole comparison's patches are read up to this; the files past it say so. */
export const GIT_REVIEW_MAX_PATCH = 2 * 1024 * 1024
export const GIT_REVIEW_MAX_FILES = 2000
export const gitChangeStatusSchema = z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'type-changed'])
export const gitChangeSchema = z.object({ path: fileRelativePathSchema, originalPath: fileRelativePathSchema.optional(), status: gitChangeStatusSchema }).strict()
export const gitListingSchema = z.object({ workspace: fileWorkspaceSchema, branch: z.string().nullable(), revision: z.string(), files: z.array(gitChangeSchema).max(GIT_REVIEW_MAX_FILES), truncated: z.boolean() }).strict()
/** A path in the thread's working folder, for Copy path and reveal. */
export const gitPathRequestSchema = toolTargetSchema.extend({ path: fileRelativePathSchema.refine(value => value.length > 0) }).strict()
/**
 * A ref Branch changes compares against: a local branch (`main`) or a remote one (`origin/main`). Never an
 * option, a range or a revision expression; Git checks that it names a commit.
 */
// eslint-disable-next-line no-control-regex
export const gitBaseRefSchema = z.string().min(1).max(240).refine(value => !value.startsWith('-') && !/[\s\0-\x1f\x7f~^:?*[\\]|\.\.|@\{/u.test(value), 'A branch name')
/** What Changes compares: the working tree against HEAD, or the branch against a base (`base...HEAD`), Automatic when `base` is null. */
export const gitReviewScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working') }).strict(),
  z.object({ kind: z.literal('branch'), base: gitBaseRefSchema.nullable() }).strict(),
])
export const gitReviewRequestSchema = toolTargetSchema.extend({ scope: gitReviewScopeSchema, ignoreWhitespace: z.boolean().optional() }).strict()
export const gitFileContentSchema = z.union([
  z.object({ kind: z.literal('text'), patch: z.string().max(GIT_MAX_PATCH) }).strict(),
  z.object({ kind: z.enum(['binary', 'too-large', 'unavailable']), message: z.string() }).strict(),
])
/** One changed file of a comparison: how it changed, its line counts when Git could count them, and its patch. */
export const gitReviewFileSchema = z.object({
  path: fileRelativePathSchema, originalPath: fileRelativePathSchema.optional(), status: gitChangeStatusSchema,
  additions: z.number().int().nonnegative().nullable(), deletions: z.number().int().nonnegative().nullable(),
  content: gitFileContentSchema,
}).strict()
export const gitReviewSchema = z.object({
  workspace: fileWorkspaceSchema,
  revision: z.string(),
  /** The comparison as it was read: for Branch changes, the base it resolved to (null when none was found) and the branch it compared. */
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('working') }).strict(),
    z.object({ kind: z.literal('branch'), base: z.string().nullable(), automatic: z.boolean(), head: z.string().nullable() }).strict(),
  ]),
  files: z.array(gitReviewFileSchema).max(GIT_REVIEW_MAX_FILES),
  truncated: z.boolean(),
}).strict()
export const gitWatchRequestSchema = toolTargetSchema.extend({ enabled: z.boolean() })
export const gitChangedSchema = toolTargetSchema.extend({ revision: z.string() })
export type GitChange = z.infer<typeof gitChangeSchema>
export type GitChangeStatus = z.infer<typeof gitChangeStatusSchema>
export type GitChangeListing = z.infer<typeof gitListingSchema>
export type GitReviewScope = z.infer<typeof gitReviewScopeSchema>
export type GitReviewFile = z.infer<typeof gitReviewFileSchema>
export type GitReview = z.infer<typeof gitReviewSchema>
export interface GitChangesBridge extends CheckpointBridge {
  list(request: z.infer<typeof toolListRequestSchema>): Promise<ToolsResult<GitChangeListing>>
  review(request: z.infer<typeof gitReviewRequestSchema>): Promise<ToolsResult<GitReview>>
  copyPath(request: z.infer<typeof gitPathRequestSchema>): Promise<ToolsResult<FilePath>>
  reveal(request: z.infer<typeof gitPathRequestSchema>): Promise<ToolsResult<FilePath>>
  watch(request: z.infer<typeof gitWatchRequestSchema>): Promise<ToolsResult<void>>
  onChanged(listener: (event: z.infer<typeof gitChangedSchema>) => void): () => void
}
