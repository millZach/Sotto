import { z } from 'zod'
import type { AgentRequest } from '../../shared/agents'

const option = z.object({ label: z.string(), description: z.string().optional() })
const question = z.object({ id: z.string(), question: z.string(), options: z.array(option).nullish() })
const paramsSchema = z.object({ threadId: z.string(), itemId: z.string().optional(), command: z.string().nullish(), reason: z.string().nullish(),
  grantRoot: z.string().nullish(), availableDecisions: z.array(z.unknown()).nullish(), questions: z.array(question).optional(),
  message: z.string().optional(), description: z.string().optional(), mode: z.string().optional(), requestedSchema: z.unknown().optional() })
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

export function pendingRequest(id: string | number, method: string, value: unknown, sessionId: string, fileSummary?: string): CodexPendingRequest | undefined {
  const mapping = requestMethods[method]
  if (!mapping) return
  const params = paramsSchema.parse(value)
  const permission = mapping.kind === 'permission'
  const questions = params.questions ?? []
  const text = permission ? params.command ?? fileSummary ?? params.reason ?? (params.grantRoot ? `Allow file changes under ${params.grantRoot}?` : 'Codex requests additional permissions. Answer in Codex for detailed scope.')
    : questions.length ? questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question}${questions.length > 1 && q.options?.length ? ` (${q.options.map(o => o.label).join('; ')})` : ''}`).join('\n')
      : params.message ?? params.description ?? 'Codex needs your input.'
  let options: AgentRequest['options'] = permission ? [{ id: 'accept', label: 'Allow' }, { id: 'decline', label: 'Deny' }]
    : questions.length === 1 ? (questions[0]!.options ?? []).map(o => ({ id: o.label, label: o.label })) : []
  if (method === 'mcpServer/elicitation/request') {
    const form = formSchema.safeParse(params.requestedSchema)
    if (form.success && Object.keys(form.data.properties).length === 1) {
      const field = fieldSchema.safeParse(Object.values(form.data.properties)[0])
      if (field.success) options = field.data.oneOf?.map(o => ({ id: o.const, label: o.title })) ?? field.data.enum?.map((id, i) => ({ id, label: field.data.enumNames?.[i] ?? id })) ?? []
    }
  }
  return { id, method, sessionId, params, request: { id: requestKey(id), kind: mapping.kind, text, options } }
}

export function declineRequest(method: string): unknown {
  return requestMethods[method]!.decline()
}

/** This is called only for a user answer. No lifecycle or timeout path can grant permission. */
export function answerRequest(pending: CodexPendingRequest, answer: string, approved?: boolean): unknown {
  if (requestMethods[pending.method]!.kind === 'permission') {
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
    try { content = z.record(z.string(), z.unknown()).parse(JSON.parse(answer)) }
    catch { if (keys.length !== 1) throw new Error('Answer this form with a JSON object keyed by its fields.'); content = { [keys[0]!]: answer } }
    for (const key of form.required ?? []) if (!(key in content)) throw new Error(`Answer the required field: ${key}.`)
    for (const [key, value] of Object.entries(content)) {
      const field = fieldSchema.parse(form.properties[key])
      if (field.type !== 'string' || Object.keys(field).some(k => !['type', 'enum', 'enumNames', 'oneOf', 'title', 'description', 'default', 'minLength', 'maxLength', 'minimum', 'maximum'].includes(k))) {
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
