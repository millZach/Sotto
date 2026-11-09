import { z } from 'zod'
import type { AgentRequest } from '../../shared/agents'
import { permissionValue } from './nativeRequests'
import { cardUnderHeadline, commandCard, modelSummary, otherRequestCard } from './requestInput'

/** Unexpected native requests still reach the user in Full access. Only one-time choices are exposed;
 * the native tool input is shown when available, while Hermes v0.23.0 may supply a generic command. */

export const HERMES_PERMISSION = 'session/request_permission'
const TEXT_LIMIT = 20_000

const permissionSchema = z.object({
  sessionId: z.string().min(1).max(512),
  toolCall: z.object({ toolCallId: z.string().min(1).max(512), title: z.string().optional(), rawInput: z.unknown().optional() }).passthrough(),
  options: z.array(z.object({ optionId: z.string().min(1).max(512), name: z.string().max(512),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })).min(1).max(32),
})
type Permission = z.infer<typeof permissionSchema>

/** What the tool update that preceded a request said, as the adapter buffered it: the tool's name and its input. */
export interface HermesToolDetail {
  readonly title?: string | undefined
  readonly rawInput?: unknown
}

export interface HermesPending {
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
export function hermesPending(wireId: string | number, method: string, params: unknown, threadId: string, detail: HermesToolDetail = {}): HermesPending | undefined {
  if (method !== HERMES_PERMISSION) return undefined
  const parsed = permissionSchema.safeParse(params)
  if (!parsed.success) return undefined
  const permission = parsed.data
  detail = { ...detail, ...permission.toolCall }
  const input = object(detail.rawInput)
  const command = words(input?.command)
  const path = words(input?.file_path) ?? words(input?.filePath) ?? words(input?.path)
  const justification = words(input?.justification)
  const tool = detail.title?.trim() || 'a tool'
  const headline = command ? `Run: ${command}` : path ? `${tool}: ${path}` : `Hermes asks to use ${tool}.`
  // The escalation's own fields are said in words below; everything else in the input is an ordinary card's.
  const rest = input ? Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'sandbox_permissions' && name !== 'justification')) : undefined
  const card = command ? commandCard(command.slice(0, TEXT_LIMIT), rest).context
    : rest ? cardUnderHeadline(otherRequestCard(rest, detail.title?.trim()), headline.slice(0, TEXT_LIMIT)) : undefined
  // The description says what a command does and the justification why it must cross. The summary takes the first it has.
  const reasonIsSummary = Boolean(command && !card?.summary && modelSummary(justification, command))
  const summary = card?.summary ?? (reasonIsSummary ? modelSummary(justification, command) : undefined)
  const detailLines = [
    ...(justification && !reasonIsSummary ? [`The model’s reason: ${justification}`] : []),
    ...(card?.details ? [card.details] : []),
  ]
  const id = `hermes-request-${JSON.stringify(wireId)}`
  return {
    wireId, threadId, toolCallId: permission.toolCall.toolCallId, permission,
    request: {
      id, kind: 'permission',
      text: headline.slice(0, TEXT_LIMIT),
      options: [],
      permissionChoices: permission.options.flatMap((option): NonNullable<AgentRequest['permissionChoices']> => option.kind === 'allow_once' ? [{ id: option.optionId, label: 'Allow once', kind: 'allow-once' }]
        : option.kind === 'reject_once' ? [{ id: option.optionId, label: 'Reject', kind: 'deny' }] : []),
      context: {
        toolCallId: permission.toolCall.toolCallId,
        ...(detail.title ? { toolName: detail.title.slice(0, TEXT_LIMIT) } : {}),
        ...card,
        ...(summary ? { summary } : {}),
        ...(detailLines.length ? { details: detailLines.join('\n').slice(0, 100_000) } : {}),
      },
    },
  }
}

/** The answer to send for the user's reply: the allow-once or reject-once choice they made, never anything wider. */
export function hermesAnswer(pending: HermesPending, approved?: boolean, permissionChoice?: string): unknown {
  if (permissionChoice) return { outcome: { outcome: 'selected', optionId: permissionValue(pending.request, permissionChoice, approved) } }
  const selected = pending.permission.options.find(option => option.kind === (approved === true ? 'allow_once' : 'reject_once'))
  if (approved === true && !selected) throw new Error('Hermes did not offer to allow this once. Nothing was approved.')
  return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
}

/** What a request is answered when the user did not answer it: the thread stopped, or Sotto disconnected. It grants nothing. */
export function hermesDecline(pending: HermesPending): unknown {
  void pending
  return { outcome: { outcome: 'cancelled' } }
}
