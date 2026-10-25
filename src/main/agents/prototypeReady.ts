import { isVisualMessage, type AgentHostSnapshot, type AgentMessage, type AgentThread, type PrototypeReady as PrototypeReadyMark, type QuestionPage } from '../../shared/agents'
import { settledIn } from './finishedUnread'
import type { QuestionPages, ReplyToSearch } from './questionPages'
import { replySource, requestSource } from './prototypeSources'
import { isSottoRequest } from './sottoRequests'

/** How many cleared sources are kept, newest last; the oldest go once the list is full. */
export const PROTOTYPES_CLEARED_MAX = 500
/** How many threads' kept replies are kept, newest last: a thread deleted with its mark standing leaves one behind. */
export const PROTOTYPES_MARKED_MAX = 200

/** A source whose mark the user cleared: a page of it was opened, or the question after it was answered. */
export interface ClearedPrototype { readonly threadId: string; readonly source: string }
/** A reply that earned a thread's mark and keeps it until the user opens its page or replies after it, as it is saved. */
export interface MarkedPrototype { readonly threadId: string; readonly messageId: string; readonly createdAt: string }

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
/** A message the user wrote: theirs, and not a wake-up Sotto sent. */
const usersReply = (thread: AgentThread, message: AgentMessage): boolean => message.role === 'user' && !wakeUp(thread, message.id, message.wakeUp === true)

/**
 * Whether the summary says the user wrote after a reply written at `createdAt`: its last user message, when that is not
 * a wake-up and is dated after the reply. A summary whose last user message is a wake-up says nothing of what came before
 * it, and is read as no reply.
 */
function summaryRepliedAfter(thread: AgentThread, createdAt: string): boolean {
  const last = thread.summary?.lastUser
  return last !== undefined && !wakeUp(thread, last.id) && Date.parse(last.createdAt) > Date.parse(createdAt)
}

/** Whether the user wrote in the thread after its newest reply: any user message after it, or the summary's word. */
function repliedAfter(thread: AgentThread, reply: NewestReply): boolean {
  if (reply.index === undefined) return summaryRepliedAfter(thread, reply.createdAt)
  for (let index = thread.messages.length - 1; index > reply.index; index--) if (usersReply(thread, thread.messages[index]!)) return true
  return false
}

/**
 * A thread's kept reply. `scan` remembers how far its messages were read: the first message's ID, how many were read,
 * and where the reply sits among them, or -1 when it was not there. A thread's messages grow at their end, so each
 * update reads only what came since, never the whole history after the reply.
 */
interface Kept { readonly messageId: string; readonly createdAt: string; scan?: { first: string; through: number; index: number } }

const samePages = (left: readonly QuestionPage[], right: readonly QuestionPage[]): boolean =>
  left === right || (left.length === right.length && left.every((page, index) => page.token === right[index]!.token && page.start === right[index]!.start && page.name === right[index]!.name && page.kind === right[index]!.kind))

const keyOf = (threadId: string, source: string): string => `${threadId}\n${source}`

/**
 * Prototype ready for review (ADR-0108). The coordinator marks a thread whose waiting question carries a working page,
 * or that has a reply, from a turn that ended, that named one; a question comes first. The mark carries those pages,
 * with the tokens QuestionPages serves them under, and names its source: `request:<ID>` or `reply:<message ID>`.
 *
 * A reply's mark is kept by its thread until the user opens one of its pages, from any client, or replies after it;
 * answering a question is replying. The thread running on does not end it, nor does a newer reply that names no page; a
 * newer reply that names a working page takes its place. Kept replies are saved, so a restart keeps them, and a source
 * opened or answered is remembered and saved, so a restart does not bring its mark back. Showing the thread does not clear
 * it. Watcher's own threads and settled threads are never marked: settled is quiet, as it is for Just finished.
 */
export class PrototypeReady {
  /** Cleared sources, oldest first: a map keeps the order things were added in. */
  private readonly cleared = new Map<string, ClearedPrototype>()
  /** Per thread, the reply that keeps its mark, oldest first. Saved. */
  private readonly kept = new Map<string, Kept>()
  /** Per thread, the newest reply while one of its questions waited, so the user answering the question clears that reply. Ephemeral. */
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

  /**
   * Told of each thread whose kept reply or cleared source was let go to make room (`by` is the thread whose own made the
   * room), since that can change the thread's mark though nothing changed in the thread. A caller that reads only the
   * threads that changed reads it again (#925). Unset, nothing is told.
   */
  onEvicted: ((threadId: string, by: string) => void) | undefined

  /** When marks began, as the coordinator saves it. */
  since(): number | undefined { return this.began }

