import { AGENT_THREAD_EXCERPT_MAX, type AgentMessage } from '../../shared/agents'
import { sameMessageContent, type ThreadEvent } from '../../shared/threadEvents'
import { EMPTY_WINDOW, type ThreadMessageWindow, type ThreadSummaryMessages } from './threadStore'

/**
 * What main shows of a write it posted and the thread store has not confirmed (#1457): the events laid over what the
 * store returns, the way the store's projection would apply them once they commit. A window, a whole history and a
 * summary each read the store and then these, so a read straight after a post sees it without waiting for the commit.
 */

/** A message as the store's projection reads it back: the columns it keeps, in the order it reads them. */
export function projectedMessage(message: AgentMessage): AgentMessage {
  return {
    id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
    ...(message.commandId === undefined ? {} : { commandId: message.commandId }),
    ...(message.turnMessageId === undefined ? {} : { turnMessageId: message.turnMessageId }),
    ...(message.attachments === undefined || message.attachments.length === 0 ? {} : { attachments: message.attachments }),
    ...(message.watcherOwnChange === undefined ? {} : { watcherOwnChange: message.watcherOwnChange }),
    ...(message.watcherObservedChanges === undefined ? {} : { watcherObservedChanges: message.watcherObservedChanges }),
  }
}

/** A stored message replaced as the projection replaces it: a Sotto mark the replacement omits is kept, and so is its turn anchor. */
function replacedMessage(held: AgentMessage, message: AgentMessage): AgentMessage {
  return projectedMessage({ ...message,
    turnMessageId: held.turnMessageId ?? message.turnMessageId,
    watcherOwnChange: message.watcherOwnChange ?? held.watcherOwnChange,
    watcherObservedChanges: message.watcherObservedChanges ?? held.watcherObservedChanges })
}

/**
 * A window of the newest messages with these events laid over it. A message outside the window that an event changes is
 * read from the store with `stored`, and changed there in turn, so an alias decides as the store would. A window asked
 * for in turns keeps every message the events add, so it may hold more turns than asked until it is read again.
 */
export function applyEventsToWindow(window: ThreadMessageWindow, events: readonly ThreadEvent[], stored: (id: string) => AgentMessage | undefined): ThreadMessageWindow {
  if (events.length === 0) return window
  let messages: AgentMessage[] | undefined
  const own = (): AgentMessage[] => (messages ??= [...window.messages])
  const list = (): readonly AgentMessage[] => messages ?? window.messages
  let { earlierAvailable, firstPosition, lastPosition } = window
  /** Messages outside the window as these events leave them; undefined once one is gone. */
  const outside = new Map<string, AgentMessage | undefined>()
  const read = (id: string): AgentMessage | undefined => {
    const inside = list().find(message => message.id === id)
    if (inside || !earlierAvailable) return inside
    if (!outside.has(id)) outside.set(id, stored(id))
    return outside.get(id)
  }
  const change = (id: string, next: (held: AgentMessage) => AgentMessage | undefined): void => {
    const index = list().findIndex(message => message.id === id)
    if (index >= 0) {
      const changed = next(list()[index]!)
      if (changed) own()[index] = changed
      else own().splice(index, 1)
      return
    }
    const held = read(id)
    if (held) outside.set(id, next(held))
  }
  for (const event of events) {
    switch (event.kind) {
      case 'messages-reset':
        messages = []
        outside.clear()
        earlierAvailable = false
        firstPosition = -1
        lastPosition = -1
        break
      case 'message-added':
        own().push(projectedMessage(event.message))
        if (firstPosition < 0) firstPosition = lastPosition + 1
        lastPosition++
        break
      case 'message-text-appended':
        change(event.messageId, held => ({ ...held, text: held.text + event.appendText }))
        break
      case 'message-replaced':
        change(event.message.id, held => replacedMessage(held, event.message))
        break
      case 'message-aliased': {
        const duplicate = read(event.messageId), canonical = read(event.canonicalId)
        if (event.messageId !== event.canonicalId && duplicate && canonical && sameMessageContent(duplicate, canonical)) change(event.messageId, () => undefined)
        break
      }
      case 'answer-given':
        break
    }
  }
  return messages ? { ...window, messages, earlierAvailable, firstPosition, lastPosition } : window
}

