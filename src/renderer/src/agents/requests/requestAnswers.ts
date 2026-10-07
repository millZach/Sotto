import { useEffect, useSyncExternalStore } from 'react'
import type { AgentQuestionAnswers, AgentRequest } from '../../../../shared/agents'
import { requestDraftQuestions, requestDraftKey, requestDraftOwnerKey, requestDraftSchema, sameRequestQuestions, type RequestDraftBridge, type RequestDraftCheckResult, type RequestDraftOwner, type RequestDraftStatus, type RequestDraftTarget } from '../../../../shared/requestDrafts'

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
  readonly revision: number
  readonly save: 'saved' | 'saving' | 'unsaved' | 'loading'
  readonly saveError: string | null
}

const EMPTY_ENTRY: RequestEntry = { selections: {}, phase: 'idle', error: null, choice: null, revision: 0, save: 'saved', saveError: null }
const SAVE_ERROR = 'Could not confirm this answer draft was saved. Keep this window open and try Save again.'
const draftError = (error: unknown): string => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : SAVE_ERROR

/** Include the question definition: a provider reusing IDs must never inherit another form's answers. */
export function requestAnswerOwnerKey(ownerId: string, request: AgentRequest, owner?: RequestDraftOwner): string {
  const questions = requestDraftQuestions(request)
  return owner && questions.length > 0 ? `${requestDraftOwnerKey(owner)}\0${JSON.stringify(questions)}` : ownerId
}

interface DraftBinding {
  readonly target: RequestDraftTarget
  readonly bridge: RequestDraftBridge
  loading: Promise<void> | null
  retiring: Promise<void> | null
  writing: Promise<boolean>
  loaded: boolean
  statusRead: number
  generation: number
  offChanged: (() => void) | null
  reofferedRevision?: number
  accepted?: Extract<RequestDraftStatus, { status: 'accepted' }>
}

export type SubmitOutcome = { readonly error: string | null } | null

export class RequestAnswerStore {
  private readonly entries = new Map<string, RequestEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly bindings = new Map<string, DraftBinding>()
  constructor(private readonly bridge: () => RequestDraftBridge | undefined = () => window.sotto?.requestDrafts) {}

  static key(ownerId: string, requestId: string): string { return `${ownerId}\0${requestId}` }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(ownerId: string, requestId: string): RequestEntry {
    return this.entries.get(RequestAnswerStore.key(ownerId, requestId)) ?? EMPTY_ENTRY
  }

  /** A reload must not discard a bound answer whose latest revision has no save acknowledgement. */
  canReload(): boolean {
    return [...this.bindings.keys()].every(key => this.entries.get(key)?.save === 'saved')
  }

  /** Save retained local answers even when their live cards (and Save actions) have gone away. */
  async flushForReload(): Promise<boolean> {
    for (;;) {
      const revisions = new Map([...this.bindings.keys()].map(key => [key, this.entries.get(key)?.revision]))
      await Promise.all([...this.bindings].map(async ([key, binding]) => {
        await binding.loading
        await binding.writing
        if (this.entries.get(key)?.save === 'saved') return
        const split = key.lastIndexOf('\0')
        await this.flush(key.slice(0, split), key.slice(split + 1))
      }))
      if ([...this.bindings.keys()].some(key => revisions.get(key) !== this.entries.get(key)?.revision)) continue
      return this.canReload()
    }
  }

  /** Stable recovery status for this owner's bindings, including ones a remounted view never saw live. */
  recoverySnapshot(owner: RequestDraftOwner, live: readonly AgentRequest[]): string {
    const ownerKey = requestDraftOwnerKey(owner)
    return JSON.stringify([...this.bindings].flatMap(([key, binding]) => {
      if (requestDraftOwnerKey(binding.target) !== ownerKey || live.some(request => request.id === binding.target.requestId
        && sameRequestQuestions(requestDraftQuestions(request), binding.target.questions))) return []
      const entry = this.entries.get(key) ?? EMPTY_ENTRY
      return [[key, entry.save === 'saving' || entry.save === 'loading' ? 'pending' : entry.revision, entry.save, entry.phase]]
    }))
  }

