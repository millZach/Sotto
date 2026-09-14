import { z } from 'zod'
import { fileRelativePathSchema } from './files'
import { toolListRequestSchema, toolTargetSchema, type ToolsResult } from './tools'

export const checkpointRequestSchema = toolTargetSchema.extend({ checkpointId: z.string().uuid() }).strict()
export const checkpointRevertSchema = checkpointRequestSchema.extend({ confirmed: z.literal(true) }).strict()
export const checkpointSchema = z.object({
  id: z.string().uuid(), threadId: z.string(), createdAt: z.string(),
  status: z.enum(['ready', 'reverting', 'uncertain', 'reverted', 'unavailable']),
  files: z.array(z.object({ path: fileRelativePathSchema, change: z.enum(['added', 'modified', 'deleted']) }).strict()),
  supported: z.boolean(), reason: z.string().optional(),
}).strict()
export const checkpointListingSchema = z.object({ checkpoints: z.array(checkpointSchema), supported: z.boolean(), reason: z.string().optional() }).strict()
export const checkpointInspectionSchema = z.object({ checkpoint: checkpointSchema, patches: z.array(z.object({ path: fileRelativePathSchema, before: z.string().nullable(), after: z.string().nullable(), binary: z.boolean() }).strict()) }).strict()
export type Checkpoint = z.infer<typeof checkpointSchema>
export interface CheckpointBridge {
  checkpoints?(request: z.infer<typeof toolListRequestSchema>): Promise<ToolsResult<z.infer<typeof checkpointListingSchema>>>
  inspectCheckpoint?(request: z.infer<typeof checkpointRequestSchema>): Promise<ToolsResult<z.infer<typeof checkpointInspectionSchema>>>
  revertCheckpoint?(request: z.infer<typeof checkpointRevertSchema>): Promise<ToolsResult<Checkpoint>>
  recoverCheckpoint?(request: z.infer<typeof checkpointRequestSchema>): Promise<ToolsResult<Checkpoint>>
}
