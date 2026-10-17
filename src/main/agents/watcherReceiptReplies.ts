import { isVisualMessage, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { WatcherRecord } from '../../shared/watcher'
import { watcherWakeUpShown } from './watcherNews'

/** A reply the transcript draws: written words or attachments, never a visual (ThreadTranscript's `drawn`). */
const drawnReply = (message: AgentMessage): boolean => message.role === 'assistant' && !isVisualMessage(message)
  && (message.text.length > 0 || Boolean(message.attachments?.length))
/** A user message the user is shown. A wake-up holding only Watcher's news is not, so it ends no turn on screen. */
const shownUser = (message: AgentMessage): boolean => message.role === 'user' && watcherWakeUpShown(message) !== null

/**
 * Where each of the current Watcher's receipts shows in its conversation (receipt cards, ADR-0073): under the last reply
 * of the Watcher turn the operation was admitted in, which is the reply the transcript shows for that turn, or under the
 * turn's own message, when it is shown, until a reply comes. The record ties each operation to its turn (`promptTurnId`)
 * and the turn to the message that began it, so nothing here reads a word of anyone's. One pass over the messages, and
 * one lookup per operation: this runs on every room update.
 */
export function watcherReceiptReplies(record: Readonly<WatcherRecord>, watcher: AgentThread | undefined): { operationId: string; messageId: string }[] {
  const current = record.current?.target
  if (!current || !watcher || !record.promptTurns?.length) return []
  const roots = new Map<string, string>()
  for (const turn of record.promptTurns) {
    if (turn.rootUserMessageId && turn.watcher.hostId === current.hostId && turn.watcher.threadId === current.threadId) roots.set(turn.id, turn.rootUserMessageId)
  }
  if (roots.size === 0) return []
  // Each message's place among the shown turns: the last drawn reply after it, before the next user message shown.
  const messages = watcher.messages
  const anchorOf = new Map<string, string | null>()
  let reply: string | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'user') {
      anchorOf.set(message.id, reply ?? (shownUser(message) ? message.id : null))
      if (shownUser(message)) reply = null
    } else if (reply === null && drawnReply(message)) reply = message.id
  }
  const placed: { operationId: string; messageId: string }[] = []
  for (const operation of record.operations) {
    const root = operation.promptTurnId === undefined ? undefined : roots.get(operation.promptTurnId)
    const messageId = root === undefined ? undefined : anchorOf.get(root)
    if (messageId) placed.push({ operationId: operation.id, messageId })
  }
  return placed
}
