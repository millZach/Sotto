import { useSyncExternalStore } from 'react'
import { MAX_DELIVERED_DRAFTS, type AgentAttachment, type AgentCommand, type AgentDelivery, type AgentState } from '../../../shared/agents'

type Command = (command: AgentCommand) => Promise<AgentState | null>

/** One revision of a thread's unsent composer content. A pristine empty composer has no revision ID. */
export interface ComposerDraft {
  readonly draftId: string
  readonly text: string
  readonly attachments: readonly AgentAttachment[]
  readonly requestId: string | null
}

export interface ThreadComposerSnapshot {
  readonly draft: ComposerDraft
  /** `saved` requires main's durability evidence for this exact revision. */
  readonly save: 'saved' | 'saving' | 'unsaved'
  readonly saveError: string | null
}

/** A revision the user sent from this window; the text is kept only in memory for the pending message. */
export interface Submission {
  readonly threadId: string
  readonly draftId: string
  readonly text: string
  readonly attachments: readonly { readonly id: string; readonly name: string }[]
  /** performance.now() at the keydown or click that sent it. */
  readonly submittedAt: number
  /** The manual-send command promise settled; delivery truth still comes from state.deliveries. */
  readonly resolved: boolean
  readonly error: string | null
  /** A local prerequisite failed before manual-send was invoked. */
  readonly notSent?: boolean
}

export type SubmissionStatus = AgentDelivery['status']

interface Entry {
  draft: ComposerDraft
  /** A published state has shown this exact revision, so later states are newer than the edit. */
  observed: boolean
  /**
   * Main has confirmed persistence for this exact revision.
   * A state echo alone is not proof: the controller publishes a draft before persisting it.
   */
  saved: boolean
  saving: string | null
  error: string | null
  superseded: string[]
}

const EMPTY: ComposerDraft = { draftId: '', text: '', attachments: [], requestId: null }
const SAVE_ERROR = 'Could not confirm this draft was saved. Keep your text and images and try Save again.'
const key = (threadId: string, draftId: string): string => `${threadId}\n${draftId}`
const isEmpty = (draft: ComposerDraft): boolean => draft.text === '' && draft.attachments.length === 0
const persistence = (state: AgentState, threadId: string, draftId: string): ThreadComposerSnapshot['save'] =>
  state.threadDraftPersistence?.find(item => item.threadId === threadId && item.draftId === draftId)?.status ?? 'unsaved'

export function hasDraftContent(draft: ComposerDraft): boolean {
  return draft.text.trim() !== '' || draft.attachments.length > 0
}

/** The newest delivery record for one revision. */
export function deliveryFor(state: AgentState, threadId: string, draftId: string): AgentDelivery | undefined {
  if (!draftId) return undefined
  return state.deliveries?.findLast(item => item.threadId === threadId && item.draftId === draftId)
}

/**
 * What the pending message says. Only an exact accepted delivery (or receipt) counts as sent;
 * a settled command promise without delivery evidence leaves the outcome uncertain.
 */
export function submissionStatus(submission: Submission, state: AgentState): { readonly status: SubmissionStatus; readonly visible: boolean } {
  const delivery = deliveryFor(state, submission.threadId, submission.draftId)
  const receipt = state.deliveredDrafts?.some(item => item.threadId === submission.threadId && item.draftId === submission.draftId) === true
  if (receipt || delivery?.status === 'accepted') {
    const thread = state.host.threads.find(item => item.id === submission.threadId)
    const shown = delivery?.messageId === undefined || thread?.messages.some(message => message.id === delivery.messageId) === true
    return { status: 'accepted', visible: !shown }
  }
  if (delivery) return { status: delivery.status, visible: true }
  return { status: submission.notSent ? 'failed' : submission.resolved ? 'uncertain' : 'queued', visible: true }
}

export function deliveryPending(status: SubmissionStatus): boolean {
  return status === 'queued' || status === 'submitting' || status === 'uncertain'
}

/**
 * Per-thread composer drafts between the renderer and the durable `threadDrafts` state.
 *
 * Every edit is a new revision with a fresh UUID. Saves are debounced, flushed on
 * navigation and before sending, and sent in order. A published state only replaces
 * local content once that state has shown the local revision (or the revision was
 * accepted), so an older state can never overwrite newer typing.
 */
export class ThreadDraftStore {
  private readonly entries = new Map<string, Entry>()
  private readonly snapshots = new Map<string, ThreadComposerSnapshot>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<() => void>()
  private readonly accepted = new Set<string>()
  private readonly legacyIds = new Map<string, string>()
  private submissionList: readonly Submission[] = []
  constructor(private readonly command: Command, private readonly debounceMs = 250, private readonly uuid: () => string = () => crypto.randomUUID()) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly submissions = (): readonly Submission[] => this.submissionList

