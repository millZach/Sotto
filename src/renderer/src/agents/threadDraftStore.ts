import { useMemo, useSyncExternalStore } from 'react'
import type { AgentSkillReference } from '../../../shared/agentSkills'
import type { AgentFileReference } from '../../../shared/agentFiles'
import { MAX_DELIVERED_DRAFTS, agentAttachmentHandlesSchema, agentThreadDraftSchema, type AgentAttachmentHandle, type AgentCommand, type AgentDelivery, type AgentState } from '../../../shared/agents'
import { gateOnCreation } from './draftThreads'

type Command = (command: AgentCommand) => Promise<AgentState | null>

/** One revision of a thread's unsent composer content. A pristine empty composer has no revision ID. */
export interface ComposerDraft {
  readonly draftId: string
  readonly text: string
  readonly attachments: readonly AgentAttachmentHandle[]
  /** Skills the user picked whose `$name` is still in the text. */
  readonly skills: readonly AgentSkillReference[]
  /** Files the user mentioned whose `@path` is still in the text. */
  readonly files: readonly AgentFileReference[]
  readonly requestId: string | null
}

/** Screenshots being read for a thread's draft, which outlive the composer that started reading them. */
export interface ScreenshotReads {
  /** Reads under way for the draft, whichever composer started them. The thread cannot send until they land. */
  readonly pending: number
  /** Why screenshots that finished reading after their composer closed were not added, until the draft next changes. */
  readonly problem: string | null
}
const NO_SCREENSHOT_READS: ScreenshotReads = { pending: 0, problem: null }

/**
 * What a composer's screenshot input needs to know and say about reads that may outlive it. A thread's composer
 * gets one from its draft store (`useScreenshotReadPort`); the coordinator's composer counts its own reads.
 */
export interface ScreenshotReadPort {
  /** Screenshots an earlier composer started reading for this draft are still being read, so nothing more is added yet. */
  readonly pending: boolean
  /** What became of screenshots read after an earlier composer closed, shown until the draft next changes. */
  readonly problem: string | null
  /** Screenshots start being read. The function returned says they have been handed on, added or not. */
  begin(): () => void
  /**
   * Screenshots that finished after this composer closed, as it does when the user moves to another thread while
   * they are read, and why the rest were not, when one could not be read. Absent: they are dropped.
   */
  addLate?(images: readonly AgentAttachmentHandle[], failure: string | null): void
}

const counted = (count: number, one: string, many: string): string => count === 1 ? one : many.replace('#', String(count))
/** Why late screenshots were left out: the draft no longer takes screenshots at all, or had no room for them. */
function lateScreenshotsLeftOut(count: number, reason: 'answering' | 'unsupported' | 'full'): string {
  const which = counted(count, 'A screenshot added before you moved to another thread', '# screenshots added before you moved to another thread')
  const were = counted(count, 'was', 'were')
  if (reason === 'answering') return `${which} ${were} not added, because this draft now answers a question.`
  if (reason === 'unsupported') return `${which} ${were} not added, because this thread's model does not read screenshots.`
  return `${which} did not fit in this draft and ${were} not added. Remove an attachment and add ${counted(count, 'it', 'them')} again.`
}

export interface ThreadComposerSnapshot {
  readonly draft: ComposerDraft
  /** `saved` requires main's durability evidence for this exact revision. */
  readonly save: 'saved' | 'saving' | 'unsaved'
  readonly saveError: string | null
  /** Answer delivery belongs to the thread even when its composer is closed. Kept only in this window. */
  readonly answer: ComposerAnswerState
}

export interface ComposerAnswerState {
  readonly sending: boolean
  readonly error: string | null
}
const NO_ANSWER: ComposerAnswerState = { sending: false, error: null }

/**
 * How a revision left the composer. `send` and `steer` are provider deliveries shown in the transcript;
 * `queue` hands the revision to the thread's follow-up queue, which shows it instead.
 */
export type SubmissionMode = 'send' | 'queue' | 'steer'

/** What a submission says when its command settled without any answer from main. */
export const UNCONFIRMED_SUBMISSION: Record<SubmissionMode, string> = {
  send: 'Sotto could not confirm this send.',
  steer: 'Sotto could not confirm this steer.',
  queue: 'Sotto could not confirm this was queued.',
}

/**
 * A revision the user sent from this window. The composer empties on the press, so this is the only
 * copy of what was sent: it holds the images' handles, whose content main keeps for an hour after nothing else
 * owns it (ADR-0031), so a refused prompt can be sent or written again.
 */
