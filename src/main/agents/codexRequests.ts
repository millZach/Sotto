import { z } from 'zod'
import type { AgentRequest, AgentQuestionAnswers } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'
import { browserRequestText, TOOLS_STILL_DECIDES } from './browserRequests'
import { changeFilesAction, modelSummary, readableFields } from './requestInput'
import { BROWSER_MCP_SERVER } from './browserAgentServer'

const option = z.object({ label: z.string(), description: z.string().optional() })
const question = z.object({ id: z.string(), question: z.string(), header: z.string().optional(), isOther: z.boolean().optional(), options: z.array(option).nullish() })
const paramsSchema = z.object({ threadId: z.string(), itemId: z.string().optional(), command: z.string().nullish(), reason: z.string().nullish(), cwd: z.string().nullish(), permissions: z.record(z.string(), z.unknown()).optional(), networkApprovalContext: z.unknown().optional(),
  grantRoot: z.string().nullish(), availableDecisions: z.array(z.unknown()).nullish(), questions: z.array(question).optional(),
  message: z.string().optional(), description: z.string().optional(), mode: z.string().optional(), requestedSchema: z.unknown().optional(), url: z.string().optional(),
  /** Named beside an elicitation, which is where an app tool confirmation arrives (issue #199). */
  serverName: z.string().optional(),
  /** What Codex says about an elicitation beyond its words: `codex_approval_kind`, and the tool as `tool_name` and `tool_params`
   *  when the asker names one (Codex 0.166.0, `mcp_approval_meta.rs`). Anything else here is kept and never read. */
  _meta: z.record(z.string(), z.unknown()).nullish().catch(undefined) })
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
// codex app-server 0.157.0's generated schema lists OpenAI's own form under two spellings beside MCP's `form`, and
// a `url` mode; the three forms carry a requested schema, the link does not.
const formModes = new Set(['form', 'openai/form', 'openaiForm'])
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

const elicitedToolSchema = z.object({ tool_name: z.string(), tool_params: z.unknown().optional() })
const formAnswerSchema = z.record(z.string(), z.unknown())
const questionAnswersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
/**
 * Codex confirms an app tool through an elicitation and names the server beside it, so one about
 * Sotto's own browser can be said plainly. The tool is named when `_meta` carries it; Codex 0.166.0's
 * own tool-call approvals carry only its parameters, so the server alone says it then (issue #199),
 * and a server that is not Sotto's keeps the card Codex already gave.
 */
function codexBrowserText(params: z.infer<typeof paramsSchema>): string | undefined {
  if (params.serverName !== BROWSER_MCP_SERVER) return undefined
  const tool = elicitedToolSchema.safeParse(params._meta)
  const named = tool.success ? browserRequestText(tool.data.tool_name, tool.data.tool_params, params.serverName) : undefined
  if (named) return named
  const said = params.message ?? params.description ?? ''
  return 'Codex is asking before it uses Sotto’s browser.' + (said ? '\n' + said : '')
    + '\n' + TOOLS_STILL_DECIDES
}

/** The servers whose own names would not tell the user what Codex is about to use. */
const serverWords: ReadonlyMap<string, string> = new Map([['node_repl', 'Computer Use'], ['codex_apps', 'an app']])
/** A sign-in Codex takes through its own browser broker: its fields never reach the form, so Allow from here would be empty. */
const BROKER_SIGN_IN = 'Sotto can’t take a sign-in for Codex. Answer it in Codex, or skip it to decline.'
const CHOOSE_CONFIRMATION = 'Choose Allow once or Deny.'
/**
 * Codex's own approvals, and an MCP server's go-ahead such as Computer Use's app access, arrive as a form with nothing to
 * fill in (issue #2149). Codex's own client answers any such form with Allow or Deny; so does a **confirmation** here.
 * OpenAI's two spellings may send no schema at all; MCP's own `form` always sends one.
 */
function emptyForm(params: z.infer<typeof paramsSchema>): boolean {
  if (!formModes.has(params.mode ?? '')) return false
  if (params.requestedSchema == null) return params.mode !== 'form'
  const form = formSchema.safeParse(params.requestedSchema)
  return form.success && Object.keys(form.data.properties).length === 0
}
const brokerSignIn = (params: z.infer<typeof paramsSchema>): boolean => params._meta?.codex_approval_kind === 'browser_auth'
/** A confirmation's words: what Codex is about to use where the server says it, then Codex's own question. */
function confirmationText(params: z.infer<typeof paramsSchema>): string {
  const said = params.message ?? params.description
  const server = params.serverName ? serverWords.get(params.serverName) ?? params.serverName : undefined
  return [server ? `Codex is asking before it uses ${server}.` : undefined, said].filter(Boolean).join('\n') || 'Codex is asking before it goes on.'
}

/** What a remembered rule would cover, in words. */
function amendmentWords(amendment: z.infer<typeof amendmentSchema>): string {
  if ('acceptWithExecpolicyAmendment' in amendment) return `Commands that start with ${amendment.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' ')}`
  const { action, host } = amendment.applyNetworkPolicyAmendment.network_policy_amendment
  return `Network requests to ${host} are ${action === 'deny' ? 'refused' : 'allowed'}`
}

