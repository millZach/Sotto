import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'

const objectSchema = z.record(z.string(), z.unknown())

const idSchema = z.string().min(1).max(256)
const permissionSchema = z.object({
  sessionId: idSchema, toolCall: z.object({ toolCallId: idSchema }),
  options: z.array(z.object({ optionId: idSchema, name: z.string().min(1).max(2_000), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })).min(1).max(20),
})
const fieldSchema = z.object({
  type: z.literal('string'), title: z.string().optional(), description: z.string().optional(), default: z.string().optional(),
  enum: z.array(z.string()).min(1).max(100).optional(), enumNames: z.array(z.string()).max(100).optional(),
  oneOf: z.array(z.object({ const: z.string(), title: z.string() }).strict()).min(1).max(100).optional(),
  minLength: z.number().int().min(0).max(100_000).optional(), maxLength: z.number().int().min(0).max(100_000).optional(),
}).strict().refine(field => !(field.enum && field.oneOf) && (!field.enumNames || field.enum?.length === field.enumNames.length)
  && (field.minLength ?? 0) <= (field.maxLength ?? 100_000))
const formSchema = z.object({
  type: z.literal('object'), title: z.string().optional(), description: z.string().optional(),
  properties: z.record(z.string().min(1).max(256), fieldSchema),
  required: z.array(idSchema).max(100).optional(), additionalProperties: z.literal(false).optional(),
}).strict().refine(form => {
  const keys = Object.keys(form.properties)
  return keys.length > 0 && keys.length <= 100 && (form.required ?? []).every(key => Object.hasOwn(form.properties, key))
})
const questionSchema = z.object({ sessionId: idSchema.optional(), mode: z.literal('form'), message: z.string().optional(), requestedSchema: formSchema })
type Permission = z.infer<typeof permissionSchema>
type Question = z.infer<typeof questionSchema>
export type DevinPending = { wireId: string | number; threadId: string; toolCallId?: string; request: AgentRequest; actionDetails?: string
  /** What the answer allows (`devinActionScope`), checked again before the answer goes. */
  scope?: string; permission?: Permission; question?: Question; answering?: boolean }

function invalidRequest(): never { throw new Error('Devin sent a request Sotto cannot safely answer. Stop this turn and review it in Devin.') }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  return result.success ? result.data : invalidRequest()
}

/** The name Devin calls one of a session's MCP tools by, as its permission rules match it (`mcp__server__tool`). */
export const devinMcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** Devin's own name for the tool a call is for, from its tool-call meta, when it gives one. */
const metaToolName = (toolCall: Record<string, unknown>): string | undefined => {
  const name = record(toolCall._meta)?.['cognition.ai/toolName']
  return typeof name === 'string' ? name : undefined
}
/** A title that may name the tool: never a command's, whose title is the command text, which could read like a tool name. */
const titleToolName = (toolCall: Record<string, unknown>): string | undefined =>
  toolCall.kind !== 'execute' && typeof toolCall.title === 'string' ? toolCall.title : undefined
/**
 * The Sotto tool a tool call is, when it names one of the session's own (`sottoTools`, by `devinMcpToolName`). Devin's
 * tool-call meta names the tool and is trusted when present; only a call without it is named by its title.
 */
function sottoToolOf(toolCall: Record<string, unknown>, sottoTools: ReadonlySet<string>): string | undefined {
  const name = metaToolName(toolCall) ?? titleToolName(toolCall)
  return name !== undefined && sottoTools.has(name) ? name : undefined
}
/** The call names an MCP tool that is not one of the session's own, in its meta or its title. */
const namesForeignTool = (toolCall: Record<string, unknown>, sottoTools: ReadonlySet<string>): boolean =>
  [metaToolName(toolCall), titleToolName(toolCall)].some(name => name?.startsWith('mcp__') === true && !sottoTools.has(name))
/** Devin says it cut the tool call's input short, so what it shows is not the whole action. */
const truncatedInput = (toolCall: Record<string, unknown>): boolean => record(toolCall._meta)?.['cognition.ai/toolInputTruncated'] === true
/**
 * What an answer to a permission allows: the tool call's input, which of the session's Sotto tools it is, if any, and
 * whether Devin cut its input short. An answer counts only while the tool call still reads the same in all three.
 */
export function devinActionScope(toolCall: Record<string, unknown> | undefined, sottoTools: ReadonlySet<string>): string {
  return JSON.stringify(toolCall ? [toolCall.rawInput ?? null, sottoToolOf(toolCall, sottoTools) ?? null, truncatedInput(toolCall)] : null)
}

/**
 * Native permission requests often carry only a tool ID; the matching activity supplies its action. A command or a file
 * change is shown when its input is complete. A call to one of the session's own Sotto tools is shown with its whole input,
 * whatever it holds, and refused when Devin says it cut that input short: the user answers it like any other, and nothing
 * here answers it for them (ADR-0004).
 */
