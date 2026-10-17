import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'

/**
 * OpenCode's two things only the user can settle (ADR-0004, ADR-0087): a permission its rules set to ask about
 * (`permission.asked`, answered once or rejected) and a form from its question tool (`form.created`, answered or
 * cancelled). Nothing here answers either on its own. OpenCode also offers `always`, which saves a grant for the whole
 * project that later sessions obey unasked; Sotto never sends it.
 */
export const opencodePermissionSchema = z.looseObject({
  id: z.string().min(1), sessionID: z.string().min(1), action: z.string().min(1), resources: z.array(z.string()).default([]),
  metadata: z.looseObject({
    files: z.array(z.looseObject({ file: z.string(), patch: z.string().optional(), status: z.string().optional() })).optional(),
  }).optional(),
  source: z.looseObject({ type: z.string(), messageID: z.string().optional(), id: z.string().optional() }).optional(),
  message: z.string().optional(),
})
export type OpenCodePermission = z.infer<typeof opencodePermissionSchema>

const optionSchema = z.looseObject({ value: z.string(), label: z.string().optional(), description: z.string().optional() })
const fieldSchema = z.looseObject({
  key: z.string().min(1), type: z.string().min(1), title: z.string().optional(), description: z.string().optional(),
  required: z.boolean().optional(), hidden: z.boolean().optional(), when: z.array(z.unknown()).optional(),
  options: z.array(optionSchema).optional(), custom: z.boolean().optional(),
  minItems: z.number().int().optional(), maxItems: z.number().int().optional(),
  minimum: z.unknown().optional(), maximum: z.unknown().optional(),
})
export const opencodeFormSchema = z.looseObject({
  id: z.string().min(1), sessionID: z.string().min(1), title: z.string().default(''), fields: z.array(fieldSchema).min(1),
})
export type OpenCodeForm = z.infer<typeof opencodeFormSchema>
type Field = OpenCodeForm['fields'][number]

export type OpenCodePending =
  | { readonly kind: 'permission'; readonly threadId: string; readonly request: AgentRequest; readonly permission: OpenCodePermission; answering?: boolean }
  | { readonly kind: 'form'; readonly threadId: string; readonly request: AgentRequest; readonly form: OpenCodeForm; answering?: boolean }

const bounded = (text: string, limit = 4_000): string => text.length > limit ? text.slice(0, limit) : text

/** What a rejection tells the model, so it carries on without the action rather than ending the turn. */
export const OPENCODE_DECLINED = 'The user declined this request.'
/** What a form Sotto cannot draw is cancelled with, so the model asks some other way. */
export const OPENCODE_FORM_UNSHOWN = 'Sotto could not show this question to the user, so it was not answered. Ask it in plain words in your reply instead.'

const ACTIONS: Readonly<Record<string, string>> = {
  edit: 'Edit', shell: 'Run a command', bash: 'Run a command', read: 'Read', webfetch: 'Fetch a web page', websearch: 'Search the web',
  external_directory: 'Work outside the project folder', glob: 'Search files', grep: 'Search file contents',
}
/** What the action is, in one sentence the request card shows. */
function permissionText(permission: OpenCodePermission): string {
  const label = ACTIONS[permission.action] ?? `Use ${bounded(permission.action, 200)}`
  const resources = permission.resources.filter(resource => resource !== '*')
  return resources.length ? `${label}: ${bounded(resources.join(', '), 500)}` : label
}

/** One permission as Sotto shows it: allow once or reject, with the files and diff it would change. */
export function opencodePermissionPending(threadId: string, permission: OpenCodePermission): Extract<OpenCodePending, { kind: 'permission' }> {
  const diff = (permission.metadata?.files ?? []).map(file => file.patch ?? file.file).join('\n')
  const request: AgentRequest = {
    id: `opencode-permission-${permission.id}`, kind: 'permission', text: permissionText(permission), options: [],
    permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'reject', label: 'Reject', kind: 'deny' }],
    context: {
      toolName: bounded(permission.action, 200),
      ...(permission.source?.id ? { toolCallId: permission.source.id } : {}),
      ...(permission.action === 'shell' || permission.action === 'bash') && permission.resources[0] ? { command: bounded(permission.resources[0]) } : {},
      ...(diff ? { details: bounded(diff, 60_000) } : {}),
    },
  }
  return { kind: 'permission', threadId, request, permission }
}

/**
 * The decision a Sotto answer names: `once` or `reject`, never `always`. A card's explicit choice wins, checked against
 * an explicit allow or deny when one came with it.
 */
