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
// The fields Codex 0.166.0 forwards in a `form`, MCP's primitives, each closed to other keys (`McpElicitationPrimitiveSchema`):
// a form with any other field is cancelled before it reaches Sotto. OpenAI's two spellings pass anything, so a field outside
// these, such as an image picker, a `pattern` or an object, is one Sotto can't show (issue #2154).
const words = { title: z.string().nullish(), description: z.string().nullish() }
const titledOption = z.object({ const: z.string(), title: z.string() }).strict()
const bound = z.number().nullish()
const fieldSchema = z.union([
  z.object({ ...words, type: z.literal('string'), enum: z.array(z.string()), enumNames: z.array(z.string()).nullish(), default: z.string().nullish() }).strict(),
  z.object({ ...words, type: z.literal('string'), oneOf: z.array(titledOption), default: z.string().nullish() }).strict(),
  z.object({ ...words, type: z.literal('string'), minLength: bound, maxLength: bound, format: z.enum(['email', 'uri', 'date', 'date-time']).nullish(), default: z.string().nullish() }).strict(),
  z.object({ ...words, type: z.enum(['number', 'integer']), minimum: bound, maximum: bound, default: z.number().nullish() }).strict(),
  z.object({ ...words, type: z.literal('boolean'), default: z.boolean().nullish() }).strict(),
  z.object({ ...words, type: z.literal('array'), minItems: bound, maxItems: bound, default: z.array(z.string()).nullish(), items: z.union([
    z.object({ type: z.literal('string'), enum: z.array(z.string()) }).strict(),
    z.object({ type: z.literal('string').optional(), anyOf: z.array(titledOption) }).strict(),
    z.object({ type: z.literal('string').optional(), oneOf: z.array(titledOption) }).strict(),
  ]) }).strict(),
])
/** A field's own words, read from any field, so one Sotto can't show still says what it asks. */
const fieldWordsSchema = z.object(words)
type FieldOption = { id: string; label: string }
/** One form field as Sotto answers it: words, choices, a number, Yes or No, or several choices. */
type FormField =
  | { kind: 'text'; minLength?: number | undefined; maxLength?: number | undefined; default?: string | undefined }
  | { kind: 'choice'; options: FieldOption[]; default?: string | undefined }
  | { kind: 'number'; integer: boolean; minimum?: number | undefined; maximum?: number | undefined; default?: number | undefined }
  | { kind: 'boolean'; default?: boolean | undefined }
  | { kind: 'several'; options: FieldOption[]; minItems?: number | undefined; maxItems?: number | undefined; default?: string[] | undefined }
const YES_NO: readonly FieldOption[] = [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }]
const UNSUPPORTED_FIELD = 'Sotto can’t show this kind of field. Decline it, or answer it in Codex if your Codex app can.'
const given = <T>(value: T | null | undefined): T | undefined => value ?? undefined
const titled = (options: readonly z.infer<typeof titledOption>[]): FieldOption[] => options.map(option => ({ id: option.const, label: option.title }))

function formField(value: unknown): FormField | undefined {
  const parsed = fieldSchema.safeParse(value)
  if (!parsed.success) return
  const field = parsed.data
  switch (field.type) {
    case 'boolean': return { kind: 'boolean', default: given(field.default) }
    case 'number': case 'integer': return { kind: 'number', integer: field.type === 'integer', minimum: given(field.minimum), maximum: given(field.maximum), default: given(field.default) }
    case 'array': {
      const items = field.items
      const options = 'enum' in items ? items.enum.map(id => ({ id, label: id })) : titled('anyOf' in items ? items.anyOf : items.oneOf)
      return { kind: 'several', options, minItems: given(field.minItems), maxItems: given(field.maxItems), default: given(field.default) }
    }
    case 'string':
      if ('enum' in field) return { kind: 'choice', options: field.enum.map((id, index) => ({ id, label: field.enumNames?.[index] ?? id })), default: given(field.default) }
      if ('oneOf' in field) return { kind: 'choice', options: titled(field.oneOf), default: given(field.default) }
      return { kind: 'text', minLength: given(field.minLength), maxLength: given(field.maxLength), default: given(field.default) }
  }
}

/** "a whole number from 1 to 5", and so on: what a number field takes, as the card and its refusal say it. */
function numberWords(field: Extract<FormField, { kind: 'number' }>): string {
  const what = field.integer ? 'a whole number' : 'a number'
  if (field.minimum !== undefined && field.maximum !== undefined) return `${what} from ${field.minimum} to ${field.maximum}`
  if (field.minimum !== undefined) return `${what} of at least ${field.minimum}`
  return field.maximum !== undefined ? `${what} of no more than ${field.maximum}` : what
}

/** What a field's question says beyond its own words: a number's range, and a default, which is said and never chosen for the user. */
function fieldHints(field: FormField): string {
  const label = (id: string): string => ('options' in field ? field.options.find(option => option.id === id)?.label : undefined) ?? id
  const fallback = field.kind === 'boolean' ? field.default === undefined ? undefined : field.default ? 'Yes' : 'No'
    : field.kind === 'several' ? field.default?.length ? field.default.map(label).join(', ') : undefined
      : field.kind === 'choice' ? field.default === undefined ? undefined : label(field.default)
        : field.default === undefined ? undefined : String(field.default)
  const range = field.kind === 'number' && (field.minimum !== undefined || field.maximum !== undefined) ? `${numberWords(field).replace(/^a/u, 'A')}.` : undefined
  return [range, fallback === undefined ? undefined : `Default: ${fallback}.`].filter(Boolean).join(' ')
}