  /**
   * Takes the saved sources back at start, keeping any cleared since, when marks began when that was saved, and the kept
   * replies, keeping any thread's newer one.
   */
  restore(saved: readonly ClearedPrototype[], began?: number, marked: readonly MarkedPrototype[] = []): void {
    if (began !== undefined) this.began = began
    const since = [...this.cleared.values()]
    this.cleared.clear()
    for (const item of [...saved, ...since]) this.add(item.threadId, item.source)
    for (const item of marked) if (!this.kept.has(item.threadId)) this.keep(item.threadId, item.messageId, item.createdAt)
  }

  /** The cleared sources as the coordinator saves them. */
  saved(): ClearedPrototype[] { return [...this.cleared.values()] }

  /** The kept replies as the coordinator saves them. */
  marked(): MarkedPrototype[] {
    return Array.from(this.kept, ([threadId, kept]) => ({ threadId, messageId: kept.messageId, createdAt: kept.createdAt }))
  }

  /**
   * A page was opened by its token, from the desktop or through the page route. Its source is remembered whether or not
   * it is the mark now: the user has seen it. True when that is new.
   */
  opened(token: string): boolean {
    const found = this.pages.source(token)
    if (!found) return false
    let changed = this.add(found.threadId, found.source)
    // A question's pages are mostly the reply's before it, under tokens of their own: opening one reviews the prototype
    // the reply keeping the mark offered too, so the mark does not fall back to it.
    const kept = this.kept.get(found.threadId)
    if (kept) { changed = this.add(found.threadId, replySource(kept.messageId)) || changed; this.kept.delete(found.threadId) }
    return changed
  }

  /**
   * The replies of each of the snapshot's threads whose pages are wanted, for QuestionPages to look in: the newest while
   * it could earn the mark, and the kept one while it holds it, so its pages keep their tokens.
   */
  replies(snapshot: Pick<AgentHostSnapshot, 'projects'>): (thread: AgentThread) => ReplyToSearch | readonly ReplyToSearch[] | undefined {
    const settled = settledIn(snapshot)
    return thread => {
      if (!this.markable(thread, settled)) return undefined
      const reply = this.wantedReply(thread)
      const newest = reply && (reply.text !== undefined ? { id: reply.id, text: reply.text } : { id: reply.id, summary: reply.summary ?? '' })
      const kept = this.kept.get(thread.id)
      if (!kept || kept.messageId === reply?.id) return newest
      const keptReply = this.keptReply(thread, kept)
      return newest && keptReply ? [newest, keptReply] : newest ?? keptReply
    }
  }

  /**
   * The user answered one of the thread's questions (ADR-0108): that is replying to the reply before it, and to the reply
   * that keeps its mark. Only the coordinator's answer path says so, never a question's leaving, which Sotto's own
   * send-back and a provider's withdrawal cause as well. True when a source was cleared.
   */
  answered(threadId: string): boolean {
    const before = this.asked.get(threadId), kept = this.kept.get(threadId)
    let changed = false
    if (before !== undefined) changed = this.add(threadId, replySource(before)) || changed
    if (kept) { changed = this.add(threadId, replySource(kept.messageId)) || changed; this.kept.delete(threadId) }
    return changed
  }

  /**
   * The snapshot with each thread's mark on it. Threads with nothing to change keep their own object, and so does the
   * snapshot. With `gone`, the snapshot holds only the threads that changed (#925) and `gone` names the threads that went,
   * whose question is let go; every other thread is as the last snapshot left it.
   */
  decorate(snapshot: AgentHostSnapshot, gone?: ReadonlySet<string>): AgentHostSnapshot {
    const settled = settledIn(snapshot)
    let threads: AgentThread[] | undefined
    for (let index = 0; index < snapshot.threads.length; index++) {
      const thread = snapshot.threads[index]!
      const next = this.publish(thread, this.markable(thread, settled) ? this.markOf(thread) : this.forget(thread.id))
      if (next !== thread) (threads ??= [...snapshot.threads])[index] = next
    }
    if (gone) for (const id of gone) this.asked.delete(id)
    else if (this.asked.size) {
      // One set of the threads present, so the cleanup grows with the threads rather than with threads times questions.
      const present = new Set<string>()
      for (const thread of snapshot.threads) present.add(thread.id)
      for (const id of this.asked.keys()) if (!present.has(id)) this.asked.delete(id)
    }
    return threads ? { ...snapshot, threads } : snapshot
  }

  private markable(thread: AgentThread, settled: (thread: AgentThread) => boolean): boolean {
    return thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && !settled(thread)
  }

  /** A thread that cannot be marked: settled, or Watcher's. Its question and its kept reply go. */
  private forget(threadId: string): undefined { this.asked.delete(threadId); this.kept.delete(threadId); return undefined }