  connect(ownerId: string, requestId: string, target: RequestDraftTarget, reoffered = false): Promise<void> {
    const key = RequestAnswerStore.key(ownerId, requestId), bridge = this.bridge()
    if (!bridge) return Promise.resolve()
    const existing = this.bindings.get(key)
    if (existing?.retiring) return existing.retiring.then(() => this.connect(ownerId, requestId, target, reoffered))
    if (existing?.loaded && !reoffered) return Promise.resolve()
    if (existing?.loading && !reoffered) return existing.loading
    const binding: DraftBinding = existing ?? { target, bridge, loading: null, retiring: null, writing: Promise.resolve(true), loaded: false,
      statusRead: 0, generation: 0, offChanged: null }
    this.bindings.set(key, binding)
    const before = this.get(ownerId, requestId)
    if (!binding.loaded) this.set(ownerId, requestId, { ...before, save: 'loading', saveError: null })
    this.watch(ownerId, requestId, binding)
    const load = this.readStatus(ownerId, requestId, binding).finally(() => { if (binding.loading === load) binding.loading = null })
    binding.loading = load
    return load
  }

  private watch(ownerId: string, requestId: string, binding: DraftBinding): void {
    if (binding.offChanged) return
    const key = RequestAnswerStore.key(ownerId, requestId)
    binding.offChanged = binding.bridge.onChanged?.(owner => {
      if (requestDraftOwnerKey(owner) === requestDraftOwnerKey(binding.target) && this.bindings.get(key) === binding) {
        void this.readStatus(ownerId, requestId, binding)
      }
    }) ?? null
  }