export interface Submission {
  readonly threadId: string
  readonly draftId: string
  readonly mode: SubmissionMode
  readonly text: string
  readonly attachments: readonly AgentAttachmentHandle[]
  readonly skills: readonly AgentSkillReference[]
  /** Files this revision mentioned, when it mentioned any. */
  readonly files?: readonly AgentFileReference[]
  /** performance.now() at the keydown or click that sent it. */
  readonly submittedAt: number
  /** The same moment on the wall clock, which is where the thread's working line starts counting. */
  readonly startedAt: string
  /** The manual-send command promise settled; delivery truth still comes from state.deliveries. */
  readonly resolved: boolean
  readonly error: string | null
  /** A local prerequisite failed before manual-send was invoked. */
  readonly notSent?: boolean
  /** The revision this prompt went back to the composer as, when it was refused and nothing newer was written. */
  readonly restoredAs?: string
  /** Refused-creation overflow remains available until explicitly dismissed or delivered. */
  readonly recovered?: boolean
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

const EMPTY: ComposerDraft = { draftId: '', text: '', attachments: [], skills: [], files: [], requestId: null }
const recoveredContentSchema = agentThreadDraftSchema.pick({ text: true, attachments: true, skills: true, files: true })
const combineDrafts = (content: readonly Pick<ComposerDraft, 'text' | 'attachments' | 'skills' | 'files'>[]): ComposerDraft => ({ ...EMPTY,
  text: content.map(item => item.text).filter(text => text.trim()).join('\n\n'),
  attachments: [...new Map(content.flatMap(item => item.attachments).map(item => [item.id, item])).values()],
  skills: [...new Map(content.flatMap(item => item.skills).map(item => [JSON.stringify([item.name, item.path]), item])).values()],
  files: [...new Map(content.flatMap(item => item.files).map(item => [item.path, item])).values()],
})
/**
 * How many saves `place` makes before it stops waiting. Typing while the placed draft saves makes a newer revision,
 * which the next pass saves; someone still typing after three is left to the composer's own save, and the leftover
 * copy stays until a later move.
 */
const PLACE_SAVE_PASSES = 3
/** How a leftover draft went into a composer: saved there, not confirmed, or refused for passing one prompt's limits. */
export type PlaceResult = 'saved' | 'unsaved' | 'too-long'
const SAVE_ERROR = 'Could not confirm this draft was saved. Keep your text and images and try Save again.'
const key = (threadId: string, draftId: string): string => `${threadId}\n${draftId}`
const isEmpty = (draft: ComposerDraft): boolean => draft.text === '' && draft.attachments.length === 0
const persistence = (state: AgentState, threadId: string, draftId: string): ThreadComposerSnapshot['save'] =>
  state.threadDraftPersistence?.find(item => item.threadId === threadId && item.draftId === draftId)?.status ?? 'unsaved'

export function hasDraftContent(draft: ComposerDraft): boolean {
  return draft.text.trim() !== '' || draft.attachments.length > 0
}

/** The durable follow-up queue took this exact revision: ownership moved, nothing was delivered. */
export function queuedRevision(state: AgentState, threadId: string, draftId: string): boolean {
  if (!draftId) return false
  return state.followupReceipts?.some(item => item.threadId === threadId && item.draftId === draftId) === true
    || state.followups?.some(item => item.threadId === threadId && item.draftId === draftId) === true
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
  // A queued revision is echoed in the transcript from the press, until the durable queue owns it and echoes it itself.
  if (submission.mode === 'queue' || queuedRevision(state, submission.threadId, submission.draftId)) {
    // A queue admission main never answered proves nothing either way, so it is unconfirmed rather than
    // refused: refused is what puts the prompt back in the composer, and main may already own this one.
    const unconfirmed = submission.resolved && submission.error === UNCONFIRMED_SUBMISSION.queue && !submission.notSent
    return { status: submission.notSent || (submission.resolved && submission.error !== null && !unconfirmed) ? 'failed' : unconfirmed ? 'uncertain' : 'queued',
      visible: !queuedRevision(state, submission.threadId, submission.draftId) }
  }
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

/**
 * A queue admission this window is still waiting on, or one that did not go through.
 * It stays listed with the queue until the durable queue owns the revision or the user dismisses it.
 */
export function queueAdmissionOpen(submission: Submission, state: AgentState): boolean {
  return submission.mode === 'queue' && !queuedRevision(state, submission.threadId, submission.draftId)
}

export function deliveryPending(status: SubmissionStatus): boolean {
  return status === 'queued' || status === 'submitting' || status === 'uncertain'
}

/**
 * Per-thread composer drafts between the renderer and the durable `threadDrafts` state.
 *
 * Every edit is a new revision with a fresh UUID. Saves are debounced, flushed on
 * navigation and before an answer, and sent in order. A send, steer or queue carries its
 * revision to main, which saves it, so the window saves nothing in front of one. A published state only replaces
 * local content once that state has shown the local revision (or the revision was
 * accepted), so an older state can never overwrite newer typing.
 */
export class ThreadDraftStore {
  private readonly entries = new Map<string, Entry>()
  private readonly snapshots = new Map<string, ThreadComposerSnapshot>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<() => void>()
  private readonly accepted = new Set<string>()
  /** Prompts already offered back to their composer after a refusal; a second offer is the user's to ask for. */
  private readonly returnedPrompts = new Set<string>()
  private readonly legacyIds = new Map<string, string>()
  private readonly pendingSaves = new Map<string, Set<Promise<void>>>()
  private readonly handoffs = new Map<string, Promise<AgentState | null>>()
  private readonly reads = new Map<string, ScreenshotReads>()
  private readonly answers = new Map<string, ComposerAnswerState>()
  private submissionList: readonly Submission[] = []
  private readonly refusedDrafts = new Map<string, readonly ComposerDraft[]>()
  private readonly projectRecoveries = new Map<string, readonly string[]>()
  private readonly recoveryTargets = new Map<string, string>()
  private readonly recoveryThreads = new Set<string>()
  /** Every write waits for the creation of a thread this window minted, so a fresh thread's draft is never refused. */
  private readonly command: Command
  constructor(command: Command, private readonly debounceMs = 250, private readonly uuid: () => string = () => crypto.randomUUID()) {
    this.command = gateOnCreation(command)
  }

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
      answer: this.answers.get(threadId) ?? NO_ANSWER,
    }
    this.snapshots.set(threadId, value)
    return value
  }

