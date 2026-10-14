import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import { permissionValue, questionValues } from './nativeRequests'

/**
 * Muse's two things only the user can settle, as MSP carries them: an approval for a tool action
 * (`approval/requested`, answered with `approval/decide`) and a structured question (`userInput/requested`,
 * answered with `userInput/answer`). Both arrive as notifications on the session's view stream, so a request
 * is shown from the notification and settled by a command; nothing here ever answers one on its own.
 */
const requirementSchema = z.looseObject({ approvalId: z.string().min(1), sourceIndex: z.number().int() })
const choiceSchema = z.looseObject({
  choiceId: z.string().min(1), decision: z.string().min(1), label: z.string().min(1),
  scope: z.string().min(1), acceptsFeedback: z.boolean().optional(), rulePreview: z.string().optional(),
})
const subjectSchema = z.looseObject({
  kind: z.string().min(1), command: z.string().optional(), path: z.string().optional(), access: z.string().optional(),
  host: z.string().optional(), port: z.number().optional(), toolName: z.string().optional(), target: z.string().optional(),
})
export const museApprovalSchema = z.looseObject({
  approvalId: z.string().min(1), sessionId: z.string().min(1), turnId: z.string().min(1),
  toolName: z.string().min(1), toolCallId: z.string().min(1), itemId: z.string().min(1),
  rawArgs: z.string().default(''), subject: subjectSchema,
  availableChoices: z.array(choiceSchema).min(1), currentRequirementId: requirementSchema,
})
export type MuseApproval = z.infer<typeof museApprovalSchema>
export const museApprovalUpdatedSchema = z.looseObject({
  approvalId: z.string().min(1), sessionId: z.string().min(1), subject: subjectSchema,
  availableChoices: z.array(choiceSchema).min(1), currentRequirementId: requirementSchema,
})
export const museApprovalDecidedSchema = z.looseObject({
  approvalId: z.string().min(1), commandId: z.string().min(1), status: z.string().min(1), terminal: z.boolean(),
})
const questionSchema = z.looseObject({
  id: z.string().min(1), header: z.string().default(''), question: z.string().min(1),
  selection: z.looseObject({ mode: z.enum(['single', 'multiple']), minSelections: z.number().int().optional(), maxSelections: z.number().int().optional() }),
  options: z.array(z.looseObject({
    label: z.string().min(1), description: z.string().optional(),
    preview: z.looseObject({ format: z.string(), content: z.string() }).optional(),
  })).default([]),
})
export const museUserInputSchema = z.looseObject({
  userInputId: z.string().min(1), sessionId: z.string().min(1), turnId: z.string().min(1),
  toolName: z.string().min(1), questions: z.array(questionSchema).min(1),
  autoResolutionMs: z.number().optional(),
})
export type MuseUserInput = z.infer<typeof museUserInputSchema>

export type MusePending =
  | { readonly kind: 'approval'; readonly threadId: string; request: AgentRequest; approval: MuseApproval; answering?: boolean }
  | { readonly kind: 'userInput'; readonly threadId: string; request: AgentRequest; input: MuseUserInput; answering?: boolean }

const bounded = (text: string, limit = 4_000): string => text.length > limit ? text.slice(0, limit) : text

function choiceKind(choice: z.infer<typeof choiceSchema>): NonNullable<AgentRequest['permissionChoices']>[number]['kind'] | undefined {
  // A wider decision cannot become one-time merely because its scope contradicts its meaning.
  if (choice.decision === 'approvedForSession' && choice.scope !== 'session') return undefined
  if (['approvedPolicyAmendment', 'deniedPolicyAmendment'].includes(choice.decision) && choice.scope !== 'localPersistent') return undefined
  if (['approved', 'approvedForSession', 'approvedPolicyAmendment'].includes(choice.decision)) {
    if (choice.scope === 'once') return 'allow-once'
    if (choice.scope === 'session') return 'allow-session'
    if (choice.scope === 'localPersistent') return 'allow-always'
    return undefined
  }
  if (choice.decision === 'abort') return 'cancel'
  if (['denied', 'deniedPolicyAmendment', 'timedOut'].includes(choice.decision)) return 'deny'
  return undefined
}

/** What the action is, in one sentence the request card can show. An unknown subject kind stays generic. */
function approvalText(approval: MuseApproval): string {
  const subject = approval.subject
  if (subject.kind === 'shell' && subject.command) return `Run a command: ${bounded(subject.command, 500)}`
  if (subject.kind === 'fileAccess' && subject.path) return `${subject.access === 'write' ? 'Write to' : 'Read'} ${bounded(subject.path, 500)}`
  if (subject.kind === 'network' && subject.host) return `Connect to ${bounded(subject.host, 300)}${subject.port ? `:${subject.port}` : ''}`
  return `Use ${bounded(approval.toolName, 200)}`
}

/** One approval as Sotto shows it. The native choices keep their own labels; Sotto only sorts them by kind. */
export function museApprovalPending(threadId: string, approval: MuseApproval): Extract<MusePending, { kind: 'approval' }> {
  // A shell approval may ask about several requirements under one native ID. Each is a new request to
  // the user, with its own answer ownership and delivery record, including after a reconnect.
  const stageId = createHash('sha256').update(JSON.stringify([approval.approvalId,
    approval.currentRequirementId.approvalId, approval.currentRequirementId.sourceIndex])).digest('hex')
  const request: AgentRequest = {
    id: `muse-approval-${stageId}`, kind: 'permission', text: approvalText(approval), options: [],
    permissionChoices: approval.availableChoices.flatMap(choice => {
      const kind = choiceKind(choice)
      return kind ? [{
        id: choice.choiceId, label: bounded(choice.label, 200), kind,
        ...(choice.rulePreview ? { description: bounded(choice.rulePreview, 500) } : {}),
      }] : []
    }),
    context: {
      toolName: approval.toolName, toolCallId: approval.toolCallId,
      ...(approval.subject.kind === 'shell' && approval.subject.command ? { command: bounded(approval.subject.command) } : {}),
      ...(approval.rawArgs ? { details: bounded(approval.rawArgs) } : {}),
    },
  }
  return { kind: 'approval', threadId, request, approval }
}