  snapshot(threadId: string): ThreadComposerSnapshot {
    const cached = this.snapshots.get(threadId)
    if (cached) return cached
    const entry = this.entries.get(threadId)
    const draft = entry?.draft ?? EMPTY
    const value: ThreadComposerSnapshot = {
      draft,
      save: entry === undefined || entry.saved ? 'saved' : entry.error !== null ? 'unsaved' : 'saving',
      saveError: entry?.error ?? null,
    }
    this.snapshots.set(threadId, value)
    return value
  }

  draft(threadId: string): ComposerDraft { return this.entries.get(threadId)?.draft ?? EMPTY }

  /** Adopt published drafts and delivery receipts. */
  receive(state: AgentState): void {
    for (const receipt of state.deliveredDrafts ?? []) this.markAccepted(receipt.threadId, receipt.draftId)
    for (const delivery of state.deliveries ?? []) if (delivery.status === 'accepted') this.markAccepted(delivery.threadId, delivery.draftId)
    const remote = new Map<string, ComposerDraft>()
    for (const item of state.threadDrafts ?? []) remote.set(item.threadId, { draftId: item.draftId, text: item.text, attachments: item.attachments, requestId: item.requestId })
    // Clears have no persisted content row, but still need exact-revision evidence
    // while a live controller is trying to remove the previous disk draft.
    for (const item of state.threadDraftPersistence ?? []) if (!remote.has(item.threadId)) remote.set(item.threadId, { ...EMPTY, draftId: item.draftId })
    if (state.threadDrafts === undefined && state.draftThreadId !== null && (state.draft || state.draftAttachments?.length)) {
      // Older state without per-thread drafts: the singleton belongs to its thread under a stable local revision.
      const legacy = key(state.draftThreadId, state.draft)
      if (!this.legacyIds.has(legacy)) this.legacyIds.set(legacy, this.uuid())
      remote.set(state.draftThreadId, { draftId: this.legacyIds.get(legacy)!, text: state.draft, attachments: state.draftAttachments ?? [], requestId: state.draftRequestId })
    }
    const changed = new Set<string>()
    for (const threadId of new Set([...this.entries.keys(), ...remote.keys()])) {
      const entry = this.entries.get(threadId)
      const published = remote.get(threadId)
      const status = published ? persistence(state, threadId, published.draftId) : 'saved'
      if (entry === undefined) {
        if (published) {
          const adopted: Entry = { draft: published, observed: true, saved: false, saving: null, error: null, superseded: [] }
          this.replace(adopted, published, status)
          this.entries.set(threadId, adopted); changed.add(threadId)
        }
        continue
      }
      const current = entry.draft
      if (current.draftId !== '' && this.accepted.has(key(threadId, current.draftId))) {
        // The composer still holds exactly the delivered revision; never clear anything newer.
        const next = published && published.draftId !== current.draftId ? published : EMPTY
        this.replace(entry, next, next === EMPTY ? 'saved' : status)
        changed.add(threadId)
        continue
      }
      const shown = published ? published.draftId === current.draftId : isEmpty(current)
      if (shown) {
        if (!entry.observed) { entry.observed = true; changed.add(threadId) }
        if (published && (status === 'saved' || !entry.saved)) {
          // A local in-flight request can precede main's first evidence. Once
          // confirmed, a late failed response cannot revoke that confirmation.
          const error = status === 'unsaved' && entry.saving !== current.draftId ? SAVE_ERROR : null
          if (entry.saved !== (status === 'saved') || entry.error !== error) {
            entry.saved = status === 'saved'; entry.error = error; changed.add(threadId)
          }
        }
        continue
      }
      if (!entry.observed) continue
      if (published && entry.superseded.includes(published.draftId)) continue
      this.replace(entry, published ?? EMPTY, status)
      changed.add(threadId)
    }
    const pruned = this.submissionList.filter(item => submissionStatus(item, state).visible)
    const submissionsChanged = pruned.length !== this.submissionList.length
    if (submissionsChanged) this.submissionList = pruned
    if (changed.size || submissionsChanged) this.emit(changed)
  }

