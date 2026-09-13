import { z } from 'zod'
import { fileRelativePathSchema, fileWorkspaceSchema, type FilePath } from './files'
import { toolTargetSchema, toolListRequestSchema, type ToolsResult } from './tools'

export const GIT_CHANGES_CHANNEL = 'sotto:git-changes:'
export const GIT_CHANGES_EVENT = `${GIT_CHANGES_CHANNEL}changed`
export const GIT_MAX_PATCH = 512 * 1024
export const gitChangeSchema = z.object({ path: fileRelativePathSchema, originalPath: fileRelativePathSchema.optional(), status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'type-changed']), staged: z.boolean(), unstaged: z.boolean() }).strict()
export const gitListingSchema = z.object({ workspace: fileWorkspaceSchema, branch: z.string().nullable(), revision: z.string(), files: z.array(gitChangeSchema).max(2000), truncated: z.boolean() }).strict()
export const gitDiffRequestSchema = toolTargetSchema.extend({ path: fileRelativePathSchema.refine(value => value.length > 0) })
export const gitWatchRequestSchema = toolTargetSchema.extend({ enabled: z.boolean() })
export const gitDiffSchema = z.object({ workspace: fileWorkspaceSchema, path: fileRelativePathSchema, revision: z.string(), content: z.union([z.object({ kind: z.literal('text'), patch: z.string().max(GIT_MAX_PATCH) }).strict(), z.object({ kind: z.enum(['binary', 'too-large', 'unavailable']), message: z.string() }).strict()]) }).strict()
export const gitChangedSchema = toolTargetSchema.extend({ revision: z.string() })
export type GitChange = z.infer<typeof gitChangeSchema>
export type GitChangeListing = z.infer<typeof gitListingSchema>
export type GitFileDiff = z.infer<typeof gitDiffSchema>
export interface GitChangesBridge {
  list(request: z.infer<typeof toolListRequestSchema>): Promise<ToolsResult<GitChangeListing>>
  diff(request: z.infer<typeof gitDiffRequestSchema>): Promise<ToolsResult<GitFileDiff>>
  copyPath(request: z.infer<typeof gitDiffRequestSchema>): Promise<ToolsResult<FilePath>>
  reveal(request: z.infer<typeof gitDiffRequestSchema>): Promise<ToolsResult<FilePath>>
  watch(request: z.infer<typeof gitWatchRequestSchema>): Promise<ToolsResult<void>>
  onChanged(listener: (event: z.infer<typeof gitChangedSchema>) => void): () => void
}
