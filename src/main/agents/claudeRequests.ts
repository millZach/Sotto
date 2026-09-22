import { z } from 'zod'
import type { AgentRequest, AgentQuestionAnswers } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'
import { object, type ClaudeFrame } from './claudeProtocol'
import { BROWSER_MCP_SERVER } from './browserAgentServer'

const questionSchema = z.object({ question: z.string().min(1), header: z.string().optional(), multiSelect: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional() })
const questionsSchema = z.object({ questions: z.array(questionSchema).min(1).max(20) })
export interface ClaudePending { id: string; tool: string; input: ClaudeFrame; request: AgentRequest; questions?: z.infer<typeof questionSchema>[]; resumeDialog?: boolean }
/**
 * Sotto's own browser tools, said in the words the user would use. A native tool carries no
 * description in the frame it asks with, so without this the card is the tool's name and its
 * arguments and nothing else. Sotto owns these six names and can say honestly what each would do;
 * a tool from anyone else's server keeps the name it came with, because Sotto cannot describe it.
 */
function browserAction(action: ClaudeFrame): string {
  const url = typeof action.url === 'string' ? action.url : ''
  if (action.type === 'inspect') return 'look at the page'
  if (action.type === 'screenshot') return 'take a picture of the page'
  if (action.type === 'navigate') return url ? 'go to ' + url : 'go to another page'
  if (action.type === 'click') return 'click in the page'
  if (action.type === 'type') return 'type into the page'
  if (action.type === 'scroll') return 'scroll the page'
  if (action.type === 'viewport') return 'change the page size'
  return 'work in the page'
}
export function browserRequestText(tool: string, input: ClaudeFrame): string | undefined {
  const prefix = 'mcp__' + BROWSER_MCP_SERVER + '__'
  const name = tool.startsWith(prefix) ? tool.slice(prefix.length) : ''
  const url = typeof input.url === 'string' ? input.url : ''
  const said = name === 'browser_pages' ? 'list the pages this thread has open'
    : name === 'browser_status' ? 'check how its browser task is going'
      : name === 'browser_start' ? 'start a browser task on a page you shared'
        : name === 'browser_open' ? url ? 'open ' + url : 'open a page'
          : name === 'browser_action' ? browserAction(object(input.action) ?? {})
            : name === 'browser_finish' ? 'finish its browser task as ' + (input.status === 'failed' ? 'failed' : 'done')
              : ''
  if (!said) return undefined
  const why = typeof input.description === 'string' && input.description.trim() ? '\n“' + input.description.trim() + '”' : ''
  // Answering here only lets it reach the browser. Every page action asks again in Tools (ADR-0020).
  return 'Use Sotto’s browser to ' + said + '.' + why + '\nOpening a page, going to another, clicking and typing still ask you in Tools.'
}

export function claudePending(frame: ClaudeFrame): ClaudePending | undefined {
  const data = object(frame.request)
  if (typeof frame.request_id === 'string' && data?.subtype === 'request_user_dialog' && data.dialog_kind === 'resume_return') {
    const payload = object(data.payload)
    const age = typeof payload?.sessionAgeMinutes === 'number' && Number.isFinite(payload.sessionAgeMinutes) ? Math.max(0, Math.floor(payload.sessionAgeMinutes)) : 0
    const tokens = typeof payload?.estimatedTokens === 'number' && Number.isFinite(payload.estimatedTokens) ? Math.max(0, Math.floor(payload.estimatedTokens)) : 0
    const question = `This session is ${age >= 60 ? `${Math.floor(age / 60)}h ${age % 60}m` : `${age}m`} old and uses ${tokens.toLocaleString('en-US')} tokens. Compact it before continuing?`
    const options = ['Compact and continue', 'Keep full history', "Don't ask again"].map(label => ({ id: label, label }))
    return { id: frame.request_id, tool: 'resume_return', input: data, resumeDialog: true,
      request: { id: frame.request_id, kind: 'question', text: question, options,
        questions: [{ id: '0', question, header: 'Resume session', options, multiSelect: false, allowFreeText: false, required: true }] } }
  }
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
    request: { id: frame.request_id, kind: 'permission', text: browserRequestText(data.tool_name, input) ?? `${data.tool_name}${description ? `: ${description}` : ''}\n${JSON.stringify(input)}`, options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      permissionChoices: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }, { id: 'deny', label: 'Deny', kind: 'deny' }],
      context: { toolName: data.tool_name, ...(typeof data.tool_use_id === 'string' ? { toolCallId: data.tool_use_id } : {}), ...(typeof input.command === 'string' ? { command: input.command } : {}), details: JSON.stringify(input).slice(0, 100000) } } }
}
export function claudeDenial(): ClaudeFrame { return { behavior: 'deny', message: 'The user did not approve this request.' } }
export function claudeAnswer(pending: ClaudePending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string): ClaudeFrame {
  if (pending.resumeDialog) {
    const selected = questionAnswers ? questionValues(pending.request, questionAnswers)['0']?.[0] : answer
    if (!pending.request.options.some(option => option.id === selected)) throw new Error('Choose how to resume this Claude session.')
    return { behavior: 'completed', result: selected === 'Compact and continue' ? 'compact' : selected === "Don't ask again" ? 'never' : 'continue' }
  }
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
