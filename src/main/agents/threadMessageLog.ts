import { summarizeThread, type AgentMessage, type AgentThreadSummary } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import type { ThreadEvent } from '../../shared/threadEvents'
import type { StoredMessageIdentity, ThreadHostEvent } from './host'

/**
 * One adapter's append path. Every change an adapter makes to what a thread said goes through this
 * object and comes out as a thread event (ADR-0016): the adapter never rebuilds the history, it says
 * what is new and the host's event store keeps the record.
 *
 * What the log holds for a thread is either its messages — while a window is looking at it, or while the
 * adapter is still working with them — or the few facts the adapter itself reads: which IDs it has
 * recorded, which of them were the user's, and the newest message's text so a growing reply is an append
 * rather than a whole message again. A thread nobody is looking at costs those facts and nothing more.
 */

/** The per-message facts the log keeps once a thread's messages are put away. */
interface Track {
  /** The messages the adapter is working with, or undefined once they are put away. */
  messages: AgentMessage[] | undefined
  /** Every message recorded for this thread by ID, with a mark of the text, so a re-read of a provider's
   * own history replaces what actually changed rather than adding a second copy of everything. */
  readonly ids: Map<string, string>
  /** Those IDs in the order they were recorded, which is the order the projection holds them in. */
  order: string[]
  /** The IDs of the user's messages, which is what a stale-reply check and a rewind preview compare. */
  userIds: string[]
  /** The newest message, so a reply that grew by a suffix is recorded as an append. */
  last: { id: string; role: AgentMessage['role']; text: string } | undefined
  /** The newest message with any text in it, which is what an activity row anchors to. */
  lastTextId: string | undefined
  lastUser: AgentMessage | undefined
  lastAssistant: AgentMessage | undefined
  lastMessageAt: string | undefined
  /** Messages opened with no text yet: a stream that has announced a reply but not said anything. An
   * empty message is never recorded, so nothing has to be taken back when the turn drops it. */
  readonly empty: Set<string>
}

function freshTrack(): Track {
  return { messages: [], ids: new Map(), order: [], userIds: [], last: undefined, lastTextId: undefined,
    lastUser: undefined, lastAssistant: undefined, lastMessageAt: undefined, empty: new Set() }
}

/** The mark of a message the store holds whose words the log never saw. The first report of it matches. */
const UNREAD = '?'

