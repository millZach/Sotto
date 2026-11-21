import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import type { AntigravityRuntimeMode } from './antigravityModels'
import { permissionValue, questionValues } from './nativeRequests'

/**
 * What Antigravity asks, as Sotto shows it and answers it (the research note, "Permissions"). A permission arrives as
 * `session/request_permission`, allowed once or rejected; Sotto never answers `allow_always`, which would save a rule in
 * Sotto's Antigravity folder for every later thread. A request whose tool call ID starts `interaction_` is a fixed-choice
 * question as T3 Code reads one, answered with the chosen option's ID, never an approval.
 *
 * `agy`'s own `ask_question` tool asks through ACP's `elicitation/create`, which 1.5.14 sends only to a client that
 * offers `elicitation.form`, and otherwise writes the question into its reply as text (parity slice 4, probed November
 * 21, 2026). Its form holds one field per question, `q1`, `q2` and on: a string with `oneOf` choices for one answer, an
 * array whose `items.anyOf` are the choices for several, and beside each an optional `q1_other` for the user's own words.
 * Each becomes one question on the card, its own words as the question's free text. A form of any other shape is refused,
 * and `agy` asks in text instead.
 *
 * A thread on Allow edits or Full access has its requests answered by Sotto by that mode, as T3 Code answers them
 * (`antigravityAutoAnswer`; Zach's choice, November 20, 2026, recorded in the ADR as an amendment to ADR-0004): edits on
 * Allow edits, everything on Full access. A question is always the user's.
 */

export const ANTIGRAVITY_PERMISSION = 'session/request_permission'
export const ANTIGRAVITY_QUESTION = 'elicitation/create'
const TEXT_LIMIT = 20_000
const QUESTION_PREFIX = 'interaction_'

const optionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
const permissionSchema = z.object({
  sessionId: z.string().min(1),
  toolCall: z.object({ toolCallId: z.string().min(1).max(512), title: z.string().max(TEXT_LIMIT).nullish(), kind: z.string().max(64).nullish(),
    content: z.array(z.unknown()).max(64).nullish(), locations: z.array(z.unknown()).max(256).nullish(), rawInput: z.unknown().optional() }).passthrough(),
  options: z.array(z.object({ optionId: z.string().max(512), name: z.string().max(TEXT_LIMIT), kind: optionKind }).passthrough()).min(1).max(64),
})
export type AntigravityPermission = z.infer<typeof permissionSchema>

const choiceSchema = z.object({ const: z.string().min(1).max(512), title: z.string().max(TEXT_LIMIT) })
const choices = z.array(choiceSchema).min(1).max(64)
const oneSchema = z.object({ type: z.literal('string'), title: z.string().max(TEXT_LIMIT).optional(), oneOf: choices })
const severalSchema = z.object({ type: z.literal('array'), title: z.string().max(TEXT_LIMIT).optional(), items: z.object({ anyOf: choices }) })
const wordsSchema = z.object({ type: z.literal('string'), title: z.string().max(TEXT_LIMIT).optional(), description: z.string().max(TEXT_LIMIT).optional() })
const formSchema = z.object({
  sessionId: z.string().min(1), toolCallId: z.string().min(1).max(512).optional(), mode: z.literal('form'), message: z.string().max(TEXT_LIMIT).optional(),
  requestedSchema: z.object({ type: z.literal('object'), properties: z.record(z.string().min(1).max(64), z.unknown()), required: z.array(z.string()).optional() }),
})
/** One of `agy`'s questions: its field, whether it takes several choices, and its field for the user's own words. */
interface AntigravityFormQuestion { readonly key: string; readonly several: boolean; readonly other?: string }

