import { z } from 'zod'
import { fileWorkspaceSchema } from './files'

export const toolListRequestSchema = z.object({ threadId: z.string().min(1).max(512), workspaceId: fileWorkspaceSchema.shape.workspaceId.optional() }).strict()
export const toolTargetSchema = toolListRequestSchema.required()
export type ToolTarget = z.infer<typeof toolTargetSchema>
export const toolsErrorSchema = z.object({ code: z.enum(['invalid-request', 'thread-unavailable', 'workspace-unavailable', 'workspace-changed', 'session-unavailable', 'page-unavailable', 'not-running', 'busy', 'unavailable', 'not-repository', 'path-unavailable', 'blocked', 'too-large']), message: z.string().max(2000) }).strict()
export type ToolsError = z.infer<typeof toolsErrorSchema>
export type ToolsResult<T> = { ok: true; value: T } | { ok: false; error: ToolsError }
export function toolsResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), error: toolsErrorSchema }).strict()])
}
