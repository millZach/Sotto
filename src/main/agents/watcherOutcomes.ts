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

interface Turn { readonly anchor: number; readonly messageId: string; readonly turnId: string; status: AgentActivity['status']; readonly steered: boolean
  readonly startedAt?: string | undefined; readonly completedAt?: string | undefined; readonly observed: boolean; nativeTurnId?: string }

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
    if (anchor !== undefined) turns.set(anchor, { anchor, messageId: messages[anchor]!.id, turnId: activity.turnId, status: activity.status, steered: activity.steered === true, startedAt: activity.startedAt,
      completedAt: activity.completedAt, observed: activity.timingSource === 'observed' })
  }
  // The thread's newest turn as its provider reports it, which can be ahead of the activity record. Only an exact match
  // of identities ties the two: the Sotto anchor an adapter reports, or the same ID.
  const last = thread.lastTurn
  if (last) {
    const anchor = user(last.messageId) ?? user(last.id)
    const known = [...turns.values()].find(turn => turn.turnId === last.id || anchor !== undefined && turn.anchor === anchor)
    if (known && known.anchor === Math.max(...turns.keys())) { known.status = last.status; known.nativeTurnId = last.id }
    else if (!known && anchor !== undefined && anchor > Math.max(-1, ...turns.keys())) turns.set(anchor, { anchor, messageId: messages[anchor]!.id, turnId: last.id, status: last.status, steered: false, observed: false, nativeTurnId: last.id })
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
export function watcherTurnOutcome(operation: Pick<WatcherOperation, 'messageId' | 'delivery' | 'outcome'>, thread: AgentThread,
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
  // A turn cut for a steer goes on in the turn the steer runs as, which may not be shown yet.
  if (turn.status === 'interrupted' && turn.steered && !next) return { outcome: 'working', ...reference }
  if (turn.status === 'interrupted') {
    // A turn cut before it answered: the user's own next message holds the thread, or it was stopped.
    return { outcome: next && !watcherMessage(messages[next.anchor]!.id) ? 'paused' : 'stopped', ...reference }
  }
  // Finished. The newest turn is not done while the work it left running goes on, or while that work is unknown: the
  // same count, unknown sub-agents included, that owes its finish work-settled news. A turn already seen in background
  // stays there while any work remains, even once another turn has begun: the thread's count cannot say whose work it
  // is, so it is not taken as ended until it reaches zero.
  const working = watcherBackgroundWorkCount(thread) > 0
  if (!next && (thread.status === 'running' || working) || next && operation.outcome === 'background' && working) {
    return { outcome: 'background', ...reference }
  }
  const reply = messages.findLast((message, position) => message.role === 'assistant' && turnOfReply(turns, position, message) === turn)
  return { outcome: 'answered', ...reference, ...(reply ? { replyMessageId: reply.id } : {}) }
}

/**
 * The turn a worker's message belongs to: the newest turn begun above it that had started when it was written. A steer
 * Claude Code held past a turn's end is shown where it was sent, above the reply that turn still gave, but its own turn
 * starts after that reply, so position alone would give the reply to the steer. Without a start time, position decides.
 * The turn before often ends, and the steer's turn begins, in the very millisecond that reply was written. A reply written
 * in the millisecond a turn Sotto timed itself began, when the turn before had not ended any earlier, is the earlier
 * turn's: a turn's reply comes before its end, and the next turn's reply waits on a model step. A provider's own times are
 * whole seconds (Codex), where a shared second says nothing about order, so there the newer turn keeps it.
 */
function turnOfReply(turns: readonly Turn[], position: number, message: AgentMessage): Turn | undefined {
  // A live adapter's exact Sotto anchor survives replay and timestamp correction. A missing retained turn does not
  // permit assigning its reply elsewhere. Older messages without this proof keep the historical timestamp fallback.
  if (message.turnMessageId !== undefined) return turns.find(turn => turn.messageId === message.turnMessageId)
  const above = turns.filter(turn => turn.anchor < position)
  const written = Date.parse(message.createdAt)
  const at = above.findLastIndex(turn => turn.startedAt === undefined || Number.isNaN(written) || Date.parse(turn.startedAt) <= written)
  if (at < 0) return above.at(-1)
  const turn = above[at]!, before = above[at - 1]
  if (turn.observed && turn.startedAt !== undefined && Date.parse(turn.startedAt) === written && before?.completedAt !== undefined
    && Date.parse(before.completedAt) >= written) return before
  return turn
}

/**
 * The reply the thread's newest turn gave, for its news (#1190): its last worker message that belongs to that turn by the
 * rule outcomes use, so a steer shown above an earlier turn's reply never takes it. Undefined when the newest turn cannot
 * be placed or wrote nothing.
 */
export function watcherNewestTurnReply(thread: AgentThread): AgentMessage | undefined {
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const turns = turnsOf(thread, messages), newest = turns.at(-1), last = thread.lastTurn
  // A newest turn Sotto cannot place is not the newest it placed: it has no reply to give, never an earlier turn's.
  if (!newest || !last || newest.nativeTurnId !== last.id && newest.turnId !== last.id) return undefined
  return messages.findLast((message, position) => message.role === 'assistant' && message.text.trim() !== '' && turnOfReply(turns, position, message) === newest)
}

/**
 * Whether the turn a brief began, by its Sotto anchor, is still the thread's newest (#1190): the newest turn Sotto placed,
 * and the provider's newest turn is that same turn, by its ID, its native ID or its anchor. A turn the provider started by
 * itself, as Claude Code does to report background work, has no anchor and is not the brief's. A steer read into the
 * brief's turn begins none of its own. A brief whose turn cannot be placed reads as newest, so nothing is claimed of it.
 */
export function watcherBriefTurnIsNewest(thread: AgentThread, turnMessageId: string): boolean {
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const turns = turnsOf(thread, messages), brief = turns.find(turn => turn.messageId === turnMessageId)
  if (!brief) return true
  if (turns.at(-1) !== brief) return false
  const last = thread.lastTurn
  return !last || last.id === brief.turnId || last.id === brief.nativeTurnId || last.messageId === turnMessageId
}

/** The newest turn's Sotto anchor, for naming the delegation a turn's news answers. */
export function watcherLatestTurnMessageId(thread: AgentThread): string | undefined {
  const messages = thread.messages.filter(message => !isVisualMessage(message))
  const turns = turnsOf(thread, messages)
  const latest = turns.at(-1)
  return latest ? messages[latest.anchor]!.id : undefined
}
