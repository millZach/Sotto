import { z } from 'zod'
import { terminalAgentStateSchema, terminalProviderSchema, TERMINALS_MAX } from './terminalWorkspace'
import type { ToolsResult } from './tools'

/** ADR-0066: phone rows contain state and opaque bindings, never output or launch arguments. */
const hookId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u)
export const phoneTerminalApprovalBindingSchema = z.object({ runId: hookId, requestId: hookId, approvalId: hookId,
  previewId: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict()
export const phoneTerminalSchema = z.object({
  id: z.uuid(), projectId: z.string().max(512), title: z.string().min(1).max(256),
  providerId: terminalProviderSchema.nullable(), state: terminalAgentStateSchema,
  stateDetection: z.enum(['available', 'unavailable']), openedAt: z.number().finite(),
  approval: phoneTerminalApprovalBindingSchema.optional(),
}).strict()
export const phoneTerminalListSchema = z.array(phoneTerminalSchema).max(TERMINALS_MAX)
export const phoneTerminalApprovalSchema = phoneTerminalApprovalBindingSchema.extend({
  terminalId: z.uuid(), previewId: z.string().regex(/^[a-f0-9]{64}$/u),
  lines: z.array(z.string().max(512)).min(1).max(8),
}).strict()
export const phoneTerminalAnswerSchema = phoneTerminalApprovalSchema.omit({ lines: true }).extend({ decision: z.enum(['allow', 'deny']) }).strict()
export type PhoneTerminal = z.infer<typeof phoneTerminalSchema>
export type PhoneTerminalApproval = z.infer<typeof phoneTerminalApprovalSchema>
export type PhoneTerminalAnswer = z.infer<typeof phoneTerminalAnswerSchema>

/** Only the desktop phone listener receives this source. Headless hosts advertise no terminals. */
export interface PhoneTerminals {
  phoneRows(): PhoneTerminal[]
  phoneApproval(terminalId: string): PhoneTerminalApproval | null
  /** Recheck authorization immediately before atomic hook dispatch. */
  answerPhoneApproval(answer: PhoneTerminalAnswer, authorized: () => boolean): Promise<boolean>
  visibility(payload: { ids: string[] }, client: object, active: () => boolean): Promise<ToolsResult<void>>
  withdrawVisibility(client: object): void
  subscribePhoneRows(listener: () => void): () => void
}
