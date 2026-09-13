import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { agentFollowupSchema, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS, type AgentFollowup } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

export function followupDigest(input: Pick<AgentFollowup, 'text' | 'attachments' | 'skills'>): string {
  return createHash('sha256').update(JSON.stringify(input.skills?.length
    ? [input.text.trim(), input.attachments, input.skills] : [input.text.trim(), input.attachments])).digest('hex')
}
const schema = z.object({ items: z.array(agentFollowupSchema), receipts: z.array(agentDeliveryReceiptsSchema.element.extend({ digest: z.string().optional() })).max(MAX_DELIVERED_DRAFTS) })
type State = z.infer<typeof schema>

/** Only durable snapshots become visible. No provider work runs under this store's mutation lane. */
export class FollowupStore {
  private state: State = { items: [], receipts: [] }
  private tail: Promise<unknown> = Promise.resolve()
  private readonly store: AtomicJsonStore<State>
  constructor(directory: string) {
    this.store = new AtomicJsonStore(join(directory, 'followups.json'), schema.parse, () => ({ items: [], receipts: [] }))
  }
  async load(): Promise<void> {
    this.state = await this.store.read()
    await this.change(state => {
      for (const item of state.items) if (item.status === 'dispatching') {
        item.status = 'uncertain'; item.error = 'Dispatch was interrupted. Refresh to reconcile; this message will not be replayed.'
      }
    })
  }
  get(): State { return structuredClone(this.state) }
  private change(update: (state: State) => void): Promise<void> {
    const task = this.tail.catch(() => undefined).then(async () => {
      const next = this.get(); update(next)
      await this.store.write(next); this.state = next
    })
    this.tail = task
    return task
  }
  enqueue(input: Pick<AgentFollowup, 'threadId' | 'draftId' | 'text' | 'attachments' | 'skills' | 'resumeAfterTurnId'>): Promise<void> {
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
      state.items.push(agentFollowupSchema.parse({ ...input, id: randomUUID(), status: 'queued', createdAt: now, updatedAt: now }))
      state.receipts = [...state.receipts, { threadId: input.threadId, draftId: input.draftId, digest }].slice(-MAX_DELIVERED_DRAFTS)
    })
  }
  edit(threadId: string, itemId: string, update?: Pick<AgentFollowup, 'text' | 'attachments' | 'skills'>): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.threadId === threadId && item.id === itemId)
      if (!item) throw new Error('That follow-up is no longer queued.')
      if (item.status === 'dispatching' || item.status === 'uncertain') throw new Error('This follow-up may already be sent. Refresh to reconcile it before making changes.')
      if (update) Object.assign(item, update, { updatedAt: new Date().toISOString() })
      else state.items = state.items.filter(candidate => candidate !== item)
    })
  }
  reorder(threadId: string, ids: string[]): Promise<void> {
    return this.change(state => {
      const items = state.items.filter(item => item.threadId === threadId)
      if (items.some(item => item.status === 'dispatching' || item.status === 'uncertain')) throw new Error('Wait for this thread’s pending delivery before reordering follow-ups.')
      if (ids.length !== items.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id))) throw new Error('The follow-up order changed. Refresh and try again.')
      state.items = [...state.items.filter(item => item.threadId !== threadId), ...ids.map(id => items.find(item => item.id === id)!)]
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
  claim(id: string): Promise<void> {
    return this.change(state => {
      const item = state.items.find(item => item.id === id)
      if (!item || item.status !== 'queued' || state.items.find(candidate => candidate.threadId === item.threadId)?.id !== id) throw new Error('This follow-up is no longer ready to send.')
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
