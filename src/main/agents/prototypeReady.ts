import { isVisualMessage, type AgentHostSnapshot, type AgentThread, type PrototypeReady as PrototypeReadyMark, type QuestionPage } from '../../shared/agents'
import { settledIn } from './finishedUnread'
import type { QuestionPages, ReplyToSearch } from './questionPages'
import { isSottoRequest } from './sottoRequests'

/** How many cleared sources are kept, newest last; the oldest go once the list is full. */
export const PROTOTYPES_CLEARED_MAX = 500

/** A source whose mark the user cleared: a page of it was opened, or the question after it was answered. */
export interface ClearedPrototype { readonly threadId: string; readonly source: string }

/** The newest reply of a thread that is not a visual: from its messages, or from its summary when it carries none. */
interface NewestReply { readonly id: string; readonly text?: string; readonly summary?: string; readonly createdAt: string; readonly index?: number }

function newestReplyOf(thread: AgentThread): NewestReply | undefined {
  const { messages } = thread
  if (messages.length) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role === 'assistant' && !isVisualMessage(message)) return { id: message.id, text: message.text, createdAt: message.createdAt, index }
    }
    return undefined
  }
  const last = thread.summary?.lastAssistant
  return last && { id: last.id, summary: last.text, createdAt: last.createdAt }
}

/** A message Sotto sent as a wake-up (ADR-0061), which is no reply of the user's. */
const wakeUp = (thread: AgentThread, id: string, flagged = false): boolean => flagged || thread.wakeUpMessageIds?.includes(id) === true

/**
 * Whether the user wrote in the thread after the reply. With its messages, any user message after it that Sotto did not
 * send as a wake-up. With only its summary, the summary's last user message when it is not a wake-up and is dated after
 * the reply; a summary whose last user message is a wake-up says nothing of what came before it, and is read as no reply.
 */
function repliedAfter(thread: AgentThread, reply: NewestReply): boolean {
  if (reply.index !== undefined) {
    for (let index = thread.messages.length - 1; index > reply.index; index--) {
      const message = thread.messages[index]!
      if (message.role === 'user' && !wakeUp(thread, message.id, message.wakeUp === true)) return true
    }
    return false
  }
  const last = thread.summary?.lastUser
  return last !== undefined && !wakeUp(thread, last.id) && Date.parse(last.createdAt) > Date.parse(reply.createdAt)
}

const samePages = (left: readonly QuestionPage[], right: readonly QuestionPage[]): boolean =>
  left === right || (left.length === right.length && left.every((page, index) => page.token === right[index]!.token && page.start === right[index]!.start && page.name === right[index]!.name && page.kind === right[index]!.kind))

const keyOf = (threadId: string, source: string): string => `${threadId}\n${source}`

/**
 * Prototype ready for review (ADR-0108). The coordinator marks a thread whose waiting question carries a working page,
 * or whose newest reply, from a turn that has ended, names one; a question comes first. The mark carries those pages,
 * with the tokens QuestionPages serves them under, and names its source: `request:<ID>` or `reply:<message ID>`.
 *
 * It stays until the user opens one of its pages, from any client, or replies in the thread; answering a question is
 * replying to the reply before it. A source opened or answered is remembered and saved, so a restart does not bring its
 * mark back; a reply the user wrote after is in the thread itself. Showing the thread does not clear it. Watcher's own
 * threads and settled threads are never marked: settled is quiet, as it is for Just finished.
 */
export class PrototypeReady {
  /** Cleared sources, oldest first: a map keeps the order things were added in. */
  private readonly cleared = new Map<string, ClearedPrototype>()
  /** Per thread, the newest reply while one of its questions waited, so answering the question clears that reply. Ephemeral. */
  private readonly asked = new Map<string, string>()

  /**
   * When marks began, in milliseconds: a reply written before then earns none, so the first start with marks does not mark
   * every thread whose last reply ever named a page. Saved, so it stays the first start's. Undefined holds no reply back.
   */
  private began: number | undefined

  constructor(private readonly pages: Pick<QuestionPages, 'searched' | 'source'>, saved: readonly ClearedPrototype[] = [], began?: number) {
    this.began = began
    this.restore(saved)
  }

  /** When marks began, as the coordinator saves it. */
  since(): number | undefined { return this.began }

  /** Takes the saved sources back at start, keeping any cleared since, and when marks began when that was saved. */
  restore(saved: readonly ClearedPrototype[], began?: number): void {
    if (began !== undefined) this.began = began
    const since = [...this.cleared.values()]
    this.cleared.clear()
    for (const item of [...saved, ...since]) this.add(item.threadId, item.source)
  }

