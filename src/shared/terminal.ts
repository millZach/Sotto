import { z } from 'zod'
import { fileWorkspaceSchema } from './files'
import { toolTargetSchema, type ToolsResult } from './tools'

export const TERMINAL_CHANNEL = 'sotto:terminal:'
export const TERMINAL_EVENT = `${TERMINAL_CHANNEL}event`
export const TERMINAL_MAX_OUTPUT = 512 * 1024
export const terminalSizeSchema = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) })
export const terminalCreateSchema = toolTargetSchema.extend({ cols: terminalSizeSchema.shape.cols.optional(), rows: terminalSizeSchema.shape.rows.optional() })
export const terminalRequestSchema = toolTargetSchema.extend({ sessionId: z.string().uuid() })
export const terminalWriteSchema = terminalRequestSchema.extend({ data: z.string().min(1).max(65536) })
export const terminalResizeSchema = terminalRequestSchema.extend(terminalSizeSchema.shape)
export const terminalSessionSchema = z.object({
  id: z.string().uuid(), workspace: fileWorkspaceSchema, title: z.string().max(256), shell: z.string().max(4096),
  status: z.enum(['running', 'exited', 'interrupted', 'unavailable']), ...terminalSizeSchema.shape,
  exitCode: z.number().int().nullable(), createdAt: z.number().finite(),
}).strict()
export const terminalSnapshotSchema = z.object({ session: terminalSessionSchema, output: z.string().max(TERMINAL_MAX_OUTPUT), sequence: z.number().int().nonnegative() }).strict()
export const terminalListingSchema = z.object({ workspace: fileWorkspaceSchema, sessions: z.array(terminalSessionSchema).max(32) }).strict()
const identity = { threadId: z.string(), workspaceId: z.string(), sessionId: z.string().uuid() }
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), ...identity, data: z.string().max(65536), sequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('session'), session: terminalSessionSchema }).strict(),
  z.object({ type: z.literal('closed'), ...identity }).strict(),
])
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>
export type TerminalEvent = z.infer<typeof terminalEventSchema>
export interface TerminalBridge {
  list(request: { threadId: string }): Promise<ToolsResult<z.infer<typeof terminalListingSchema>>>
  create(request: z.infer<typeof terminalCreateSchema>): Promise<ToolsResult<TerminalSnapshot>>
  read(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<TerminalSnapshot>>
  write(request: z.infer<typeof terminalWriteSchema>): Promise<ToolsResult<void>>
  resize(request: z.infer<typeof terminalResizeSchema>): Promise<ToolsResult<void>>
  interrupt(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<void>>
  close(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<void>>
  reopen(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<TerminalSnapshot>>
  onEvent(listener: (event: TerminalEvent) => void): () => void
}
