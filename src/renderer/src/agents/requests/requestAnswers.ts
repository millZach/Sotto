import { useSyncExternalStore } from 'react'
import type { AgentQuestionAnswers, AgentRequest } from '../../../../shared/agents'

export type StructuredQuestion = NonNullable<AgentRequest['questions']>[number]
export type PermissionChoice = NonNullable<AgentRequest['permissionChoices']>[number]

/** What an answer command carries beyond its owner and request identity. */
export interface RequestAnswer {
  readonly answer: string
  readonly approved?: boolean
  readonly questionAnswers?: AgentQuestionAnswers
  readonly permissionChoice?: string
}

/** One question's in-progress choice. `other` marks the free-text choice as picked. */
export interface QuestionSelection {
  readonly optionIds: readonly string[]
  readonly other: boolean
  readonly text: string
}

export const EMPTY_SELECTION: QuestionSelection = { optionIds: [], other: false, text: '' }

/** How the card renders a request: its questions inline, the native choices, or the legacy composer answer. */
export function requestMode(request: AgentRequest): 'structured' | 'permission' | 'legacy-options' | 'legacy-text' {
  if (request.kind === 'permission') return 'permission'
  if (request.questions && request.questions.length > 0) return 'structured'
  return request.options.length > 0 ? 'legacy-options' : 'legacy-text'
}

/** Questions that only take text have no Other choice to pick: their text is the answer. */
export function textOnly(question: StructuredQuestion): boolean {
  return question.options.length === 0
}

/** A native question is required unless the provider marked it otherwise. */
export function isRequired(question: StructuredQuestion): boolean {
  return question.required !== false
}

/** The provider asked for something Sotto cannot submit; its reason replaces the input. */
export function isUnavailable(question: StructuredQuestion): boolean {
  return question.unavailableReason !== undefined
}

export function pickOption(question: StructuredQuestion, selection: QuestionSelection, optionId: string, checked: boolean): QuestionSelection {
  if (isUnavailable(question) || !question.options.some(option => option.id === optionId)) return selection
  if (!question.multiSelect) return checked ? { ...selection, optionIds: [optionId], other: false } : selection
  const without = selection.optionIds.filter(id => id !== optionId)
  return { ...selection, optionIds: checked ? question.options.map(option => option.id).filter(id => id === optionId || without.includes(id)) : without }
}

export function pickOther(question: StructuredQuestion, selection: QuestionSelection, checked: boolean): QuestionSelection {
  if (isUnavailable(question) || !question.allowFreeText) return selection
  return question.multiSelect ? { ...selection, other: checked } : checked ? { ...selection, optionIds: [], other: true } : { ...selection, other: false }
}

/**
 * - empty: nothing picked or typed, which an optional question may send as is.
 * - partial: Other picked without its text; it blocks sending until finished or cleared.
 * - complete: an answer the provider can accept.
 */
export type AnswerProgress = 'empty' | 'partial' | 'complete'

export function answerProgress(question: StructuredQuestion, selection: QuestionSelection | undefined): AnswerProgress {
  if (!selection || isUnavailable(question)) return 'empty'
  const text = selection.text.trim().length > 0
  if (textOnly(question)) return question.allowFreeText && text ? 'complete' : 'empty'
  // A picked Other with no text is incomplete even when options are also chosen.
  if (selection.other && question.allowFreeText && !text) return 'partial'
  const known = selection.optionIds.some(id => question.options.some(option => option.id === id))
  return known || (question.allowFreeText && selection.other && text) ? 'complete' : 'empty'
}

export function isAnswered(question: StructuredQuestion, selection: QuestionSelection | undefined): boolean {
  return answerProgress(question, selection) === 'complete'
}

/** Whether this question still stands between the form and sending. */
export function blocksSending(question: StructuredQuestion, selection: QuestionSelection | undefined): boolean {
  const progress = answerProgress(question, selection)
  return progress === 'partial' || (progress === 'empty' && isRequired(question))
}

/** Every required question answered by its own ID, optional ones only when answered; null until then. */
export function buildQuestionAnswers(questions: readonly StructuredQuestion[], selections: Readonly<Record<string, QuestionSelection>>): AgentQuestionAnswers | null {
  const answers: Record<string, { optionIds: string[]; text?: string }> = {}
  for (const question of questions) {
    const selection = selections[question.id]
    if (blocksSending(question, selection)) return null
    if (!isAnswered(question, selection)) continue
    const text = selection!.text.trim()
    const useText = question.allowFreeText && text.length > 0 && (textOnly(question) || selection!.other)
    answers[question.id] = {
      optionIds: textOnly(question) ? [] : selection!.optionIds.filter(id => question.options.some(option => option.id === id)),
      ...(useText ? { text } : {}),
    }
  }
  return answers
}

export function structuredAnswer(questions: readonly StructuredQuestion[], selections: Readonly<Record<string, QuestionSelection>>): RequestAnswer | null {
  const questionAnswers = buildQuestionAnswers(questions, selections)
  return questionAnswers === null ? null : { answer: '', questionAnswers }
}

export function permissionAnswer(choice: PermissionChoice): RequestAnswer {
  return { answer: choice.label, approved: choice.kind.startsWith('allow-'), permissionChoice: choice.id }
}

