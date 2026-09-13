import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'

const questionSchema = z.object({ sessionId: z.string(), toolCallId: z.string(), questions: z.array(z.object({ question: z.string(), id: z.string().optional(), header: z.string().optional(), multiSelect: z.boolean().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })).default([]) })).min(1).max(30) })
const permissionSchema = z.object({ sessionId: z.string(), toolCall: z.object({ toolCallId: z.string(), title: z.string().optional(), rawInput: z.unknown().optional() }), options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })) })
export type GrokPending = { wireId: string | number; threadId: string; toolCallId: string; request: AgentRequest; permission?: z.infer<typeof permissionSchema>; question?: z.infer<typeof questionSchema>; answering?: boolean }
export function grokPending(wireId: string | number, method: string, value: unknown, threadId: string): GrokPending | undefined {
  const id = `grok-request-${JSON.stringify(wireId)}`
  if (method === 'session/request_permission') {
    const permission = permissionSchema.parse(value)
    return { wireId, threadId, toolCallId: permission.toolCall.toolCallId, permission, request: { id, kind: 'permission', text: `${permission.toolCall.title ?? 'Grok requests permission to use a tool.'}${permission.toolCall.rawInput === undefined ? '' : `\n${JSON.stringify(permission.toolCall.rawInput).slice(0, 20000)}`}`, options: [],
      permissionChoices: permission.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind === 'allow_once' ? 'allow-once' : option.kind === 'allow_always' ? 'allow-always' : 'deny',
        ...(['allow_always', 'reject_always'].includes(option.kind) ? { description: 'Remember this decision using the native provider’s offered scope.' } : {}) })),
      context: { toolCallId: permission.toolCall.toolCallId, details: permission.toolCall.rawInput === undefined ? undefined : JSON.stringify(permission.toolCall.rawInput).slice(0, 100000) } } }
  }
  if (method === 'x.ai/ask_user_question') {
    const question = questionSchema.parse(value)
    return { wireId, threadId, toolCallId: question.toolCallId, question, request: { id, kind: 'question', text: question.questions.map(q => q.question).join('\n'), options: question.questions.length === 1 ? question.questions[0]!.options.map(option => ({ id: option.label, label: option.label })) : [],
      questions: question.questions.map((q, index) => ({ id: String(index), question: q.question, header: q.header, options: q.options.map(option => ({ id: option.label, ...option })), multiSelect: q.multiSelect ?? false, allowFreeText: true })), context: { toolCallId: question.toolCallId } } }
  }
  return undefined
}
export function grokAnswer(pending: GrokPending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string): unknown {
  if (pending.permission) {
    if (permissionChoice) return { outcome: { outcome: 'selected', optionId: permissionValue(pending.request, permissionChoice, approved) } }
    const selected = pending.permission.options.find(option => option.kind === (approved === true ? 'allow_once' : 'reject_once'))
    if (approved === true && !selected) throw new Error('Grok did not offer a one-time permission. Answer in Grok.')
    return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  const questions = pending.question!.questions
  let supplied = questionAnswers
  if (!supplied) {
    let values: Record<string, string>
    if (questions.length === 1) values = { [questions[0]!.question]: answer }
    else { try { values = z.record(z.string(), z.string()).parse(JSON.parse(answer)) } catch { throw new Error('Answer every Grok question with a JSON object keyed by question text.') } }
    supplied = Object.fromEntries(questions.map((question, index) => { const value = values[question.question] ?? ''; return [String(index), question.options.some(option => option.label === value) ? { optionIds: [value] } : { optionIds: [], text: value }] }))
  }
  questionValues(pending.request, supplied)
  return { outcome: 'accepted', answers: Object.fromEntries(questions.map((question, index) => [question.question, [...supplied[String(index)]!.optionIds, ...(supplied[String(index)]!.text?.trim() ? ['Other'] : [])]])),
    annotations: Object.fromEntries(questions.flatMap((question, index) => {
      const answer = supplied[String(index)]!; const preview = !question.multiSelect && answer.optionIds.length === 1 ? question.options.find(option => option.label === answer.optionIds[0])?.preview : undefined
      return preview || answer.text?.trim() ? [[question.question, { ...(preview ? { preview } : {}), ...(answer.text?.trim() ? { notes: answer.text } : {}) }]] : []
    })) }
}
