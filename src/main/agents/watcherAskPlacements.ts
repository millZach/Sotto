import type { AgentMessage, AgentThread } from '../../shared/agents'
import type { WatcherAsk } from '../../shared/watcherAsks'
import type { WatcherRecord } from '../../shared/watcher'
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

type Watcher = Pick<AgentThread, 'messages'> & Partial<Pick<AgentThread, 'status'>>
type Turns = Pick<WatcherRecord, 'promptTurns' | 'current'>

/**
 * The last answer for each history, kept while its messages, its turns and whether it runs stay the same objects: the
 * room is projected on every publish, and a history that has not changed is not read again.
 */
const placedFor = new WeakMap<readonly AgentMessage[], { readonly turns: Turns['promptTurns']; readonly running: boolean; readonly placed: WatcherAskPlacement[] }>()

/**
 * Where each request the current Watcher's wake-ups said waited on the user shows its card in Watcher's conversation
 * (ADR-0073, answering in Watcher's conversation): under the reply of the turn the wake-up began, the reply in which
 * Watcher tells the user about it. That is the turn's last shown reply before the next message; when the user wrote into
 * the running turn (a message that began no turn of its own) and the reply came after it, it is the first reply after
 * that, up to the next turn. A message that began a turn, a wake-up or one the record ties to a turn, is never crossed,
 * as receipt cards place theirs. While that turn still runs with no reply, the card waits for it rather than showing
 * somewhere it would leave when the reply comes. A turn that ended with none puts the card under the wake-up when it is
 * shown, else under the last shown message before it. Read from each wake-up's `watcherAsks` mark, the host's own record
 * of the send, never from anyone's words, and from the window the host holds: a wake-up outside it places nothing.
 */
export function watcherAskPlacements(watcher: Watcher | undefined, record?: Turns): WatcherAskPlacement[] {
  const messages = watcher?.messages
  if (!messages) return []
  const running = watcher?.status === 'running'
  const kept = placedFor.get(messages)
  if (kept && kept.turns === record?.promptTurns && kept.running === running) return kept.placed
  if (!messages.some(message => message.watcherAsks?.length)) {
    placedFor.set(messages, { turns: record?.promptTurns, running, placed: [] })
    return placedFor.get(messages)!.placed
  }
  const current = record?.current?.target
  const turnStarts = new Set<string>()
  for (const turn of record?.promptTurns ?? []) {
    if (turn.rootUserMessageId && current && turn.watcher.hostId === current.hostId && turn.watcher.threadId === current.threadId) turnStarts.add(turn.rootUserMessageId)
  }
  for (const message of messages) if (message.role === 'user' && message.wakeUp === true) turnStarts.add(message.id)
  const placed: WatcherAskPlacement[] = []
  for (const [at, wakeUp] of messages.entries()) {
    if (wakeUp.role !== 'user' || !wakeUp.watcherAsks?.length) continue
    let anchor: string | undefined
    let index = at + 1
    for (; index < messages.length && messages[index]!.role !== 'user'; index++) if (isShownReply(messages[index]!)) anchor = messages[index]!.id
    // The user wrote into the running turn before it replied: its reply is the first after their message, up to the next turn.
    let ended = index < messages.length && turnStarts.has(messages[index]!.id)
    for (; anchor === undefined && !ended && index < messages.length; index++) {
      const message = messages[index]!
      if (message.role === 'user' && turnStarts.has(message.id)) ended = true
      else if (isShownReply(message)) anchor = message.id
    }
    // The turn is still Watcher's current one and has not replied: the card waits for the reply.
    if (anchor === undefined && running && !ended) continue
    if (anchor === undefined && shown(wakeUp)) anchor = wakeUp.id
    for (let before = at - 1; anchor === undefined && before >= 0; before--) if (shown(messages[before]!)) anchor = messages[before]!.id
    if (anchor === undefined) continue
    for (const ask of wakeUp.watcherAsks) placed.push({ ...ask, messageId: anchor, wakeUpMessageId: wakeUp.id })
  }
  placedFor.set(messages, { turns: record?.promptTurns, running, placed })
  return placed
}