export interface AntigravityPending {
  readonly wireId: string | number
  readonly threadId: string
  readonly kind: 'permission' | 'question'
  readonly toolCallId: string
  readonly request: AgentRequest
  /** A permission, or a question as T3 reads one; absent for `agy`'s own form. */
  readonly permission?: AntigravityPermission
  /** `agy`'s own form (`elicitation/create`): its questions, answered with `accept` and their fields, or declined. */
  readonly form?: readonly AntigravityFormQuestion[]
  answering?: boolean
}

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const unquoted = (title: string): string => title.replace(/^`([\s\S]*)`$/u, '$1')
const bounded = (text: string, limit = TEXT_LIMIT): string => text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/** The command a request would run: `agy`'s own fields (`CommandLine` and the rest, as T3 reads them), else the title. */
export function antigravityCommand(rawInput: unknown): string | undefined {
  const input = object(rawInput)
  for (const key of ['CommandLine', 'command_line', 'commandLine', 'command']) if (typeof input?.[key] === 'string' && (input[key] as string).trim()) return (input[key] as string).trim()
  return undefined
}
/** The files a request would change: its diff blocks, in the shape a file change's row takes, and the paths it names. */
function fileChanges(toolCall: AntigravityPermission['toolCall']): { paths: string[]; diffs: string[] } {
  const diffs: string[] = [], paths = new Set<string>()
  for (const item of toolCall.content ?? []) {
    const block = object(item)
    if (block?.type !== 'diff' || typeof block.path !== 'string') continue
    paths.add(block.path.slice(0, 4_096))
    diffs.push(`${block.path}\n--- before\n${typeof block.oldText === 'string' ? block.oldText : ''}\n+++ after\n${typeof block.newText === 'string' ? block.newText : ''}`)
  }
  for (const location of toolCall.locations ?? []) { const path = object(location)?.path; if (typeof path === 'string') paths.add(path.slice(0, 4_096)) }
  return { paths: [...paths].slice(0, 50), diffs }
}
const contentText = (content: readonly unknown[] | null | undefined): string[] => (content ?? []).flatMap(item => {
  const part = object(object(item)?.content)
  return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
})

/** `agy`'s form as one card, or undefined for a form of another shape, which Sotto refuses so that `agy` asks in text. */
function antigravityForm(wireId: string | number, params: unknown, threadId: string): AntigravityPending | undefined {
  const parsed = formSchema.safeParse(params)
  if (!parsed.success) return undefined
  const properties = parsed.data.requestedSchema.properties, keys = Object.keys(properties)
  const form: AntigravityFormQuestion[] = [], questions: NonNullable<AgentRequest['questions']> = []
  for (const key of keys) {
    if (/^q\d+_other$/u.test(key)) { if (!keys.includes(key.slice(0, -'_other'.length)) || !wordsSchema.safeParse(properties[key]).success) return undefined; continue }
    if (!/^q\d+$/u.test(key)) return undefined
    const one = oneSchema.safeParse(properties[key]), several = one.success ? undefined : severalSchema.safeParse(properties[key])
    const field = one.success ? { title: one.data.title, choices: one.data.oneOf } : several?.success ? { title: several.data.title, choices: several.data.items.anyOf } : undefined
    if (!field) return undefined
    const ids = new Set(field.choices.map(choice => choice.const))
    if (ids.size !== field.choices.length) return undefined
    const other = keys.includes(`${key}_other`) ? `${key}_other` : undefined
    form.push({ key, several: !one.success, ...(other ? { other } : {}) })
    questions.push({ id: key, question: bounded(field.title?.trim() || 'Choose an option.'),
      options: field.choices.map(choice => ({ id: choice.const, label: bounded(choice.title.trim() || choice.const, 512) })),
      multiSelect: !one.success, allowFreeText: other !== undefined, required: parsed.data.requestedSchema.required?.includes(key) ?? false })
  }
  if (!questions.length || questions.length > 20) return undefined
  const text = questions.length === 1 ? questions[0]!.question : bounded(parsed.data.message?.trim() || 'Antigravity has questions.')
  return { wireId, threadId, kind: 'question', toolCallId: parsed.data.toolCallId ?? '', form, request: { id: `antigravity-request-${JSON.stringify(wireId)}`,
    kind: 'question', text, options: questions.length === 1 ? questions[0]!.options : [], questions, skippable: true,
    ...(parsed.data.toolCallId ? { context: { toolCallId: parsed.data.toolCallId } } : {}) } }
}

