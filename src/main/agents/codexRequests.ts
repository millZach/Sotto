import { z } from 'zod'
import type { AgentRequest, AgentQuestionAnswers } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'
import { browserRequestText } from './browserRequests'
import { BROWSER_MCP_SERVER } from './browserAgentServer'

const option = z.object({ label: z.string(), description: z.string().optional() })
const question = z.object({ id: z.string(), question: z.string(), header: z.string().optional(), isOther: z.boolean().optional(), options: z.array(option).nullish() })
const paramsSchema = z.object({ threadId: z.string(), itemId: z.string().optional(), command: z.string().nullish(), reason: z.string().nullish(), cwd: z.string().nullish(), permissions: z.record(z.string(), z.unknown()).optional(), networkApprovalContext: z.unknown().optional(),
  grantRoot: z.string().nullish(), availableDecisions: z.array(z.unknown()).nullish(), questions: z.array(question).optional(),
  message: z.string().optional(), description: z.string().optional(), mode: z.string().optional(), requestedSchema: z.unknown().optional(),
  /** Named beside an elicitation, which is where an app tool confirmation arrives (issue #199). */
  serverName: z.string().optional(), request: z.unknown().optional() })
export type CodexPendingRequest = { id: string | number; method: string; sessionId: string; params: z.infer<typeof paramsSchema>; request: AgentRequest }
export const requestKey = (id: string | number): string => `rpc:${JSON.stringify(id)}`
const requestMethods: Record<string, { kind: 'permission' | 'question'; decline: () => unknown }> = {
  'item/commandExecution/requestApproval': { kind: 'permission', decline: () => ({ decision: 'decline' }) },
  'item/fileChange/requestApproval': { kind: 'permission', decline: () => ({ decision: 'decline' }) },
  // The schema has no explicit decline: an empty grant is the only refusal, scoped to this turn.
  'item/permissions/requestApproval': { kind: 'permission', decline: () => ({ permissions: {}, scope: 'turn' }) },
  'item/tool/requestUserInput': { kind: 'question', decline: () => ({ answers: {} }) },
  'mcpServer/elicitation/request': { kind: 'question', decline: () => ({ action: 'decline', content: null }) },
}
const formSchema = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).nullish() })
const fieldSchema = z.object({ type: z.string(), enum: z.array(z.string()).optional(), enumNames: z.array(z.string()).nullish(),
  oneOf: z.array(z.object({ const: z.string(), title: z.string() })).optional(), minLength: z.number().nullish(), maxLength: z.number().nullish(),
  minimum: z.number().nullish(), maximum: z.number().nullish() }).passthrough()
function supportedFormField(field: z.infer<typeof fieldSchema>): boolean {
  return field.type === 'string' && Object.keys(field).every(key => ['type', 'enum', 'enumNames', 'oneOf', 'title', 'description', 'default', 'minLength', 'maxLength', 'minimum', 'maximum'].includes(key))
}
const amendmentSchema = z.union([
  z.object({ acceptWithExecpolicyAmendment: z.object({ execpolicy_amendment: z.array(z.string()) }).strict() }).strict(),
  z.object({ applyNetworkPolicyAmendment: z.object({ network_policy_amendment: z.object({ action: z.enum(['allow', 'deny']), host: z.string() }).strict() }).strict() }).strict(),
])

const elicitedToolSchema = z.object({ name: z.string(), arguments: z.unknown().optional() })
/**
 * Codex confirms an app tool through an elicitation and names the server beside it, so one about
 * Sotto's own browser can be said plainly. The body's own shape is not established against a real
 * client (issue #199): the tool is named when it can be read and the server alone when it cannot,
 * and a server that is not Sotto's keeps the card Codex already gave.
 */
function codexBrowserText(params: z.infer<typeof paramsSchema>): string | undefined {
  if (params.serverName !== BROWSER_MCP_SERVER) return undefined
  const tool = elicitedToolSchema.safeParse(params.request)
  const named = tool.success ? browserRequestText(tool.data.name, tool.data.arguments, params.serverName) : undefined
  if (named) return named
  const said = params.message ?? params.description ?? ''
  return 'Codex is asking before it uses Sotto’s browser.' + (said ? '\n' + said : '')
    + '\nClicking and typing still ask you in Tools, and so do opening a page and going to another unless you let this thread open pages.'
}

