import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { agentAttachmentHandleSchema, agentAttachmentSchema, agentFollowupSchema, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS,
  type AgentAttachmentHandle, type AgentFollowup } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { StageInline } from './attachmentStore'
import type { BabysitNews } from './babysitNews'
import { pullRequestKey } from './gitPullRequests'
import { babysitNewsSchema } from './wakeUp'

/** Why a follow-up came back from a restart without an image it had, whatever the reason the image was not kept. */
export const LOST_IMAGES = 'An image in this follow-up was no longer kept when Sotto started, so the follow-up was paused rather than sent without it. Attach the image again or remove the follow-up.'
/** Shared identity for prompt admission, the outbox and queue receipts. Images stay handles, never content reads. */
export function followupDigest(input: Pick<AgentFollowup, 'text' | 'skills' | 'files'> & { readonly attachments?: readonly AgentAttachmentHandle[] | undefined }): string {
  const base = input.skills?.length ? [input.text.trim(), input.attachments ?? [], input.skills] : [input.text.trim(), input.attachments ?? []]
  // Mentioned files join the digest only when there are any, so revisions without them keep their existing identity.
  return createHash('sha256').update(JSON.stringify(input.files?.length ? [...base, input.files] : base)).digest('hex')
}
const receiptsSchema = z.array(agentDeliveryReceiptsSchema.element.extend({ digest: z.string().optional() })).max(MAX_DELIVERED_DRAFTS)
/**
 * A queued item as the store keeps it. A wake-up keeps the news it was worded from, so news that comes later folds into
 * it and a stop takes back its pull request's part; the window is sent the words alone.
 */
const queuedSchema = agentFollowupSchema.extend({ news: z.array(babysitNewsSchema).max(50).optional() })
export type QueuedFollowup = z.infer<typeof queuedSchema>
type State = { items: QueuedFollowup[]; receipts: z.infer<typeof receiptsSchema> }
/**
 * What the file may hold: a follow-up written before ADR-0031 kept its images inline. Each is read as it stands and
 * staged when the store loads, so an upgrade never discards the queue as unreadable.
 */