  private markOf(thread: AgentThread): PrototypeReadyMark | undefined {
    let mark: PrototypeReadyMark | undefined, waits = false
    for (const request of thread.requests) {
      if (request.kind !== 'question' || isSottoRequest(request.id)) continue
      waits = true
      const source = requestSource(request.id)
      if (mark || this.cleared.has(keyOf(thread.id, source))) continue
      const working = this.pages.searched(thread.id, source)?.working
      if (working?.length) mark = { source, pages: working as QuestionPage[] }
    }
    if (waits) {
      const reply = newestReplyOf(thread)
      if (reply) this.asked.set(thread.id, reply.id)
    } else {
      // No question waits now. One the user answered cleared its replies through answered(); one that left otherwise, sent
      // back by Sotto or withdrawn by its provider, clears nothing: the user has not replied.
      this.asked.delete(thread.id)
      // The newest reply that names a working page takes the mark, from any reply that held it before.
      const reply = this.wantedReply(thread)
      const working = reply && this.pages.searched(thread.id, replySource(reply.id))?.working
      if (working?.length) {
        if (this.kept.get(thread.id)?.messageId !== reply!.id) this.keep(thread.id, reply!.id, reply!.createdAt)
        return { source: replySource(reply!.id), pages: working as QuestionPage[] }
      }
    }
    const kept = this.kept.get(thread.id)
    if (!kept) return mark
    if (this.cleared.has(keyOf(thread.id, replySource(kept.messageId))) || this.repliedAfterKept(thread, kept)) { this.kept.delete(thread.id); return mark }
    if (mark) return mark
    const working = this.pages.searched(thread.id, replySource(kept.messageId))?.working
    return working?.length ? { source: replySource(kept.messageId), pages: working as QuestionPage[] } : undefined
  }

  /** The newest reply when it could earn the mark: its turn has ended, nothing waits, the user has not replied or opened it. */
  private wantedReply(thread: AgentThread): NewestReply | undefined {
    if (thread.status === 'running' || thread.requests.length) return undefined
    const reply = newestReplyOf(thread)
    if (!reply || this.cleared.has(keyOf(thread.id, replySource(reply.id))) || repliedAfter(thread, reply)) return undefined
    if (this.began !== undefined && !(Date.parse(reply.createdAt) >= this.began)) return undefined
    return reply
  }

  /**
   * A kept reply as QuestionPages looks in it: its words where the thread carries them, its summary when that is of it,
   * and otherwise its ID alone, for QuestionPages to read it from the thread's store. Its words matter only for a search
   * not yet made, after a restart, so a thread that carries neither messages nor a summary yet, as one still loading after
   * a restart, names nothing: a search then would find no words and keep that answer.
   */
  private keptReply(thread: AgentThread, kept: Kept): ReplyToSearch | undefined {
    if (!thread.messages.length && !thread.summary) return undefined
    const index = kept.scan?.index ?? -1
    const carried = index >= 0 ? thread.messages[index] : undefined
    if (carried?.id === kept.messageId) return { id: kept.messageId, text: carried.text }
    const last = thread.summary?.lastAssistant
    return last?.id === kept.messageId ? { id: kept.messageId, summary: last.text } : { id: kept.messageId }
  }

  /**
   * Whether the user wrote after a kept reply: a user message after it that is not a wake-up, read only from where the
   * last update stopped. When the thread's messages do not hold the reply, the summary says, as for a summarized thread.
   */
  private repliedAfterKept(thread: AgentThread, kept: Kept): boolean {
    const { messages } = thread
    if (!messages.length) return summaryRepliedAfter(thread, kept.createdAt)
    let scan = kept.scan
    if (!scan || scan.first !== messages[0]!.id || scan.through > messages.length || (scan.index >= 0 && messages[scan.index]?.id !== kept.messageId)) {
      scan = kept.scan = { first: messages[0]!.id, through: 0, index: -1 }
    }
    for (let at = scan.through; at < messages.length; at++) {
      const message = messages[at]!
      if (scan.index < 0) { if (message.id === kept.messageId) scan.index = at }
      else if (usersReply(thread, message)) return true
    }
    scan.through = messages.length
    return scan.index < 0 && summaryRepliedAfter(thread, kept.createdAt)
  }

  /** Keeps a reply as its thread's mark, newest last. */
  private keep(threadId: string, messageId: string, createdAt: string): void {
    this.kept.delete(threadId)
    this.kept.set(threadId, { messageId, createdAt })
    while (this.kept.size > PROTOTYPES_MARKED_MAX) {
      const oldest = this.kept.keys().next().value!
      this.kept.delete(oldest)
      this.onEvicted?.(oldest, threadId)
    }
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
    while (this.cleared.size > PROTOTYPES_CLEARED_MAX) {
      const oldest = this.cleared.keys().next().value!
      const evicted = this.cleared.get(oldest)!
      this.cleared.delete(oldest)
      this.onEvicted?.(evicted.threadId, threadId)
    }
    return true
  }
}
