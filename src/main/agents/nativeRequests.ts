import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'

/**
 * Does this provider request read as something only a person can answer? Adapters map the shapes they
 * know and refuse the rest, which is right until a provider renames or reshapes one: the refusal is a
 * protocol-level error nobody sees, the provider treats it as a refusal, and the thread carries on as
 * though the user had said no. This is how an adapter recognises that case well enough to say it out
 * loud. It is deliberately about the method's name rather than its payload, because the payload is the
 * part that has changed.
 */
export function needsPerson(method: string): boolean {
  return /requestApproval$|requestUserInput$|request_permission$|ask_user_question$|elicitation\/request$|^item\/permissions\//u.test(method)
}

/**
 * What a thread is told when one of those requests arrives in a shape its adapter cannot read. It never
 * says which side is behind: a renamed method means the client is ahead of Sotto, a dropped field means
 * Sotto is ahead of the client, and the frame does not say which. Naming one of them would send the user
 * to update the wrong thing.
 */
export function unreadableRequest(provider: string): string {
  return `${provider} asked for something only you can answer in a form Sotto could not read, so it was declined without reaching you. Nothing else was lost. Answer it in ${provider}, and check for a Sotto or ${provider} update.`
}

/** Validate against the original native request, never against renderer-provided choices. */
/** What a provider that takes words with a declined question is told when the user skips it (ADR-0135, October 27, 2026). */
/**
 * What Muse is told when Watcher asks with its own question tool, which would hold Watcher's turn until the user answered
 * (#2228). The question reaches no one and nothing is answered for the user: the tool is closed to Watcher, as Claude
 * Code's and Codex's are at launch, and Watcher asks again with Sotto's ask_user. Grok Build's and Cursor's cancels carry
 * no words.
 */
export const WATCHER_QUESTION_TOOL_CLOSED = 'This question tool is closed to Watcher, so the question reached no one and nothing was answered. Ask the user with ask_user on sotto_threads instead: it shows them a card and returns at once.'
export const QUESTION_SKIPPED = 'The user skipped this question. Proceed using your own judgement.'
const QUESTION_NOT_SKIPPABLE = 'This question cannot be skipped on its own. Answer it, or skip the whole form.'
/** Whether one question was skipped in this answer. */
export const skippedQuestion = (supplied: AgentQuestionAnswers | undefined, questionId: string): boolean => supplied?.[questionId]?.skipped === true
/**
 * Whether a form field that must be answered can carry the skip sentence as its words: a field that takes typed words with
 * no format to match, whose length limits the sentence fits. A required yes-or-no, number or choice field cannot, so it has
 * no Skip of its own and only the whole form's Skip declines it (Zach's pick, November 6, 2026).
 */
export function skipSentenceFits(minLength?: number, maxLength?: number): boolean {
  return QUESTION_SKIPPED.length >= (minLength ?? 0) && QUESTION_SKIPPED.length <= (maxLength ?? Number.POSITIVE_INFINITY)
}
export function questionValues(request: AgentRequest, supplied: AgentQuestionAnswers): Record<string, string[]> {
  const questions = request.questions ?? []
  if (!questions.length || Object.keys(supplied).some(id => !questions.some(question => question.id === id))) throw new Error('The question changed. Review its original request.')
  return Object.fromEntries(questions.flatMap(question => {
    const answer = supplied[question.id]
    // A question the user skipped on its own (ADR-0135, November 6, 2026) is answered with the skip sentence. An adapter
    // whose provider takes no words leaves it out instead, as its own clients send a question the user passed over.
    if (answer?.skipped) {
      if (!question.skippable) throw new Error(QUESTION_NOT_SKIPPABLE)
      if (answer.optionIds.length || answer.text?.trim()) throw new Error('A skipped question takes no answer.')
      return [[question.id, [QUESTION_SKIPPED]]]
    }
    if (question.required === false && (!answer || (answer.optionIds.length === 0 && !answer.text?.trim()))) return []
    if (question.unavailableReason) throw new Error(question.unavailableReason)
    if (!answer || !Array.isArray(answer.optionIds) || new Set(answer.optionIds).size !== answer.optionIds.length) throw new Error('Answer every question once.')
    if (!question.multiSelect && answer.optionIds.length > 1) throw new Error('Choose one option for this question.')
    if (answer.optionIds.some(id => !question.options.some(option => option.id === id))) throw new Error('Choose an offered question option.')
    if (answer.text?.trim() && !question.allowFreeText) throw new Error('This question does not support free text.')
    const values = [...answer.optionIds.map(id => question.options.find(option => option.id === id)!.label), ...(answer.text?.trim() ? [answer.text] : [])]
    if (!values.length) throw new Error('Answer every question.')
    return [[question.id, values]]
  }))
}
export function permissionValue(request: AgentRequest, choiceId: string, approved: boolean | undefined): string {
  const choice = request.permissionChoices?.find(choice => choice.id === choiceId)
  if (!choice) throw new Error('This permission choice was not offered by the provider.')
  if (approved !== choice.kind.startsWith('allow-')) throw new Error('Explicit approval must match the selected permission choice.')
  return choice.id
}
