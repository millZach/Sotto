import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'

/**
 * What Cursor asks the user (ADR-0123, ADR-0004), as Sotto shows it and answers it. Every answer is the user's own:
 * a permission is allowed once or rejected, never allowed always, since that would save a grant in Sotto's Cursor
 * folder; a question is answered with the options the user chose; a plan is accepted or rejected. Nothing here answers
 * on the user's behalf, and stopping a thread or disconnecting answers `cancelled`, which grants nothing.
 */

/** The method each kind of request arrives on. `cursor/ask_question` and `cursor/create_plan` carry no session ID: a process serves one thread. */
export const CURSOR_PERMISSION = 'session/request_permission'
export const CURSOR_QUESTION = 'cursor/ask_question'
export const CURSOR_PLAN = 'cursor/create_plan'
/** What a plan request's context names, so a window can show it as a plan card rather than a permission (ADR-0123). */
export const CURSOR_PLAN_TOOL = 'cursor/create_plan'
/** The choices a plan card offers, as permission choices: accepting is the allow, rejecting the deny. */
export const CURSOR_PLAN_CHOICES = [
  { id: 'accept-plan', label: 'Accept plan', kind: 'allow-once' },
  { id: 'reject-plan', label: 'Reject', kind: 'deny' },
] as const satisfies NonNullable<AgentRequest['permissionChoices']>
/** Cursor's own option for skipping a question it asks as a permission, when a client takes no `cursor/ask_question`. */
const SKIP_OPTION = '__ask_question_skip__'
const TEXT_LIMIT = 20_000

const optionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
const permissionSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z.object({ toolCallId: z.string().min(1).max(512), title: z.string().max(TEXT_LIMIT).optional(), kind: z.string().max(64).optional(),
    content: z.array(z.unknown()).max(64).optional(), rawInput: z.unknown().optional() }).passthrough(),
  options: z.array(z.object({ optionId: z.string().min(1).max(512), name: z.string().max(512), kind: optionKind })).min(1).max(32),
})
const questionSchema = z.object({
  toolCallId: z.string().min(1).max(512).optional(), title: z.string().max(TEXT_LIMIT).optional(),
  questions: z.array(z.object({ id: z.string().min(1).max(512), prompt: z.string().max(TEXT_LIMIT),
    options: z.array(z.object({ id: z.string().min(1).max(512), label: z.string().min(1).max(TEXT_LIMIT) })).max(64), allowMultiple: z.boolean().optional() })).min(1).max(30),
})
const planSchema = z.object({
  toolCallId: z.string().min(1).max(512).optional(), name: z.string().max(TEXT_LIMIT).optional(), overview: z.string().max(TEXT_LIMIT).optional(),
  plan: z.string().max(1_000_000).default(''), todos: z.array(z.object({ content: z.string().max(TEXT_LIMIT).optional() }).passthrough()).max(500).optional(),
})
type Permission = z.infer<typeof permissionSchema>
type Question = z.infer<typeof questionSchema>

export interface CursorPending {
  readonly wireId: string | number
  readonly threadId: string
  readonly kind: 'permission' | 'question' | 'plan'
  readonly toolCallId: string | undefined
  readonly request: AgentRequest
  readonly permission?: Permission
  readonly question?: Question
  answering?: boolean
}

const contentText = (content: readonly unknown[] | undefined): string[] => (content ?? []).flatMap(item => {
  const inner = item && typeof item === 'object' ? (item as { content?: unknown }).content : undefined
  const part = inner && typeof inner === 'object' ? inner as { type?: unknown; text?: unknown } : undefined
  return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
})
const unquoted = (title: string): string => title.replace(/^`([\s\S]*)`$/u, '$1')

/**
 * One request Cursor sent, as Sotto shows it, or undefined for a request Sotto does not read. `threadId` is the thread
 * whose process asked; the request's own Sotto ID is the adapter's to give.
 */
