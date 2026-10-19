import type { AgentMessage, AgentThread } from '../../shared/agents'
import type { WatcherAsk } from '../../shared/watcherAsks'
import { isShownReply } from '../../shared/watcherRoom'
import { watcherWakeUpShown } from './watcherNews'

/** One request a wake-up said waited on the user, and the message of the conversation its card goes under. */
export interface WatcherAskPlacement extends WatcherAsk {
  /** The shown message the card goes under. */
  readonly messageId: string
  /** The wake-up that carried it, which may itself be shown nowhere. */
  readonly wakeUpMessageId: string
}

/** A message Watcher's conversation draws: a reply with words, or a user message that is not only Sotto's news. */
const shown = (message: AgentMessage): boolean => message.role === 'assistant' ? isShownReply(message) : watcherWakeUpShown(message) !== null

/**
 * Where each request the current Watcher's wake-ups said waited on the user shows its card in Watcher's conversation
 * (ADR-0073, answering in Watcher's conversation): under the last shown reply of the turn the wake-up began, the reply in
 * which Watcher tells the user about it, or, while that turn has none, under the wake-up itself when it is shown, else
 * under the last shown message before it. A wake-up holding only Watcher's news is shown nowhere, so its cards cannot go
 * under it. Read from each wake-up's `watcherAsks` mark, the host's own record of the send, never from anyone's words, and
 * from the window the host holds: a wake-up outside it places nothing. This runs on every room update, so a history with
 * no asks costs one pass and copies nothing.
 */
export function watcherAskPlacements(watcher: Pick<AgentThread, 'messages'> | undefined): WatcherAskPlacement[] {
  const messages = watcher?.messages
  if (!messages?.some(message => message.watcherAsks?.length)) return []
  const placed: WatcherAskPlacement[] = []
  for (const [at, wakeUp] of messages.entries()) {
    if (wakeUp.role !== 'user' || !wakeUp.watcherAsks?.length) continue
    let anchor: string | undefined
    for (let index = at + 1; index < messages.length && messages[index]!.role !== 'user'; index++) if (isShownReply(messages[index]!)) anchor = messages[index]!.id
    if (anchor === undefined && shown(wakeUp)) anchor = wakeUp.id
    for (let index = at - 1; anchor === undefined && index >= 0; index--) if (shown(messages[index]!)) anchor = messages[index]!.id
    if (anchor === undefined) continue
    for (const ask of wakeUp.watcherAsks) placed.push({ ...ask, messageId: anchor, wakeUpMessageId: wakeUp.id })
  }
  return placed
}
