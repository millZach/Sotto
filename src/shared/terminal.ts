import { z } from 'zod'
import { fileWorkspaceSchema } from './files'
import { toolListRequestSchema, toolTargetSchema, type ToolsResult } from './tools'

export const TERMINAL_CHANNEL = 'sotto:terminal:'
export const TERMINAL_EVENT = `${TERMINAL_CHANNEL}event`
export const TERMINAL_MAX_OUTPUT = 512 * 1024
export const TERMINAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** FileReader emits base64 PNGs; reject their actual byte size before preload's transport ceiling hides the reason. */
export function terminalImageSizeError(dataUrl: string): { code: 'invalid-request'; message: string } | null {
  const base64Length = dataUrl.length - 'data:image/png;base64,'.length
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return Math.floor(base64Length * 3 / 4) - padding > TERMINAL_IMAGE_MAX_BYTES
    ? { code: 'invalid-request', message: 'The PNG is larger than 10 MiB. Paste a smaller image.' } : null
}
/** Where a shell lives: the shared Tools surface, or a pane's own drawer. The two never show each other's shells. */
export const terminalPlaceSchema = z.enum(['tools', 'drawer'])
export type TerminalPlace = z.infer<typeof terminalPlaceSchema>
export const terminalSizeSchema = z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) })
export const terminalCreateSchema = toolTargetSchema.extend({ cols: terminalSizeSchema.shape.cols.optional(), rows: terminalSizeSchema.shape.rows.optional(), place: terminalPlaceSchema.optional() })
export const terminalListRequestSchema = toolListRequestSchema.extend({ place: terminalPlaceSchema.optional() })
export const terminalRequestSchema = toolTargetSchema.extend({ sessionId: z.string().uuid() })
export const terminalWriteSchema = terminalRequestSchema.extend({ data: z.string().min(1).max(65536) })
export const terminalResizeSchema = terminalRequestSchema.extend(terminalSizeSchema.shape)
export const terminalImageSchema = terminalRequestSchema.extend({ dataUrl: z.string().max(Math.ceil(TERMINAL_IMAGE_MAX_BYTES * 4 / 3) + 64) }).strict()
export const terminalSessionSchema = z.object({
  id: z.string().uuid(), workspace: fileWorkspaceSchema, title: z.string().max(256), shell: z.string().max(4096),
  status: z.enum(['running', 'exited', 'interrupted', 'unavailable']), ...terminalSizeSchema.shape,
  exitCode: z.number().int().nullable(), createdAt: z.number().finite(),
  // A session saved before the drawer existed carries no place; it reads as a Tools shell, where it always lived.
  place: terminalPlaceSchema.default('tools'),
}).strict()
export const terminalSnapshotSchema = z.object({ session: terminalSessionSchema, output: z.string().max(TERMINAL_MAX_OUTPUT), sequence: z.number().int().nonnegative() }).strict()
export const terminalListingSchema = z.object({ workspace: fileWorkspaceSchema, sessions: z.array(terminalSessionSchema).max(32) }).strict()
const identity = { threadId: z.string(), workspaceId: z.string(), sessionId: z.string().uuid() }
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), ...identity, data: z.string().max(65536), sequence: z.number().int().nonnegative(), place: terminalPlaceSchema }).strict(),
  z.object({ type: z.literal('session'), session: terminalSessionSchema }).strict(),
  z.object({ type: z.literal('closed'), ...identity }).strict(),
])
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>
export type TerminalEvent = z.infer<typeof terminalEventSchema>
export interface TerminalBridge {
  list(request: z.infer<typeof terminalListRequestSchema>): Promise<ToolsResult<z.infer<typeof terminalListingSchema>>>
  create(request: z.infer<typeof terminalCreateSchema>): Promise<ToolsResult<TerminalSnapshot>>
  read(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<TerminalSnapshot>>
  write(request: z.infer<typeof terminalWriteSchema>): Promise<ToolsResult<void>>
  resize(request: z.infer<typeof terminalResizeSchema>): Promise<ToolsResult<void>>
  interrupt(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<void>>
  close(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<void>>
  reopen(request: z.infer<typeof terminalRequestSchema>): Promise<ToolsResult<TerminalSnapshot>>
  pasteImage(request: z.infer<typeof terminalImageSchema>): Promise<ToolsResult<void>>
  /** Native menu zoom yields to terminal zoom only while a terminal (including its search) has focus. */
  setFocused?(focused: boolean): Promise<ToolsResult<void>>
  onEvent(listener: (event: TerminalEvent) => void): () => void
}