export function opencodePermissionDecision(pending: Extract<OpenCodePending, { kind: 'permission' }>, approved: boolean | undefined, permissionChoice?: string): 'once' | 'reject' {
  if (permissionChoice) {
    const chosen = (pending.request.permissionChoices ?? []).find(choice => choice.id === permissionChoice)
    return permissionValue(pending.request, permissionChoice, approved ?? chosen?.kind.startsWith('allow-')) === 'once' ? 'once' : 'reject'
  }
  if (typeof approved !== 'boolean') throw new Error('Explicitly allow or deny this permission request.')
  return approved ? 'once' : 'reject'
}

const optionId = (index: number): string => `option-${index}`
const YES_NO = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] as const
/** Whether Sotto can draw this field: no field that shows only for another's answer, nothing hidden, no link to open. */
function drawable(field: Field): boolean {
  if (field.hidden === true || (field.when?.length ?? 0) > 0) return false
  return ['string', 'number', 'integer', 'boolean', 'multiselect'].includes(field.type)
}
function fieldOptions(field: Field): readonly { value: string; label: string; description?: string }[] {
  if (field.type === 'boolean') return YES_NO
  return (field.options ?? []).map(option => ({ value: option.value, label: option.label?.trim() || option.value,
    ...(option.description ? { description: option.description } : {}) }))
}

/** One form as a question card, or undefined when Sotto cannot draw it and cancels it instead. */
export function opencodeFormPending(threadId: string, form: OpenCodeForm): Extract<OpenCodePending, { kind: 'form' }> | undefined {
  if (!form.fields.every(drawable)) return undefined
  const questions = form.fields.map((field, index) => {
    const options = fieldOptions(field)
    const header = field.title?.trim() || (form.fields.length > 1 ? `Question ${index + 1}` : '')
    return {
      id: field.key, question: bounded(field.description?.trim() || field.title?.trim() || form.title || 'OpenCode has a question.', 2_000),
      ...(header ? { header: bounded(header, 200) } : {}),
      options: options.map((option, at) => ({ id: optionId(at), label: bounded(option.label, 500), ...(option.description ? { description: bounded(option.description, 1_000) } : {}) })),
      multiSelect: field.type === 'multiselect',
      allowFreeText: field.type !== 'boolean' && (field.custom === true || options.length === 0),
      required: field.required !== false,
    }
  })
  const request: AgentRequest = { id: `opencode-form-${form.id}`, kind: 'question', text: questions[0]!.question, options: [], questions }
  return { kind: 'form', threadId, request, form }
}

/** The answer OpenCode's form takes, one value per field in the field's own type, from what the user chose and typed. */
export function opencodeFormAnswer(pending: Extract<OpenCodePending, { kind: 'form' }>, answer: string, questionAnswers?: AgentQuestionAnswers): Record<string, string | number | boolean | string[]> {
  const fields = pending.form.fields
  let supplied = questionAnswers
  if (!supplied) {
    if (fields.length !== 1) throw new Error('Answer every question.')
    const question = pending.request.questions![0]!
    const selected = question.options.findIndex(option => option.label === answer)
    supplied = { [question.id]: selected >= 0 ? { optionIds: [optionId(selected)] } : { optionIds: [], text: answer } }
  }
  questionValues(pending.request, supplied)
  const result: Record<string, string | number | boolean | string[]> = {}
  for (const field of fields) {
    const given = supplied[field.key]
    const options = fieldOptions(field)
    const chosen = (given?.optionIds ?? []).map(id => options[Number(id.slice('option-'.length))]!.value)
    const typed = given?.text?.trim()
    if (!chosen.length && !typed) continue
    if (field.type === 'multiselect') {
      const values = [...chosen, ...(typed ? [typed] : [])]
      if (field.minItems !== undefined && values.length < field.minItems) throw new Error(`Choose at least ${field.minItems} options for this question.`)
      if (field.maxItems !== undefined && values.length > field.maxItems) throw new Error(`Choose no more than ${field.maxItems} options for this question.`)
      result[field.key] = values
    } else if (field.type === 'boolean') result[field.key] = chosen[0] === 'true'
    else if (field.type === 'number' || field.type === 'integer') {
      const value = Number(typed ?? chosen[0])
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) throw new Error(field.type === 'integer' ? 'Answer this question with a whole number.' : 'Answer this question with a number.')
      result[field.key] = value
    } else result[field.key] = chosen[0] ?? typed!
  }
  return result
}