/** A short mark of a message's text, so an unchanged one can be recognised without keeping the words. */
function mark(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}:${hash.toString(36)}`
}

/** True when the two messages differ in anything but their text. */
function metadataChanged(previous: AgentMessage, next: AgentMessage): boolean {
  return previous.createdAt !== next.createdAt || previous.commandId !== next.commandId
    || JSON.stringify(previous.attachments ?? []) !== JSON.stringify(next.attachments ?? [])
}

export class ThreadMessageLog {
  private readonly listeners = new Set<(event: ThreadHostEvent) => void>()
  private readonly tracks = new Map<string, Track>()
  private readonly watched = new Set<string>()
  /** False until the host says what it is looking at. Until then no thread's messages are put away. */
  private declared = false

  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The watched set, as `observeThreads` gave it. A thread that left it keeps its facts alone. */
  observe(ids: readonly string[]): void {
    this.declared = true
    this.watched.clear()
    for (const id of ids) this.watched.add(id)
    for (const [id, track] of this.tracks) if (!this.watched.has(id) && track.messages && !this.pinned.has(id)) track.messages = undefined
    for (const id of ids) { const track = this.tracks.get(id); if (track) track.messages ??= [] }
  }

  /** Threads whose messages the adapter is still working with even though no window is looking at them. */
  private readonly pinned = new Set<string>()
  /** Hold this thread's messages while its provider session is open. */
  pin(threadId: string): void {
    this.pinned.add(threadId)
    const track = this.track(threadId)
    track.messages ??= []
  }
  /** Its session is closed: put the messages away unless a window is looking at the thread. */
  release(threadId: string): void {
    this.pinned.delete(threadId)
    const track = this.tracks.get(threadId)
    if (track && this.declared && !this.watched.has(threadId)) track.messages = undefined
  }
  /** Everything about this thread is gone: a disconnection, or a thread that no longer exists. */
  forget(threadId: string): void { this.tracks.delete(threadId); this.pinned.delete(threadId) }
  forgetAll(): void { this.tracks.clear(); this.pinned.clear() }

  /**
   * True while this thread's messages should be in hand: a window is looking at it, its provider session
   * is open, or nothing has said yet what is being looked at.
   */
  private wanted(threadId: string): boolean { return !this.declared || this.watched.has(threadId) || this.pinned.has(threadId) }
  /** True while this thread's messages are in hand rather than put away. */
  holding(threadId: string): boolean { return this.tracks.get(threadId)?.messages !== undefined }

  /** The messages the adapter is working with. Empty once they are put away. */
  messages(threadId: string): AgentMessage[] { return this.track(threadId).messages ?? [] }
  /** What a snapshot carries: the messages while they are in hand, nothing once they are put away. */
  published(threadId: string): AgentMessage[] {
    return structuredClone(this.track(threadId).messages ?? [])
  }
  /** The sidebar's facts, kept as the events went by so a summary never costs a history. */
  summary(threadId: string): AgentThreadSummary {
    const track = this.track(threadId)
    const beside = summarizeThread({ messages: [...(track.lastUser ? [track.lastUser] : []), ...(track.lastAssistant ? [track.lastAssistant] : [])] })
    return { ...beside, messageCount: track.order.length,
      ...(track.lastMessageAt === undefined ? {} : { lastMessageAt: track.lastMessageAt }) }
  }
  /** The same facts with the activity beside them, which is what a thread's own snapshot carries. */
  summaryBeside(threadId: string, activities: readonly AgentActivity[] | undefined): AgentThreadSummary {
    const beside = summarizeThread({ messages: [], activities: activities === undefined ? undefined : [...activities] })
    return { ...this.summary(threadId), activityCount: beside.activityCount,
      ...(beside.runningTurnStartedAt === undefined ? {} : { runningTurnStartedAt: beside.runningTurnStartedAt }) }
  }
  /**
   * One thread as a snapshot carries it: its messages while a window is looking at it, and its summary
   * alone when none is. What the pane draws for a thread outside the watched set comes from the store.
   */
  publishedThread<T extends { id: string; messages: AgentMessage[]; activities?: AgentActivity[] | undefined; summary?: AgentThreadSummary | undefined }>(thread: T): T {
    if (this.holding(thread.id)) return { ...thread, messages: this.published(thread.id) }
    return { ...thread, messages: [], summary: this.summaryBeside(thread.id, thread.activities) }
  }
  count(threadId: string): number { return this.track(threadId).order.length }
  has(threadId: string, messageId: string): boolean { return this.track(threadId).ids.has(messageId) }
  userMessageIds(threadId: string): readonly string[] { return this.track(threadId).userIds }
  lastUserMessageId(threadId: string): string | undefined { return this.track(threadId).userIds.at(-1) }
  lastMessageId(threadId: string): string | undefined { return this.track(threadId).last?.id }
  /** One message as the log holds it, for an adapter adding to a reply it already reported. Present
   * while the thread's messages are in hand, and for the newest message either way. */
  message(threadId: string, messageId: string): AgentMessage | undefined {
    const track = this.track(threadId)
    const held = track.messages?.find(value => value.id === messageId)
    if (held) return { ...held }
    if (track.lastUser?.id === messageId) return { ...track.lastUser }
    if (track.lastAssistant?.id === messageId) return { ...track.lastAssistant }
    return undefined
  }
  /** The newest message recorded, so a stream that grew can be recognised without the whole history. */
  lastMessage(threadId: string): { id: string; role: AgentMessage['role']; text: string } | undefined {
    const last = this.track(threadId).last
    return last === undefined ? undefined : { ...last }
  }
  lastTextMessageId(threadId: string): string | undefined { return this.track(threadId).lastTextId }

  /**
   * What the host's event store already holds for this thread, before the adapter reads its provider.
   * Nothing is published: these messages are already the record. Seeding is what lets a re-read of a
   * provider's own history append its unseen tail instead of adding a second copy of everything.
   */
  seed(threadId: string, identities: readonly (StoredMessageIdentity | AgentMessage)[]): void {
    if (this.tracks.has(threadId) || identities.length === 0) return
    const track = freshTrack()
    // The words stay in the store unless the caller handed them over as well. Without them the first
    // report of a message is taken as the copy the store already holds rather than as a change to it.
    const words = identities.every(identity => 'text' in identity)
    for (const identity of identities) {
      const message = 'text' in identity ? identity : undefined
      track.ids.set(identity.id, message ? mark(message.text) : UNREAD)
      track.order.push(identity.id)
      if (identity.role === 'user') track.userIds.push(identity.id)
      if (message) {
        if (message.role === 'user') track.lastUser = { ...message }
        else track.lastAssistant = { ...message }
        track.last = { id: message.id, role: message.role, text: message.text }
        if (message.text.length) track.lastTextId = message.id
        if (track.lastMessageAt === undefined || Date.parse(message.createdAt) > Date.parse(track.lastMessageAt)) track.lastMessageAt = message.createdAt
      }
    }
    track.messages = words ? identities.map(identity => ({ ...(identity as AgentMessage) })) : undefined
    this.tracks.set(threadId, track)
  }

  /**
   * Record one message the provider reported. An ID the log has not seen is an addition, a reply that
   * grew by a suffix is an append, and anything else about a message already recorded is a replacement.
   * A message opened with no text yet is held back until it says something.
   */
  add(threadId: string, message: AgentMessage): void {
    const track = this.track(threadId)
    const existing = track.messages?.find(value => value.id === message.id)
    if (!track.ids.has(message.id)) {
      if (track.empty.has(message.id)) {
        if (!message.text.length) { if (existing) Object.assign(existing, message); return }
        track.empty.delete(message.id)
      } else if (!message.text.length && message.role === 'assistant') {
        // Nothing was said yet. Keep the place in the window and wait for the first words.
        track.empty.add(message.id)
        if (!existing) track.messages?.push({ ...message })
        return
      }
      if (existing) Object.assign(existing, message)
      else track.messages?.push({ ...message })
      this.publish(threadId, track, { kind: 'message-added', at: message.createdAt || new Date().toISOString(), message: { ...message } })
      return
    }
    if (track.ids.get(message.id) === UNREAD) {
      // The store already holds this one; the provider is reading its own history back to us.
      track.ids.set(message.id, mark(message.text))
      if (existing) Object.assign(existing, message)
      else track.messages?.push({ ...message })
      return
    }
    const previous = track.last?.id === message.id ? track.last : undefined
    if (previous && !metadataChanged(existing ?? message, message)) {
      if (previous.text === message.text) { if (existing) Object.assign(existing, message); return }
      if (message.text.startsWith(previous.text)) {
        const appendText = message.text.slice(previous.text.length)
        if (existing) Object.assign(existing, message)
        this.publish(threadId, track, { kind: 'message-text-appended', at: new Date().toISOString(), messageId: message.id, appendText })
        return
      }
    }
    if (existing ? existing.text === message.text && !metadataChanged(existing, message)
      : track.ids.get(message.id) === mark(message.text)) return
    if (existing) Object.assign(existing, message)
    this.publish(threadId, track, { kind: 'message-replaced', at: new Date().toISOString(), message: { ...message } })
  }

  /** A reply that arrived as a suffix: the stream said more of a message the log already holds. */
  appendText(threadId: string, messageId: string, appendText: string): void {
    if (!appendText.length) return
    const track = this.track(threadId)
    const existing = track.messages?.find(value => value.id === messageId)
    if (track.empty.has(messageId) && !track.ids.has(messageId)) {
      const opened = existing ?? { id: messageId, role: 'assistant' as const, text: '', createdAt: new Date().toISOString() }
      this.add(threadId, { ...opened, text: appendText })
      return
    }
    if (!track.ids.has(messageId)) return
    if (existing) existing.text += appendText
    this.publish(threadId, track, { kind: 'message-text-appended', at: new Date().toISOString(), messageId, appendText })
  }

  /** A confirmed rewind: everything recorded for this thread is dropped and the new epoch written down. */
  reset(threadId: string, historyEpoch?: string): void {
    const track = this.track(threadId)
    const holding = track.messages !== undefined
    this.tracks.set(threadId, { ...freshTrack(), messages: holding ? [] : undefined })
    this.emit(threadId, { kind: 'messages-reset', at: new Date().toISOString(), ...(historyEpoch === undefined ? {} : { historyEpoch }) })
  }

  /**
   * What this thread's provider currently shows. An adapter that recomputes a whole array — a durable
   * history rail merged with a live tail — hands it here, and the log works out what is new: an unseen
   * message is added, a message that grew is appended to. A list that is shorter than what the log
   * already knows is a partial read (a capped poll, a session read afresh after a reap), never a rewind:
   * providers are read to append and never to rebuild (ADR-0016), and only `reset` takes words back.
   */
  set(threadId: string, messages: readonly AgentMessage[]): void {
    for (const message of messages) this.add(threadId, message)
    // Only a list that covers everything the log knows is also what the window should hold.
    const current = this.track(threadId)
    if (!this.wanted(threadId)) { current.messages = undefined; return }
    if (messages.length >= current.order.length) current.messages = messages.map(message => ({ ...message }))
  }

  /**
   * Put this thread's messages in the order the provider's own identities give them. Nothing is
   * published: the order a pane draws is not a change to what was said, and the store keeps the order
   * the events arrived in. A message the predicate drops is dropped from the window alone.
   */
  arrange(threadId: string, keep: (message: AgentMessage) => boolean, rank: (message: AgentMessage) => number): void {
    const track = this.tracks.get(threadId)
    if (!track?.messages) return
    track.messages = track.messages.filter(keep).sort((first, second) => rank(first) - rank(second))
  }

  /** Drop the places kept for messages that never said anything; nothing was recorded for them. */
  dropEmpty(threadId: string): void {
    const track = this.tracks.get(threadId)
    if (!track?.empty.size) return
    if (track.messages) track.messages = track.messages.filter(message => !track.empty.has(message.id))
    track.empty.clear()
  }

  private track(threadId: string): Track {
    let track = this.tracks.get(threadId)
    if (!track) { track = freshTrack(); this.tracks.set(threadId, track) }
    return track
  }

  /** Apply one event to the facts and hand it on. Every event leaves this object here. */
  private publish(threadId: string, track: Track, event: ThreadEvent): void {
    if (event.kind === 'message-added') {
      const { message } = event
      track.ids.set(message.id, mark(message.text))
      track.order.push(message.id)
      if (message.role === 'user') { track.userIds.push(message.id); track.lastUser = { ...message } }
      else track.lastAssistant = { ...message }
      track.last = { id: message.id, role: message.role, text: message.text }
      if (message.text.length) track.lastTextId = message.id
      if (track.lastMessageAt === undefined || Date.parse(message.createdAt) > Date.parse(track.lastMessageAt)) track.lastMessageAt = message.createdAt
    } else if (event.kind === 'message-text-appended') {
      if (track.last?.id === event.messageId) track.last = { ...track.last, text: track.last.text + event.appendText }
      if (track.lastAssistant?.id === event.messageId) track.lastAssistant = { ...track.lastAssistant, text: track.lastAssistant.text + event.appendText }
      if (track.lastUser?.id === event.messageId) track.lastUser = { ...track.lastUser, text: track.lastUser.text + event.appendText }
      const grown = track.last?.id === event.messageId ? track.last.text
        : track.lastAssistant?.id === event.messageId ? track.lastAssistant.text : undefined
      if (grown !== undefined) track.ids.set(event.messageId, mark(grown))
      track.lastTextId = event.messageId
    } else if (event.kind === 'message-replaced') {
      const { message } = event
      track.ids.set(message.id, mark(message.text))
      if (track.last?.id === message.id) track.last = { id: message.id, role: message.role, text: message.text }
      if (message.role === 'user' && track.lastUser?.id === message.id) track.lastUser = { ...message }
      if (message.role === 'assistant' && track.lastAssistant?.id === message.id) track.lastAssistant = { ...message }
      if (message.text.length && track.order.at(-1) === message.id) track.lastTextId = message.id
    }
    this.emit(threadId, event)
  }

  private emit(threadId: string, event: ThreadEvent): void {
    for (const listener of this.listeners) listener({ threadId, event })
  }
}
