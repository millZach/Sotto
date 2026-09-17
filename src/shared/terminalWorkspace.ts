import { z } from 'zod'
import { agentWorktreeSchema, providerIdSchema } from './agents'
import { TERMINAL_MAX_OUTPUT, terminalSizeSchema } from './terminal'
import type { ToolsResult } from './tools'

/** Terminal mode: terminals opened beside Threads, owned by a project rather than a thread. */
export const TERMINALS_CHANNEL = 'sotto:terminals:'
export const TERMINALS_EVENT = `${TERMINALS_CHANNEL}event`
export const TERMINALS_MAX = 64
/** A pasted image on its way to a terminal's folder: PNG only, the same ceiling as an attachment. */
export const TERMINAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export const terminalPermissionSchema = z.enum(['ask', 'edits', 'everything'])
export const terminalLaunchSchema = z.object({
  provider: providerIdSchema.nullable(),
  /** Sotto's public model ID; the command mapping reads the CLI name out of it. */
  modelId: z.string().max(512).nullable(),
  reasoning: z.string().max(64).nullable(),
  permission: terminalPermissionSchema.nullable(),
}).strict()
export type TerminalLaunch = z.infer<typeof terminalLaunchSchema>

export const workingCopyModeSchema = z.enum(['independent', 'shared'])
export const workspaceTerminalSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().max(512),
  title: z.string().min(1).max(256),
  launch: terminalLaunchSchema,
  workingCopy: workingCopyModeSchema,
  worktree: agentWorktreeSchema.optional(),
  workingDirectory: z.string().max(4_096),
  branch: z.string().max(256).nullable(),
  /** The command as shown in the dialog's Runs box and printed on the terminal's first line. */
  command: z.string().max(4_096),
  /** `starting` is published the moment the terminal is asked for, before its process exists; its branch may still be null. */
  status: z.enum(['starting', 'running', 'exited', 'unavailable']),
  ...terminalSizeSchema.shape,
  exitCode: z.number().int().nullable(),
  openedAt: z.number().finite(),
  /** Set once the terminal is closed; it then sits on the Closed shelf until Sotto quits. Nothing outlives the session. */
  closedAt: z.number().finite().nullable(),
}).strict()
export type WorkspaceTerminal = z.infer<typeof workspaceTerminalSchema>

export const terminalOpenSchema = z.object({
  projectId: z.string().min(1).max(512), title: z.string().min(1).max(256), workingCopy: workingCopyModeSchema, launch: terminalLaunchSchema,
  cols: terminalSizeSchema.shape.cols.optional(), rows: terminalSizeSchema.shape.rows.optional(),
}).strict()
export const workspaceTerminalRequestSchema = z.object({ id: z.string().uuid() }).strict()
export const workspaceTerminalWriteSchema = workspaceTerminalRequestSchema.extend({ data: z.string().min(1).max(65536) }).strict()
export const workspaceTerminalResizeSchema = workspaceTerminalRequestSchema.extend(terminalSizeSchema.shape).strict()
export const workspaceTerminalImageSchema = workspaceTerminalRequestSchema.extend({ dataUrl: z.string().max(14_000_000) }).strict()
export const workspaceTerminalSnapshotSchema = z.object({ terminal: workspaceTerminalSchema, output: z.string().max(TERMINAL_MAX_OUTPUT), sequence: z.number().int().nonnegative() }).strict()
export const workspaceTerminalListingSchema = z.object({
  terminals: z.array(workspaceTerminalSchema).max(TERMINALS_MAX),
  /** The shell a terminal without a provider opens, by name: what the dialog's Runs box shows for it. */
  shell: z.string().max(256),
}).strict()
export const workspaceTerminalImageResultSchema = z.object({ path: z.string().max(4_096) }).strict()
export const workspaceTerminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), id: z.string().uuid(), data: z.string().max(65536), sequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('terminal'), terminal: workspaceTerminalSchema }).strict(),
])
export type WorkspaceTerminalSnapshot = z.infer<typeof workspaceTerminalSnapshotSchema>
export type WorkspaceTerminalEvent = z.infer<typeof workspaceTerminalEventSchema>
export type TerminalOpenRequest = z.infer<typeof terminalOpenSchema>

export interface TerminalWorkspaceBridge {
  list(): Promise<ToolsResult<z.infer<typeof workspaceTerminalListingSchema>>>
  /** Resolves as soon as the terminal exists, with status `starting`; the process and the branch follow as events. */
  open(request: TerminalOpenRequest): Promise<ToolsResult<WorkspaceTerminalSnapshot>>
  read(request: z.infer<typeof workspaceTerminalRequestSchema>): Promise<ToolsResult<WorkspaceTerminalSnapshot>>
  write(request: z.infer<typeof workspaceTerminalWriteSchema>): Promise<ToolsResult<void>>
  resize(request: z.infer<typeof workspaceTerminalResizeSchema>): Promise<ToolsResult<void>>
  interrupt(request: z.infer<typeof workspaceTerminalRequestSchema>): Promise<ToolsResult<void>>
  /** Ends the process; the terminal stays open with its output. */
  stop(request: z.infer<typeof workspaceTerminalRequestSchema>): Promise<ToolsResult<void>>
  /** Starts the same command again in the same folder, under the same ID, with fresh output. Reopens a closed terminal. */
  restart(request: z.infer<typeof workspaceTerminalRequestSchema>): Promise<ToolsResult<WorkspaceTerminalSnapshot>>
  close(request: z.infer<typeof workspaceTerminalRequestSchema>): Promise<ToolsResult<void>>
  /** Saves a pasted PNG under the terminal's folder and types its path into the terminal. */
  pasteImage(request: z.infer<typeof workspaceTerminalImageSchema>): Promise<ToolsResult<z.infer<typeof workspaceTerminalImageResultSchema>>>
  onEvent(listener: (event: WorkspaceTerminalEvent) => void): () => void
}
