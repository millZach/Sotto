import { readFile, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AgentQuestionAnswers, AgentRequest } from '../../shared/agents'
import {
  requestDraftQuestions, requestDraftKey, requestDraftSchema, requestDraftTargetSchema, requestDraftOwnerSchema, requestDraftOwnerKey, requestDraftDiscardSchema, requestQuestionsSignature, sameRequestQuestions,
  type RequestDraft, type RequestDraftOwner, type RequestDraftTarget, type RequestDraftDiscard, type RequestDraftCheckResult, type RequestDraftStatus,
} from '../../shared/requestDrafts'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const retirementSchema = z.object({ owner: requestDraftOwnerSchema, requestId: requestDraftTargetSchema.shape.requestId,
  questionsDigest: z.string().regex(/^[a-f0-9]{64}$/u), decisionId: requestDraftSchema.shape.decisionId.unwrap(),
  revision: requestDraftSchema.shape.revision }).strict()
type Retirement = z.infer<typeof retirementSchema>
const retirementKey = (item: Pick<Retirement, 'owner' | 'requestId' | 'questionsDigest'>): string =>
  JSON.stringify([requestDraftOwnerKey(item.owner), item.requestId, item.questionsDigest])
const { retirements: ledgerField, ...unledgeredFields } = { version: z.literal(2), drafts: z.array(requestDraftSchema),
  retirements: z.array(retirementSchema).max(1536), watcherOwners: z.array(requestDraftOwnerSchema).optional(),
  unclassifiedOwners: z.array(requestDraftOwnerSchema).optional() }
const uniqueDrafts = (saved: { drafts: readonly RequestDraft[] }): boolean => new Set(saved.drafts.map(draft => requestDraftKey(draft.target))).size === saved.drafts.length
const savedSchema = z.object({ ...unledgeredFields, retirements: ledgerField }).strict()
  .refine(uniqueDrafts, 'Draft identities must be unique.')
  .refine(saved => new Set(saved.retirements.map(retirementKey)).size === saved.retirements.length, 'Retirement identities must be unique.')
/** Everything but the ledger, for a commit that keeps the ledger it was already checked with. */
const unledgeredSchema = z.object(unledgeredFields).strict().refine(uniqueDrafts, 'Draft identities must be unique.')
type Saved = z.infer<typeof savedSchema>
/** The ledger looked up by identity: each retirement by its key, and each owner it names by owner ID with its first place. */
interface LedgerIndex {
  readonly retirements: readonly Retirement[]
  readonly byKey: ReadonlyMap<string, Retirement>
  readonly owners: ReadonlyMap<string, readonly { readonly key: string; readonly owner: RequestDraftOwner; readonly first: number }[]>
}
const loadedSchema = z.union([savedSchema, z.object({ version: z.literal(1), drafts: savedSchema.shape.drafts,
  // The unshipped v1 extension is read strictly too, so its accepted records survive this migration.
  retirements: savedSchema.shape.retirements.max(512).default([]), watcherOwners: savedSchema.shape.watcherOwners, unclassifiedOwners: savedSchema.shape.unclassifiedOwners }).strict()])
const parseSaved = (input: unknown): Saved => {
  const saved = loadedSchema.parse(input)
  return savedSchema.parse({ ...saved, version: 2 })
}
const unreadable = 'Answer draft storage could not be read. The original request-drafts.json is unchanged. Repair it and restart before saving answers.'
const saveFailed = 'Could not save this answer draft. Keep this window open and try Save again.'
const privacyFailed = 'Local history is off, but retired submitted answers could not be removed. Nothing was changed. Restore local storage access and save Settings again.'
export const requestQuestionsDigest = (questions: NonNullable<AgentRequest['questions']>): string => createHash('sha256').update(requestQuestionsSignature(questions)).digest('hex')

export type BindRequestDraftDecision = (target: RequestDraftTarget, decisionId: string, answers: AgentQuestionAnswers | undefined) => Promise<void>

