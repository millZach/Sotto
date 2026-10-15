import { isVisualMessage, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { AgentActivity } from '../../shared/agentActivity'
import type { WatcherOperation, WatcherOutcome } from '../../shared/watcher'
import { watcherBackgroundWorkCount } from './watcherWakeUp'

/** Outcomes nothing later can change: an observation never moves one of these again. */
export const WATCHER_FINAL_OUTCOMES: ReadonlySet<WatcherOutcome> = new Set(['answered', 'failed', 'stopped', 'paused', 'unknown'])

/** What one observation of a thread proves about a delegation's turn. Identities only, never words. */
export interface WatcherTurnOutcome {
  readonly outcome: WatcherOutcome
  /** The Sotto user message the answering turn began with. */
  readonly turnMessageId?: string
  /** The provider's own ID for that turn, when the thread proves the two are the same turn. */
  readonly nativeTurnId?: string
  /** The turn's final reply, the last message the worker wrote in it. */
  readonly replyMessageId?: string
}

interface Turn { readonly anchor: number; readonly turnId: string; status: AgentActivity['status']; readonly steered: boolean
  readonly startedAt?: string | undefined; nativeTurnId?: string }

/**
 * The thread's turns, each at the user message it began with, oldest first. Claude Code and Grok Build name a turn by
 * that message; Codex names its own and records the message as the turn's anchor. A turn whose anchor is not a retained
 * user message cannot be placed, so it is left out rather than guessed.
 */
function turnsOf(thread: AgentThread, messages: readonly AgentMessage[]): Turn[] {
  const index = new Map(messages.map((message, position) => [message.id, position]))
  const user = (id: string | undefined) => { const at = id === undefined ? undefined : index.get(id); return at !== undefined && messages[at]!.role === 'user' ? at : undefined }
  const turns = new Map<number, Turn>()
  for (const activity of thread.activities ?? []) if (activity.kind === 'turn') {
    const anchor = user(activity.turnId) ?? user(activity.afterMessageId)
    if (anchor !== undefined) turns.set(anchor, { anchor, turnId: activity.turnId, status: activity.status, steered: activity.steered === true, startedAt: activity.startedAt })
  }
  // The thread's newest turn as its provider reports it, which can be ahead of the activity record. Only an exact match
  // of identities ties the two: the Sotto anchor a Watcher adapter reports, or the same ID.
  const last = thread.lastTurn
  if (last) {
    const anchor = user(last.messageId) ?? user(last.id)
    const known = [...turns.values()].find(turn => turn.turnId === last.id || anchor !== undefined && turn.anchor === anchor)
    if (known && known.anchor === Math.max(...turns.keys())) { known.status = last.status; known.nativeTurnId = last.id }
    else if (!known && anchor !== undefined && anchor > Math.max(-1, ...turns.keys())) turns.set(anchor, { anchor, turnId: last.id, status: last.status, steered: false, nativeTurnId: last.id })
  }
  return [...turns.values()].sort((a, b) => a.anchor - b.anchor)
}

/**
 * Where an accepted start or send stands in its thread, from the thread alone. The brief's own message ties it to a turn:
 * the turn that message began, or for a steer the running turn it was read into, so a steer shares that turn's answer and
 * a queued send gets its own. A turn the provider cut for a steer of Watcher's goes on in the next one; one cut by the
 * user's own message is paused. Undefined when the thread does not yet show the brief, so nothing is concluded.
 * `watcherMessage` says whether a user message is one Watcher sent, rather than the user's own.
 */
export function watcherTurnOutcome(operation: Pick<WatcherOperation, 'messageId' | 'delivery'>, thread: AgentThread,
  watcherMessage: (messageId: string) => boolean): WatcherTurnOutcome | undefined {
  if (!operation.messageId) return undefined
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const at = messages.findIndex(message => message.role === 'user' && message.id === operation.messageId)
  if (at < 0) return undefined
  const turns = turnsOf(thread, messages)
  let index = turns.findIndex(turn => turn.anchor === at)
  // A steer read into a running turn begins none of its own. Anything else waits for the turn its message begins.
  if (index < 0 && operation.delivery === 'steer') index = turns.findLastIndex(turn => turn.anchor < at)
  if (index < 0) return { outcome: 'working' }
  while (turns[index]!.status === 'interrupted' && turns[index]!.steered && index + 1 < turns.length && watcherMessage(messages[turns[index + 1]!.anchor]!.id)) index++
  const turn = turns[index]!, next = turns[index + 1]
  const reference = { turnMessageId: messages[turn.anchor]!.id, ...(turn.nativeTurnId ? { nativeTurnId: turn.nativeTurnId } : {}) }
  if (turn.status === 'running') return { outcome: 'working', ...reference }
  if (turn.status === 'failed') return { outcome: 'failed', ...reference }
  if (turn.status === 'unknown') return { outcome: 'unknown', ...reference }
  if (turn.status === 'interrupted') {
    // A turn cut before it answered: the user's own next message holds the thread, or it was stopped.
    return { outcome: next && !watcherMessage(messages[next.anchor]!.id) ? 'paused' : 'stopped', ...reference }
  }
  // Finished. The newest turn is not done while the work it left running goes on, or while that work is unknown.
  if (!next && (thread.status === 'running' || watcherBackgroundWorkCount(thread) > 0 || (thread.subagentSummary?.unknown ?? 0) > 0)) {
    return { outcome: 'background', ...reference }
  }
  const reply = messages.findLast((message, position) => message.role === 'assistant' && turnOfReply(turns, position, message) === turn)
  return { outcome: 'answered', ...reference, ...(reply ? { replyMessageId: reply.id } : {}) }
}

/**
 * The turn a worker's message belongs to: the newest turn begun above it that had started when it was written. A steer
 * Claude Code held past a turn's end is shown where it was sent, above the reply that turn still gave, but its own turn
 * starts after that reply, so position alone would give the reply to the steer. Without a start time, position decides.
 */
function turnOfReply(turns: readonly Turn[], position: number, message: AgentMessage): Turn | undefined {
  const above = turns.filter(turn => turn.anchor < position)
  const written = Date.parse(message.createdAt)
  return above.findLast(turn => turn.startedAt === undefined || Number.isNaN(written) || Date.parse(turn.startedAt) <= written) ?? above.at(-1)
}

/** The newest turn's Sotto anchor, for naming the delegation a turn's news answers. */
export function watcherLatestTurnMessageId(thread: AgentThread): string | undefined {
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const turns = turnsOf(thread, messages)
  const latest = turns.at(-1)
  return latest ? messages[latest.anchor]!.id : undefined
}