export function pendingRequest(id: string | number, method: string, value: unknown, sessionId: string, fileSummary?: string): CodexPendingRequest | undefined {
  const mapping = requestMethods[method]
  if (!mapping) return
  const params = paramsSchema.parse(value)
  const permission = mapping.kind === 'permission'
  const questions = params.questions ?? []
  const browser = method === 'mcpServer/elicitation/request' ? codexBrowserText(params) : undefined
  const text = browser ?? (permission ? params.command ?? fileSummary ?? params.reason ?? (params.grantRoot ? `Allow file changes under ${params.grantRoot}?` : 'Codex requests additional permissions. Answer in Codex for detailed scope.')
    : questions.length ? questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${questions.length > 1 && q.options?.length ? ` (${q.options.map(o => o.label).join('; ')})` : ''}`).join('\n')
      : params.message ?? params.description ?? 'Codex needs your input.')
  let options: AgentRequest['options'] = permission ? [{ id: 'accept', label: 'Allow' }, { id: 'decline', label: 'Deny' }]
    : questions.length === 1 ? (questions[0]!.options ?? []).map(o => ({ id: o.label, label: o.label })) : []
  let formQuestions: AgentRequest['questions']
  if (method === 'mcpServer/elicitation/request') {
    const form = formSchema.safeParse(params.requestedSchema)
    if (form.success) formQuestions = Object.entries(form.data.properties).map(([id, value]) => {
      const field = fieldSchema.safeParse(value)
      const supported = field.success && supportedFormField(field.data)
      return { id, question: field.success && typeof field.data.description === 'string' ? field.data.description : id,
        ...(field.success && typeof field.data.title === 'string' ? { header: field.data.title } : {}),
        options: supported ? field.data.oneOf?.map(option => ({ id: option.const, label: option.title })) ?? field.data.enum?.map((id, index) => ({ id, label: field.data.enumNames?.[index] ?? id })) ?? [] : [],
        multiSelect: false, allowFreeText: supported && !field.data.enum && !field.data.oneOf,
        required: form.data.required?.includes(id) ?? false,
        ...(!supported ? { unavailableReason: 'This field needs the native Codex client; Sotto cannot submit this field type or its validation rules.' } : {}) }
    })
    if (form.success && Object.keys(form.data.properties).length === 1) {
      const field = fieldSchema.safeParse(Object.values(form.data.properties)[0])
      if (field.success) options = field.data.oneOf?.map(o => ({ id: o.const, label: o.title })) ?? field.data.enum?.map((id, i) => ({ id, label: field.data.enumNames?.[i] ?? id })) ?? []
    }
  }
  const decisions = params.availableDecisions ?? ['accept', 'decline']
  const permissionChoices: NonNullable<AgentRequest['permissionChoices']> = method === 'item/permissions/requestApproval' ? [
    ...(params.permissions ? [{ id: 'allow-turn', label: 'Allow requested permissions for this turn', kind: 'allow-once' as const }, { id: 'allow-session', label: 'Allow requested permissions for this session', kind: 'allow-session' as const }] : []),
    { id: 'decline', label: 'Deny', kind: 'deny' },
  ] : decisions.flatMap((value, index): NonNullable<AgentRequest['permissionChoices']> => {
    if (value === 'accept') return [{ id: value, label: 'Allow once', kind: 'allow-once' as const }]
    if (value === 'acceptForSession') return [{ id: value, label: 'Allow for this session', kind: 'allow-session' as const }]
    if (value === 'decline') return [{ id: value, label: 'Deny', kind: 'deny' as const }]
    if (value === 'cancel') return [{ id: value, label: 'Cancel turn', kind: 'cancel' as const }]
    const amendment = amendmentSchema.safeParse(value)
    if (amendment.success) {
      const denying = 'applyNetworkPolicyAmendment' in amendment.data && amendment.data.applyNetworkPolicyAmendment.network_policy_amendment.action === 'deny'
      return [{ id: `native-decision:${index}`, label: denying ? 'Deny and remember this network rule' : 'Allow and remember this rule', kind: denying ? 'deny' : 'allow-always', description: JSON.stringify(amendment.data) }]
    }
    return [] // Unknown native payloads cannot become guessed grants.
  })
  return { id, method, sessionId, params, request: { id: requestKey(id), kind: mapping.kind, text, options,
    ...(questions.length ? { questions: questions.map(q => ({ id: q.id, question: q.question, header: q.header, options: (q.options ?? []).map(option => ({ id: option.label, ...option })), multiSelect: false, allowFreeText: q.isOther ?? !q.options?.length })) } : formQuestions ? { questions: formQuestions } : {}),
    ...(permission ? { permissionChoices } : {}), context: { toolName: method, toolCallId: params.itemId, command: params.command ?? undefined, cwd: params.cwd ?? params.grantRoot ?? undefined,
      details: JSON.stringify({ ...(params.reason ? { reason: params.reason } : {}), ...(params.permissions ? { permissions: params.permissions } : {}), ...(params.networkApprovalContext ? { networkApprovalContext: params.networkApprovalContext } : {}), ...(fileSummary ? { files: fileSummary } : {}) }).slice(0, 100000) } } }
}

export function declineRequest(method: string): unknown {
  return requestMethods[method]!.decline()
}

/** This is called only for a user answer. No lifecycle or timeout path can grant permission. */
export function answerRequest(pending: CodexPendingRequest, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string): unknown {
  if (requestMethods[pending.method]!.kind === 'permission') {
    if (permissionChoice) {
      const choice = permissionValue(pending.request, permissionChoice, approved)
      if (pending.method === 'item/permissions/requestApproval') return choice === 'decline' ? declineRequest(pending.method) : { permissions: pending.params.permissions, scope: choice === 'allow-turn' ? 'turn' : 'session' }
      if (choice.startsWith('native-decision:')) return { decision: pending.params.availableDecisions![Number(choice.slice('native-decision:'.length))] }
      return { decision: choice }
    }
    if (typeof approved !== 'boolean') throw new Error('Explicitly approve or decline this permission request.')
    if (!approved) return declineRequest(pending.method)
    if (pending.method === 'item/permissions/requestApproval') throw new Error('This permission scope cannot be granted by Sotto. Answer it in Codex.')
    if (pending.params.availableDecisions && !pending.params.availableDecisions.includes('accept')) throw new Error('This permission needs a different decision. Answer it in Codex.')
    return { decision: 'accept' }
  }
  if (pending.method === 'mcpServer/elicitation/request') {
    if (approved === false) return declineRequest(pending.method)
    if (pending.params.mode !== 'form') throw new Error('Complete this interactive question directly in Codex; Sotto cannot answer this form.')
    const form = formSchema.parse(pending.params.requestedSchema)
    const keys = Object.keys(form.properties)
    let content: Record<string, unknown>
    if (questionAnswers) {
      const answered = questionValues(pending.request, questionAnswers)
      content = Object.fromEntries(Object.keys(answered).map(id => [id, questionAnswers[id]!.optionIds[0] ?? questionAnswers[id]!.text]))
    } else {
      try { content = z.record(z.string(), z.unknown()).parse(JSON.parse(answer)) }
      catch { if (keys.length !== 1) throw new Error('Answer this form with a JSON object keyed by its fields.'); content = { [keys[0]!]: answer } }
    }
    for (const key of form.required ?? []) if (!(key in content)) throw new Error(`Answer the required field: ${key}.`)
    for (const [key, value] of Object.entries(content)) {
      const field = fieldSchema.parse(form.properties[key])
      if (!supportedFormField(field)) {
        throw new Error('Answer this structured field directly in Codex.')
      }
      let schema = z.string()
      if (field.minLength != null) schema = schema.min(field.minLength)
      if (field.maxLength != null) schema = schema.max(field.maxLength)
      const text = schema.parse(value)
      if (field.enum && !field.enum.includes(text) || field.oneOf && !field.oneOf.some(o => o.const === text)) throw new Error('Choose an offered form option.')
    }
    return { action: 'accept', content }
  }
  const questions = pending.params.questions ?? []
  if (!questions.length) throw new Error('Codex did not provide question identifiers. Answer this request in Codex.')
  if (questionAnswers) return { answers: Object.fromEntries(Object.entries(questionValues(pending.request, questionAnswers)).map(([id, answers]) => [id, { answers }])) }
  let values: Record<string, string | string[]> = {}
  if (questions.length > 1) {
    try { values = z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(JSON.parse(answer)) }
    catch {
      const numbered = new Map<number, string>()
      for (const line of answer.split(/\r?\n/u)) {
        const match = /^(\d+)[.):]\s*(.+)$/u.exec(line.trim())
        if (match) numbered.set(Number(match[1]), match[2]!)
      }
      if (questions.some((_, i) => !numbered.has(i + 1))) throw new Error('Answer each question on a numbered line (1: answer, 2: answer), or answer in Codex.')
      values = Object.fromEntries(questions.map((q, i) => [q.id, numbered.get(i + 1)!]))
    }
  }
  return { answers: Object.fromEntries(questions.map(q => {
    const value = questions.length === 1 ? answer : values[q.id]
    if (value === undefined) throw new Error(`Answer question ${q.id}.`)
    return [q.id, { answers: Array.isArray(value) ? value : [value] }]
  })) }
}