export interface RequestDraftOwnerState {
  /** Main classifies the saved owner; a renderer cannot supply this evidence. */
  readonly watcher?: boolean
  readonly connected: boolean
  readonly ready: boolean
  readonly requests: readonly AgentRequest[]
  readonly uncertainRequestIds?: readonly string[]
  readonly completed?: readonly { readonly requestId: string; readonly questionsDigest?: string; readonly decisionId?: string }[]
}

/** Unsent question answers have their own durable aggregate, independent of both composers and history.
 * It never submits an answer. Native delivery and request liveness remain main-owned evidence.
 */
export class RequestDraftService {
  private saved: Saved = { version: 2, drafts: [], retirements: [] }
  private readonly store: Pick<AtomicJsonStore<Saved>, 'write'>
  private readonly path: string
  private storageError: string | null = null
  private writing: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(owner: RequestDraftOwner) => void>()
  /** Built from the saved ledger when it changes, and replaced with it: it holds no owner the ledger does not name. */
  private ledgerIndex: LedgerIndex | undefined

  /**
   * `watcherOwnerIds` names every owner ID whose thread `lookup` could find to be Watcher, or `preserveOwner` could keep,
   * now. Naming more costs a lookup each; naming fewer would lose a Watcher owner. Without it every commit looks up every
   * retirement's thread, which with a few hundred answered questions was half of main's time (#1230).
   */
  constructor(directory: string, private readonly lookup: (owner: RequestDraftOwner) => RequestDraftOwnerState | undefined,
    private readonly refresh: (target: RequestDraftTarget, decisionId?: string) => Promise<void>,
    store?: Pick<AtomicJsonStore<Saved>, 'write'>,
    private readonly preserveOwner?: (owner: RequestDraftOwner) => boolean | undefined,
    private readonly watcherOwnerIds?: () => Iterable<string>) {
    this.path = join(directory, 'request-drafts.json')
    this.store = store ?? new AtomicJsonStore(this.path, parseSaved, () => ({ version: 2, drafts: [], retirements: [] }))
  }

