import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { agentAttachmentHandleSchema, agentAttachmentSchema, agentFollowupSchema, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS,
  type AgentAttachmentHandle, type AgentFollowup } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { StageInline } from './attachmentStore'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { isResumeNoteText } from '../../shared/restartResume'
import { wakeUpNewsSchema, foldWakeUpNews, isBabysitNews, isRestartNews, isWatcherNews, isWatcherOnlyWakeUp, WAKE_UP_NEWS_MAX, type WakeUpNews } from './wakeUp'

/** Why a follow-up came back from a restart without an image it had, whatever the reason the image was not kept. */
export const LOST_IMAGES = 'An image in this follow-up was no longer kept when Sotto started, so the follow-up was paused rather than sent without it. Attach the image again or remove the follow-up.'
/** Shared identity for prompt admission, the outbox and queue receipts. Images stay handles, never content reads. */
export function followupDigest(input: Pick<AgentFollowup, 'text' | 'skills' | 'files'> & { readonly attachments?: readonly AgentAttachmentHandle[] | undefined }): string {
  const base = input.skills?.length ? [input.text.trim(), input.attachments ?? [], input.skills] : [input.text.trim(), input.attachments ?? []]
  // Mentioned files join the digest only when there are any, so revisions without them keep their existing identity.
  return createHash('sha256').update(JSON.stringify(input.files?.length ? [...base, input.files] : base)).digest('hex')
}
const receiptsSchema = z.array(agentDeliveryReceiptsSchema.element.extend({ digest: z.string().optional() })).max(MAX_DELIVERED_DRAFTS * 2)
/**
 * A queued item as the store keeps it. A wake-up keeps the news it was worded from, one part per pull request, so news
 * that comes later folds into it and a stop takes back its pull request's part; the window is sent the words alone.
 */
const queuedSchema = agentFollowupSchema.extend({ watcherOperationId: z.uuid().optional(), news: z.array(wakeUpNewsSchema).max(WAKE_UP_NEWS_MAX + 1).optional() })
export type QueuedFollowup = z.infer<typeof queuedSchema>
type State = { items: QueuedFollowup[]; receipts: z.infer<typeof receiptsSchema> }
/**
 * What the file may hold: a follow-up written before ADR-0031 kept its images inline. Each is read as it stands and
 * staged when the store loads, so an upgrade never discards the queue as unreadable.
 */
const storedSchema = z.object({ items: z.array(queuedSchema.extend({ attachments: z.array(z.union([agentAttachmentHandleSchema, agentAttachmentSchema])) })), receipts: receiptsSchema })
/** How a wake-up's news is worded, given all of it: the store folds news and the caller words it (`wakeUpText`). */
export type WordWakeUp = (news: readonly WakeUpNews[]) => string
/** The review token of an item queued while the thread rested on no turn Sotto had read. */
export const UNKNOWN_TURN = 'unknown'
/** Sotto's wake-up still waiting in a queue (ADR-0061 decision 8): one that has not started to send. */
export const isWaitingWakeUp = (item: Pick<QueuedFollowup, 'wakeUp' | 'status'>): boolean => item.wakeUp === true && ['queued', 'paused', 'failed'].includes(item.status)
/** Sotto's wake-up waiting in this thread's queue. */
const waitingWakeUp = (item: QueuedFollowup, threadId: string): boolean => item.threadId === threadId && isWaitingWakeUp(item)
/**
 * A waiting wake-up that resumes a turn a restart stopped (ADR-0076) goes ahead of the user's follow-ups, which were
 * waiting on that turn; every other wake-up goes after them.
 */
const leadsQueue = (item: QueuedFollowup, threadId: string): boolean => waitingWakeUp(item, threadId) && (item.news ?? []).some(isRestartNews)
const WAKE_UP_NOT_EDITABLE = "A wake-up is Sotto's own message and cannot be edited. Remove it if the thread should not get it."