/** An updated native approval as its current requirement; the host decides whether it replaces a stage. */
export function museApprovalRefreshed(pending: Extract<MusePending, { kind: 'approval' }>, updated: z.infer<typeof museApprovalUpdatedSchema>): Extract<MusePending, { kind: 'approval' }> {
  return museApprovalPending(pending.threadId, { ...pending.approval, subject: updated.subject,
    availableChoices: updated.availableChoices, currentRequirementId: updated.currentRequirementId })
}

const optionId = (index: number): string => `option-${index}`

/** One structured question as Sotto shows it. IDs name positions, keeping native labels out of IDs. */
export function museUserInputPending(threadId: string, input: MuseUserInput): MusePending {
  const request: AgentRequest = {
    id: input.userInputId, kind: 'question', text: bounded(input.questions[0]!.question, 2_000), options: [],
    questions: input.questions.map(question => ({
      id: question.id, question: bounded(question.question, 2_000),
      ...(question.header ? { header: bounded(question.header, 200) } : {}),
      options: question.options.map((option, index) => ({
        id: optionId(index), label: bounded(option.label, 500),
        ...(option.description ? { description: bounded(option.description, 1_000) } : {}),
        ...(option.preview ? { preview: bounded(option.preview.content, 2_000) } : {}),
      })),
      multiSelect: question.selection.mode === 'multiple', allowFreeText: true,
      required: (question.selection.minSelections ?? 1) > 0,
    })),
  }
  return { kind: 'userInput', threadId, request, input }
}

/**
 * The `approval/decide` choice a Sotto answer names. An explicit choice from the card wins; a plain allow or
 * deny takes the one-time form of it, never a wider one the user did not pick.
 */
export function museApprovalChoice(pending: Extract<MusePending, { kind: 'approval' }>, approved: boolean | undefined, permissionChoice?: string): string {
  if (permissionChoice) {
    // A card may name only the choice; whether it allows is the choice's own kind, checked against an
    // explicit allow or deny when one came with it.
    const chosen = (pending.request.permissionChoices ?? []).find(choice => choice.id === permissionChoice)
    return permissionValue(pending.request, permissionChoice, approved ?? chosen?.kind.startsWith('allow-'))
  }
  if (typeof approved !== 'boolean') throw new Error('Explicitly allow or deny this permission request.')
  const wants: readonly string[] = approved ? ['allow-once'] : ['deny', 'cancel']
  const offered = pending.request.permissionChoices ?? []
  const choice = wants.flatMap(kind => offered.filter(candidate => candidate.kind === kind
    && pending.approval.availableChoices.some(native => native.choiceId === candidate.id && native.scope === 'once')))[0]
  if (!choice) throw new Error(approved ? 'Muse did not offer a way to allow this. Answer in Muse.' : 'Muse did not offer a way to deny this. Answer in Muse.')
  return choice.id
}

/** The `userInput/answer` answers a Sotto answer names, one per question, in Muse's own form. */
export function museUserInputAnswers(pending: Extract<MusePending, { kind: 'userInput' }>, answer: string, questionAnswers?: AgentQuestionAnswers): { questionId: string; selectedLabel?: string; selectedLabels?: string[]; freeText?: string; note?: string }[] {
  const questions = pending.input.questions
  let supplied = questionAnswers
  if (!supplied) {
    if (questions.length !== 1) throw new Error('Answer every question.')
    const question = questions[0]!
    const selected = question.options.findIndex(option => option.label === answer)
    supplied = { [question.id]: selected >= 0 ? { optionIds: [optionId(selected)] } : { optionIds: [], text: answer } }
  }
  questionValues(pending.request, supplied)
  return questions.map(question => {
    const given = supplied![question.id]
    // Optional questions are deliberately omitted by the form when they have no answer.
    // MSP still needs one answer per question, with an empty selection or text for those entries.
    if (!given || (!given.optionIds.length && !given.text?.trim())) return question.selection.mode === 'multiple'
      ? { questionId: question.id, selectedLabels: [] }
      : { questionId: question.id, freeText: '' }
    const nativeLabels = new Map(question.options.map((option, index) => [optionId(index), option.label]))
    const labels = given.optionIds.map(id => nativeLabels.get(id)!)
    const note = given.text?.trim()
    if (note && note.length > 500) throw new Error(`Muse accepts up to 500 characters for ${labels.length ? 'a note' : 'an answer'}. Nothing was sent. Shorten it and try again.`)
    if (!labels.length) return { questionId: question.id, freeText: note ?? '' }
    if (question.selection.mode === 'multiple') {
      const minimum = question.selection.minSelections ?? 1
      if (labels.length < minimum) throw new Error(`Choose at least ${minimum} options for this question.`)
      if (question.selection.maxSelections !== undefined && labels.length > question.selection.maxSelections) throw new Error(`Choose no more than ${question.selection.maxSelections} options for this question.`)
    }
    return question.selection.mode === 'multiple'
      ? { questionId: question.id, selectedLabels: labels, ...(note ? { note } : {}) }
      : { questionId: question.id, selectedLabel: labels[0]!, ...(note ? { note } : {}) }
  })
}