  async start(): Promise<void> {
    // Do not use read()/peek(): invalid input must never become an empty, writable store or a plaintext backup.
    try { this.saved = parseSaved(JSON.parse(await readFile(this.path, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = unreadable }
    if (this.storageError) return
    // A process killed during atomic replacement can leave its old unsent snapshot beside the file.
    // Once the primary is readable, discard only this store's abandoned copies, including submitted text.
    const directory = dirname(this.path)
    try {
      for (const name of await readdir(directory)) {
        if (!/^request-drafts\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) continue
        const path = join(directory, name)
        if (this.preserveOwner) {
          const contents = await readFile(path, 'utf8')
          let copy: Saved
          try { copy = parseSaved(JSON.parse(contents)) } catch {
            // A malformed copy can still carry a known dormant owner. Preserve its bytes;
            // ordinary abandoned copies keep their original cleanup behavior.
            const ids = [...contents.matchAll(/"ownerId"\s*:\s*("(?:[^"\\]|\\.)*")/gu)]
            if (/"(?:watcherOwners|unclassifiedOwners)"\s*:\s*\[\s*\{/u.test(contents) || ids.some(match => {
              let ownerId: string
              try { ownerId = JSON.parse(match[1]!) } catch { return false }
              return this.dormant({ kind: 'thread', ownerId, providerId: 'codex' }, { version: 2, drafts: [], retirements: [],
                ...(/"watcherOwners"\s*:\s*\[\s*\]/u.test(contents) ? { watcherOwners: [] } : {}) })
            })) continue
            await unlink(path)
            continue
          }
          const drafts = copy.drafts.filter(draft => this.dormant(draft.target, copy))
          const retirements = copy.retirements.filter(item => this.dormant(item.owner, copy))
          if (drafts.length || retirements.length || copy.watcherOwners?.length) {
            if (drafts.length !== copy.drafts.length || retirements.length !== copy.retirements.length) {
              await new AtomicJsonStore(path, parseSaved, () => ({ version: 2 as const, drafts: [], retirements: [] })).write({ ...copy, drafts, retirements })
            }
            continue
          }
        }
        await unlink(path)
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = unreadable }
  }

  private dormant(owner: RequestDraftOwner, saved = this.saved): boolean {
    if (!this.preserveOwner) return false
    const classification = this.preserveOwner(owner)
    const key = requestDraftOwnerKey(owner)
    if (classification === true || saved.watcherOwners?.some(item => requestDraftOwnerKey(item) === key)) return true
    // Old Owl snapshots carry no classification. Park unavailable owners until a host supplies it;
    // this is retention evidence only, never a launch profile or permission.
    return classification === undefined && (saved.watcherOwners === undefined
      || saved.unclassifiedOwners?.some(item => requestDraftOwnerKey(item) === key) === true)
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

  private ledger(retirements: readonly Retirement[] = this.saved.retirements): LedgerIndex {
    if (this.ledgerIndex?.retirements === retirements) return this.ledgerIndex
    const byKey = new Map<string, Retirement>()
    const owners = new Map<string, { key: string; owner: RequestDraftOwner; first: number }[]>()
    retirements.forEach((item, first) => {
      byKey.set(retirementKey(item), item)
      const key = requestDraftOwnerKey(item.owner), named = owners.get(item.owner.ownerId)
      if (!named) owners.set(item.owner.ownerId, [{ key, owner: item.owner, first }])
      else if (!named.some(entry => entry.key === key)) named.push({ key, owner: item.owner, first })
    })
    return this.ledgerIndex = { retirements, byKey, owners }
  }

  /**
   * The retirement owners a commit looks up, in ledger order. Once a commit has classified the ledger, looking up an
   * ordinary owner again can change what is saved only if its thread is Watcher or dormant now, or it is still
   * unclassified; an owner already kept as Watcher stays kept. Every other lookup would change nothing.
   */
  private retirementOwners(retirements: readonly Retirement[], watchers: ReadonlyMap<string, unknown>, unclassified: ReadonlyMap<string, RequestDraftOwner>): RequestDraftOwner[] {
    if (!this.watcherOwnerIds || this.saved.watcherOwners === undefined) return retirements.map(item => item.owner)
    const { owners } = this.ledger(retirements)
    const found = new Map<string, { owner: RequestDraftOwner; first: number }>()
    for (const id of this.watcherOwnerIds()) {
      for (const entry of owners.get(id) ?? []) if (!watchers.has(entry.key)) found.set(entry.key, entry)
    }
    for (const [key, owner] of unclassified) {
      const entry = owners.get(owner.ownerId)?.find(item => item.key === key)
      if (entry) found.set(key, entry)
    }
    return [...found.values()].sort((a, b) => a.first - b.first).map(entry => entry.owner)
  }

  private async commit(drafts: RequestDraft[], retirements = this.saved.retirements): Promise<void> {
    // Remote hosts reconnect in the background. Remember known Watcher owners with their
    // forms so offline startup and ordinary ledger trimming cannot lose their identity.
    const watchers = new Map((this.saved.watcherOwners ?? []).map(owner => [requestDraftOwnerKey(owner), owner]))
    const unclassified = new Map((this.saved.unclassifiedOwners ?? []).map(owner => [requestDraftOwnerKey(owner), owner]))
    // Each owner once, in the order the drafts, the ledger and the unclassified owners name them.
    const owners = new Map<string, RequestDraftOwner>()
    for (const owner of [...drafts.map(draft => draft.target), ...this.retirementOwners(retirements, watchers, unclassified), ...unclassified.values()]) {
      if (owner.kind !== 'thread') continue
      const key = requestDraftOwnerKey(owner)
      if (!owners.has(key)) owners.set(key, owner)
    }
    for (const [key, owner] of owners) {
      const state = this.lookup(owner), classification = this.preserveOwner?.(owner)
      const identity = { kind: owner.kind, ownerId: owner.ownerId, providerId: owner.providerId }
      if (state?.watcher === true || classification === true) { watchers.set(key, identity); unclassified.delete(key) }
      else if (state || classification === false) unclassified.delete(key)
      else if (this.saved.watcherOwners === undefined && classification === undefined) unclassified.set(key, identity)
    }
    const fields = { version: 2, drafts, watcherOwners: [...watchers.values()], ...(unclassified.size ? { unclassifiedOwners: [...unclassified.values()] } : {}) }
    // A save, discard or hold keeps the ledger it was saved and checked with, so only the rest is checked again.
    const kept = retirements === this.saved.retirements
    let next: Saved
    if (kept) {
      const rest = unledgeredSchema.parse(fields)
      next = { version: rest.version, drafts: rest.drafts, retirements: this.saved.retirements, watcherOwners: rest.watcherOwners,
        ...(rest.unclassifiedOwners ? { unclassifiedOwners: rest.unclassifiedOwners } : {}) }
    } else next = savedSchema.parse({ ...fields, retirements })
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
    // A kept ledger leaves its owners as they were.
    if (!kept) {
      const beforeRetirements = new Map(this.saved.retirements.map(item => [retirementKey(item), JSON.stringify(item)]))
      const afterRetirements = new Map(next.retirements.map(item => [retirementKey(item), JSON.stringify(item)]))
      for (const item of [...this.saved.retirements, ...next.retirements]) {
        const key = retirementKey(item)
        if (beforeRetirements.get(key) !== afterRetirements.get(key)) changed.set(requestDraftOwnerKey(item.owner), item.owner)
      }
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

  private retirement(target: RequestDraftTarget): Retirement | undefined {
    return this.ledger().byKey.get(retirementKey({ owner: target, requestId: target.requestId, questionsDigest: requestQuestionsDigest(target.questions) }))
  }

  private reoffered(target: RequestDraftTarget): boolean {
    const request = this.lookup(target)?.requests.find(item => item.id === target.requestId
      && sameRequestQuestions(requestDraftQuestions(item), target.questions))
    return request?.delivery === 'uncertain' || request?.answerRetryReady === true
  }

  private currentStatus(target: RequestDraftTarget): RequestDraftStatus {
    const draft = this.current(target)
    if (draft) return { status: 'draft', draft: structuredClone(draft) }
    const accepted = this.retirement(target)
    if (accepted && this.reoffered(target)) return { status: 'unconfirmed', revision: accepted.revision }
    return accepted ? { status: 'accepted', decisionId: accepted.decisionId, revision: accepted.revision } : { status: 'missing' }
  }

  private async retire(drafts: RequestDraft[]): Promise<void> {
    const retirements = new Map(this.saved.retirements.map(item => [retirementKey(item), item]))
    for (const draft of drafts) {
      const { kind, ownerId, providerId, requestId } = draft.target
      const item: Retirement = { owner: { kind, ownerId, providerId }, requestId,
        questionsDigest: requestQuestionsDigest(draft.target.questions), decisionId: draft.decisionId!, revision: draft.revision }
      const key = retirementKey(item)
      retirements.delete(key)
      retirements.set(key, item)
    }
    const retired = new Set(drafts)
    // Acceptance metadata and deletion of submitted words share one durable replacement.
    const items = [...retirements.values()]
    const ordinary = new Set(items.filter(item => !this.dormant(item.owner)).slice(-512))
    await this.commit(this.saved.drafts.filter(draft => !retired.has(draft)),
      items.filter(item => this.dormant(item.owner) || ordinary.has(item)))
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
      const accepted = this.saved.drafts.filter(draft => draft.target.kind === 'thread' && !this.dormant(draft.target) && draft.held && draft.decisionId && !this.reoffered(draft.target)
        && this.lookup(draft.target)?.completed?.some(item => item.requestId === draft.target.requestId
          && item.decisionId === draft.decisionId && item.questionsDigest === requestQuestionsDigest(draft.target.questions)))
      if (accepted.length) await this.retire(accepted)
      else if (this.saved.drafts.filter(draft => draft.target.kind === 'thread').map(draft => draft.target).some(owner =>
        this.lookup(owner)?.watcher === true && !this.saved.watcherOwners?.some(item => requestDraftOwnerKey(item) === requestDraftOwnerKey(owner)))
        || this.saved.unclassifiedOwners?.some(owner => this.lookup(owner) !== undefined || this.preserveOwner?.(owner) !== undefined)) {
        await this.commit(this.saved.drafts)
      }
    })
  }

  /** Main's read-only recovery work, bounded by saved drafts rather than the host's thread archive. */
  heldThreadAnswers(): Promise<RequestDraft[]> {
    return this.serial(async () => structuredClone(this.saved.drafts.filter(draft => draft.target.kind === 'thread'
      && !this.dormant(draft.target) && draft.held && draft.decisionId)))
  }

  /** Retired submitted answers follow local history; unsent forms and thread recovery keep their own retention. */
  privacyChanged(historyEnabled: boolean): Promise<void> {
    if (historyEnabled) return Promise.resolve()
    return this.serial(async () => {
      // A held form is a submitted copy even before its native attempt is bound. An attempt identity is also
      // submission evidence: retain no answer or question text just because a legacy form lost its held flag.
      const drafts = this.saved.drafts.filter(draft => draft.target.kind !== 'personal' || !draft.held && !draft.decisionId)
      if (drafts.length === this.saved.drafts.length) return
      try { await this.commit(drafts) } catch { throw new Error(privacyFailed) }
    })
  }

  list(input: RequestDraftOwner): Promise<RequestDraft[]> {
    const owner = requestDraftOwnerSchema.parse(input)
    if (owner.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => !this.dormant(owner) && this.lookup(owner)
      ? structuredClone(this.saved.drafts.filter(draft => requestDraftOwnerKey(draft.target) === requestDraftOwnerKey(owner))) : [])
  }

  discard(input: RequestDraftDiscard): Promise<boolean> {
    const { target, revision } = requestDraftDiscardSchema.parse(input)
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => {
      if (this.dormant(target) || !this.lookup(target)) throw new Error('This answer owner is unavailable.')
      const previous = this.current(target)
      if (!previous) return false
      if (previous.revision !== revision) throw new Error('A newer answer draft may be saved. Reload retained answers before discarding.')
      await this.commit(this.saved.drafts.filter(draft => draft !== previous))
      return true
    })
  }

  /** Main only: bind the persisted held form before the native write. No answer content enters receipts. */
  bindDecision(target: RequestDraftTarget, decisionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => {
      const previous = this.current(target)
      if (!previous?.held || this.dormant(target) || !this.lookup(target) || !answers) return
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
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => {
      const draft = this.current(target)
      return !this.dormant(target) && this.lookup(target) && draft && sameRequestQuestions(draft.target.questions, target.questions) ? structuredClone(draft) : null
    })
  }

  status(input: RequestDraftTarget): Promise<RequestDraftStatus> {
    const target = requestDraftTargetSchema.parse(input)
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => this.dormant(target) ? { status: 'missing' } : this.currentStatus(target))
  }

  save(input: RequestDraft): Promise<RequestDraft> {
    const draft = requestDraftSchema.parse(input)
    if (draft.target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    return this.serial(async () => {
      const previous = this.current(draft.target), state = this.lookup(draft.target)
      const accepted = this.retirement(draft.target)
      if (accepted && draft.revision <= accepted.revision) throw new Error('This answer revision was already accepted. Reload the current answer before saving.')
      if (draft.decisionId !== previous?.decisionId) throw new Error('Delivery identity is owned by main. Reload this answer before saving.')
      if (this.dormant(draft.target) || !state) throw new Error('This answer belongs to a request that is no longer available.')
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
    if (target.kind !== 'thread') throw new Error('Standalone chats are no longer available.')
    // Capture the attempt before refresh can publish acceptance and reconcile its saved hold.
    const initial = await this.serial(async () => {
      if (this.dormant(target)) throw new Error('This answer owner is unavailable.')
      return { status: this.currentStatus(target),
      reoffered: this.reoffered(target), retirement: this.retirement(target),
      retryReady: this.lookup(target)?.requests.some(item => item.id === target.requestId && item.answerRetryReady === true
        && sameRequestQuestions(requestDraftQuestions(item), target.questions)) === true,
      completed: structuredClone(this.lookup(target)?.completed ?? []) }
    })
    const observed = initial.status
    if (observed.status === 'accepted') return observed
    const captured = observed.status === 'draft' ? observed.draft : null
    // A renderer's cached snapshot/observe subscription is not a fresh native read.
    // The read can publish snapshots, so it must run outside the disk-write lane.
    let refreshFailure: { error: unknown } | undefined
    try { await this.refresh(target, captured?.decisionId) }
    catch (error) { refreshFailure = { error } }
    return this.serial(async () => {
      const previous = this.current(target)
      if (previous && (!captured || previous.revision !== captured.revision
        || previous.decisionId !== captured.decisionId || previous.held !== captured.held)) {
        if (refreshFailure) throw refreshFailure.error
        throw new Error('A newer answer draft is saved. Check the current answer again.')
      }
      const accepted = this.retirement(target)
      const expected = captured ?? initial.retirement
      if (!previous && accepted && expected && accepted.revision >= expected.revision
        && (accepted.revision !== expected.revision || accepted.decisionId !== expected.decisionId)) {
        if (refreshFailure) throw refreshFailure.error
        throw new Error('A newer answer draft is saved. Check the current answer again.')
      }
      const matchesCaptured = (item: { requestId: string; decisionId?: string; questionsDigest?: string }): boolean =>
        !!captured?.decisionId && item.requestId === target.requestId && item.decisionId === captured.decisionId
        && item.questionsDigest === requestQuestionsDigest(target.questions)
      const state = this.lookup(target)
      // Uncertainty may still describe this held write. Newly arriving proof can settle that
      // exact attempt once its native request closes, even when the read then fails. A live
      // re-ask, an explicit retry-ready marker and proof known before Check retain the new-offer boundary instead.
      const completedDuringRead = captured?.held && captured.decisionId && !initial.retryReady && !initial.completed.some(matchesCaptured)
        && initial.retirement?.decisionId !== captured.decisionId
        && !state?.requests.some(item => item.id === target.requestId && sameRequestQuestions(requestDraftQuestions(item), target.questions))
        && (state?.completed?.some(matchesCaptured) || accepted?.decisionId === captured.decisionId && accepted.revision === captured.revision)
      const reoffered = (initial.reoffered || this.reoffered(target)) && !completedDuringRead
      if (!reoffered && !previous && accepted && (!captured || accepted.revision >= captured.revision)) {
        if (!captured && refreshFailure) throw refreshFailure.error
        return { status: 'accepted', decisionId: accepted.decisionId, revision: accepted.revision }
      }
      if (!reoffered && captured?.held && captured.decisionId
        && this.lookup(target)?.completed?.some(item => item.requestId === target.requestId
          && item.decisionId === captured.decisionId && item.questionsDigest === requestQuestionsDigest(target.questions))) {
        await this.retire([previous ?? captured])
        return { status: 'accepted', decisionId: captured.decisionId, revision: captured.revision }
      }
      // A failed fresh read can confirm only exact acceptance; it never releases an editable hold.
      if (refreshFailure) throw refreshFailure.error
      if (!this.offered(target)) throw new Error('This answer is still unconfirmed. Reconnect and check the original request.')
      if (!previous) {
        const floor = accepted?.revision ?? initial.retirement?.revision
        if (reoffered && floor !== undefined) {
          const next: RequestDraft = { target, revision: floor + 1, selections: {}, held: false }
          await this.commit([...this.saved.drafts, next])
          return { status: 'editable', draft: structuredClone(next) }
        }
        return { status: 'editable', draft: null }
      }
      if (!previous.held) return { status: 'editable', draft: structuredClone(previous) }
      const { decisionId, ...editable } = previous
      void decisionId
      const next = { ...editable, revision: previous.revision + 1, held: false }
      await this.commit(this.saved.drafts.map(item => item === previous ? next : item))
      return { status: 'editable', draft: structuredClone(next) }
    })
  }
}