type Stored = z.infer<typeof storedSchema>
/** The durable queue as it stands, for reading only. */
export interface FollowupView {
  readonly items: readonly Readonly<QueuedFollowup>[]
  readonly receipts: readonly Readonly<State['receipts'][number]>[]
}

/** Only durable snapshots become visible. No provider work runs under this store's mutation lane. */
export class FollowupStore {
  private state: State = { items: [], receipts: [] }
  private readonly dormant = new Map<string, Stored['items'][number]>()
  private readonly gatedMachines = new Map<string, Stored['items'][number]>()
  private active: (threadId: string) => boolean = () => true
  private tail: Promise<unknown> = Promise.resolve()
  private readonly store: AtomicJsonStore<Stored>
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean = () => true, private readonly isWatcherThread: (id: string) => boolean = () => false, private readonly watcherEnabled: () => boolean = () => true) {
    this.store = new AtomicJsonStore<Stored>(join(directory, 'followups.json'), storedSchema.parse, () => ({ items: [], receipts: [] }))
  }
  /**
   * Reads the queue, staging any image an older version kept inline. `kept` says whether a follow-up's content is
   * still there. One that lost an image, because its content is gone or an inline one was not the image it claimed,
   * is paused and says so, never sent without it.
   */
  async load(stage?: StageInline, kept: (handle: AgentAttachmentHandle) => boolean = () => true, active: (threadId: string) => boolean = () => true): Promise<void> {
    this.active = active
    await this.cleanPrivateCopies()
    const privateCorruption = !this.historyEnabled() && this.watcherEnabled()
      && this.hasPrivateWords(await this.readCopy(join(this.directory, 'followups.json')))
    const stored = await (privateCorruption ? this.store.peek() : this.store.read())
    const items: State['items'] = []
    const lost = new Set<string>()
    for (const item of stored.items) {
      if (item.watcherOperationId && !this.watcherEnabled()) { this.gatedMachines.set(item.id, structuredClone(item)); continue }
      if (!this.historyEnabled() && active(item.threadId) && (item.watcherOperationId || this.isWatcherThread(item.threadId))) continue
      if (!active(item.threadId)) {
        this.dormant.set(item.id, structuredClone(item))
        items.push(queuedSchema.parse({ ...item, attachments: item.attachments.filter(attachment => !('dataUrl' in attachment)) }))
        continue
      }
      const attachments: AgentAttachmentHandle[] = []
      for (const attachment of item.attachments) {
        if (!('dataUrl' in attachment)) { attachments.push(attachment); continue }
        if (!stage) throw new Error('This queue holds images from an earlier version and cannot be read without staging them.')
        const handle = await stage(attachment)
        if (handle) attachments.push(handle)
        else lost.add(item.id)
      }
      items.push(queuedSchema.parse({ ...item, attachments }))
    }
    this.state = { items, receipts: stored.receipts }
    await this.change(state => {
      for (const item of state.items) {
        if (!active(item.threadId)) continue
        const remaining = item.attachments.filter(kept)
        if (remaining.length === item.attachments.length && !lost.has(item.id)) continue
        item.attachments = remaining
        if (['queued', 'paused', 'failed'].includes(item.status)) { item.status = 'paused'; item.error = LOST_IMAGES }
      }
      for (const item of state.items) if (active(item.threadId) && item.status === 'dispatching') {
        item.status = 'uncertain'; item.error = 'Dispatch was interrupted. Refresh to reconcile; this message will not be replayed.'
      }
    })
  }
  get(): State { return structuredClone(this.state) }
  /**
   * The queue without a copy, for callers that only look: the coordinator reads thread ids and statuses
   * several times per streaming frame, and a copy carries every queued image with it. Safe to hold across
   * an await, because a change never edits this object; it builds the next one and swaps it in whole.
   */
  peek(): FollowupView { return this.state }
  /** Runs `update` in the mutation lane, after every change asked before it, and saves; an update that says `false` changed nothing and writes nothing. */
  private change(update: (state: State) => void | false): Promise<void> {
    const task = this.tail.catch(() => undefined).then(async () => {
      const next = this.get()
      if (update(next) === false) return
      await this.store.write({ ...next, items: [...this.gatedMachines.values(), ...next.items.filter(item => !this.active(item.threadId) || this.historyEnabled() || !item.watcherOperationId && !this.isWatcherThread(item.threadId)).map(item => this.dormant.get(item.id) ?? item)] }); this.state = next
    })
    this.tail = task
    return task
  }
  enqueue(input: Pick<AgentFollowup, 'threadId' | 'draftId' | 'text' | 'attachments' | 'skills' | 'files' | 'resumeAfterTurnId'> & { watcherOperationId?: string; messageId?: string | undefined }): Promise<void> {
    return this.change(state => {
      const receipt = state.receipts.find(r => r.threadId === input.threadId && r.draftId === input.draftId)
      const item = state.items.find(r => r.threadId === input.threadId && r.draftId === input.draftId)
      const digest = followupDigest(input)
      if (receipt || item) {
        if ((receipt?.digest ?? (item ? followupDigest(item) : undefined)) !== digest) throw new Error('This revision already belongs to a submitted prompt. Use a new draft revision for different content.')
        return
      }
      if (state.items.filter(item => item.threadId === input.threadId).length >= 100) throw new Error('This thread already has 100 follow-ups. Remove or send some first.')
      const now = new Date().toISOString()
      // The user's follow-ups go before a wake-up that waits, which goes when the queue would send the next one (decision 8).
      const wakeUp = state.items.findIndex(item => waitingWakeUp(item, input.threadId) && !leadsQueue(item, input.threadId))
      state.items.splice(wakeUp === -1 ? state.items.length : wakeUp, 0, queuedSchema.parse({ ...input, id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now }))
      const receipts = [...state.receipts, { threadId: input.threadId, draftId: input.draftId, digest }]
      const ordinary = new Set(receipts.filter(receipt => this.active(receipt.threadId)).slice(-MAX_DELIVERED_DRAFTS))
      state.receipts = receipts.filter(receipt => !this.active(receipt.threadId) || ordinary.has(receipt))
    })
  }
  async privacyChanged(): Promise<void> { await this.change(() => undefined); await this.cleanPrivateCopies() }
  private async readCopy(path: string): Promise<string> {
    try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  private privateItem(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false
    const value = item as { watcherOperationId?: unknown; threadId?: unknown }
    return value.watcherOperationId !== undefined || typeof value.threadId === 'string' && this.isWatcherThread(value.threadId) && this.active(value.threadId)
  }
  private hasPrivateWords(contents: string): boolean {
    try { const value = JSON.parse(contents) as { items?: unknown }; if (Array.isArray(value.items)) return value.items.some(item => this.privateItem(item)) }
    catch { /* Damaged JSON can still name a private item before its broken boundary. */ }
    if (/(?<!\\)"watcherOperationId"\s*:/u.test(contents)) return true
    for (const match of contents.matchAll(/(?<!\\)"threadId"\s*:\s*("(?:[^"\\]|\\.)*")/gu)) {
      const threadId: unknown = JSON.parse(match[1]!)
      if (typeof threadId === 'string' && this.isWatcherThread(threadId) && this.active(threadId)) return true
    }
    return false
  }
  private async cleanPrivateCopies(): Promise<void> {
    if (this.historyEnabled() || !this.watcherEnabled()) return
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names) if (/^followups\.json\.(?:tmp|corrupt)-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
      const path = join(this.directory, name), contents = await this.readCopy(path)
      if (!this.hasPrivateWords(contents)) continue
      let value: { items: unknown[]; [key: string]: unknown }
      try { value = JSON.parse(contents) as typeof value }
      catch { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }); continue }
      if (!Array.isArray(value.items)) { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }); continue }
      // Keep ordinary saved queue items, even when another part of this backup fails its schema.
      value.items = value.items.filter(item => !this.privateItem(item))
      await new AtomicJsonStore(path, input => input, () => ({})).write(value)
    }
  }
  /**
   * Removes the named Watcher items that can no longer be sent, keeping any whose dispatch is still unresolved. Answers the
   * operations whose removed item had already failed: a dispatch can fail just ahead of the cancel in this lane, and once
   * its item is gone that failure is nowhere else to read.
   */
  async cancelWatcher(operationIds: ReadonlySet<string>): Promise<string[]> {
    let failed: string[] = []
    await this.change(state => {
      const cancelled = state.items.filter(item => item.watcherOperationId && operationIds.has(item.watcherOperationId)
        && item.status !== 'dispatching' && item.status !== 'uncertain')
      failed = cancelled.flatMap(item => item.status === 'failed' ? [item.watcherOperationId!] : [])
      state.items = state.items.filter(item => !cancelled.includes(item))
    })
    return failed
  }
  edit(threadId: string, itemId: string, update?: Pick<AgentFollowup, 'text' | 'attachments' | 'skills' | 'files'>): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.threadId === threadId && item.id === itemId)
      if (!item) throw new Error('That follow-up is no longer queued.')
      if (item.status === 'dispatching' || item.status === 'uncertain') throw new Error('This follow-up may already be sent. Refresh to reconcile it before making changes.')
      if (update && item.wakeUp) throw new Error(WAKE_UP_NOT_EDITABLE)
      if (update) Object.assign(item, update, { updatedAt: new Date().toISOString() })
      else state.items = state.items.filter(candidate => candidate !== item)
    })
  }
  reorder(threadId: string, ids: string[]): Promise<void> {
    return this.change(state => {
      const items = state.items.filter(item => item.threadId === threadId)
      if (items.some(item => item.status === 'dispatching' || item.status === 'uncertain')) throw new Error('Wait for this thread’s pending delivery before reordering follow-ups.')
      // A wake-up holding only Watcher's news is shown in no queue (ADR-0073), so an order may leave it out; anything
      // else missing or added is a change made since the order was read.
      const hidden = items.filter(item => isWatcherOnlyWakeUp(item) && !ids.includes(item.id))
      const shown = items.filter(item => !hidden.includes(item))
      if (ids.length !== shown.length || new Set(ids).size !== ids.length || ids.some(id => !shown.some(item => item.id === id))) throw new Error('The follow-up order changed. Refresh and try again.')
      // Sotto's wake-up keeps its place after the user's follow-ups, wherever the user moved theirs; a resume note, before.
      const ordered = [...ids.map(id => shown.find(item => item.id === id)!), ...hidden]
      const leading = ordered.filter(item => leadsQueue(item, threadId))
      state.items = [...state.items.filter(item => item.threadId !== threadId), ...leading, ...ordered.filter(item => !waitingWakeUp(item, threadId)),
        ...ordered.filter(item => waitingWakeUp(item, threadId) && !leading.includes(item))]
    })
  }
  /**
   * Holds a wake-up for a thread (ADR-0061 decision 8): Sotto's own item, after the user's, which the queue sends at
   * once when the thread is ready and otherwise when it would send the next one. A thread holds one waiting wake-up,
   * and later news folds into it until it goes. Resolves once it is saved.
   */
  queueWakeUp(threadId: string, news: WakeUpNews, word: WordWakeUp, resumeAfterTurnId?: string, attention?: boolean): Promise<void> {
    return this.change(state => {
      const now = new Date().toISOString()
      const waiting = state.items.find(item => waitingWakeUp(item, threadId))
      if (waiting) {
        const folded = foldWakeUpNews(waiting.news ?? [], wakeUpNewsSchema.parse(news))
        // Checked before it is saved: a queue file its own schema refuses would be set aside whole on the next start.
        // A resume note is the review a paused queue waits for: the turn it follows did not finish, and it says so.
        // News that needs Watcher's attention starts a stopped wake-up no one is shown, and so no one can resume, again.
        // A thread's facts alone only keep its news current: they never send it, mid-turn or otherwise.
        // Whether Watcher's news needs it is the caller's to say (a pull request's change does); without word, anything but evidence.
        const needs = isWatcherNews(news) && (attention ?? news.events.some(event => event.kind !== 'evidence-changed'))
        const resumes = isRestartNews(news) || needs && ['failed', 'paused'].includes(waiting.status) && isWatcherOnlyWakeUp({ wakeUp: true, news: folded })
          ? { status: 'queued' as const, error: undefined } : {}
        const next = queuedSchema.parse({ ...waiting, news: folded, text: word(folded), updatedAt: now, ...resumeAfterTurnId ? { resumeAfterTurnId } : {}, ...resumes })
        state.items = state.items.map(item => item === waiting ? next : item)
      } else {
        state.items.push(queuedSchema.parse({ id: randomUUID(), threadId, draftId: randomUUID(), text: word([news]), attachments: [], status: 'queued', wakeUp: true,
          news: [news], createdAt: now, updatedAt: now, ...(resumeAfterTurnId ? { resumeAfterTurnId } : {}) }))
      }
      // A resume note goes first, so the turn it resumes ends before the follow-ups queued behind that turn go.
      const leading = state.items.find(item => leadsQueue(item, threadId))
      if (leading) {
        const rest = state.items.filter(item => item !== leading)
        const at = rest.findIndex(item => item.threadId === threadId)
        rest.splice(at === -1 ? rest.length : at, 0, leading)
        state.items = rest
      }
    })
  }
  /**
   * Takes back what a waiting wake-up says of one pull request, or of every one, once babysitting it ended quietly: a
   * stop, a settle or the switch sends the thread nothing (decision 9). A wake-up left with no news goes with it.
   */
  withdrawWakeUp(threadId: string, url: string | undefined, word: WordWakeUp): Promise<void> {
    const key = url === undefined ? undefined : pullRequestKey(url)
    // Looked for inside the lane, never in the snapshot before it: a wake-up whose save is still pending is in the lane
    // ahead of this, and is taken back once it lands rather than left to send.
    return this.change(state => {
      const waiting = state.items.find(item => waitingWakeUp(item, threadId))
      if (!waiting) return false
      const kept = (waiting.news ?? []).filter(item => !isBabysitNews(item) || key !== undefined && pullRequestKey(item.pullRequest.url) !== key)
      if (kept.length === (waiting.news ?? []).length) return false
      if (kept.length) Object.assign(waiting, { news: kept, text: word(kept), updatedAt: new Date().toISOString() })
      else state.items = state.items.filter(item => item !== waiting)
    })
  }
  /**
   * Drops from a wake-up about to go every part `due` says may no longer go, because its babysitting ended quietly or
   * by the switch since it was told, and the item when nothing is left. One that had started to send goes back to
   * waiting, since nothing was sent. A wake-up without its news is left as it is.
   */
  pruneWakeUp(id: string, due: (news: WakeUpNews) => boolean, word: WordWakeUp, transform?: (news: WakeUpNews) => WakeUpNews | undefined): Promise<void> {
    return this.change(state => {
      const item = state.items.find(candidate => candidate.id === id)
      if (!item?.wakeUp || !item.news || !['queued', 'dispatching', 'paused', 'failed'].includes(item.status)) return false
      const kept = item.news.flatMap(news => { const next = transform ? transform(news) : news; return next && due(next) ? [next] : [] })
      if (JSON.stringify(kept) === JSON.stringify(item.news) && item.status === 'queued') return false
      if (!kept.length) { state.items = state.items.filter(candidate => candidate !== item); return }
      Object.assign(item, { news: kept, text: word(kept), status: item.status === 'dispatching' ? 'queued' : item.status, updatedAt: new Date().toISOString() })
      delete item.commandId; delete item.messageId
      if (item.status === 'queued') delete item.error
    })
  }
  /**
   * Sets a stopped wake-up holding only Watcher's news going again, since no one is shown it to resume or remove it:
   * one paused or not sent waits again behind the thread's other items, after `turnId`; one whose send is unknown is let
   * go, as an unknown send is never sent twice, and its news was already told.
   */
  reviveWakeUp(id: string, turnId: string): Promise<void> {
    return this.change(state => {
      const item = state.items.find(candidate => candidate.id === id)
      if (!item || !isWatcherOnlyWakeUp(item) || !['paused', 'failed', 'uncertain'].includes(item.status)) return false
      if (item.status === 'uncertain') { state.items = state.items.filter(candidate => candidate !== item); return }
      Object.assign(item, { status: 'queued', resumeAfterTurnId: turnId, updatedAt: new Date().toISOString() })
      delete item.error; delete item.commandId; delete item.messageId
      state.items = [...state.items.filter(candidate => candidate !== item), item]
    })
  }
  /**
   * Words each waiting wake-up again from the news it keeps, with `word`, and saves those whose words changed: an
   * earlier build saved Watcher's news in a wake-up's text, which this build sends beside it instead (ADR-0073).
   */
  rewordWakeUps(word: (item: QueuedFollowup) => string): Promise<void> {
    return this.change(state => {
      let changed = false
      for (const item of state.items) {
        if (!isWaitingWakeUp(item) || !this.active(item.threadId) || this.dormant.has(item.id)) continue
        const text = word(item)
        if (text !== item.text) { item.text = text; changed = true }
      }
      if (!changed) return false
    })
  }
  pause(threadId: string, error: string): Promise<void> {
    return this.change(state => {
      for (const item of state.items) if (item.threadId === threadId && item.status === 'queued') Object.assign(item, { status: 'paused', error })
    })
  }
  resume(threadId: string, turnId?: string): Promise<void> {
    return this.change(state => {
      for (const item of state.items) if (item.threadId === threadId && ['paused', 'failed'].includes(item.status)) {
        item.status = 'queued'; if (turnId) item.resumeAfterTurnId = turnId; delete item.error
      }
    })
  }
  /**
   * Binds the resume note (ADR-0076), queued against no turn, to the turn the thread turned out to rest on: the note is
   * that turn's review. Any other wake-up or prompt queued against no turn keeps waiting for the user's.
   */
  bindResumeNote(id: string, turnId: string): Promise<void> {
    return this.change(state => {
      const item = state.items.find(candidate => candidate.id === id)
      if (!item?.wakeUp || item.resumeAfterTurnId !== UNKNOWN_TURN || !(item.news ?? []).some(isRestartNews) || !isResumeNoteText(item.text)) return false
      Object.assign(item, { resumeAfterTurnId: turnId, updatedAt: new Date().toISOString() })
    })
  }
  claim(id: string, mode: 'send' | 'steer' = 'send'): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.id === id)
      if (!item || item.status !== 'queued' || mode === 'send' && state.items.find(candidate => candidate.threadId === item.threadId)?.id !== id) throw new Error(item?.wakeUp ? 'This wake-up is no longer ready to send.' : 'This follow-up is no longer ready to send.')
      Object.assign(item, { status: 'dispatching', commandId: randomUUID(), messageId: item.watcherOperationId && item.messageId ? item.messageId : randomUUID(), updatedAt: new Date().toISOString() })
    })
  }
  settle(id: string, status: 'accepted' | 'uncertain' | 'failed', error?: string): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.id === id)
      if (!item) return
      if (status === 'accepted') state.items = state.items.filter(candidate => candidate !== item)
      else Object.assign(item, { status, error, updatedAt: new Date().toISOString() })
    })
  }
}