  /** The cleared sources as the coordinator saves them. */
  saved(): ClearedPrototype[] { return [...this.cleared.values()] }

  /**
   * A page was opened by its token, from the desktop or through the page route. Its source is remembered whether or not
   * it is the mark now: the user has seen it. True when that is new.
   */
  opened(token: string): boolean {
    const found = this.pages.source(token)
    return found ? this.add(found.threadId, found.source) : false
  }

  /** The reply of each of the snapshot's threads whose pages are wanted, for QuestionPages to look in. */
  replies(snapshot: Pick<AgentHostSnapshot, 'projects'>): (thread: AgentThread) => ReplyToSearch | undefined {
    const settled = settledIn(snapshot)
    return thread => {
      if (!this.markable(thread, settled)) return undefined
      const reply = this.wantedReply(thread)
      return reply && (reply.text !== undefined ? { id: reply.id, text: reply.text } : { id: reply.id, summary: reply.summary ?? '' })
    }
  }

  /** The snapshot with each thread's mark on it. Threads with nothing to change keep their own object, and so does the snapshot. */
  decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    const settled = settledIn(snapshot)
    let threads: AgentThread[] | undefined
    for (let index = 0; index < snapshot.threads.length; index++) {
      const thread = snapshot.threads[index]!
      const next = this.publish(thread, this.markable(thread, settled) ? this.markOf(thread) : this.forget(thread.id))
      if (next !== thread) (threads ??= [...snapshot.threads])[index] = next
    }
    if (this.asked.size) for (const id of this.asked.keys()) if (!snapshot.threads.some(thread => thread.id === id)) this.asked.delete(id)
    return threads ? { ...snapshot, threads } : snapshot
  }

  private markable(thread: AgentThread, settled: (thread: AgentThread) => boolean): boolean {
    return thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && !settled(thread)
  }

  private forget(threadId: string): undefined { this.asked.delete(threadId); return undefined }

  private markOf(thread: AgentThread): PrototypeReadyMark | undefined {
    let mark: PrototypeReadyMark | undefined, waits = false
    for (const request of thread.requests) {
      if (request.kind !== 'question' || isSottoRequest(request.id)) continue
      waits = true
      const source = `request:${request.id}`
      if (mark || this.cleared.has(keyOf(thread.id, source))) continue
      const working = this.pages.searched(thread.id, source)?.working
      if (working?.length) mark = { source, pages: working as QuestionPage[] }
    }
    if (waits) {
      const reply = newestReplyOf(thread)
      if (reply) this.asked.set(thread.id, reply.id)
      return mark
    }
    // No question waits now: one that did was answered or withdrawn, and the reply before it is answered with it.
    const before = this.asked.get(thread.id)
    if (before !== undefined) { this.asked.delete(thread.id); this.add(thread.id, `reply:${before}`) }
    const reply = this.wantedReply(thread)
    const working = reply && this.pages.searched(thread.id, `reply:${reply.id}`)?.working
    return working?.length ? { source: `reply:${reply!.id}`, pages: working as QuestionPage[] } : undefined
  }

  /** The newest reply when it could earn the mark: its turn has ended, nothing waits, the user has not replied or opened it. */
  private wantedReply(thread: AgentThread): NewestReply | undefined {
    if (thread.status === 'running' || thread.requests.length) return undefined
    const reply = newestReplyOf(thread)
    if (!reply || this.cleared.has(keyOf(thread.id, `reply:${reply.id}`)) || repliedAfter(thread, reply)) return undefined
    if (this.began !== undefined && !(Date.parse(reply.createdAt) >= this.began)) return undefined
    return reply
  }

  /** The thread as clients read it: with `prototypeReady` while it is marked, without it otherwise. */
  private publish(thread: AgentThread, mark: PrototypeReadyMark | undefined): AgentThread {
    const current = thread.prototypeReady
    if (!mark) {
      if (current === undefined) return thread
      const { prototypeReady: _mark, ...rest } = thread
      void _mark
      return rest
    }
    if (current && current.source === mark.source && samePages(current.pages, mark.pages)) return thread
    return { ...thread, prototypeReady: mark }
  }

  /** Remembers a cleared source, newest last; true when it is new. */
  private add(threadId: string, source: string): boolean {
    const key = keyOf(threadId, source)
    if (this.cleared.has(key)) return false
    this.cleared.set(key, { threadId, source })
    while (this.cleared.size > PROTOTYPES_CLEARED_MAX) this.cleared.delete(this.cleared.keys().next().value!)
    return true
  }
}
