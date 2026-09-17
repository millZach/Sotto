import { z } from 'zod'
import { agentRequestSchema, providerIdSchema, type AgentHostSnapshot, type AgentThread, type ProviderId } from './agents'

const id = z.string().min(1).max(256)
export const requestDraftOwnerSchema = z.object({ kind: z.enum(['thread', 'personal']), ownerId: id, providerId: providerIdSchema }).strict()
export type RequestDraftOwner = z.infer<typeof requestDraftOwnerSchema>
export const requestDraftTargetSchema = requestDraftOwnerSchema.extend({ requestId: id, questions: agentRequestSchema.shape.questions.unwrap().min(1) }).strict()
export type RequestDraftTarget = z.infer<typeof requestDraftTargetSchema>
const questionSelectionSchema = z.object({ optionIds: z.array(id).max(100), other: z.boolean(), text: z.string().max(24_000) }).strict()
export type QuestionSelection = z.infer<typeof questionSelectionSchema>
export const requestDraftSchema = z.object({
  target: requestDraftTargetSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  selections: z.record(id, questionSelectionSchema), held: z.boolean(),
  /** Main-owned native attempt identity; never grants permission to deliver. */
  decisionId: id.optional(),
}).strict().superRefine((draft, context) => {
  const questions = draft.target.questions
  if (new Set(questions.map(question => question.id)).size !== questions.length
    || questions.some(question => new Set(question.options.map(option => option.id)).size !== question.options.length)) {
    context.addIssue({ code: 'custom', message: 'Question and option identities must be unique.' })
  }
  for (const [questionId, selection] of Object.entries(draft.selections)) {
    const question = questions.find(item => item.id === questionId)
    if (!question || question.unavailableReason !== undefined || new Set(selection.optionIds).size !== selection.optionIds.length
      || selection.optionIds.some(optionId => !question.options.some(option => option.id === optionId))
      || (!question.multiSelect && selection.optionIds.length + Number(selection.other) > 1)
      || (!question.allowFreeText && (selection.other || selection.text.length > 0))) {
      context.addIssue({ code: 'custom', message: 'Selections must belong to their original question.' })
    }
  }
})
export type RequestDraft = z.infer<typeof requestDraftSchema>
export const requestDraftDiscardSchema = z.object({ target: requestDraftTargetSchema, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
export type RequestDraftDiscard = z.infer<typeof requestDraftDiscardSchema>
export const REQUEST_DRAFT_LIST = 'request-draft:list'
export const REQUEST_DRAFT_DISCARD = 'request-draft:discard'
export const REQUEST_DRAFT_GET = 'request-draft:get'
export const REQUEST_DRAFT_SAVE = 'request-draft:save'
export const REQUEST_DRAFT_CHECK = 'request-draft:check'
export interface RequestDraftBridge {
  /** Read retained forms without requiring or recreating a native request. */
  list(owner: RequestDraftOwner): Promise<RequestDraft[]>
  discard(input: RequestDraftDiscard): Promise<boolean>
  get(target: RequestDraftTarget): Promise<RequestDraft | null>
  save(draft: RequestDraft): Promise<RequestDraft>
  /** Only main can release a held attempt after a fresh native read. This never delivers an answer. */
  check(target: RequestDraftTarget): Promise<RequestDraft | null>
}
export const requestDraftOwnerKey = (owner: RequestDraftOwner): string => JSON.stringify([owner.kind, owner.providerId, owner.ownerId])
/** Legacy single-provider snapshots can identify the owner through its model instead of providerId. */
export function requestDraftProvider(host: AgentHostSnapshot, thread: AgentThread, fallback: ProviderId): ProviderId {
  const model = host.models.find(item => item.id === thread.modelId)
  return thread.providerId ?? model?.providerId ?? providerIdSchema.safeParse(model?.provider.toLowerCase()).data ?? fallback
}
export const requestDraftKey = (target: RequestDraftTarget): string => JSON.stringify([target.kind, target.providerId, target.ownerId, target.requestId, requestQuestionsSignature(target.questions)])
export const requestQuestionsSignature = (questions: RequestDraftTarget['questions']): string => JSON.stringify(agentRequestSchema.shape.questions.unwrap().parse(questions))
export const sameRequestQuestions = (a: RequestDraftTarget['questions'], b: RequestDraftTarget['questions']): boolean => requestQuestionsSignature(a) === requestQuestionsSignature(b)