/**
 * A summary's messages with these events laid over them, for `summaryOf` alone: words appended past what its excerpt
 * shows are left off. An alias, or a replacement that changes a message's role, leaves them as the store holds them
 * until the commit reads them again: an alias takes out a duplicate with the same words, so only its identity and the
 * count can differ meanwhile.
 */
export function applyEventsToSummary(summary: ThreadSummaryMessages, events: readonly ThreadEvent[]): ThreadSummaryMessages {
  if (events.length === 0) return summary
  let { count, user, assistant } = summary
  for (const event of events) {
    switch (event.kind) {
      case 'messages-reset':
        count = 0; user = undefined; assistant = undefined
        break
      case 'message-added': {
        count++
        const message = projectedMessage(event.message)
        if (message.role === 'user') user = message
        else assistant = message
        break
      }
      case 'message-text-appended':
        // Only a summary's excerpt reads the words, so an append past what it shows is not copied.
        if (user?.id === event.messageId && user.text.length < AGENT_THREAD_EXCERPT_MAX) user = { ...user, text: user.text + event.appendText }
        if (assistant?.id === event.messageId && assistant.text.length < AGENT_THREAD_EXCERPT_MAX) assistant = { ...assistant, text: assistant.text + event.appendText }
        break
      case 'message-replaced':
        if (user?.id === event.message.id && event.message.role === 'user') user = replacedMessage(user, event.message)
        if (assistant?.id === event.message.id && event.message.role === 'assistant') assistant = replacedMessage(assistant, event.message)
        break
      case 'message-aliased':
      case 'answer-given':
        break
    }
  }
  return { count, user, assistant }
}

/**
 * One message as the store will hold it once these events commit: read from the store by its ID, with the events that
 * name it laid over it, so a read of one message while a write is in flight reads one message rather than the history.
 * An alias reads its canonical message the same way.
 */
export function applyEventsToMessage(messageId: string, events: readonly ThreadEvent[], stored: (id: string) => AgentMessage | undefined): AgentMessage | undefined {
  if (events.length === 0) return stored(messageId)
  const needed = new Set([messageId])
  for (const event of events) if (event.kind === 'message-aliased' && event.messageId === messageId) needed.add(event.canonicalId)
  const states = new Map<string, AgentMessage | undefined>()
  /** After a reset, a message the events have not named is no longer held. */
  let cleared = false
  const held = (id: string): AgentMessage | undefined => {
    if (!states.has(id)) states.set(id, cleared ? undefined : stored(id))
    return states.get(id)
  }
  for (const event of events) {
    switch (event.kind) {
      case 'messages-reset':
        states.clear()
        cleared = true
        break
      case 'message-added':
        // A second row under the same identity is never the one read back.
        if (needed.has(event.message.id) && !held(event.message.id)) states.set(event.message.id, projectedMessage(event.message))
        break
      case 'message-text-appended': {
        const message = needed.has(event.messageId) ? held(event.messageId) : undefined
        if (message) states.set(event.messageId, { ...message, text: message.text + event.appendText })
        break
      }
      case 'message-replaced': {
        const message = needed.has(event.message.id) ? held(event.message.id) : undefined
        if (message) states.set(event.message.id, replacedMessage(message, event.message))
        break
      }
      case 'message-aliased': {
        if (event.messageId !== messageId || event.messageId === event.canonicalId) break
        const duplicate = held(event.messageId), canonical = held(event.canonicalId)
        if (duplicate && canonical && sameMessageContent(duplicate, canonical)) states.set(messageId, undefined)
        break
      }
      case 'answer-given':
        break
    }
  }
  return held(messageId)
}

/** A message's identity as the store lists it: what an adapter recognises a stored message by. */
export interface MessageIdentity { readonly id: string; readonly role: AgentMessage['role']; readonly turnMessageId?: string }

