import { z } from 'zod'
import { fileWorkspaceSchema } from './files'
import { toolListRequestSchema, toolTargetSchema, type ToolsResult } from './tools'
export const prReviewRequestSchema = toolListRequestSchema.extend({ remote: z.string().min(1).max(240).optional() }).strict()
export const prActionSchema = toolTargetSchema.extend({ revision: z.string().min(1), remote: z.string().min(1).max(240), action: z.enum(['push', 'create']), base: z.string().min(1).max(240).optional(), title: z.string().min(1).max(500).optional(), body: z.string().max(60000).optional() }).strict()
/** Drafting reads the branch; the base and remote come from the review the form already holds. */
export const prDraftRequestSchema = toolListRequestSchema.extend({ remote: z.string().min(1).max(240).optional(), base: z.string().min(1).max(240).optional() }).strict()
/** Nulls mean nothing was written - no key, generation off, no commits, or a failed request. Never an error. */
export const prDraftSchema = z.object({ title: z.string().nullable(), body: z.string().nullable() }).strict()
export const pullRequestSchema = z.object({ number: z.number().int().positive(), title: z.string(), url: z.string().url(), state: z.string(), base: z.string(), head: z.string(), draft: z.boolean(), review: z.string(), checks: z.array(z.object({ name: z.string(), status: z.string(), url: z.string().nullable() }).strict()) }).strict()
export const prReviewSchema = z.object({ workspace: fileWorkspaceSchema, revision: z.string(), branch: z.string().nullable(), head: z.string(), remotes: z.array(z.string()), remote: z.string().nullable(), remoteUrl: z.string(), repository: z.string().nullable(), base: z.string(), title: z.string(), body: z.string(), pullRequest: pullRequestSchema.nullable(), error: z.string().nullable() }).strict()
export const prActionResultSchema = z.object({ message: z.string(), pullRequest: pullRequestSchema.nullable() }).strict()
export type PrReview = z.infer<typeof prReviewSchema>
export type PrDraft = z.infer<typeof prDraftSchema>
export type PullRequest = z.infer<typeof pullRequestSchema>
export interface GitPullRequestsBridge {
  reviewPullRequest?(request: z.infer<typeof prReviewRequestSchema>): Promise<ToolsResult<PrReview>>
  draftPullRequestText?(request: z.infer<typeof prDraftRequestSchema>): Promise<ToolsResult<PrDraft>>
  actPullRequest?(request: z.infer<typeof prActionSchema>): Promise<ToolsResult<z.infer<typeof prActionResultSchema>>>
}