/** One request `agy` sent, as Sotto shows it, or undefined for one Sotto does not read. The Sotto ID is the adapter's to give. */
export function antigravityPending(wireId: string | number, method: string, params: unknown, threadId: string): AntigravityPending | undefined {
  if (method === ANTIGRAVITY_QUESTION) return antigravityForm(wireId, params, threadId)
  if (method !== ANTIGRAVITY_PERMISSION) return undefined
  const parsed = permissionSchema.safeParse(params)
  if (!parsed.success) return undefined
  const permission = parsed.data, toolCall = permission.toolCall
  const id = `antigravity-request-${JSON.stringify(wireId)}`
  if (toolCall.toolCallId.startsWith(QUESTION_PREFIX)) {
    // A question takes exactly one of its own options. Options without IDs, or two with one ID, cannot be answered.
    const ids = new Set<string>()
    for (const option of permission.options) { if (!option.optionId.trim() || ids.has(option.optionId)) return undefined; ids.add(option.optionId) }
    const prompt = bounded(toolCall.title?.trim() || 'Choose an option.')
    const options = permission.options.map(option => ({ id: option.optionId, label: bounded(option.name.trim() || option.optionId, 512) }))
    return { wireId, threadId, kind: 'question', toolCallId: toolCall.toolCallId, permission, request: { id, kind: 'question', text: prompt, options,
      questions: [{ id: 'question', question: prompt, options, multiSelect: false, allowFreeText: false, required: true }], context: { toolCallId: toolCall.toolCallId } } }
  }
  const title = toolCall.title?.trim() || 'Antigravity asks to use a tool.'
  const command = toolCall.kind === 'execute' ? antigravityCommand(toolCall.rawInput) ?? unquoted(title) : undefined
  const { paths, diffs } = command ? { paths: [], diffs: [] } : fileChanges(toolCall)
  const unnamed = paths.filter(path => !title.includes(path))
  const said = contentText(toolCall.content)
  const details = [...said, ...diffs].join('\n')
  return { wireId, threadId, kind: 'permission', toolCallId: toolCall.toolCallId, permission, request: { id, kind: 'permission',
    text: [title, ...(unnamed.length ? [unnamed.join('\n')] : []), ...said].join('\n').slice(0, TEXT_LIMIT), options: [],
    // Allow once and reject only: `agy`'s allow-always would save a rule in Sotto's Antigravity folder.
    permissionChoices: permission.options.flatMap((option): NonNullable<AgentRequest['permissionChoices']> => !option.optionId.trim() ? []
      : option.kind === 'allow_once' ? [{ id: option.optionId, label: 'Allow once', kind: 'allow-once' }]
      : option.kind === 'reject_once' ? [{ id: option.optionId, label: 'Reject', kind: 'deny' }] : []),
    context: { toolCallId: toolCall.toolCallId, ...(command ? { command: command.slice(0, TEXT_LIMIT) } : {}),
      ...(details ? { details: details.slice(0, 100_000) } : {}) } } }
}

/** Tool kinds that change files, which Allow edits answers. */
const EDIT_KINDS = new Set(['edit', 'delete', 'move'])
/**
 * The option Sotto answers with for the thread's mode, or undefined when the user answers. As T3's policy: Allow edits
 * allows a file change once; Full access allows anything once. Ask for approval and Auto leave every request to the
 * user, since `agy`'s Auto has already reviewed what it asks about. A question is never answered for the user.
 */