export function devinPending(wireId: string | number, method: string, value: unknown, threadId: string, toolCall?: Record<string, unknown>,
  sottoTools: ReadonlySet<string> = new Set()): DevinPending | undefined {
  const id = `devin-request-${JSON.stringify(wireId)}`
  if (method === 'session/request_permission') {
    const permission = parse(permissionSchema, value)
    if (new Set(permission.options.map(option => option.optionId)).size !== permission.options.length) invalidRequest()
    if (!toolCall || toolCall.toolCallId !== permission.toolCall.toolCallId) invalidRequest()
    const input = parse(objectSchema, toolCall.rawInput)
    // Input Devin says it cut short is never the whole action, and an MCP tool that is not one of the session's own
    // Sotto tools is not shown at all, whatever its input looks like.
    if (truncatedInput(toolCall)) invalidRequest()
    if (namesForeignTool(toolCall, sottoTools)) invalidRequest()
    const sottoTool = sottoToolOf(toolCall, sottoTools)
    const command = !sottoTool && typeof input.command === 'string' && input.command.trim() ? input.command : undefined
    const file = typeof input.file_path === 'string' && input.file_path.trim() && (typeof input.content === 'string' || typeof input.old_string === 'string' && typeof input.new_string === 'string') ? input.file_path : undefined
    if (!command && !file && !sottoTool) invalidRequest()
    const details = JSON.stringify(input)
    if (details.length > 100_000) invalidRequest() // Never offer an approval with silently omitted scope.
    const choices = permission.options.filter(option => option.kind === 'allow_once' || option.kind === 'reject_once')
    if (!choices.some(option => option.kind === 'reject_once')) invalidRequest()
    const text = sottoTool ? `Use Sotto’s ${sottoTool.slice(sottoTool.lastIndexOf('__') + 2)} tool`
      : typeof toolCall.title === 'string' ? toolCall.title.slice(0, 2_000) : 'Devin requests permission.'
    return { wireId, threadId, toolCallId: permission.toolCall.toolCallId, permission, actionDetails: details, scope: devinActionScope(toolCall, sottoTools), request: {
      id, kind: 'permission', text, options: [],
      permissionChoices: choices.map(option => ({ id: option.optionId, label: option.kind === 'allow_once' ? 'Allow once' : 'Deny', kind: option.kind === 'allow_once' ? 'allow-once' : 'deny' })),
      context: { toolCallId: permission.toolCall.toolCallId, ...(command && Object.keys(input).length === 1 ? { command } : { details }) },
    } }
  }
  if (method === 'elicitation/create') {
    const question = parse(questionSchema, value)
    const questions: NonNullable<AgentRequest['questions']> = Object.entries(question.requestedSchema.properties).map(([id, field]) => ({
      id, question: field.description ?? field.title ?? id, ...(field.title ? { header: field.title } : {}),
      options: field.oneOf?.map(option => ({ id: option.const, label: option.title })) ?? field.enum?.map((value, index) => ({ id: value, label: field.enumNames?.[index] ?? value })) ?? [],
      multiSelect: false, allowFreeText: !field.enum && !field.oneOf, required: question.requestedSchema.required?.includes(id) ?? false,
    }))
    return { wireId, threadId, question, request: { id, kind: 'question', text: question.message ?? 'Devin needs your input.', questions, options: questions.length === 1 ? questions[0]!.options : [], skippable: true } }
  }
  return undefined
}
export function devinDecline(pending: DevinPending): unknown {
  return pending.permission ? { outcome: { outcome: 'cancelled' } } : { action: 'decline' }
}
/** Invoked only after an explicit user answer, never on a timer, disconnect or skipped request. */
export function devinAnswer(pending: DevinPending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string, skipped?: boolean): unknown {
  if (pending.permission) {
    if (typeof approved !== 'boolean') throw new Error('Explicitly allow or deny this permission request.')
    const choice = permissionChoice
      ? permissionValue(pending.request, permissionChoice, approved)
      : pending.permission.options.find(option => option.kind === (approved ? 'allow_once' : 'reject_once'))?.optionId
    if (!choice) throw new Error('Devin did not offer this one-time decision.')
    return { outcome: { outcome: 'selected', optionId: choice } }
  }
  if (approved === false || skipped) return devinDecline(pending)
  const form = pending.question!.requestedSchema
  let content: Record<string, unknown>
  if (questionAnswers) {
    const answers = questionValues(pending.request, questionAnswers)
    content = Object.fromEntries(Object.keys(answers).map(key => [key, questionAnswers[key]!.optionIds[0] ?? questionAnswers[key]!.text]))
  } else {
    try { content = parse(objectSchema, JSON.parse(answer)) }
    catch {
      const keys = Object.keys(form.properties)
      if (keys.length !== 1 || answer.trim().startsWith('{')) throw new Error('Answer every field in this question.')
      content = { [keys[0]!]: answer }
    }
  }
  if ((form.required ?? []).some(key => !Object.hasOwn(content, key))) throw new Error('Answer every required field.')
  for (const [key, value] of Object.entries(content)) {
    const field = form.properties[key]
    if (!Object.hasOwn(form.properties, key) || !field || typeof value !== 'string') throw new Error('Answer only the fields Devin requested.')
    if (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 100_000)) throw new Error('The answer does not fit this field’s length limits.')
    if (field.enum && !field.enum.includes(value) || field.oneOf && !field.oneOf.some(option => option.const === value)) throw new Error('Choose an offered question option.')
  }
  return { action: 'accept', content }
}