/** Absent choices are a legacy Allow/Deny request; an explicit empty list means none of the native choices can be sent. */
export function hasNoSendableChoice(request: AgentRequest): boolean {
  return request.kind === 'permission' && request.permissionChoices !== undefined && request.permissionChoices.length === 0
}

export function legacyPermissionAnswer(approved: boolean): RequestAnswer {
  return { answer: approved ? 'Approved' : 'Denied', approved }
}

/** Title and body for a permission: the native tool context when present, otherwise the request text. */
export function permissionSummary(request: AgentRequest): { readonly title: string; readonly command?: string; readonly cwd?: string; readonly details?: string } {
  const [first = '', ...rest] = request.text.split('\n')
  const context = request.context
  const restText = rest.join('\n').trim()
  const title = first.trim() || (context?.toolName ? `Use ${context.toolName}` : 'Permission request')
  const command = context?.command ?? (restText && !context?.details ? restText : undefined)
  const details = context?.details && context.details.trim() !== command?.trim() ? context.details : undefined
  return { title, ...(command ? { command } : {}), ...(context?.cwd ? { cwd: context.cwd } : {}), ...(details ? { details } : {}) }
}

/**
 * How one answer attempt went, kept outside React so a pane losing focus, a split re-layout or leaving the page
 * cannot forget a selection or re-enable a request that was already sent.
 * - sending: dispatched, waiting for main.
 * - sent: main accepted; the card stays closed until the request leaves the snapshot.
 * - unconfirmed: the bridge gave no answer; it may have been delivered, so nothing is resent until checked.
 * - failed: main refused before dispatch; the request can be answered again.
 */
export type AnswerPhase = 'idle' | 'sending' | 'sent' | 'unconfirmed' | 'failed'

export interface RequestEntry {
  readonly selections: Readonly<Record<string, QuestionSelection>>
  readonly phase: AnswerPhase
  readonly error: string | null
  /** Which choice is being sent, for the pressed state. */
  readonly choice: string | null
}

const EMPTY_ENTRY: RequestEntry = { selections: {}, phase: 'idle', error: null, choice: null }

export type SubmitOutcome = { readonly error: string | null } | null

export class RequestAnswerStore {
  private readonly entries = new Map<string, RequestEntry>()
  private readonly listeners = new Set<() => void>()

  static key(ownerId: string, requestId: string): string { return `${ownerId}\0${requestId}` }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(ownerId: string, requestId: string): RequestEntry {
    return this.entries.get(RequestAnswerStore.key(ownerId, requestId)) ?? EMPTY_ENTRY
  }

  select(ownerId: string, requestId: string, questionId: string, selection: QuestionSelection): void {
    const entry = this.get(ownerId, requestId)
    if (entry.phase === 'sending' || entry.phase === 'sent' || entry.phase === 'unconfirmed') return
    this.set(ownerId, requestId, { ...entry, selections: { ...entry.selections, [questionId]: selection }, ...(entry.phase === 'failed' ? { phase: 'idle', error: null } : {}) })
  }

  /** Sends once: a second call while one is sending, sent or unconfirmed does nothing. */
  async submit(ownerId: string, requestId: string, choice: string | null, send: () => Promise<SubmitOutcome>): Promise<void> {
    const entry = this.get(ownerId, requestId)
    if (entry.phase === 'sending' || entry.phase === 'sent' || entry.phase === 'unconfirmed') return
    this.set(ownerId, requestId, { ...entry, phase: 'sending', error: null, choice })
    let outcome: SubmitOutcome
    try { outcome = await send() } catch { outcome = null }
    const current = this.get(ownerId, requestId)
    if (outcome === null) this.set(ownerId, requestId, { ...current, phase: 'unconfirmed', error: null })
    else if (outcome.error !== null) this.set(ownerId, requestId, { ...current, phase: 'failed', error: outcome.error, choice: null })
    else this.set(ownerId, requestId, { ...current, phase: 'sent', error: null })
  }

  /** After a successful re-read, a request main still offers without an uncertain delivery may be answered again. */
  release(ownerId: string, requestId: string): void {
    const entry = this.get(ownerId, requestId)
    if (entry.phase !== 'unconfirmed' && entry.phase !== 'sent') return
    this.set(ownerId, requestId, { ...entry, phase: 'idle', choice: null })
  }

  /** Forget answers for requests the owner no longer has. */
  prune(ownerId: string, liveRequestIds: readonly string[]): void {
    const prefix = `${ownerId}\0`
    let changed = false
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix) && !liveRequestIds.includes(key.slice(prefix.length))) { this.entries.delete(key); changed = true }
    }
    if (changed) this.emit()
  }

  private set(ownerId: string, requestId: string, entry: RequestEntry): void {
    this.entries.set(RequestAnswerStore.key(ownerId, requestId), entry)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

export const requestAnswerStore = new RequestAnswerStore()

export function useRequestEntry(ownerId: string, requestId: string, store: RequestAnswerStore = requestAnswerStore): RequestEntry {
  return useSyncExternalStore(store.subscribe, () => store.get(ownerId, requestId))
}
