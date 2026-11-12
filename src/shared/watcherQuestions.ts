import { z } from 'zod'
import type { AgentRequest } from './agents'
import { watcherThreadTargetSchema } from './watcher'

/**
 * Watcher's own question (#2228, ADR-0073, November 5, 2026): Watcher asks the user with `ask_user`, which puts Sotto's card
 * in Watcher's conversation and answers at once, so Watcher keeps working while the card waits. Its provider's own
 * question tool, which held Watcher's turn until the user answered, is closed to it. The user's choice reaches Watcher as
 * news, labelled as theirs.
 */
export const WATCHER_ASK_TOOL = 'ask_user'
export const WATCHER_QUESTION_WORDS_MAX = 1_000
export const WATCHER_QUESTION_LABEL_MAX = 80
export const WATCHER_QUESTION_DESCRIPTION_MAX = 300
/** The most questions main keeps, open and answered, newest last: the card's place and its answered line stay that long. */
export const WATCHER_QUESTIONS_KEPT = 50

/** The two choices of a settle question, Sotto's own, so the answer Settle it is the user's agreement to that settle. */
export const SETTLE_IT = 'Settle it'
export const KEEP_WATCHING = 'Keep watching'
export const SETTLE_CHOICES = Object.freeze([
  Object.freeze({ label: SETTLE_IT, description: 'Stop watching it. The thread stays in All threads.' }),
  Object.freeze({ label: KEEP_WATCHING, description: 'Keep it in view in case more work comes in.' }),
])

const label = z.string().trim().min(1).max(WATCHER_QUESTION_LABEL_MAX)
const optionSchema = z.object({ label, description: z.string().trim().min(1).max(WATCHER_QUESTION_DESCRIPTION_MAX).optional() }).strict()
export const watcherAskInputSchema = z.object({
  /** The question as the user reads it, with what they must know to answer. */
  question: z.string().trim().min(1).max(WATCHER_QUESTION_WORDS_MAX),
  /** Two to four choices. Left out for a settle question, whose choices are Sotto's: Settle it and Keep watching. */
  options: z.array(optionSchema).min(2).max(4).optional(),
  /** The thread this asks whether to settle, by its machine and its own thread ID there. */
  settle: watcherThreadTargetSchema.optional(),
}).strict().refine(input => input.settle !== undefined || input.options !== undefined, 'Give two to four options, or name the thread to settle.')
  .refine(input => !input.options || new Set(input.options.map(option => option.label.toLowerCase())).size === input.options.length, 'Each option needs its own label.')
export type WatcherAskInput = z.infer<typeof watcherAskInputSchema>
/** What the tool answers: the card is up, and the answer comes later as news. */
export const watcherAskOutputSchema = z.object({ status: z.literal('ok'), questionId: z.uuid(), note: z.string().min(1).max(1_000) }).strict()
export const WATCHER_ASK_NOTE = 'Sotto showed the user this question as a card in your conversation. Carry on with your work: their answer comes as news, in their own choice, or news that they skipped it. Do not ask it again while its card waits.'

/**
 * One question of Watcher's: `open` while its card waits; `answered` with the user's choice, in the card's own words;
 * `skipped` when the user pressed Skip and gave no answer (#2477); `closed` when a new Watcher took over before the user
 * answered, and the question went in the handover.
 */
export const watcherQuestionSchema = z.object({
  id: z.uuid(),
  /** The Watcher conversation that asked, by its thread on this computer. */
  watcherThreadId: z.string().min(1).max(512),
  question: z.string().min(1).max(WATCHER_QUESTION_WORDS_MAX),
  options: z.array(optionSchema).min(2).max(4),
  settle: watcherThreadTargetSchema.optional(),
  state: z.enum(['open', 'answered', 'skipped', 'closed']),
  /** The user's choice, the option's label. */
  choice: label.optional(),
  /** When Watcher asked, which places the card after that turn; and when it was answered, skipped or closed. */
  at: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  /** A Settle it that settle_thread has already used, so one answer agrees one settle. */
  spent: z.literal(true).optional(),
}).strict()
export type WatcherQuestion = z.infer<typeof watcherQuestionSchema>

const REQUEST_PREFIX = 'watcher-question:'
/** The request ID a question's card answers under, on Watcher's own thread, as every card's answer names one. */
export const watcherQuestionRequestId = (questionId: string): string => `${REQUEST_PREFIX}${questionId}`
/** Whether a request ID names a card of Watcher's own question. */
export const isWatcherQuestionRequest = (requestId: string): boolean => requestId.startsWith(REQUEST_PREFIX)
/** The question a request ID names, when it is one of Watcher's own. */
export const watcherQuestionOf = (requestId: string): string | undefined => requestId.startsWith(REQUEST_PREFIX) ? requestId.slice(REQUEST_PREFIX.length) : undefined
/** The one question on the card, by the ID its answer names. */
export const WATCHER_QUESTION_FIELD = 'answer'
const optionId = (index: number): string => `choice-${index + 1}`

/**
 * The card a question is drawn as, on the desktop and the phone: the ordinary question card, with one choice and no
 * written answer. The user can always write to Watcher in its message box instead. It is `skippable` (#2477), so it offers
 * the Skip a thread's card does (ADR-0135), and a skip reaches Watcher as news that the user gave no answer.
 */
export function watcherQuestionRequest(question: Pick<WatcherQuestion, 'id' | 'question' | 'options' | 'at'>): AgentRequest {
  return { id: watcherQuestionRequestId(question.id), kind: 'question', text: question.question, options: [], since: question.at, skippable: true,
    questions: [{ id: WATCHER_QUESTION_FIELD, question: question.question, multiSelect: false, allowFreeText: false,
      options: question.options.map((option, index) => ({ id: optionId(index), label: option.label, ...option.description ? { description: option.description } : {} })) }] }
}

/** The choice an answer to a question's card names: by its option, or by the label's own words. Undefined when it names none. */
export function watcherQuestionChoice(question: Pick<WatcherQuestion, 'options'>, answer: { readonly answer: string; readonly questionAnswers?: Readonly<Record<string, { readonly optionIds: readonly string[] }>> | undefined }): string | undefined {
  const picked = answer.questionAnswers?.[WATCHER_QUESTION_FIELD]?.optionIds
  if (picked !== undefined) {
    if (picked.length !== 1) return undefined
    return question.options.find((_option, index) => optionId(index) === picked[0])?.label
  }
  const words = answer.answer.trim().toLowerCase()
  return question.options.find(option => option.label.toLowerCase() === words)?.label
}
