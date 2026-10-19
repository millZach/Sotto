import type { AgentRequest } from '../../../../shared/agents'
import { EMPTY_SELECTION, requestMode, textOnly, type RequestAnswer, type RequestEntry } from './requestAnswers'

/** The words a receipt uses for an answer written in the user's own words, which Sotto never repeats. */
export const OWN_WORDS = 'in your own words'
const plainLabel = (label: string): string => label.replace(/\s*\(recommended\)\s*$/iu, '')

/**
 * What the user chose on a request's card, in the card's own words: the permission choice, or the option labels, or
 * that they wrote their own answer. Never their text. Null when the card offered nothing it could name, such as a plain
 * question answered in the composer.
 */
export function chosenWords(request: AgentRequest, entry: Pick<RequestEntry, 'choice' | 'selections'>): string | null {
  const mode = requestMode(request)
  if (mode === 'permission') {
    if (entry.choice === null) return null
    const choices = request.permissionChoices
    if (choices) return choices.find(choice => choice.id === entry.choice)?.label ?? null
    return entry.choice === 'allow' ? 'Allow' : entry.choice === 'deny' ? 'Deny' : null
  }
  if (mode === 'legacy-options') {
    const picked = entry.selections[request.id]?.optionIds[0] ?? entry.choice
    const option = request.options.find(item => item.id === picked)
    return option === undefined ? null : plainLabel(option.label)
  }
  if (mode !== 'structured') return null
  const labels: string[] = []
  let own = false
  for (const question of request.questions ?? []) {
    const selection = entry.selections[question.id]
    if (selection === undefined) continue
    for (const id of selection.optionIds) {
      const option = question.options.find(item => item.id === id)
      if (option !== undefined) labels.push(plainLabel(option.label))
    }
    if ((selection.other || textOnly(question)) && selection.text.trim() !== '') own = true
  }
  if (labels.length === 0) return own ? OWN_WORDS : null
  return own ? `${labels.join(', ')}, and ${OWN_WORDS}` : labels.join(', ')
}

/** The same words for an answer as it is sent: what the card's choice or selections were, read back from the answer itself. */
export function answerWords(request: AgentRequest, answer: RequestAnswer): string | null {
  const mode = requestMode(request)
  if (mode === 'permission') return chosenWords(request, { choice: answer.permissionChoice ?? (answer.approved === true ? 'allow' : answer.approved === false ? 'deny' : null), selections: {} })
  if (mode === 'legacy-options') return chosenWords(request, { choice: answer.answer, selections: {} })
  const selections = Object.fromEntries(Object.entries(answer.questionAnswers ?? {}).map(([id, given]) =>
    [id, { ...EMPTY_SELECTION, optionIds: given.optionIds, other: (given.text ?? '').trim() !== '', text: given.text ?? '' }]))
  return chosenWords(request, { choice: null, selections })
}

const ANSWERED_KEPT = 200
/**
 * What this window sent for each request it answered, by thread and request, in the card's own words, and whether
 * main took the answer, from whichever card sent it: the thread's own pane or Watcher's conversation. Held in memory for
 * this window's life alone; nothing is saved. A request answered anywhere else, or before a restart, is not here, and
 * Watcher's line for it then says only that it no longer waits. A request seen waiting again under the same ID, which a
 * provider may reuse, is forgotten, so an earlier request's choice is never told of a later one.
 */
class AnsweredChoices {
  private readonly entries = new Map<string, { readonly words: string | null; readonly sent: boolean }>()
  private readonly listeners = new Set<() => void>()
  private static key(threadId: string, requestId: string): string { return JSON.stringify([threadId, requestId]) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  note(threadId: string, requestId: string, words: string | null, sent: boolean): void {
    const key = AnsweredChoices.key(threadId, requestId)
    const before = this.entries.get(key)
    const next = { words: words ?? before?.words ?? null, sent: sent || before?.sent === true }
    if (before !== undefined && before.words === next.words && before.sent === next.sent) return
    this.entries.delete(key)
    this.entries.set(key, next)
    while (this.entries.size > ANSWERED_KEPT) this.entries.delete(this.entries.keys().next().value!)
    this.changed()
  }
  /** Forgets a request that waits again: whatever was sent for an earlier one under its ID no longer speaks for it. */
  forget(threadId: string, requestId: string): void {
    if (this.entries.delete(AnsweredChoices.key(threadId, requestId))) this.changed()
  }
  /** The words of an answer main took from this window; null when this window did not send one. */
  sent(threadId: string, requestId: string): string | null | undefined {
    const entry = this.entries.get(AnsweredChoices.key(threadId, requestId))
    return entry?.sent ? entry.words : undefined
  }
  clear(): void { this.entries.clear() }
  private changed(): void { for (const listener of [...this.listeners]) listener() }
}
export const answeredChoices = new AnsweredChoices()