  /** A new revision of the thread's composer. */
  edit(threadId: string, patch: { readonly text?: string; readonly attachments?: readonly AgentAttachment[]; readonly requestId?: string | null }): void {
    const entry = this.entries.get(threadId) ?? { draft: EMPTY, observed: true, saved: true, saving: null, error: null, superseded: [] }
    this.entries.set(threadId, entry)
    if (entry.draft.draftId) entry.superseded = [...entry.superseded.slice(-15), entry.draft.draftId]
    entry.draft = {
      draftId: this.uuid(),
      text: patch.text ?? entry.draft.text,
      attachments: patch.attachments ?? entry.draft.attachments,
      requestId: patch.requestId === undefined ? entry.draft.requestId : patch.requestId,
    }
    entry.observed = false
    entry.saved = false
    entry.error = null
    const pending = this.timers.get(threadId)
    if (pending !== undefined) clearTimeout(pending)
    this.timers.set(threadId, setTimeout(() => this.flush(threadId), this.debounceMs))
    this.emit(new Set([threadId]))
  }

  /** Save the thread's latest unsaved revision now (navigation, unmount, explicit retry). */
  flush(threadId: string, retry = false): void {
    const pending = this.timers.get(threadId)
    if (pending !== undefined) { clearTimeout(pending); this.timers.delete(threadId) }
    const entry = this.entries.get(threadId)
    if (entry === undefined || entry.saved || !entry.draft.draftId) { if (pending !== undefined) this.emit(new Set([threadId])); return }
    if (entry.saving === entry.draft.draftId && !retry) return
    const draft = entry.draft
    entry.saving = draft.draftId
    entry.error = null
    this.emit(new Set([threadId]))
    const settle = (result: AgentState | null): void => {
      const current = this.entries.get(threadId)
      if (current?.draft.draftId !== draft.draftId) return
      current.saving = null
      const status = result === null ? 'unsaved' : persistence(result, threadId, draft.draftId)
      current.saved ||= status === 'saved'
      current.error = current.saved || status === 'saving' ? null : SAVE_ERROR
      this.emit(new Set([threadId]))
    }
    this.command({ type: 'save-thread-draft', threadId, draftId: draft.draftId, text: draft.text, attachments: [...draft.attachments], requestId: draft.requestId })
      .then(settle, () => settle(null))
  }

  flushAll(): void { for (const threadId of [...this.timers.keys()]) this.flush(threadId) }

  /**
   * Capture the current revision for sending. The pending debounce is replaced by an
   * immediate save of this same revision, so nothing older can be saved after it.
   */
  submit(threadId: string, submittedAt: number): ComposerDraft | null {
    const entry = this.entries.get(threadId)
    if (entry === undefined || !hasDraftContent(entry.draft)) return null
    this.flush(threadId)
    const draft = entry.draft
    const submission: Submission = {
      threadId, draftId: draft.draftId, text: draft.text.trim(), submittedAt, resolved: false, error: null,
      attachments: draft.attachments.map(({ id, name }) => ({ id, name })),
    }
    this.submissionList = [...this.submissionList.filter(item => key(item.threadId, item.draftId) !== key(threadId, draft.draftId)), submission].slice(-MAX_DELIVERED_DRAFTS)
    this.emit(new Set())
    return draft
  }

  resolve(threadId: string, draftId: string, error: string | null, notSent = false): void {
    let found = false
    this.submissionList = this.submissionList.map(item => {
      if (item.threadId !== threadId || item.draftId !== draftId) return item
      found = true
      return { ...item, resolved: true, error, notSent }
    })
    if (found) this.emit(new Set())
  }

  dismiss(threadId: string, draftId: string): void {
    this.submissionList = this.submissionList.filter(item => item.threadId !== threadId || item.draftId !== draftId)
    this.emit(new Set())
  }

  private markAccepted(threadId: string, draftId: string): void {
    this.accepted.add(key(threadId, draftId))
    if (this.accepted.size > MAX_DELIVERED_DRAFTS * 4) this.accepted.delete(this.accepted.values().next().value!)
  }

  private replace(entry: Entry, draft: ComposerDraft, status: ThreadComposerSnapshot['save']): void {
    entry.draft = draft
    entry.observed = true
    entry.saved = status === 'saved'
    entry.saving = null
    entry.error = status === 'unsaved' ? SAVE_ERROR : null
  }

  private emit(threads: ReadonlySet<string>): void {
    for (const threadId of threads) this.snapshots.delete(threadId)
    for (const listener of this.listeners) listener()
  }
}

export function useThreadComposer(store: ThreadDraftStore, threadId: string): ThreadComposerSnapshot {
  return useSyncExternalStore(store.subscribe, () => store.snapshot(threadId))
}

export function useSubmissions(store: ThreadDraftStore): readonly Submission[] {
  return useSyncExternalStore(store.subscribe, store.submissions)
}
