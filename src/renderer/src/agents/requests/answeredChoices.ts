import { t } from '@lingui/core/macro'

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
    return entry.choice === 'allow' ? t({ message: 'Allow', comment: 'Answers an agent’s permission request.' })
      : entry.choice === 'deny' ? t({ message: 'Deny', comment: 'Answers an agent’s permission request.' }) : null
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
interface Answered { readonly words: string | null; readonly sent: boolean; readonly gone: boolean }
/**
 * What this window sent for each request it answered, by thread and request, in the card's own words, and whether
 * main took the answer, from whichever place sent it: Watcher's conversation, the thread's own card, or its composer.
 * Only Sotto Owl with Watcher on notes anything, and it is held in memory for this window's life alone; nothing is
 * saved. A request answered anywhere else, or before a restart, is not here, and Watcher's line for it then says only
 * that it no longer waits. The window tells it each thread's requests as they arrive (`observe`), whether or not
 * Watcher is on screen: once an answered request has left its thread, one waiting again under the same ID, which a
 * provider may reuse, is a new request, and the earlier choice is forgotten rather than told of it.
 */
class AnsweredChoices {
  private readonly threads = new Map<string, Map<string, Answered>>()
  private size = 0
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  note(threadId: string, requestId: string, words: string | null, sent: boolean): void {
    const thread = this.threads.get(threadId) ?? new Map<string, Answered>()
    const before = thread.get(requestId)
    const next: Answered = { words: words ?? before?.words ?? null, sent: sent || before?.sent === true, gone: false }
    if (before !== undefined && before.words === next.words && before.sent === next.sent && !before.gone) return
    if (before === undefined) this.size++
    thread.set(requestId, next)
    this.threads.set(threadId, thread)
    while (this.size > ANSWERED_KEPT) this.dropOldest()
    this.changed()
  }
  /** Whether anything is kept for this thread, so the window tells only those threads' requests. */
  has(threadId: string): boolean { return this.threads.has(threadId) }
  /**
   * A thread's requests as they now stand. One that has left is marked so; one that waits again after it left is a new
   * request under a reused ID, and what was sent for the earlier one is forgotten.
   */
  observe(threadId: string, live: readonly { readonly id: string }[]): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    let changed = false
    for (const [requestId, answered] of thread) {
      const waiting = live.some(request => request.id === requestId)
      if (!waiting && !answered.gone) thread.set(requestId, { ...answered, gone: true })
      else if (waiting && answered.gone) { thread.delete(requestId); this.size--; changed = true }
    }
    if (thread.size === 0) this.threads.delete(threadId)
    if (changed) this.changed()
  }
  /** The words of an answer main took from this window; null when this window did not send one. */
  sent(threadId: string, requestId: string): string | null | undefined {
    const answered = this.threads.get(threadId)?.get(requestId)
    return answered?.sent ? answered.words : undefined
  }
  clear(): void { this.threads.clear(); this.size = 0 }
  private dropOldest(): void {
    const [threadId, thread] = this.threads.entries().next().value!
    thread.delete(thread.keys().next().value!)
    this.size--
    if (thread.size === 0) this.threads.delete(threadId)
  }
  private changed(): void { for (const listener of [...this.listeners]) listener() }
}
export const answeredChoices = new AnsweredChoices()