  draft(threadId: string): ComposerDraft { return this.entries.get(threadId)?.draft ?? EMPTY }

  /** Nothing reached a refused creation: carry submitted revisions and newer typing back as one draft. */
  carryRefusedCreation(threadId: string, projectId: string): boolean {
    const draft = this.draft(threadId)
    const submissions = this.submissionList.filter(item => item.threadId === threadId)
    const kept = submissions.filter(item => item.restoredAs !== draft.draftId
      && (!item.recovered || !submissions.some(other => other.draftId === item.restoredAs)))
    const sent = [...kept.filter(item => !item.recovered), ...kept.filter(item => item.recovered)]
    this.refusedDrafts.set(threadId, [...sent.map(item => ({ ...item, files: item.files ?? [], requestId: null })), draft])
    this.projectRecoveries.set(projectId, [...new Set([...(this.projectRecoveries.get(projectId) ?? []), threadId])])
    return this.refusedDrafts.get(threadId)!.some(item => Boolean(item.text.trim() || item.attachments.length || item.skills.length || item.files?.length))
      || this.screenshotReads(threadId).pending > 0
  }

  /** Move recovery and any screenshot reads to the next thread, even after leaving the Threads page. */
  restoreRefusedCreation(threadId: string, projectId: string): void {
    const sources = this.projectRecoveries.get(projectId)
    if (!sources) return
    const targetDraft = this.draft(threadId)
    const alreadyCarried = this.refusedDrafts.get(threadId)?.some(draft => draft.draftId === targetDraft.draftId)
    const content = [...sources.flatMap(id => this.refusedDrafts.get(id)!), ...(alreadyCarried ? [] : [targetDraft])]
    // An unconfirmed creation can later appear in main and be reused as its own recovery target.
    this.recoveryTargets.delete(threadId)
    this.projectRecoveries.delete(projectId)
    this.submissionList = this.submissionList.filter(item => !sources.includes(item.threadId))
    this.recoveryThreads.add(threadId)
    this.restoreRecoveredDrafts(threadId, content)
    for (const sourceId of sources) {
      this.refusedDrafts.delete(sourceId)
      if (sourceId === threadId) continue
      const reads = this.screenshotReads(sourceId)
      const targetReads = this.screenshotReads(threadId)
      this.reads.delete(sourceId)
      this.recoveryTargets.set(sourceId, threadId)
      this.setScreenshotReads(threadId, { pending: reads.pending + targetReads.pending, problem: [targetReads.problem, reads.problem].filter(Boolean).join(' ') || null })
    }
  }

  /** Keep each recovery batch within the same limits as a saved or sent draft. Overflow stays visible. */
  private restoreRecoveredDrafts(threadId: string, content: readonly ComposerDraft[]): void {
    const batches: ComposerDraft[] = [EMPTY]
    for (const draft of content) {
      const merged = combineDrafts([batches.at(-1)!, draft])
      if (recoveredContentSchema.safeParse(merged).success) batches[batches.length - 1] = merged
      else batches.push(draft)
    }
    const previous = this.draft(threadId)
    const restoredAs = this.restoreDraft(threadId, batches[0]!)!
    const retained = this.submissionList.find(item => item.recovered && item.threadId === threadId && item.restoredAs === previous.draftId)
    if (retained) this.submissionList = this.submissionList.map(item => item === retained ? { ...item, ...batches[0]!, draftId: item.draftId, restoredAs } : item)
    if (batches.length === 1) { if (retained) this.emit(new Set([threadId])); return }
    for (const [index, batch] of batches.entries()) {
      // Late screenshots can overflow an already restored batch; keep its existing message once.
      if (index === 0 && retained) continue
      const draftId = this.uuid()
      this.submissionList = [...this.submissionList, { ...batch, threadId, draftId, mode: 'send', submittedAt: 0,
        startedAt: new Date().toISOString(), resolved: true, notSent: true, recovered: true,
        error: 'This prompt was kept after a new thread was refused. Use Restore prompt to bring it back. Nothing was sent.',
        ...(index === 0 ? { restoredAs } : {}) }]
    }
    this.emit(new Set([threadId]))
  }