const storedSchema = z.object({ items: z.array(queuedSchema.extend({ attachments: z.array(z.union([agentAttachmentHandleSchema, agentAttachmentSchema])) })), receipts: receiptsSchema })
/** How a wake-up's news is worded, given all of it: the store folds news and the caller words it (`wakeUpText`). */
export type WordWakeUp = (news: readonly BabysitNews[]) => string
/** Sotto's wake-up waiting in a thread's queue: the one that has not started to send. */
const waitingWakeUp = (item: QueuedFollowup, threadId: string): boolean => item.threadId === threadId && item.wakeUp === true && ['queued', 'paused', 'failed'].includes(item.status)
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
  private tail: Promise<unknown> = Promise.resolve()
  private readonly store: AtomicJsonStore<Stored>
  constructor(directory: string) {
    this.store = new AtomicJsonStore<Stored>(join(directory, 'followups.json'), storedSchema.parse, () => ({ items: [], receipts: [] }))
  }
  /**
   * Reads the queue, staging any image an older version kept inline. `kept` says whether a follow-up's content is
   * still there. One that lost an image, because its content is gone or an inline one was not the image it claimed,
   * is paused and says so, never sent without it.
   */
  async load(stage?: StageInline, kept: (handle: AgentAttachmentHandle) => boolean = () => true): Promise<void> {
    const stored = await this.store.read()
    const items: State['items'] = []
    const lost = new Set<string>()
    for (const item of stored.items) {
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
        const remaining = item.attachments.filter(kept)
        if (remaining.length === item.attachments.length && !lost.has(item.id)) continue
        item.attachments = remaining
        if (['queued', 'paused', 'failed'].includes(item.status)) { item.status = 'paused'; item.error = LOST_IMAGES }
      }
      for (const item of state.items) if (item.status === 'dispatching') {
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
  private change(update: (state: State) => void): Promise<void> {
    const task = this.tail.catch(() => undefined).then(async () => {
      const next = this.get(); update(next)
      await this.store.write(next); this.state = next
    })
    this.tail = task
    return task
  }
  enqueue(input: Pick<AgentFollowup, 'threadId' | 'draftId' | 'text' | 'attachments' | 'skills' | 'files' | 'resumeAfterTurnId'>): Promise<void> {
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
      const wakeUp = state.items.findIndex(item => waitingWakeUp(item, input.threadId))
      state.items.splice(wakeUp === -1 ? state.items.length : wakeUp, 0, queuedSchema.parse({ ...input, id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now }))
      state.receipts = [...state.receipts, { threadId: input.threadId, draftId: input.draftId, digest }].slice(-MAX_DELIVERED_DRAFTS)
    })
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
      if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id))) throw new Error('The follow-up order changed. Refresh and try again.')
      // Sotto's wake-up keeps its place after the user's follow-ups, wherever the user moved theirs.
      const ordered = ids.map(id => items.find(item => item.id === id)!)
      state.items = [...state.items.filter(item => item.threadId !== threadId), ...ordered.filter(item => !waitingWakeUp(item, threadId)), ...ordered.filter(item => waitingWakeUp(item, threadId))]
    })
  }
  /**
   * Holds a wake-up for a thread (ADR-0061 decision 8): Sotto's own item, after the user's, which the queue sends at
   * once when the thread is ready and otherwise when it would send the next one. A thread holds one waiting wake-up,
   * and later news folds into it until it goes. Resolves once it is saved.
   */
  queueWakeUp(threadId: string, news: BabysitNews, word: WordWakeUp, resumeAfterTurnId?: string): Promise<void> {
    return this.change(state => {
      const now = new Date().toISOString()
      const waiting = state.items.find(item => waitingWakeUp(item, threadId))
      if (waiting) {
        const folded = [...waiting.news ?? [], babysitNewsSchema.parse(news)]
        Object.assign(waiting, { news: folded, text: word(folded), updatedAt: now }, resumeAfterTurnId ? { resumeAfterTurnId } : {})
        return
      }
      state.items.push(queuedSchema.parse({ id: randomUUID(), threadId, draftId: randomUUID(), text: word([news]), attachments: [], status: 'queued', wakeUp: true,
        news: [news], createdAt: now, updatedAt: now, ...(resumeAfterTurnId ? { resumeAfterTurnId } : {}) }))
    })
  }
  /**
   * Takes back what a waiting wake-up says of one pull request, or of every one, once babysitting it ended quietly: a
   * stop, a settle or the switch sends the thread nothing (decision 9). A wake-up left with no news goes with it.
   */
  withdrawWakeUp(threadId: string, url: string | undefined, word: WordWakeUp): Promise<void> {
    const key = url === undefined ? undefined : pullRequestKey(url)
    if (!this.state.items.some(item => waitingWakeUp(item, threadId))) return Promise.resolve()
    return this.change(state => {
      const waiting = state.items.find(item => waitingWakeUp(item, threadId))
      if (!waiting) return
      const kept = key === undefined ? [] : (waiting.news ?? []).filter(item => pullRequestKey(item.pullRequest.url) !== key)
      if (kept.length === (waiting.news ?? []).length) return
      if (kept.length) Object.assign(waiting, { news: kept, text: word(kept), updatedAt: new Date().toISOString() })
      else state.items = state.items.filter(item => item !== waiting)
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
  claim(id: string, mode: 'send' | 'steer' = 'send'): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.id === id)
      if (!item || item.status !== 'queued' || mode === 'send' && state.items.find(candidate => candidate.threadId === item.threadId)?.id !== id) throw new Error('This follow-up is no longer ready to send.')
      Object.assign(item, { status: 'dispatching', commandId: randomUUID(), messageId: randomUUID(), updatedAt: new Date().toISOString() })
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