const identityOf = (message: AgentMessage): MessageIdentity =>
  ({ id: message.id, role: message.role, ...(message.turnMessageId === undefined ? {} : { turnMessageId: message.turnMessageId }) })

/**
 * Every message's identity, oldest first, as the store will list them once these events commit. It reads identities, not
 * words: only an alias reads the two messages it names, to decide as the projection does.
 */
export function applyEventsToIdentities(identities: readonly MessageIdentity[], events: readonly ThreadEvent[], stored: (id: string) => AgentMessage | undefined): readonly MessageIdentity[] {
  if (events.length === 0) return identities
  let list: MessageIdentity[] = [...identities]
  for (const [index, event] of events.entries()) {
    switch (event.kind) {
      case 'messages-reset':
        list = []
        break
      case 'message-added':
        list.push(identityOf(projectedMessage(event.message)))
        break
      case 'message-replaced': {
        const at = list.findIndex(identity => identity.id === event.message.id)
        // The projection keeps a turn anchor it already holds.
        if (at >= 0) list[at] = { ...identityOf(event.message), ...(list[at]!.turnMessageId === undefined ? {} : { turnMessageId: list[at]!.turnMessageId! }) }
        break
      }
      case 'message-aliased': {
        if (event.messageId === event.canonicalId || !list.some(identity => identity.id === event.messageId) || !list.some(identity => identity.id === event.canonicalId)) break
        const before = events.slice(0, index)
        const duplicate = applyEventsToMessage(event.messageId, before, stored), canonical = applyEventsToMessage(event.canonicalId, before, stored)
        if (duplicate && canonical && sameMessageContent(duplicate, canonical)) list = list.filter(identity => identity.id !== event.messageId)
        break
      }
      case 'message-text-appended':
      case 'answer-given':
        break
    }
  }
  return list
}

/** Whether these events only add to messages and change them in place, so every stored message keeps its position. */
export function keepsPositions(events: readonly ThreadEvent[]): boolean {
  return events.every(event => event.kind !== 'messages-reset' && event.kind !== 'message-aliased')
}

/**
 * A page of a thread's history read by count (`readMessages` with `limit` and `beforePosition`) with events laid over it
 * that keep every stored message's position (`keepsPositions`): stored messages keep theirs, and each added message takes
 * the next after the store's last. `lastStored` is the store's last position, or -1. Only the page is read.
 */
export function pageWithEvents(read: (options: { limit?: number; beforePosition?: number }) => ThreadMessageWindow, lastStored: number,
  events: readonly ThreadEvent[], options: { limit?: number; beforePosition?: number }): ThreadMessageWindow {
  const added = events.filter((event): event is Extract<ThreadEvent, { kind: 'message-added' }> => event.kind === 'message-added').map(event => projectedMessage(event.message))
  const last = lastStored + added.length
  const end = Math.min(options.beforePosition ?? last + 1, last + 1)
  const first = options.limit === undefined ? 0 : Math.max(0, end - options.limit)
  if (end <= first) return EMPTY_WINDOW
  const storedEnd = Math.min(end, lastStored + 1)
  const fromStore = storedEnd > first ? read({ limit: storedEnd - first, beforePosition: storedEnd }).messages : []
  const fromEvents = added.slice(Math.max(0, first - lastStored - 1), Math.max(0, end - lastStored - 1))
  const messages = [...fromStore, ...fromEvents]
  const at = new Map(messages.map((message, index) => [message.id, index]))
  for (const event of events) {
    if (event.kind === 'message-text-appended') {
      const index = at.get(event.messageId)
      if (index !== undefined) messages[index] = { ...messages[index]!, text: messages[index]!.text + event.appendText }
    } else if (event.kind === 'message-replaced') {
      const index = at.get(event.message.id)
      if (index !== undefined) messages[index] = replacedMessage(messages[index]!, event.message)
    }
  }
  return { messages, earlierAvailable: first > 0, firstPosition: first, lastPosition: end - 1 }
}