function formQuestion(id: string, value: unknown, required: boolean): NonNullable<AgentRequest['questions']>[number] {
  const field = formField(value)
  const said = fieldWordsSchema.safeParse(value)
  const own = said.success ? said.data : {}
  const hints = field ? fieldHints(field) : ''
  return { id, question: (own.description ?? id) + (hints ? `\n${hints}` : ''), ...(own.title ? { header: own.title } : {}),
    options: field?.kind === 'boolean' ? [...YES_NO] : field?.kind === 'choice' || field?.kind === 'several' ? field.options : [],
    multiSelect: field?.kind === 'several', allowFreeText: field?.kind === 'text' || field?.kind === 'number', required,
    ...(!field ? { unavailableReason: UNSUPPORTED_FIELD } : {}) }
}

/** A field's answer in its own type, from a JSON answer or what the card sent, or a refusal in plain words. */
function formValue(field: FormField, value: unknown): unknown {
  if (field.kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 'false') return value === 'true'
    throw new Error('Choose Yes or No.')
  }
  if (field.kind === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : Number.NaN
    if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number)) || (field.minimum !== undefined && number < field.minimum)
      || (field.maximum !== undefined && number > field.maximum)) throw new Error(`Answer with ${numberWords(field)}.`)
    return number
  }
  if (field.kind === 'several') {
    const values: unknown = typeof value === 'string' ? [value] : value
    if (!Array.isArray(values) || values.some(item => typeof item !== 'string' || !field.options.some(option => option.id === item)) || new Set(values).size !== values.length) throw new Error('Choose an offered form option.')
    if (field.minItems !== undefined && values.length < field.minItems) throw new Error(`Choose at least ${field.minItems} ${field.minItems === 1 ? 'option' : 'options'}.`)
    if (field.maxItems !== undefined && values.length > field.maxItems) throw new Error(`Choose no more than ${field.maxItems} ${field.maxItems === 1 ? 'option' : 'options'}.`)
    return values
  }
  if (field.kind === 'choice') {
    if (typeof value !== 'string' || !field.options.some(option => option.id === value)) throw new Error('Choose an offered form option.')
    return value
  }
  if (typeof value !== 'string') throw new Error('Answer with words.')
  if (field.minLength !== undefined && value.length < field.minLength) throw new Error(`Answer with at least ${field.minLength} characters.`)
  if (field.maxLength !== undefined && value.length > field.maxLength) throw new Error(`Answer with no more than ${field.maxLength} characters.`)
  return value
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
    if (form.success) formQuestions = Object.entries(form.data.properties).map(([id, value]) => formQuestion(id, value, form.data.required?.includes(id) ?? false))
    // A one-field form's choices are the request's too, for a client that answers with one choice.
    if (form.success && Object.keys(form.data.properties).length === 1) {
      const field = formField(Object.values(form.data.properties)[0])
      options = field?.kind === 'boolean' ? [...YES_NO] : field?.kind === 'choice' ? field.options : []
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
    ...(questions.length ? { questions: questions.map(q => ({ id: q.id, question: q.question, header: q.header, options: (q.options ?? []).map(option => ({ id: option.label, ...option })), multiSelect: false, allowFreeText: (q.isOther ?? false) || !q.options?.length, prose: true as const })) } : formQuestions ? { questions: formQuestions } : {}),
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
      // The card sends a choice by its ID, several choices as their IDs, and anything typed as text; `formValue` types each.
      content = Object.fromEntries(Object.keys(answered).map(id => [id, questionAnswers[id]!.optionIds.length > 1 || formField(form.properties[id])?.kind === 'several'
        ? questionAnswers[id]!.optionIds : questionAnswers[id]!.optionIds[0] ?? questionAnswers[id]!.text]))
    } else {
      try { content = formAnswerSchema.parse(JSON.parse(answer)) }
      catch { if (keys.length !== 1) throw new Error('Answer this form with a JSON object keyed by its fields.'); content = { [keys[0]!]: answer } }
    }
    for (const key of form.required ?? []) if (!(key in content)) throw new Error(`Answer the required field: ${key}.`)
    const typed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(content)) {
      if (!Object.hasOwn(form.properties, key)) throw new Error('Answer only this form’s own fields.')
      const field = formField(form.properties[key])
      if (!field) throw new Error(UNSUPPORTED_FIELD)
      typed[key] = formValue(field, value)
    }
    return { action: 'accept', content: typed }
  }
  const questions = pending.params.questions ?? []
  if (!questions.length) throw new Error('Codex did not provide question identifiers. Answer this request in Codex.')
  // Codex's own clients send typed words as `user_note: <text>` after any chosen label, so the model and Codex never
  // read them as the option they spell (Codex 0.166.0, tui/src/bottom_pane/request_user_input/mod.rs; issue #2157).
  // A Codex option's id is its label, and questionValues has checked every id against the native request.
  if (questionAnswers) return { answers: Object.fromEntries(Object.keys(questionValues(pending.request, questionAnswers)).map(id => {
    const { optionIds, text } = questionAnswers[id]!
    return [id, { answers: [...optionIds, ...(text?.trim() ? [`user_note: ${text.trim()}`] : [])] }]
  })) }
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
