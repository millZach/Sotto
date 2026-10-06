import { readFile, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { personalAnswerHeld, type PersonalChatState } from '../../shared/personalChats'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import {
  requestDraftQuestions, requestDraftKey, requestDraftSchema, requestDraftTargetSchema, requestDraftOwnerSchema, requestDraftOwnerKey, requestDraftDiscardSchema, requestQuestionsSignature, sameRequestQuestions,
  type RequestDraft, type RequestDraftOwner, type RequestDraftTarget, type RequestDraftDiscard, type RequestDraftCheckResult,
} from '../../shared/requestDrafts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const savedSchema = z.object({ version: z.literal(1), drafts: z.array(requestDraftSchema) }).strict()
  .refine(saved => new Set(saved.drafts.map(draft => requestDraftKey(draft.target))).size === saved.drafts.length, 'Draft identities must be unique.')
type Saved = z.infer<typeof savedSchema>
const unreadable = 'Answer draft storage could not be read. The original request-drafts.json is unchanged. Repair it and restart before saving answers.'
const saveFailed = 'Could not save this answer draft. Keep this window open and try Save again.'
export const requestQuestionsDigest = (questions: NonNullable<AgentRequest['questions']>): string => createHash('sha256').update(requestQuestionsSignature(questions)).digest('hex')

export type BindRequestDraftDecision = (target: RequestDraftTarget, decisionId: string, answers: AgentQuestionAnswers | undefined) => Promise<void>

export interface RequestDraftOwnerState {
  readonly connected: boolean
  readonly ready: boolean
  readonly requests: readonly AgentRequest[]
  readonly uncertainRequestIds?: readonly string[]
  readonly completed?: readonly { readonly requestId: string; readonly questionsDigest?: string; readonly decisionId?: string }[]
}

/** Shared production projection: legacy redacted decisions deliberately have no digest fallback. */
export function personalRequestDraftState(state: PersonalChatState, owner: RequestDraftOwner): RequestDraftOwnerState | undefined {
  const chat = state.chats.find(item => owner.kind === 'personal' && item.id === owner.ownerId && item.providerId === owner.providerId)
  return chat ? { connected: chat.connected === true, ready: chat.historyStatus !== 'loading' && chat.historyStatus !== 'error',
    requests: chat.requests,
    uncertainRequestIds: [...new Set((chat.decisions ?? []).map(item => item.requestId))].filter(id => personalAnswerHeld(chat, id)),
    completed: (chat.decisions ?? []).filter(item => item.status === 'accepted').map(item => ({ requestId: item.requestId,
      decisionId: item.id, ...(item.questionsDigest ? { questionsDigest: item.questionsDigest } : {}) })) } : undefined
}

/** Unsent question answers have their own durable aggregate, independent of both composers and history.
 * It never submits an answer. Native delivery and request liveness remain main-owned evidence.
 */
export class RequestDraftService {
  private saved: Saved = { version: 1, drafts: [] }
  private readonly store: Pick<AtomicJsonStore<Saved>, 'write'>
  private readonly path: string
  private storageError: string | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(owner: RequestDraftOwner) => void>()

  constructor(directory: string, private readonly lookup: (owner: RequestDraftOwner) => RequestDraftOwnerState | undefined,
    private readonly refresh: (target: RequestDraftTarget) => Promise<void>,
    store?: Pick<AtomicJsonStore<Saved>, 'write'>) {
    this.path = join(directory, 'request-drafts.json')
    this.store = store ?? new AtomicJsonStore(this.path, savedSchema.parse, () => ({ version: 1, drafts: [] }))
  }

  async start(): Promise<void> {
    // Do not use read()/peek(): invalid input must never become an empty, writable store or a plaintext backup.
    try { this.saved = savedSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = unreadable }
    if (this.storageError) return
    // A process killed during atomic replacement can leave its old unsent snapshot beside the file.
    // Once the primary is readable, discard only this store's abandoned copies, including submitted text.
    const directory = dirname(this.path)
    try {
      for (const name of await readdir(directory)) {
        if (/^request-drafts\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) await unlink(join(directory, name))
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = unreadable }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.writing.catch(() => undefined).then(async () => {
      if (this.storageError) throw new Error(this.storageError)
      return operation()
    })
    this.writing = work
    return work
  }

  onChanged(listener: (owner: RequestDraftOwner) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async commit(drafts: RequestDraft[]): Promise<void> {
    const next = savedSchema.parse({ version: 1, drafts })
    const before = new Map(this.saved.drafts.map(draft => [requestDraftKey(draft.target), JSON.stringify(draft)]))
    const after = new Map(next.drafts.map(draft => [requestDraftKey(draft.target), JSON.stringify(draft)]))
    const changed = new Map<string, RequestDraftOwner>()
    for (const draft of [...this.saved.drafts, ...next.drafts]) {
      const key = requestDraftKey(draft.target)
      if (before.get(key) === after.get(key)) continue
      const { kind, ownerId, providerId } = draft.target
      const owner = { kind, ownerId, providerId }
      changed.set(requestDraftOwnerKey(owner), owner)
    }
    try { await this.store.write(next) } catch { throw new Error(saveFailed) }
    this.saved = next
    for (const owner of changed.values()) for (const listener of this.listeners) {
      // A failed window notification cannot turn a successful durable write into a failed save.
      try { listener(owner) } catch { /* the window lists again when it mounts */ }
    }
  }

  private current(target: RequestDraftTarget): RequestDraft | undefined {
    return this.saved.drafts.find(draft => requestDraftKey(draft.target) === requestDraftKey(target))
  }

  private offered(target: RequestDraftTarget): boolean {
    const state = this.lookup(target)
    return !!state?.connected && state.ready && !state.uncertainRequestIds?.includes(target.requestId)
      && state.requests.some(request => request.id === target.requestId && request.delivery !== 'uncertain'
        && sameRequestQuestions(requestDraftQuestions(request), target.questions))
  }

  /** Only positive acceptance of the exact bound native attempt can erase held content.
   * Disappearance, changed definitions and legacy receipts are recovery evidence, not acceptance. */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const drafts = this.saved.drafts.filter(draft => !draft.held || !draft.decisionId
        || !this.lookup(draft.target)?.completed?.some(item => item.requestId === draft.target.requestId
          && item.decisionId === draft.decisionId && item.questionsDigest === requestQuestionsDigest(draft.target.questions)))
      if (drafts.length !== this.saved.drafts.length) await this.commit(drafts)
    })
  }

  /** Main's read-only recovery work, bounded by saved drafts rather than the host's thread archive. */
  heldThreadAnswers(): Promise<RequestDraft[]> {
    return this.serial(async () => structuredClone(this.saved.drafts.filter(draft => draft.target.kind === 'thread'
      && draft.held && draft.decisionId)))
  }

  list(input: RequestDraftOwner): Promise<RequestDraft[]> {
    const owner = requestDraftOwnerSchema.parse(input)
    return this.serial(async () => this.lookup(owner)
      ? structuredClone(this.saved.drafts.filter(draft => requestDraftOwnerKey(draft.target) === requestDraftOwnerKey(owner))) : [])
  }

  discard(input: RequestDraftDiscard): Promise<boolean> {
    const { target, revision } = requestDraftDiscardSchema.parse(input)
    return this.serial(async () => {
      if (!this.lookup(target)) throw new Error('This answer owner is unavailable.')
      const previous = this.current(target)
      if (!previous) return false
      if (previous.revision !== revision) throw new Error('A newer answer draft may be saved. Reload retained answers before discarding.')
      await this.commit(this.saved.drafts.filter(draft => draft !== previous))
      return true
    })
  }

  /** Main only: bind the persisted held form before the native write. No answer content enters receipts. */
  bindDecision(target: RequestDraftTarget, decisionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    return this.serial(async () => {
      const previous = this.current(target)
      if (!previous?.held || !this.lookup(target) || !answers) return
      // A delayed older answer IPC must not bind whichever newer held text is now saved.
      // Compare in memory only; receipts still contain no answer text or answer digests.
      const submitted: AgentQuestionAnswers = {}
      for (const question of previous.target.questions) {
        const selection = previous.selections[question.id]
        if (!selection) continue
        const text = question.allowFreeText && (question.options.length === 0 || selection.other) ? selection.text.trim() : ''
        if (selection.optionIds.length || text) submitted[question.id] = { optionIds: selection.optionIds, ...(text ? { text } : {}) }
      }
      const canonical = (value: AgentQuestionAnswers): string => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([id, answer]) => [id, [...answer.optionIds].sort(), answer.text ?? '']))
      if (canonical(submitted) !== canonical(answers)) return
      if (previous.decisionId && previous.decisionId !== decisionId) throw new Error('This answer already belongs to another delivery attempt. Check it before retrying.')
      await this.commit(this.saved.drafts.map(draft => draft === previous ? { ...previous, decisionId } : draft))
    })
  }

  get(input: RequestDraftTarget): Promise<RequestDraft | null> {
    const target = requestDraftTargetSchema.parse(input)
    return this.serial(async () => {
      const draft = this.current(target)
      return this.lookup(target) && draft && sameRequestQuestions(draft.target.questions, target.questions) ? structuredClone(draft) : null
    })
  }

  save(input: RequestDraft): Promise<RequestDraft> {
    const draft = requestDraftSchema.parse(input)
    return this.serial(async () => {
      const previous = this.current(draft.target), state = this.lookup(draft.target)
      if (draft.decisionId !== previous?.decisionId) throw new Error('Delivery identity is owned by main. Reload this answer before saving.')
      if (!state) throw new Error('This answer belongs to a request that is no longer available.')
      // Native liveness gates a held submission below, not local text retention. Even the first
      // keystroke's queued save can arrive after a question closes; keep it for explicit recovery.
      if (previous && sameRequestQuestions(previous.target.questions, draft.target.questions)) {
        if (draft.revision < previous.revision || draft.revision === previous.revision && JSON.stringify(draft) !== JSON.stringify(previous)) {
          throw new Error('A newer answer draft is already saved. Your local answer has been kept.')
        }
        if (draft.revision === previous.revision) return structuredClone(previous)
        if (previous.held && !draft.held) throw new Error('Check this answer with the provider before editing it again.')
        if (previous.held && JSON.stringify(draft.selections) !== JSON.stringify(previous.selections)) throw new Error('Check this answer before changing a held revision.')
      }
      if (draft.held && !this.offered(draft.target)) throw new Error('Reconnect and check this question before sending your answer.')
      await this.commit([...this.saved.drafts.filter(item => requestDraftKey(item.target) !== requestDraftKey(draft.target)), draft])
      return structuredClone(draft)
    })
  }

  async check(input: RequestDraftTarget): Promise<RequestDraftCheckResult> {
    const target = requestDraftTargetSchema.parse(input)
    // Capture the attempt before refresh can publish acceptance and reconcile its saved hold.
    const captured = await this.serial(async () => {
      const draft = this.current(target)
      return draft ? structuredClone(draft) : null
    })
    // A renderer's cached snapshot/observe subscription is not a fresh native read.
    // The read can publish snapshots, so it must run outside the disk-write lane.
    await this.refresh(target)
    return this.serial(async () => {
      const previous = this.current(target)
      if (previous && (!captured || previous.revision !== captured.revision
        || previous.decisionId !== captured.decisionId || previous.held !== captured.held)) {
        throw new Error('A newer answer draft is saved. Check the current answer again.')
      }
      if (captured?.held && captured.decisionId
        && this.lookup(target)?.completed?.some(item => item.requestId === target.requestId
          && item.decisionId === captured.decisionId && item.questionsDigest === requestQuestionsDigest(target.questions))) {
        if (previous) await this.commit(this.saved.drafts.filter(item => item !== previous))
        return { status: 'accepted', decisionId: captured.decisionId, revision: captured.revision }
      }
      if (!this.offered(target)) throw new Error('This answer is still unconfirmed. Reconnect and check the original request.')
      if (!previous) return { status: 'editable', draft: null }
      if (!previous.held) return { status: 'editable', draft: structuredClone(previous) }
      const { decisionId, ...editable } = previous
      void decisionId
      const next = { ...editable, revision: previous.revision + 1, held: false }
      await this.commit(this.saved.drafts.map(item => item === previous ? next : item))
      return { status: 'editable', draft: structuredClone(next) }
    })
  }
}
