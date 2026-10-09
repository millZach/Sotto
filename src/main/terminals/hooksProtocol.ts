import { z } from 'zod'

export const TERMINAL_HOOK_FRAME_BYTES = 8 * 1024
export const TERMINAL_HOOK_MAX_CONNECTIONS = 32
/** IDs carry no provider text. Unknown/native structured forms remain in the CLI. */
export const terminalHookId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u)
export const terminalAgentHookEventSchema = z.object({
  terminalId: terminalHookId, runId: terminalHookId, eventId: terminalHookId,
  kind: z.enum(['session-start', 'working', 'permission', 'notification', 'completed', 'cancelled', 'ended']),
  state: z.enum(['starting', 'working', 'needs-you', 'idle']),
  providerSessionId: terminalHookId.optional(), turnId: terminalHookId.optional(),
  requestId: terminalHookId.optional(), approvalId: terminalHookId.optional(),
  notificationType: z.enum(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'question']).optional(),
  workPhase: z.enum(['submitted', 'tool-start', 'tool-end', 'continuing']).optional(),
}).strict()
export type TerminalAgentHookEvent = z.infer<typeof terminalAgentHookEventSchema>
export const terminalHookFrameSchema = terminalAgentHookEventSchema.extend({ secret: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export const terminalHookAnswerSchema = z.object({
  terminalId: terminalHookId, runId: terminalHookId, requestId: terminalHookId, approvalId: terminalHookId,
  answerId: terminalHookId, decision: z.enum(['allow', 'deny']),
}).strict()
export type TerminalHookAnswer = z.infer<typeof terminalHookAnswerSchema>
export const terminalHookAcknowledgementSchema = z.object({
  type: z.literal('answer-delivered'), secret: z.string().regex(/^[a-f0-9]{64}$/u),
  terminalId: terminalHookId, runId: terminalHookId, requestId: terminalHookId, approvalId: terminalHookId, answerId: terminalHookId,
}).strict()
