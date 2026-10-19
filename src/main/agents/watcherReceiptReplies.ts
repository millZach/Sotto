import type { AgentMessage, AgentThread } from '../../shared/agents'
import type { WatcherRecord } from '../../shared/watcher'
import { isShownReply } from '../../shared/watcherRoom'
import { watcherWakeUpShown } from './watcherNews'

/** A user message the user is shown. A wake-up holding only Watcher's news is not, so it ends no turn on screen. */
const shownUser = (message: AgentMessage): boolean => message.role === 'user' && watcherWakeUpShown(message) !== null

/**
 * Where each of the current Watcher's receipts shows in its conversation (receipt cards, ADR-0073): under the reply of
 * the Watcher turn the operation was admitted in, never another turn's. That is the turn's last shown reply before the
 * next message of the user's or Sotto's, a hidden wake-up included. When the user wrote into the running turn (a message
 * that began no turn of its own) and the turn's reply came after it, it is that reply. A message that began another turn,
 * shown or hidden, is never crossed: a turn that ended with no shown reply keeps its cards under its own message. The record ties each operation to its
 * turn (`promptTurnId`) and the turn to the message that began it, so nothing here reads a word of anyone's. Each turn is
 * placed once, and each operation is one lookup: this runs on every room update.
 */
export function watcherReceiptReplies(record: Readonly<WatcherRecord>, watcher: AgentThread | undefined): { operationId: string; messageId: string }[] {
  const current = record.current?.target
  if (!current || !watcher || !record.promptTurns?.length) return []
  const roots = new Map<string, string>()
  for (const turn of record.promptTurns) {
    if (turn.rootUserMessageId && turn.watcher.hostId === current.hostId && turn.watcher.threadId === current.threadId) roots.set(turn.id, turn.rootUserMessageId)
  }
  if (roots.size === 0) return []
  // The messages that began a turn: a reply after one of them is that turn's, never an earlier one's.
  const turnStarts = new Set(roots.values())
  const messages = watcher.messages
  const positions = new Map(messages.map((message, index) => [message.id, index] as const))
  const anchors = new Map<string, string | null>()
  const anchorOf = (root: string): string | null => {
    if (anchors.has(root)) return anchors.get(root)!
    const at = positions.get(root)
    let anchor: string | null = null
    if (at !== undefined) {
      let index = at + 1
      for (; index < messages.length && messages[index]!.role !== 'user'; index++) if (isShownReply(messages[index]!)) anchor = messages[index]!.id
      // The user wrote into the running turn before it replied: its reply is the first after their message, up to the next turn.
      for (; anchor === null && index < messages.length; index++) {
        const message = messages[index]!
        if (message.role === 'user' && turnStarts.has(message.id)) break
        if (isShownReply(message)) anchor = message.id
      }
      if (anchor === null && shownUser(messages[at]!)) anchor = root
    }
    anchors.set(root, anchor)
    return anchor
  }
  const placed: { operationId: string; messageId: string }[] = []
  for (const operation of record.operations) {
    const root = operation.promptTurnId === undefined ? undefined : roots.get(operation.promptTurnId)
    const messageId = root === undefined ? null : anchorOf(root)
    if (messageId !== null) placed.push({ operationId: operation.id, messageId })
  }
  return placed
}