export function antigravityAutoAnswer(mode: AntigravityRuntimeMode, pending: AntigravityPending): string | undefined {
  if (pending.kind !== 'permission' || !pending.permission) return undefined
  const once = pending.permission.options.find(option => option.kind === 'allow_once' && option.optionId.trim())
  if (!once) return undefined
  if (mode === 'full-access') return once.optionId
  if (mode === 'auto-accept-edits' && EDIT_KINDS.has(pending.permission.toolCall.kind ?? '')) return once.optionId
  return undefined
}

/**
 * The answer to send for the user's reply: a permission allowed once or rejected, a question with its one chosen option,
 * or `agy`'s form with each question's choices and words, or declined when the user skipped it.
 */
export function antigravityAnswer(pending: AntigravityPending, answer: string, approved?: boolean, questionAnswers?: AgentQuestionAnswers, permissionChoice?: string, skipped?: boolean): unknown {
  if (pending.form) return formAnswer(pending, pending.form, answer, questionAnswers, skipped)
  if (!pending.permission) throw new Error('That Antigravity request is no longer waiting.')
  const options = pending.permission.options
  if (pending.kind === 'permission') {
    if (permissionChoice) return { outcome: { outcome: 'selected', optionId: permissionValue(pending.request, permissionChoice, approved) } }
    const selected = options.find(option => option.kind === (approved === true ? 'allow_once' : 'reject_once') && option.optionId.trim())
    if (approved === true && !selected) throw new Error('Antigravity did not offer to allow this once. Nothing was approved.')
    return selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  const question = pending.request.questions?.[0]
  let supplied = questionAnswers
  if (!supplied && question) {
    const words = answer.trim().toLowerCase()
    const matches = question.options.filter(entry => entry.id.toLowerCase() === words || entry.label.toLowerCase() === words)
    if (matches.length !== 1) throw new Error('Antigravity’s question takes one of its own options. Choose one of them.')
    supplied = { [question.id]: { optionIds: [matches[0]!.id] } }
  }
  if (!supplied) throw new Error('Antigravity’s question takes one of its own options. Choose one of them.')
  questionValues(pending.request, supplied)
  const chosen = question ? supplied[question.id]?.optionIds ?? [] : []
  if (chosen.length !== 1 || !options.some(option => option.optionId === chosen[0])) throw new Error('Antigravity’s question takes exactly one of its own options. Choose one of them.')
  return { outcome: { outcome: 'selected', optionId: chosen[0] } }
}

/** `agy`'s form answered: `accept` with each question's chosen option IDs and words, or `decline` for a skipped card. */
function formAnswer(pending: AntigravityPending, form: readonly AntigravityFormQuestion[], answer: string, questionAnswers?: AgentQuestionAnswers, skipped?: boolean): unknown {
  if (skipped) return { action: 'decline' }
  let supplied = questionAnswers
  const only = pending.request.questions?.length === 1 ? pending.request.questions[0] : undefined
  if (!supplied && only) {
    // Words alone, as a phone or a thread answers: one of its options by name, else its own words where it takes them.
    const words = answer.trim(), match = only.options.filter(option => option.label.toLowerCase() === words.toLowerCase() || option.id === words)
    if (match.length === 1) supplied = { [only.id]: { optionIds: [match[0]!.id] } }
    else if (words && only.allowFreeText) supplied = { [only.id]: { optionIds: [], text: words } }
  }
  if (!supplied) throw new Error('Answer each of Antigravity’s questions.')
  questionValues(pending.request, supplied)
  const content: Record<string, string | string[]> = {}
  for (const question of form) {
    const given = supplied[question.key]
    if (!given) continue
    if (given.optionIds.length) content[question.key] = question.several ? [...given.optionIds] : given.optionIds[0]!
    if (question.other && given.text?.trim()) content[question.other] = given.text.trim()
  }
  return { action: 'accept', content }
}

/** What a request is answered when the user did not answer it: the thread stopped, or Sotto disconnected. It grants nothing. */
export function antigravityDecline(pending?: AntigravityPending): unknown { return pending?.form ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } } }
