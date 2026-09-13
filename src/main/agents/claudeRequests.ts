import { z } from 'zod'
import type { AgentRequest, AgentQuestionAnswers } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'
import { object, type ClaudeFrame } from './claudeProtocol'

const questionSchema = z.object({ question: z.string().min(1), header: z.string().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional() })
const questionsSchema = z.object({ questions: z.array(questionSchema).min(1).max(20) })
export interface ClaudePending { id: string; tool: string; input: ClaudeFrame; request: AgentRequest; questions?: z.infer<typeof questionSchema>[] }
export function claudePending(frame: ClaudeFrame): ClaudePending | undefined {
  const data = object(frame.request)
  if (typeof frame.request_id !== 'string' || data?.subtype !== 'can_use_tool' || typeof data.tool_name !== 'string' || !data.tool_name.trim() || !object(data.input)) return undefined
  const input = data.input as ClaudeFrame
  if (data.tool_name === 'AskUserQuestion') {
    const parsed = questionsSchema.safeParse(input)
    if (!parsed.success) return undefined
    const questions = parsed.data.questions
    return { id: frame.request_id, tool: data.tool_name, input, questions,
      request: { id: frame.request_id, kind: 'question', text: questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${questions.length > 1 && q.options?.length ? `\n${q.options.map(o => o.label).join(' / ')}` : ''}`).join('\n'),
        options: questions.length === 1 ? (questions[0]!.options ?? []).map(option => ({ id: option.label, label: option.label })) : [],
        questions: questions.map((q, index) => ({ id: String(index), question: q.question, header: q.header, multiSelect: q.multiSelect ?? false, allowFreeText: true, options: (q.options ?? []).map(option => ({ id: option.label, ...option })) })),
        context: { toolName: data.tool_name, ...(typeof data.tool_use_id === 'string' ? { toolCallId: data.tool_use_id } : {}) } } }
  }
  const description = typeof data.description === 'string' ? data.description : typeof input.description === 'string' ? input.description : ''
  return { id: frame.request_id, tool: data.tool_name, input,
    request: { id: frame.request_id, kind: 'permission', text: `${data.tool_name}${description ? `: ${description}` : ''}\n${JSON.stringify(input)}`, options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      permissionChoices: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
      context: { toolName: data.tool_name, ...(typeof data.tool_use_id === 'string' ? { toolCallId: data.tool_use_id } : {}), ...(typeof input.command === 'string' ? { command: input.command } : {}), details: JSON.stringify(input).slice(0, 100000) } } }
}
export function claudeDenial(): ClaudeFrame { return { behavior: 'deny', message: 'The user did not approve this request.' } }
export function claudeAnswer(pending: ClaudePending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string): ClaudeFrame {
  if (permissionChoice) permissionValue(pending.request, permissionChoice, approved)
  if (!pending.questions) return approved === true ? { behavior: 'allow', updatedInput: pending.input } : claudeDenial()
  if (questionAnswers) {
    const values = questionValues(pending.request, questionAnswers)
    return { behavior: 'allow', updatedInput: { ...pending.input, answers: Object.fromEntries(pending.questions.map((question, index) => [question.question, values[String(index)]!.join(', ')])) } }
  }
  if (!answer.trim()) return claudeDenial()
  const answers: Record<string, string> = {}
  if (pending.questions.length === 1) answers[pending.questions[0]!.question] = answer
  else {
    let supplied: Record<string, unknown> | undefined
    try { supplied = object(JSON.parse(answer)) } catch { /* Numbered answers are also accepted. */ }
    const lines = answer.split('\n')
    for (const [i, question] of pending.questions.entries()) {
      const value = supplied?.[question.question] ?? supplied?.[String(i + 1)] ?? lines.find(line => line.startsWith(`${i + 1}. `))?.slice(String(i + 1).length + 2)
      if (typeof value !== 'string' || !value.trim()) throw new Error('Answer every question with numbered lines or a JSON object keyed by question text.')
      answers[question.question] = value
    }
  }
  return { behavior: 'allow', updatedInput: { ...pending.input, answers } }
}