  private recoveredThreadId(threadId: string): string {
    while (this.recoveryTargets.has(threadId)) threadId = this.recoveryTargets.get(threadId)!
    return threadId
  }

  setAnswerState(threadId: string, answer: ComposerAnswerState): void {
    this.answers.set(threadId, answer)
    this.emit(new Set([threadId]))
  }

  screenshotReads(threadId: string): ScreenshotReads { return this.reads.get(this.recoveredThreadId(threadId)) ?? NO_SCREENSHOT_READS }

  /**
   * Screenshots start being read for the thread's draft. The returned function says they have been handed on,
   * added or not; until then the thread's composer, open now or opened later, cannot send.
   */
  beginScreenshotRead(threadId: string): () => void {
    this.setScreenshotReads(threadId, { pending: this.screenshotReads(threadId).pending + 1, problem: null })
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const reads = this.screenshotReads(threadId)
      this.setScreenshotReads(threadId, { ...reads, pending: Math.max(0, reads.pending - 1) })
    }
  }

  /**
   * Screenshots that finished reading after the composer they were added to closed, as it does when the user
   * moves to another thread, and `failure` when one of them could not be read. As many as the draft takes, as it
   * is now, join it; the thread's screenshot problem names the rest, so none is lost without a word. A draft
   * that now answers a question, or a thread whose model does not read screenshots, takes none.
   */
  addLateScreenshots(threadId: string, images: readonly AgentAttachmentHandle[], { imagesSupported, failure = null }: { readonly imagesSupported: boolean; readonly failure?: string | null }): void {
    threadId = this.recoveredThreadId(threadId)
    const recovering = this.refusedDrafts.get(threadId)
    const draft = recovering?.at(-1) ?? this.draft(threadId)
    if (draft.requestId === null && imagesSupported && (recovering || this.recoveryThreads.has(threadId))) {
      const added = images.map(image => ({ ...EMPTY, attachments: [image] }))
      if (recovering) this.refusedDrafts.set(threadId, [...recovering, ...added])
      else this.restoreRecoveredDrafts(threadId, [draft, ...added])
      if (failure) this.reads.set(threadId, { ...this.screenshotReads(threadId), problem: failure })
      this.emit(new Set([threadId]))
      return
    }
    const before = draft.attachments
    const refusal = draft.requestId !== null ? 'answering' : !imagesSupported ? 'unsupported' : null
    let attachments = before
    let leftOut = 0
    for (const image of images) {
      const next = refusal === null ? agentAttachmentHandlesSchema.safeParse([...attachments, image]) : null
      if (next?.success) attachments = next.data
      else leftOut += 1
    }
    if (attachments !== before) {
      if (recovering) this.refusedDrafts.set(threadId, [...recovering.slice(0, -1), { ...draft, attachments }])
      else this.revise(threadId, { attachments })
    }
    const problems = [...(leftOut > 0 ? [lateScreenshotsLeftOut(leftOut, refusal ?? 'full')] : []), ...(failure ? [failure] : [])]
    if (problems.length > 0) this.reads.set(threadId, { ...this.screenshotReads(threadId), problem: problems.join(' ') })
    this.emit(new Set([threadId]))
  }

  /** The screenshot problem has been seen through: the user changed the draft or sent it. */
  private clearScreenshotProblem(threadId: string): void {
    const reads = this.reads.get(threadId)
    if (reads?.problem) this.setScreenshotReads(threadId, { ...reads, problem: null })
  }

  private setScreenshotReads(threadId: string, reads: ScreenshotReads): void {
    threadId = this.recoveredThreadId(threadId)
    if (reads.pending === 0 && reads.problem === null) this.reads.delete(threadId)
    else this.reads.set(threadId, reads)
    this.emit(new Set())
  }

  /** Adopt published drafts, delivery receipts and follow-up queue ownership. */
  receive(state: AgentState): void {
    for (const receipt of state.deliveredDrafts ?? []) this.markAccepted(receipt.threadId, receipt.draftId)
    // Queue ownership clears only that exact revision, exactly like a delivery receipt.
    for (const receipt of state.followupReceipts ?? []) this.markAccepted(receipt.threadId, receipt.draftId)
    for (const item of state.followups ?? []) this.markAccepted(item.threadId, item.draftId)
    for (const delivery of state.deliveries ?? []) if (delivery.status === 'accepted') this.markAccepted(delivery.threadId, delivery.draftId)
    const remote = new Map<string, ComposerDraft>()
    for (const item of state.threadDrafts ?? []) remote.set(item.threadId, { draftId: item.draftId, text: item.text, attachments: item.attachments, skills: item.skills ?? [], files: item.files ?? [], requestId: item.requestId })
    // Clears have no persisted content row, but still need exact-revision evidence
    // while a live controller is trying to remove the previous disk draft.
    for (const item of state.threadDraftPersistence ?? []) if (!remote.has(item.threadId)) remote.set(item.threadId, { ...EMPTY, draftId: item.draftId })
    if (state.threadDrafts === undefined && state.draftThreadId !== null && (state.draft || state.draftAttachments?.length)) {
      // Older state without per-thread drafts: the singleton belongs to its thread under a stable local revision.
      const legacy = key(state.draftThreadId, state.draft)
      if (!this.legacyIds.has(legacy)) this.legacyIds.set(legacy, this.uuid())
      remote.set(state.draftThreadId, { draftId: this.legacyIds.get(legacy)!, text: state.draft, attachments: state.draftAttachments ?? [], skills: [], files: [], requestId: state.draftRequestId })
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
    const pruned = this.submissionList.filter(item => {
      // Voice can send main's saved composer without a renderer submission. Its exact ownership
      // retires the retained alias too; failure or newer typing keeps the original recoverable.
      if (item.recovered && item.restoredAs && this.accepted.has(key(item.threadId, item.restoredAs))) return false
      return item.mode === 'queue' ? queueAdmissionOpen(item, state) : submissionStatus(item, state).visible
    })
    // Refused is the one outcome that proves nothing was sent, so the prompt comes back to an empty
    // composer. It is offered back once; typing since the press is never replaced without being asked.
    const returned = pruned.map(item => submissionStatus(item, state).status === 'failed' ? this.returnPrompt(item, changed) : item)
    const kept = new Set(pruned)
    const retiredThreads = new Set(this.submissionList.filter(item => !kept.has(item)).map(item => item.threadId))
    const submissionsChanged = pruned.length !== this.submissionList.length || returned.some((item, index) => item !== pruned[index])
    if (submissionsChanged) this.submissionList = returned
    // A submission retired here (the queue owning its revision) may never be resolved, so the emptied composer
    // it was holding back is saved once nothing else on its thread is unresolved.
    for (const threadId of retiredThreads) this.saveAfterSubmissions(threadId)
    if (changed.size || submissionsChanged) this.emit(changed)
  }

  /** A new revision of the thread's composer. */
  edit(threadId: string, patch: { readonly text?: string; readonly attachments?: readonly AgentAttachmentHandle[]; readonly skills?: readonly AgentSkillReference[]; readonly files?: readonly AgentFileReference[]; readonly requestId?: string | null }): void {
    if (this.answers.get(threadId)?.error) this.answers.delete(threadId)
    this.revise(threadId, patch)
    this.clearScreenshotProblem(threadId)
    this.emit(new Set([threadId]))
  }

  /**
   * Replace the thread's composer content with a new revision. `debounce` saves it after the debounce;
   * `after-submissions` leaves it for `saveAfterSubmissions`, once nothing the thread submitted is unresolved.
   * Sending uses it too: the composer starts a fresh empty revision on the press, so an older
   * published state can never put the sent text back (the new revision has not been observed).
   */
  private revise(threadId: string, patch: { readonly text?: string; readonly attachments?: readonly AgentAttachmentHandle[]; readonly skills?: readonly AgentSkillReference[]; readonly files?: readonly AgentFileReference[]; readonly requestId?: string | null }, save: 'debounce' | 'after-submissions' = 'debounce'): string {
    const entry = this.entries.get(threadId) ?? { draft: EMPTY, observed: true, saved: true, saving: null, error: null, superseded: [] }
    this.entries.set(threadId, entry)
    if (entry.draft.draftId) entry.superseded = [...entry.superseded.slice(-15), entry.draft.draftId]
    entry.draft = {
      draftId: this.uuid(),
      text: patch.text ?? entry.draft.text,
      attachments: patch.attachments ?? entry.draft.attachments,
      skills: patch.skills ?? entry.draft.skills,
      files: patch.files ?? entry.draft.files,
      requestId: patch.requestId === undefined ? entry.draft.requestId : patch.requestId,
    }
    entry.observed = false
    entry.saved = false
    entry.error = null
    const pending = this.timers.get(threadId)
    if (pending !== undefined) clearTimeout(pending)
    if (save === 'debounce') this.timers.set(threadId, setTimeout(() => this.flush(threadId), this.debounceMs))
    else this.timers.delete(threadId)
    return entry.draft.draftId
  }

  /** Save the thread's latest unsaved revision now (navigation, unmount, explicit retry). */
  flush(threadId: string, retry = false): void { void this.flushPending(threadId, retry) }

  private flushPending(threadId: string, retry = false): Promise<void> {
    const pending = this.timers.get(threadId)
    if (pending !== undefined) { clearTimeout(pending); this.timers.delete(threadId) }
    const entry = this.entries.get(threadId)
    const outstanding = (): Promise<void> => Promise.all(this.pendingSaves.get(threadId) ?? []).then(() => undefined)
    if (entry === undefined || entry.saved || !entry.draft.draftId) { if (pending !== undefined) this.emit(new Set([threadId])); return outstanding() }
    if (entry.saving === entry.draft.draftId && !retry) return outstanding()
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
      if (current.saved) current.observed = true
      current.error = current.saved || status === 'saving' ? null : SAVE_ERROR
      this.emit(new Set([threadId]))
    }
    let result: Promise<AgentState | null>
    try {
      result = this.command({ type: 'save-thread-draft', composer: 'manual', threadId, draftId: draft.draftId, text: draft.text, attachments: [...draft.attachments], ...(draft.skills.length ? { skills: [...draft.skills] } : {}), ...(draft.files.length ? { files: [...draft.files] } : {}), requestId: draft.requestId })
    } catch { result = Promise.resolve(null) }
    const task = result.then(settle, () => settle(null))
    const saves = this.pendingSaves.get(threadId) ?? new Set<Promise<void>>()
    this.pendingSaves.set(threadId, saves); saves.add(task)
    void task.finally(() => { saves.delete(task); if (!saves.size) this.pendingSaves.delete(threadId) })
    return task
  }

  /** Flush the latest revision and all earlier saves before the explicit Manage/Resume action.
   * Callers await success before focusing the managed composer; null retains local edits and saveError.
   * Keep competing composer/management actions disabled for this thread while this promise is pending.
   */
  handoffToManagement(threadId: string, action: 'assign' | 'resume'): Promise<AgentState | null> {
    const existing = this.handoffs.get(threadId)
    if (existing) return existing
    const task = (async (): Promise<AgentState | null> => {
      try {
        for (;;) {
          const revision = this.draft(threadId).draftId
          await this.flushPending(threadId)
          await Promise.all(this.pendingSaves.get(threadId) ?? [])
          if (this.draft(threadId).draftId !== revision) continue
          if (!this.entries.get(threadId)?.saved && revision) throw new Error(this.snapshot(threadId).saveError ?? SAVE_ERROR)
          const result = await this.command({ type: action, threadId, expectedDraftId: revision || null })
          if (result === null || result.error) throw new Error(result?.error ?? 'Management handoff could not be confirmed. Your draft is retained.')
          if (!result.assignments.some(item => item.threadId === threadId && item.mode === 'managed')) throw new Error('Management did not take this thread. Your draft is retained.')
          this.receive(result)
          return result
        }
      } catch (error) {
        const entry = this.entries.get(threadId) ?? { draft: EMPTY, observed: true, saved: true, saving: null, error: null, superseded: [] }
        entry.error = error instanceof Error ? error.message : SAVE_ERROR
        this.entries.set(threadId, entry); this.emit(new Set([threadId]))
        return null
      }
    })()
    this.handoffs.set(threadId, task)
    void task.finally(() => this.handoffs.delete(threadId))
    return task
  }

  flushAll(): void { for (const threadId of [...this.timers.keys()]) this.flush(threadId) }

  /** Whether every current composer revision has durability evidence right now. */
  canReload(): boolean {
    return [...this.entries.values()].every(entry => !entry.draft.draftId || entry.saved)
  }

  /** A deliberate window reload waits for durability evidence, including edits made while saving. */
  async flushForReload(): Promise<boolean> {
    for (;;) {
      const revisions = new Map([...this.entries].map(([id, entry]) => [id, entry.draft.draftId]))
      await Promise.all([...this.entries.keys()].map(id => this.flushPending(id)))
      if ([...this.entries].some(([id, entry]) => revisions.get(id) !== entry.draft.draftId)) continue
      return this.canReload()
    }
  }


  /**
   * Take the current revision out of the composer for sending, and start a fresh empty revision at once: the
   * press empties the composer, not the provider's acknowledgement.
   *
   * `savedBy` says who makes the submitted revision durable. `window`, the default, saves it now, as an edit is,
   * and saves the empty revision after the debounce; an answer uses it, because main keeps no draft for one.
   * `main` is a send, steer or queue: its command carries the revision and main saves it as it admits it, so the
   * window saves nothing in front of it. The pending debounce is dropped, so nothing older is saved after it, and
   * the empty revision is saved once the thread has no submission left unresolved (`saveAfterSubmissions`), so
   * the window's own draft saves stay out of the send. A save main or the window makes for another reason, such as
   * focus moving to another thread, still goes when it is asked for.
   */
  submit(threadId: string, submittedAt: number, mode: SubmissionMode = 'send', savedBy: 'main' | 'window' = 'window'): ComposerDraft | null {
    const entry = this.entries.get(threadId)
    if (entry === undefined || !hasDraftContent(entry.draft)) return null
    if (savedBy === 'window') this.flush(threadId)
    const draft = entry.draft
    // Once its restored revision is sent, that exact submission owns the recovery copy too.
    // Keep one retry ID while unresolved, then let delivery or queue ownership retire it.
    const recovered = this.submissionList.find(item => item.recovered && item.threadId === threadId && item.restoredAs === draft.draftId)
    const submission: Submission = {
      threadId, draftId: draft.draftId, mode, text: draft.text.trim(), submittedAt, startedAt: new Date().toISOString(), resolved: false, error: null,
      attachments: draft.attachments.map(attachment => ({ ...attachment })), skills: [...draft.skills], files: [...draft.files],
      ...(recovered ? { recovered: true } : {}),
    }
    const submissions = this.submissionList.filter(item => key(item.threadId, item.draftId) !== key(threadId, draft.draftId))
      .map(item => item === recovered ? submission : item)
    if (!recovered) submissions.push(submission)
    const recent = new Set(submissions.filter(item => !item.recovered).slice(-MAX_DELIVERED_DRAFTS))
    this.submissionList = submissions.filter(item => item.recovered || recent.has(item))
    this.revise(threadId, { text: '', attachments: [], skills: [], files: [], requestId: null }, savedBy === 'window' ? 'debounce' : 'after-submissions')
    this.clearScreenshotProblem(threadId)
    this.emit(new Set([threadId]))
    return draft
  }

  /**
   * Send a submitted prompt again from its own copy, with the same revision, so the provider can
   * never take it twice. A composer still holding the restored prompt empties again on the press.
   */
  retry(threadId: string, draftId: string, submittedAt: number): Submission | null {
    const submission = this.submissionList.find(item => item.threadId === threadId && item.draftId === draftId)
    if (submission === undefined) return null
    if (submission.restoredAs !== undefined && this.draft(threadId).draftId === submission.restoredAs) {
      // Like a press, the retried send carries its revision to main: the emptied composer waits for it to resolve.
      this.revise(threadId, { text: '', attachments: [], skills: [], files: [], requestId: null }, 'after-submissions')
    }
    // Sending it again is a fresh outcome: a second refusal may offer it back again.
    this.returnedPrompts.delete(key(threadId, draftId))
    // It is on its way, so it is no longer the prompt sitting in the composer.
    const { restoredAs, ...carried } = submission
    void restoredAs
    const next: Submission = { ...carried, submittedAt, startedAt: new Date().toISOString(), resolved: false, error: null, notSent: false }
    this.submissionList = this.submissionList.map(item => item === submission ? next : item)
    this.emit(new Set([threadId]))
    return next
  }

  /**
   * Write content back into the composer as a new revision. With `onlyWhenEmpty`, typing that
   * happened since the press is kept instead and the caller offers the restore as a choice.
   */
  restoreDraft(threadId: string, content: Pick<ComposerDraft, 'text' | 'attachments' | 'skills' | 'files' | 'requestId'>, onlyWhenEmpty = false): string | null {
    const draftId = this.putBack(threadId, content, onlyWhenEmpty)
    if (draftId !== null) this.emit(new Set([threadId]))
    return draftId
  }

  /**
   * Put a draft that no composer holds (a leftover draft, whose thread is gone) into this thread's composer, after
   * anything already written there, and save it at once. Resolves 'saved' only once main has saved the composer with
   * it, so the caller may let the original go; 'unsaved' leaves both, and nothing is lost either way. It may run
   * again for the same draft (a retry, a refused creation brought back, the same unused thread reused): words and
   * images the composer already holds are not added twice. 'too-long' writes nothing, because the two together pass
   * one prompt's limits and could never be saved. Typing that lands while it saves is a newer revision built on the
   * placed one, and is saved by the same call.
   */
  async place(threadId: string, content: Pick<ComposerDraft, 'text' | 'attachments'>): Promise<PlaceResult> {
    const current = this.draft(threadId)
    const carried = content.text.trim()
    const merged = combineDrafts([current, { ...EMPTY, ...content, text: carried === '' || current.text.includes(carried) ? '' : content.text }])
    if (!recoveredContentSchema.safeParse(merged).success) return 'too-long'
    const changed = merged.text !== current.text || merged.attachments.length !== current.attachments.length
    if (changed) this.restoreDraft(threadId, { ...merged, requestId: current.requestId })
    for (let pass = 0; pass < PLACE_SAVE_PASSES; pass += 1) {
      await this.flushPending(threadId)
      const entry = this.entries.get(threadId)
      if (entry === undefined || entry.error !== null) return 'unsaved'
      if (entry.saved) return 'saved'
    }
    return 'unsaved'
  }

  private putBack(threadId: string, content: Pick<ComposerDraft, 'text' | 'attachments' | 'skills' | 'files' | 'requestId'>, onlyWhenEmpty: boolean): string | null {
    if (onlyWhenEmpty && hasDraftContent(this.draft(threadId))) return null
    return this.revise(threadId, { text: content.text, attachments: [...content.attachments], skills: [...content.skills], files: [...content.files], requestId: content.requestId })
  }

  /** Put a submitted prompt back in the composer, replacing whatever is written there. */
  restore(threadId: string, draftId: string): void {
    const submission = this.submissionList.find(item => item.threadId === threadId && item.draftId === draftId)
    if (submission === undefined) return
    this.returnedPrompts.add(key(threadId, draftId))
    const restoredAs = this.putBack(threadId, { ...submission, files: submission.files ?? [], requestId: null }, false)
    this.submissionList = this.submissionList.map(item => item === submission ? { ...item, ...(restoredAs === null ? {} : { restoredAs }) } : item)
    this.emit(new Set([threadId]))
  }

  resolve(threadId: string, draftId: string, error: string | null, notSent = false): void {
    let found = false
    const changed = new Set<string>()
    this.submissionList = this.submissionList.map(item => {
      if (item.threadId !== threadId || item.draftId !== draftId) return item
      found = true
      const settled: Submission = { ...item, resolved: true, error, notSent }
      // A prompt that never left the window is refused on this evidence alone, and so is a queue
      // admission main answered: the queue writes no delivery record. A direct send waits for its
      // record, which is what tells a refusal from silence.
      const refused = notSent || item.mode === 'queue' && error !== null && error !== UNCONFIRMED_SUBMISSION.queue
      return refused ? this.returnPrompt(settled, changed) : settled
    })
    // Called whether or not it was found: a published state may have retired the submission first (the queue
    // owning its revision), and the emptied composer is still owed its save.
    this.saveAfterSubmissions(threadId)
    if (found) this.emit(changed)
  }

  /**
   * The empty revision a send left in the composer, saved once nothing the thread submitted is unresolved. Main
   * saved the sent revision itself; this only records that the composer was emptied, and after a delivered send
   * main already holds no draft for the thread, so the save usually writes nothing.
   */
  private saveAfterSubmissions(threadId: string): void {
    const entry = this.entries.get(threadId)
    // A save still running for the sent revision does not count: only one of this revision does.
    if (entry === undefined || entry.saved || entry.saving === entry.draft.draftId || !entry.draft.draftId || !isEmpty(entry.draft) || this.timers.has(threadId)) return
    if (this.submissionList.some(item => item.threadId === threadId && !item.resolved)) return
    this.timers.set(threadId, setTimeout(() => this.flush(threadId), this.debounceMs))
  }

  /** Offer a refused prompt back to its composer, once, and only while nothing newer is written there. */
  private returnPrompt(submission: Submission, changed: Set<string>): Submission {
    const id = key(submission.threadId, submission.draftId)
    if (submission.recovered || this.returnedPrompts.has(id)) return submission
    this.returnedPrompts.add(id)
    if (this.returnedPrompts.size > MAX_DELIVERED_DRAFTS * 4) this.returnedPrompts.delete(this.returnedPrompts.values().next().value!)
    const restoredAs = this.putBack(submission.threadId, { ...submission, files: submission.files ?? [], requestId: null }, true)
    if (restoredAs === null) return submission
    changed.add(submission.threadId)
    return { ...submission, restoredAs }
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
    if (entry.draft.draftId && entry.draft.draftId !== draft.draftId) entry.superseded = [...entry.superseded.slice(-15), entry.draft.draftId]
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

export function useScreenshotReads(store: ThreadDraftStore, threadId: string): ScreenshotReads {
  return useSyncExternalStore(store.subscribe, () => store.screenshotReads(threadId))
}

/**
 * The thread's screenshot reads as its composer's screenshot input takes them. `imagesSupported` is whether the
 * thread's model reads screenshots, which decides whether screenshots that land after the composer closed are added.
 */
export function useScreenshotReadPort(store: ThreadDraftStore, threadId: string, imagesSupported: boolean): ScreenshotReadPort {
  const reads = useScreenshotReads(store, threadId)
  return useMemo(() => ({
    pending: reads.pending > 0,
    problem: reads.problem,
    begin: () => store.beginScreenshotRead(threadId),
    addLate: (images, failure) => store.addLateScreenshots(threadId, images, { imagesSupported, failure }),
  }), [store, threadId, imagesSupported, reads])
}

export function useSubmissions(store: ThreadDraftStore): readonly Submission[] {
  return useSyncExternalStore(store.subscribe, store.submissions)
}
