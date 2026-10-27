import { AGENT_THREAD_EXCERPT_MAX, type AgentMessage } from '../../shared/agents'
import { sameMessageContent, type ThreadEvent } from '../../shared/threadEvents'
import type { ThreadMessageWindow, ThreadSummaryMessages } from './threadStore'

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
