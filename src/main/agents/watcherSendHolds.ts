import type { AgentThread } from '../../shared/agents'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import type { CheckoutPendingWork } from './checkoutMutations'

/**
 * What a Watcher send waits on, said in its refusal (#1203, ADR-0073). Only the thread's foreground turn and its own queue
 * hold a send. Background work a finished turn left running never does: an idle thread takes a send now and starts a new
 * turn, and a queued prompt goes as soon as the turn is free.
 */
export const RUNNING_TURN_HOLD = 'This thread’s turn is running. Steer it, or queue this prompt to go when the turn ends. Nothing was sent.'

export const NO_TURN_TO_STEER = 'No turn is running in this thread, so there is nothing to steer. Send it now instead: background work does not hold a send. Nothing was sent.'

/** The refusal for a steer whose `expectedTurnId` names a turn that is no longer the one running. */
export const STEER_TURN_CHANGED = 'The turn this steer names is no longer running. Read the thread, or leave out expectedTurnId to steer the turn that is running. Nothing was sent.'

/**
 * What a Watcher send that asked to steer says when it went another way (ADR-0130): now, to a thread whose turn was over,
 * or queued, to a turn that cannot take a steer. Nothing is said when it steered.
 */
export function steerFallbackNote(used: 'now' | 'queue' | 'steer' | undefined): string | undefined {
  if (used === 'now') return 'No turn was running, so this went now and started a turn instead of steering.'
  if (used === 'queue') return 'This thread’s turn cannot take a steer, so this was queued to go when the turn ends.'
  return undefined
}

/** The refusal while the user's own turn in a thread runs. Watcher may only steer it (ADR-0073). */
export const USER_TURN_RUNNING = 'The user’s own turn in this thread is running. Steer it, or send once it ends. Nothing was sent.'

/**
 * The refusal while an earlier send to a thread is unconfirmed (#1222). Sotto never sends a prompt twice, so only the
 * provider's confirmation or the user's Continue with a new message, which sets that send aside, lets a send go there.
 */
export const UNCONFIRMED_SEND_HOLD = 'An earlier send to this thread is unconfirmed. Read the thread to see what happened, then ask the user to set that send aside there with Continue with a new message. Nothing was sent.'

/**
 * The refusal while a watch stays paused after the user's turn for some other hold, or one this computer cannot see, as
 * on a paired host whose deliveries only that host knows (#1222). It names no turn, since none is running.
 */
export const WATCH_PAUSED_HOLD = 'This watch is paused until the thread’s earlier work settles. Read the thread to see what it waits on. Nothing was sent.'

/**
 * A prompt whose first word is a slash command, such as `/compact` (#1222). A provider runs one as a command of its own
 * rather than a message, so Sotto could never confirm it and the thread would hold every later send. A path such as
 * `/home/x` is not one: its first word has a second slash. A plugin's command, such as `/my-plugin:review`, is one.
 */
export function startsWithSlashCommand(text: string): boolean {
  return /^\s*\/[\p{L}\p{N}_:-]+(?:\s|$)/u.test(text)
}

export const SLASH_COMMAND_REFUSAL = 'This prompt starts with a slash command, which Watcher cannot send as a message. Ask the user to run it in the thread themselves. Nothing was sent.'

/** The refusal for a `now` send to an idle thread whose queue goes first. `heldByStop` is a user prompt a machine Stop holds. */
export function queueHold(reason: CheckoutPendingWork, heldByStop: boolean): string {
  switch (reason) {
    case 'uncertain-send': return UNCONFIRMED_SEND_HOLD
    case 'failed-followups': return 'A queued prompt in this thread failed and waits for the user to review it. Nothing was sent.'
    case 'paused-followups': return 'This thread’s queue is paused until the user reviews it. Nothing was sent.'
    case 'pending-work': return heldByStop
      ? 'This thread’s queue holds a user prompt from before this thread was stopped, until the user reviews it. Nothing was sent.'
      : 'This thread has a queued prompt that goes first, as soon as its turn is free. Queue this one behind it. Nothing was sent.'
  }
}

/**
 * What read_operation says of a Watcher send still in a thread's queue that its queue holds for the user's review: it
 * stays `working`, since the user's Resume sends it, but not "still working", which a thread at rest would belie.
 */
export function queuedSendHeld(reason: 'paused-followups' | 'failed-followups'): string {
  return reason === 'paused-followups'
    ? 'It waits in the thread’s queue, which is paused until the user reviews the thread and resumes it. Nothing has been sent. Tell the user rather than send it again.'
    : 'It waits in the thread’s queue behind a queued prompt that failed, until the user reviews it. Nothing has been sent. Tell the user rather than send it again.'
}

/**
 * What a Watcher send that names no delivery, or names steer, does (ADR-0130): it steers a running turn, with the turn it
 * reads as running when the send names none, or unfenced into a running turn Sotto has not confirmed (#1490), and goes
 * now to a thread whose turn is over, so steering an idle thread never fails. A turn still under way that cannot be
 * steered, on a provider that does not steer or ending after its thread reads idle, takes it queued. A thread waiting on
 * the user's card was refused before this.
 */
export function defaultDelivery(thread: Pick<AgentThread, 'status' | 'lastTurn'>,
  canSteer: boolean, expectedTurnId: string | undefined): { readonly delivery: 'now' | 'queue' | 'steer'; readonly expectedTurnId?: string } {
  if (!isThreadTurnRunning(thread)) return { delivery: 'now', ...(expectedTurnId ? { expectedTurnId } : {}) }
  if (!canSteer || thread.status !== 'running') return { delivery: 'queue', ...(expectedTurnId ? { expectedTurnId } : {}) }
  const turnId = expectedTurnId ?? (thread.lastTurn?.status === 'running' ? thread.lastTurn.id : undefined)
  return { delivery: 'steer', ...(turnId ? { expectedTurnId: turnId } : {}) }
}