export function pendingRequest(id: string | number, method: string, value: unknown, sessionId: string, fileSummary?: string): CodexPendingRequest | undefined {
  const mapping = requestMethods[method]
  if (!mapping) return
  const parsed = paramsSchema.safeParse(value)
  if (!parsed.success) return
  const params = parsed.data
  const questions = params.questions ?? []
  const empty = method === 'mcpServer/elicitation/request' && !questions.length && emptyForm(params)
  const confirmation = empty && !brokerSignIn(params)
  const permission = mapping.kind === 'permission' || confirmation
  const browser = method === 'mcpServer/elicitation/request' ? codexBrowserText(params) : undefined
  const link = method === 'mcpServer/elicitation/request' && params.mode === 'url' ? params.url : undefined
  const text = browser ?? (confirmation ? confirmationText(params) : permission ? params.command ?? fileSummary ?? params.reason ?? (params.grantRoot ? `Allow file changes under ${params.grantRoot}?` : 'Codex requests additional permissions. Answer in Codex for detailed scope.')
    : questions.length ? questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${questions.length > 1 && q.options?.length ? ` (${q.options.map(o => o.label).join('; ')})` : ''}`).join('\n')
      : params.message ?? params.description ?? 'Codex needs your input.')
    + (link ? `\n${link}` : '')
  let options: AgentRequest['options'] = confirmation ? [] : permission ? [{ id: 'accept', label: 'Allow' }, { id: 'decline', label: 'Deny' }]
    : questions.length === 1 ? (questions[0]!.options ?? []).map(o => ({ id: o.label, label: o.label })) : []
  let formQuestions: AgentRequest['questions']
  // A link to open, not a form: Continue says the user has opened it, Decline refuses.
  if (link) options = [{ id: 'continue', label: 'Continue' }, { id: 'decline', label: 'Decline' }]
  if (empty && !confirmation) formQuestions = [{ id: 'sign-in', question: params.message ?? params.description ?? 'Sign in', options: [], multiSelect: false,
    allowFreeText: false, required: true, unavailableReason: BROKER_SIGN_IN }]
  else if (!empty && method === 'mcpServer/elicitation/request' && formModes.has(params.mode ?? '')) {
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
      return [{ id: `native-decision:${index}`, label: denying ? 'Deny and remember this network rule' : 'Allow and remember this rule', kind: denying ? 'deny' : 'allow-always', description: amendmentWords(amendment.data) }]
    }
    return [] // Unknown native payloads cannot become guessed grants.
  })
  // Codex's reason is the only words it sends for a request, so on a permission that names something else it is the summary.
  const summary = permission && (params.command || fileSummary || params.grantRoot) ? modelSummary(params.reason, params.command ?? undefined) : undefined
  const files = permission && !params.command && fileSummary ? fileSummary : undefined
  const fields = readableFields({ ...(params.reason && !summary && text !== params.reason ? { reason: params.reason } : {}), ...(params.permissions ? { permissions: params.permissions } : {}), ...(params.networkApprovalContext ? { network: params.networkApprovalContext } : {}) })
  return { id, method, sessionId, params, request: { id: requestKey(id), kind: permission ? 'permission' : 'question', text, options, ...(confirmation ? { confirmation: true as const } : {}),
    ...(questions.length ? { questions: questions.map(q => ({ id: q.id, question: q.question, header: q.header, options: (q.options ?? []).map(option => ({ id: option.label, ...option })), multiSelect: false, allowFreeText: q.isOther ?? !q.options?.length, prose: true as const })) } : formQuestions ? { questions: formQuestions } : {}),
    ...(permission ? { permissionChoices } : { skippable: true as const }), context: { toolName: method, toolCallId: params.itemId, command: params.command ?? undefined, cwd: params.cwd ?? params.grantRoot ?? undefined,
      ...(files ? { action: changeFilesAction(files.split('\n').length) } : {}), ...(summary ? { summary } : {}), ...(files || fields ? { details: [files, fields].filter(Boolean).join('\n') } : {}) } } }
}

export function declineRequest(method: string): unknown {
  return requestMethods[method]!.decline()
}

/** This is called only for a user answer. No lifecycle or timeout path can grant permission. */
export function answerRequest(pending: CodexPendingRequest, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string, skipped?: boolean): unknown {
  // A skipped question is declined: no answers to a question, `decline` to a form. Codex reads either and goes on.
  if (skipped && pending.request.kind === 'question') return declineRequest(pending.method)
  // A confirmation is answered by the user's explicit choice alone; no words, and no `{}`, ever allow it (issue #2149).
  if (pending.request.confirmation) {
    const allow = permissionChoice ? permissionValue(pending.request, permissionChoice, approved) === 'accept' : approved
    if (typeof allow !== 'boolean') throw new Error(CHOOSE_CONFIRMATION)
    return allow ? { action: 'accept', content: {} } : declineRequest(pending.method)
  }
  if (pending.request.kind === 'permission') {
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
    if (pending.params.mode === 'url' && pending.params.url) return answer === 'decline' ? declineRequest(pending.method) : { action: 'accept', content: null }
    if (brokerSignIn(pending.params)) throw new Error(BROKER_SIGN_IN)
    const parsed = formModes.has(pending.params.mode ?? '') ? formSchema.safeParse(pending.params.requestedSchema) : undefined
    if (!parsed?.success) throw new Error('Complete this interactive question directly in Codex; Sotto cannot answer this form.')
    const form = parsed.data
    const keys = Object.keys(form.properties)
    let content: Record<string, unknown>
    if (questionAnswers) {
      const answered = questionValues(pending.request, questionAnswers)
      content = Object.fromEntries(Object.keys(answered).map(id => [id, questionAnswers[id]!.optionIds[0] ?? questionAnswers[id]!.text]))
    } else {
      try { content = formAnswerSchema.parse(JSON.parse(answer)) }
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
    try { values = questionAnswersSchema.parse(JSON.parse(answer)) }
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
