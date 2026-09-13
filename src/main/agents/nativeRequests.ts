import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'

/** Validate against the original native request, never against renderer-provided choices. */
export function questionValues(request: AgentRequest, supplied: AgentQuestionAnswers): Record<string, string[]> {
  const questions = request.questions ?? []
  if (!questions.length || Object.keys(supplied).some(id => !questions.some(question => question.id === id))) throw new Error('The question changed. Review its original request.')
  return Object.fromEntries(questions.flatMap(question => {
    const answer = supplied[question.id]
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