  /** Owner changes read durable status only; Check is reserved for an explicit release. */
  private async readStatus(ownerId: string, requestId: string, binding: DraftBinding): Promise<void> {
    const read = ++binding.statusRead, restoring = !binding.loaded, before = this.get(ownerId, requestId)
    const currentRead = (): boolean => this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) === binding && read === binding.statusRead
    try {
      const status = await binding.bridge.status(binding.target)
      if (!currentRead()) return
      const current = this.get(ownerId, requestId)
      if (status.status === 'draft' && requestDraftKey(status.draft.target) !== requestDraftKey(binding.target)) {
        throw new Error('The saved answer belongs to a different question. Reload the original answer before editing.')
      }
      if (status.status === 'unconfirmed') {
        // A native re-offer starts a new delivery boundary even when the provider reuses
        // the form and request ID. Delivered selections belong to the older attempt.
        binding.loaded = true
        if (current.revision > status.revision) {
          if (restoring) this.set(ownerId, requestId, { ...current, save: 'unsaved', saveError: SAVE_ERROR })
          return
        }
        if (binding.reofferedRevision !== status.revision) {
          binding.reofferedRevision = status.revision
          binding.generation++
        }
        const edited = (current.phase === 'idle' || current.phase === 'failed') && current.revision > 0
        this.set(ownerId, requestId, { ...current, selections: edited ? current.selections : {},
          revision: status.revision + Number(edited), phase: edited ? current.phase : 'unconfirmed',
          error: null, choice: null, save: edited ? 'unsaved' : 'saved', saveError: null })
        this.watch(ownerId, requestId, binding)
        return
      }
      if (status.status === 'accepted') {
        if (status.revision <= (binding.reofferedRevision ?? 0)) return
        const pristine = !binding.loaded && current.revision === 0 && current.phase === 'idle' && Object.keys(current.selections).length === 0
        if (pristine || current.revision === status.revision && (current.phase === 'sending' || current.phase === 'sent' || current.phase === 'unconfirmed')) {
          this.accepted(ownerId, requestId, binding, status)
          binding.loaded = true
          return
        }
        if (!binding.accepted || status.revision > binding.accepted.revision) binding.accepted = status
      }
      if (status.status === 'draft' && this.isAccepted(ownerId, requestId, binding) && status.draft.revision > current.revision) {
        binding.generation++
        this.set(ownerId, requestId, { ...current, selections: status.draft.selections, revision: status.draft.revision,
          phase: status.draft.held ? 'unconfirmed' : 'idle', error: null, choice: null, save: 'saved', saveError: null })
        this.watch(ownerId, requestId, binding)
        return
      }
      if (!restoring || binding.loaded) return
      const draft = status.status === 'draft' ? status.draft : null
      binding.loaded = true
      // Edits made while a read was pending win per question. Normal controls wait for this initial read.
      const edited = current.revision !== before.revision || before.revision > 0
      this.set(ownerId, requestId, { ...current,
        selections: edited ? { ...draft?.selections, ...current.selections } : draft?.selections ?? current.selections,
        revision: edited ? Math.max(current.revision, draft?.revision ?? (status.status === 'accepted' ? status.revision : 0)) + 1 : draft?.revision ?? current.revision,
        phase: draft?.held ? 'unconfirmed' : current.phase,
        save: edited ? 'saving' : 'saved', saveError: null,
      })
    } catch (error) {
      if (currentRead() && restoring && !this.isAccepted(ownerId, requestId, binding)) {
        this.set(ownerId, requestId, { ...this.get(ownerId, requestId), save: 'unsaved', saveError: draftError(error) })
      }
    }
  }

  private isAccepted(ownerId: string, requestId: string, binding: DraftBinding): boolean {
    const current = this.get(ownerId, requestId)
    return current.phase === 'sent' && binding.accepted?.revision === current.revision
  }

  private accepted(ownerId: string, requestId: string, binding: DraftBinding, proof: Extract<RequestDraftStatus, { status: 'accepted' }>): void {
    if (proof.revision <= (binding.reofferedRevision ?? 0) || binding.accepted && binding.accepted.revision > proof.revision) return
    binding.accepted = proof
    binding.offChanged?.()
    binding.offChanged = null
    this.set(ownerId, requestId, { ...this.get(ownerId, requestId), revision: proof.revision,
      phase: 'sent', error: null, choice: null, save: 'saved', saveError: null })
  }

  select(ownerId: string, requestId: string, questionId: string, selection: QuestionSelection): void {
    const entry = this.get(ownerId, requestId)
    if (entry.phase === 'sending' || entry.phase === 'sent' || entry.phase === 'unconfirmed') return
    this.set(ownerId, requestId, { ...entry, revision: entry.revision + 1, selections: { ...entry.selections, [questionId]: selection }, ...(entry.phase === 'failed' ? { phase: 'idle', error: null } : {}) })
    void this.flush(ownerId, requestId)
  }

  /** Each edit queues immediately, independent of pane lifetime. Only its own atomic acknowledgement marks it saved. */
  async flush(ownerId: string, requestId: string): Promise<boolean> {
    const binding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
    if (!binding) return true
    if (!binding.loaded) {
      await this.connect(ownerId, requestId, binding.target)
      if (!binding.loaded) return false
      // A successful restore already proves durability when no local edits were made.
      if (this.get(ownerId, requestId).save === 'saved') return true
    }
    if (this.isAccepted(ownerId, requestId, binding)) return true
    const entry = this.get(ownerId, requestId)
    const parsed = requestDraftSchema.safeParse({ target: binding.target, revision: Math.max(1, entry.revision),
      selections: Object.fromEntries(Object.entries(entry.selections).map(([id, selection]) => [id, { ...selection, optionIds: [...selection.optionIds] }])),
      held: entry.phase === 'sending' || entry.phase === 'sent' || entry.phase === 'unconfirmed' })
    if (!parsed.success) {
      this.set(ownerId, requestId, { ...entry, save: 'unsaved', saveError: 'This answer could not be saved. Use the offered choices and at most 24,000 characters per answer.' })
      return false
    }
    const draft = parsed.data
    const generation = binding.generation
    this.set(ownerId, requestId, { ...entry, revision: draft.revision, save: 'saving', saveError: null })
    const work = binding.writing.then(async () => {
      if (generation !== binding.generation) return true
      if (this.isAccepted(ownerId, requestId, binding) && draft.revision <= binding.accepted!.revision) return true
      try {
        const saved = await binding.bridge.save(draft)
        if (generation !== binding.generation) return true
        if (saved.revision !== draft.revision || JSON.stringify(saved) !== JSON.stringify(draft)) throw new Error(SAVE_ERROR)
        const current = this.get(ownerId, requestId)
        if (current.revision === draft.revision) this.set(ownerId, requestId, { ...current, save: 'saved', saveError: null })
        return true
      } catch (error) {
        if (generation !== binding.generation) return true
        const current = this.get(ownerId, requestId)
        if (this.isAccepted(ownerId, requestId, binding) && draft.revision <= current.revision) return true
        if (current.revision === draft.revision) this.set(ownerId, requestId, { ...current, save: 'unsaved', saveError: draftError(error) })
        return false
      }
    })
    binding.writing = work
    return work
  }

  /** Sends once: a second call while one is sending, sent or unconfirmed does nothing. */
  async submit(ownerId: string, requestId: string, choice: string | null, send: () => Promise<SubmitOutcome>): Promise<void> {
    const entry = this.get(ownerId, requestId)
    const submittedBinding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
    const submittedGeneration = submittedBinding?.generation
    if (entry.phase === 'sending' || entry.phase === 'sent' || entry.phase === 'unconfirmed') return
    const sending: RequestEntry = { ...entry, revision: entry.revision + 1, phase: 'sending', error: null, choice }
    this.set(ownerId, requestId, sending)
    if (this.bindings.has(RequestAnswerStore.key(ownerId, requestId)) && !await this.flush(ownerId, requestId)) {
      // A lost save acknowledgement might have persisted the hold. Main must check it before any delivery.
      if (submittedBinding && (submittedBinding.generation !== submittedGeneration || this.isAccepted(ownerId, requestId, submittedBinding))) return
      this.set(ownerId, requestId, { ...this.get(ownerId, requestId), phase: 'unconfirmed', error: 'This answer was not sent because its draft could not be saved. Check again after storage is available.' })
      return
    }
    if (submittedBinding && (submittedBinding.generation !== submittedGeneration || this.isAccepted(ownerId, requestId, submittedBinding))) return
    const submittedRevision = this.get(ownerId, requestId).revision
    let outcome: SubmitOutcome
    try { outcome = await send() } catch { outcome = null }
    const current = this.get(ownerId, requestId)
    // A departed unbound request may already have been pruned or its ID reused while this reply waited.
    if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) !== submittedBinding || (!submittedBinding && current !== sending)
      || current.revision !== submittedRevision || submittedBinding && (submittedBinding.generation !== submittedGeneration || this.isAccepted(ownerId, requestId, submittedBinding))) return
    if (outcome === null) this.set(ownerId, requestId, { ...current, phase: 'unconfirmed', error: null })
    else if (outcome.error !== null) {
      const binding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
      if (binding) {
        // A command error alone is not evidence of nondelivery. Main checks the original request/intent.
        const checkedRevision = this.get(ownerId, requestId).revision
        const checkedGeneration = binding.generation
        try {
          const draft = await binding.bridge.check(binding.target)
          if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) !== binding
            || binding.generation !== checkedGeneration || this.get(ownerId, requestId).revision !== checkedRevision || this.isAccepted(ownerId, requestId, binding)) return
          await this.checked(ownerId, requestId, draft, 'failed', outcome.error)
        } catch {
          if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) === binding
            && binding.generation === checkedGeneration && this.get(ownerId, requestId).revision === checkedRevision && !this.isAccepted(ownerId, requestId, binding)) this.set(ownerId, requestId, { ...this.get(ownerId, requestId), phase: 'unconfirmed', error: outcome.error })
        }
      } else this.set(ownerId, requestId, { ...current, phase: 'failed', error: outcome.error, choice: null })
    }
    else this.set(ownerId, requestId, { ...current, phase: 'sent', error: null })
  }

  /** After a successful re-read, a request main still offers without an uncertain delivery may be answered again. */
  async release(ownerId: string, requestId: string, reread?: () => Promise<boolean>): Promise<void> {
    const entry = this.get(ownerId, requestId)
    const binding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
    // Bound Check captures the attempt before its own native refresh. A separate read could
    // retire accepted evidence first. Requests without saved forms keep their provider read.
    if (!binding && reread) {
      try { if (!await reread()) return } catch { return }
      if (this.get(ownerId, requestId) !== entry || this.bindings.has(RequestAnswerStore.key(ownerId, requestId))) return
    }
    if (entry.phase !== 'unconfirmed' && entry.phase !== 'sent'
      && !(binding && reread && (entry.phase === 'idle' || entry.phase === 'failed'))) return
    if (binding) {
      let checkedRevision = entry.revision
      let checkedGeneration = binding.generation
      try {
        await binding.loading
        if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) !== binding) return
        checkedRevision = this.get(ownerId, requestId).revision
        checkedGeneration = binding.generation
        const priorAcceptance = this.isAccepted(ownerId, requestId, binding) ? binding.accepted : undefined
        const draft = await binding.bridge.check(binding.target)
        if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) !== binding
          || binding.generation !== checkedGeneration || this.get(ownerId, requestId).revision !== checkedRevision
          || this.isAccepted(ownerId, requestId, binding) && !(priorAcceptance && binding.accepted === priorAcceptance
            && draft.status === 'editable' && draft.draft && draft.draft.revision > checkedRevision)) return
        await this.checked(ownerId, requestId, draft, 'idle', null)
      } catch (error) {
        if (this.bindings.get(RequestAnswerStore.key(ownerId, requestId)) === binding
          && binding.generation === checkedGeneration && this.get(ownerId, requestId).revision === checkedRevision && !this.isAccepted(ownerId, requestId, binding)) this.set(ownerId, requestId, { ...this.get(ownerId, requestId), saveError: draftError(error) })
      }
      return
    }
    this.set(ownerId, requestId, { ...entry, phase: 'idle', choice: null })
  }

  private async checked(ownerId: string, requestId: string, result: RequestDraftCheckResult, phase: 'idle' | 'failed', error: string | null): Promise<void> {
    const current = this.get(ownerId, requestId)
    if (result.status === 'accepted') {
      // Acceptance retires this revision in main. Saving it again would recreate delivered
      // text as an unsent answer. Older proof cannot settle or save newer local edits.
      const accepted = result.revision === current.revision
      const binding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
      if (accepted && binding) { this.accepted(ownerId, requestId, binding, result); return }
      this.set(ownerId, requestId, { ...current, phase: accepted ? 'sent' : phase, error: accepted ? null : error, choice: null,
        ...(accepted ? { save: 'saved', saveError: null } : {}) })
      return
    }
    const draft = result.draft
    const binding = this.bindings.get(RequestAnswerStore.key(ownerId, requestId))
    if (draft && requestDraftKey(draft.target) !== requestDraftKey(binding?.target ?? draft.target)) throw new Error('The saved answer belongs to a different question. Reload the original answer before editing.')
    if (draft && binding && this.isAccepted(ownerId, requestId, binding) && draft.revision > current.revision) {
      binding.generation++
      this.set(ownerId, requestId, { ...current, selections: draft.selections, revision: draft.revision,
        phase, error, choice: null, save: 'saved', saveError: null })
      this.watch(ownerId, requestId, binding)
      return
    }
    // Checking delivery is not proof that newer local content was saved. A failed preflight can leave
    // only an older revision (or nothing) in main; retain the local edit and persist it after release.
    const needsSave = !draft || draft.revision < current.revision || JSON.stringify(draft.selections) !== JSON.stringify(current.selections)
    this.set(ownerId, requestId, { ...current, phase, error, choice: null,
      revision: needsSave ? Math.max(current.revision, draft?.revision ?? 0) + 1 : draft.revision,
      save: needsSave ? 'saving' : 'saved', saveError: null })
    if (binding) this.watch(ownerId, requestId, binding)
    if (needsSave) await this.flush(ownerId, requestId)
  }

  /** Forget answers for requests the owner no longer has. */
  prune(ownerId: string, live: readonly AgentRequest[]): void {
    const prefix = `${ownerId}\0`
    let changed = false
    for (const key of [...this.entries.keys()]) {
      // Renderer snapshots are not authoritative. Durable records are retired only by main.
      if (!this.bindings.has(key) && key.startsWith(prefix) && !live.some(request => request.id === key.slice(prefix.length))) { this.entries.delete(key); changed = true }
    }
    for (const [key, binding] of this.bindings) {
      if (binding.target.kind !== 'thread' || binding.target.ownerId !== ownerId || binding.retiring
        || live.some(request => request.id === binding.target.requestId && sameRequestQuestions(requestDraftQuestions(request), binding.target.questions))) continue
      // A missing card alone retires nothing. Main must confirm that its saved draft is gone.
      binding.retiring = this.retire(key, binding).finally(() => { binding.retiring = null })
    }
    if (changed) this.emit()
  }

  private async retire(key: string, binding: DraftBinding): Promise<void> {
    await binding.loading
    await binding.writing
    const entry = this.entries.get(key)
    if (!entry || entry.save !== 'saved') return
    try {
      const status = await binding.bridge.status(binding.target)
      const current = this.entries.get(key)
      if (status.status === 'draft' || status.status === 'unconfirmed' || current?.save !== 'saved' || current.revision !== entry.revision || this.bindings.get(key) !== binding) return
      binding.offChanged?.()
      binding.statusRead++
      this.entries.delete(key)
      this.bindings.delete(key)
      this.emit()
    } catch {
      // An unreadable owner or storage is not evidence of retirement; retain its local recovery state.
    }
  }

  private set(ownerId: string, requestId: string, entry: RequestEntry): void {
    this.entries.set(RequestAnswerStore.key(ownerId, requestId), entry)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

export const requestAnswerStore = new RequestAnswerStore()

export function useRequestEntry(ownerId: string, requestId: string, store: RequestAnswerStore = requestAnswerStore, target?: RequestDraftTarget,
  nativeOffer?: 'uncertain' | 'retry-ready'): RequestEntry {
  const targetKey = target ? JSON.stringify(target) : ''
  useEffect(() => { if (targetKey) void store.connect(ownerId, requestId, JSON.parse(targetKey) as RequestDraftTarget, nativeOffer !== undefined) }, [ownerId, requestId, store, targetKey, nativeOffer])
  return useSyncExternalStore(store.subscribe, () => store.get(ownerId, requestId))
}