export function cursorPending(wireId: string | number, method: string, params: unknown, threadId: string): CursorPending | undefined {
  const id = `cursor-request-${JSON.stringify(wireId)}`
  if (method === CURSOR_PERMISSION) {
    const parsed = permissionSchema.safeParse(params)
    if (!parsed.success) return undefined
    const permission = parsed.data
    const said = contentText(permission.toolCall.content)
    // Cursor asks its own question this way only when a client takes no `cursor/ask_question`; Sotto takes it, but a
    // question that comes this way is still a question, answered with one of its options or skipped.
    if (permission.options.some(option => option.optionId === SKIP_OPTION)) {
      const options = permission.options.filter(option => option.optionId !== SKIP_OPTION && option.kind === 'allow_once').map(option => ({ id: option.optionId, label: option.name || option.optionId }))
      const prompt = (said.join('\n') || permission.toolCall.title || 'Cursor has a question.').slice(0, TEXT_LIMIT)
      return { wireId, threadId, kind: 'question', toolCallId: permission.toolCall.toolCallId, permission, request: { id, kind: 'question', text: prompt, options,
        questions: [{ id: 'question', question: prompt, options, multiSelect: false, allowFreeText: false, required: false }], context: { toolCallId: permission.toolCall.toolCallId } } }
    }
    const title = permission.toolCall.title ?? 'Cursor asks to use a tool.'
    const command = permission.toolCall.kind === 'execute' ? unquoted(title) : undefined
    return { wireId, threadId, kind: 'permission', toolCallId: permission.toolCall.toolCallId, permission, request: { id, kind: 'permission',
      text: [title, ...said].join('\n').slice(0, TEXT_LIMIT), options: [],
      // Allow once and reject only: Cursor's allow-always would save a rule in Sotto's Cursor folder (ADR-0123).
      permissionChoices: permission.options.flatMap((option): NonNullable<AgentRequest['permissionChoices']> => option.kind === 'allow_once' ? [{ id: option.optionId, label: 'Allow once', kind: 'allow-once' }]
        : option.kind === 'reject_once' ? [{ id: option.optionId, label: 'Reject', kind: 'deny' }] : []),
      context: { toolCallId: permission.toolCall.toolCallId, ...(command ? { command: command.slice(0, TEXT_LIMIT) } : {}),
        ...(said.length ? { details: said.join('\n').slice(0, 100_000) } : {}) } } }
  }
  if (method === CURSOR_QUESTION) {
    const parsed = questionSchema.safeParse(params)
    if (!parsed.success) return undefined
    const question = parsed.data
    const questions = question.questions.map(entry => ({ id: entry.id, question: entry.prompt || question.title || 'Cursor has a question.',
      options: entry.options.map(option => ({ id: option.id, label: option.label })), multiSelect: entry.allowMultiple === true, allowFreeText: false, required: false }))
    const only = questions.length === 1 ? questions[0]! : undefined
    return { wireId, threadId, kind: 'question', toolCallId: question.toolCallId, question, request: { id, kind: 'question',
      text: (question.title && !only ? question.title : questions.map(entry => entry.question).join('\n')).slice(0, TEXT_LIMIT),
      options: only ? only.options : [], questions, ...(question.toolCallId ? { context: { toolCallId: question.toolCallId } } : {}) } }
  }
  if (method === CURSOR_PLAN) {
    const parsed = planSchema.safeParse(params)
    if (!parsed.success) return undefined
    const plan = parsed.data
    const text = [plan.name, plan.overview, plan.plan].filter(part => part?.trim()).join('\n\n') || 'Cursor has a plan.'
    return { wireId, threadId, kind: 'plan', toolCallId: plan.toolCallId, request: { id, kind: 'permission', text: text.slice(0, TEXT_LIMIT), options: [],
      permissionChoices: CURSOR_PLAN_CHOICES.map(choice => ({ ...choice })),
      context: { toolName: CURSOR_PLAN_TOOL, ...(plan.toolCallId ? { toolCallId: plan.toolCallId } : {}), ...(plan.plan ? { details: plan.plan.slice(0, 100_000) } : {}) } } }
  }
  return undefined
}

/**
 * The answer to send for the user's reply. A permission is allowed once or rejected; a question is answered with the
 * options chosen, or skipped when none was; a plan is accepted or rejected.
 */
export function cursorAnswer(pending: CursorPending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string): unknown {
  if (pending.kind === 'plan') {
    const accepted = permissionChoice ? permissionValue(pending.request, permissionChoice, approved) === 'accept-plan' : approved === true
    return { outcome: accepted ? { outcome: 'accepted' } : { outcome: 'rejected' } }
  }
  if (pending.kind === 'permission') {
    const options = pending.permission!.options
    if (permissionChoice) {
      const chosen = permissionValue(pending.request, permissionChoice, approved)
      return { outcome: { outcome: 'selected', optionId: chosen } }
    }
    const selected = options.find(option => option.kind === (approved === true ? 'allow_once' : 'reject_once'))
    if (approved === true && !selected) throw new Error('Cursor did not offer to allow this once. Nothing was approved.')
    return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  const questions = pending.request.questions ?? []
  let supplied = questionAnswers
  if (!supplied) {
    const only = questions.length === 1 ? questions[0]! : undefined
    if (!only) throw new Error('Answer each of Cursor’s questions by choosing its options.')
    const words = answer.trim().toLowerCase()
    const option = only.options.find(entry => entry.label.toLowerCase() === words || entry.id.toLowerCase() === words)
    if (words && !option) throw new Error('Cursor’s question takes one of its own options. Choose one of them.')
    supplied = { [only.id]: { optionIds: option ? [option.id] : [] } }
  }
  questionValues(pending.request, supplied)
  const answered = questions.flatMap(entry => {
    const chosen = supplied[entry.id]?.optionIds ?? []
    return chosen.length ? [{ questionId: entry.id, selectedOptionIds: [...chosen] }] : []
  })
  // A question Cursor asked as a permission takes its one chosen option back the same way, or its own skip.
  if (pending.permission) return { outcome: { outcome: 'selected', optionId: answered[0]?.selectedOptionIds[0] ?? SKIP_OPTION } }
  return { outcome: answered.length ? { outcome: 'answered', answers: answered } : { outcome: 'skipped' } }
}

/** What a request is answered when the user did not answer it: the thread stopped, or Sotto disconnected. It grants nothing. */
export function cursorDecline(pending: CursorPending): unknown {
  void pending
  return { outcome: { outcome: 'cancelled' } }
}
