import { z } from 'zod'
import type { AgentRequest } from '../../shared/agents'
import { permissionValue } from './nativeRequests'

/**
 * What DeepSeek Harness asks the user (ADR-0136, ADR-0004). Its one request is a sandbox escalation: a tool call
 * the sandbox denied, retried with `sandbox_permissions` and a `justification`, arrives as
 * `session/request_permission` carrying only the tool call's ID and two one-shot choices. The detail a card needs
 * is in the `tool_call` update the harness sends first, so the adapter buffers it and hands it here: the card
 * shows the command or file itself, the boundary it asks to cross, and the model's justification named as the
 * model's. The user answers every one, allow once or reject; there is no allow-always to offer, and declining
 * grants nothing. Questions have no route on this surface, so none is built here.
 */

export const DEEPSEEK_PERMISSION = 'session/request_permission'
const TEXT_LIMIT = 20_000

const permissionSchema = z.object({
  sessionId: z.string().min(1).max(512),
  toolCall: z.object({ toolCallId: z.string().min(1).max(512) }).passthrough(),
  options: z.array(z.object({ optionId: z.string().min(1).max(512), name: z.string().max(512),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })).min(1).max(32),
})
type Permission = z.infer<typeof permissionSchema>

/** What the tool update that preceded a request said, as the adapter buffered it: the tool's name and its input. */
export interface DeepSeekToolDetail {
  readonly title?: string | undefined
  readonly rawInput?: unknown
}

export interface DeepSeekPending {
  readonly wireId: string | number
  readonly threadId: string
  readonly toolCallId: string
  readonly request: AgentRequest
  readonly permission: Permission
  answering?: boolean
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const words = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

/**
 * One escalation request, as Sotto shows it, or undefined for a frame Sotto does not read. The request's own Sotto
 * ID is the adapter's to give. A request whose tool update was never buffered still becomes a card, naming only
 * the tool: never approving from ignorance is the user's to do with a reject.
 */
export function deepseekPending(wireId: string | number, method: string, params: unknown, threadId: string, detail: DeepSeekToolDetail = {}): DeepSeekPending | undefined {
  if (method !== DEEPSEEK_PERMISSION) return undefined
  const parsed = permissionSchema.safeParse(params)
  if (!parsed.success) return undefined
  const permission = parsed.data
  const input = object(detail.rawInput)
  const command = words(input?.command)
  const path = words(input?.file_path) ?? words(input?.filePath) ?? words(input?.path)
  const boundary = words(input?.sandbox_permissions)
  const justification = words(input?.justification)
  const tool = detail.title?.trim() || 'a tool'
  const headline = command ? `Run in ${boundary ?? 'a wider sandbox'}: ${command}`
    : path ? `${tool} ${path} outside the sandbox`
    : `DeepSeek Harness asks to use ${tool} outside the sandbox.`
  const detailLines = [
    ...(boundary ? [`Sandbox it asks for: ${boundary}`] : []),
    ...(justification ? [`The model’s reason: ${justification}`] : []),
    ...(command ? [] : input ? [JSON.stringify(input)] : []),
  ]
  const id = `deepseek-request-${JSON.stringify(wireId)}`
  return {
    wireId, threadId, toolCallId: permission.toolCall.toolCallId, permission,
    request: {
      id, kind: 'permission',
      text: [headline, ...detailLines].join('\n').slice(0, TEXT_LIMIT),
      options: [],
      permissionChoices: permission.options.flatMap((option): NonNullable<AgentRequest['permissionChoices']> => option.kind === 'allow_once' ? [{ id: option.optionId, label: 'Allow once', kind: 'allow-once' }]
        : option.kind === 'reject_once' ? [{ id: option.optionId, label: 'Reject', kind: 'deny' }] : []),
      context: {
        toolCallId: permission.toolCall.toolCallId,
        ...(detail.title ? { toolName: detail.title.slice(0, TEXT_LIMIT) } : {}),
        ...(command ? { command: command.slice(0, TEXT_LIMIT) } : {}),
        ...(detailLines.length ? { details: detailLines.join('\n').slice(0, 100_000) } : {}),
      },
    },
  }
}

/** The answer to send for the user's reply: the allow-once or reject-once choice they made, never anything wider. */
export function deepseekAnswer(pending: DeepSeekPending, approved?: boolean, permissionChoice?: string): unknown {
  if (permissionChoice) return { outcome: { outcome: 'selected', optionId: permissionValue(pending.request, permissionChoice, approved) } }
  const selected = pending.permission.options.find(option => option.kind === (approved === true ? 'allow_once' : 'reject_once'))
  if (approved === true && !selected) throw new Error('DeepSeek Harness did not offer to allow this once. Nothing was approved.')
  return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
}

/** What a request is answered when the user did not answer it: the thread stopped, or Sotto disconnected. It grants nothing. */
export function deepseekDecline(pending: DeepSeekPending): unknown {
  void pending
  return { outcome: { outcome: 'cancelled' } }
}
