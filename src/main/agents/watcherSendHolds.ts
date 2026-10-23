import type { CheckoutPendingWork } from './checkoutMutations'

/**
 * What a Watcher send waits on, said in its refusal (#1203, ADR-0073). Only the thread's foreground turn and its own queue
 * hold a send. Background work a finished turn left running never does: an idle thread takes a send now and starts a new
 * turn, and a queued prompt goes as soon as the turn is free.
 */
export const RUNNING_TURN_HOLD = 'This thread’s turn is running. Steer it, or queue this prompt to go when the turn ends. Nothing was sent.'

export const NO_TURN_TO_STEER = 'No turn is running in this thread, so there is nothing to steer. Send it now instead: background work does not hold a send. Nothing was sent.'

/** The refusal while the user's own turn in a thread runs. Watcher may only steer it (ADR-0073). */
export const USER_TURN_RUNNING = 'The user’s own turn in this thread is running. Steer it, or send once it ends. Nothing was sent.'

/**
 * The refusal while an earlier send to a thread is unconfirmed (#1222). Sotto never sends a prompt twice, so only the
 * provider's confirmation or the user's Continue with a new message, which sets that send aside, lets a send go there.
 */
export const UNCONFIRMED_SEND_HOLD = 'An earlier send to this thread is unconfirmed. Read the thread to see what happened, then ask the user to set that send aside there with Continue with a new message. Nothing was sent.'

/**
 * The refusal once the user set their own unconfirmed prompt aside: automatic work waits until their next message there
 * is confirmed (ADR-0058), so there is nothing more to ask of them.
 */
export const SET_ASIDE_HOLD = 'The user set aside an unconfirmed message in this thread. Watcher can send there once their next message is confirmed. Nothing was sent.'

/**
 * A prompt whose first word is a slash command, such as `/compact` (#1222). A provider runs one as a command of its own
 * rather than a message, so Sotto could never confirm it and the thread would hold every later send. A path such as
 * `/home/x` is not one: its first word has a second slash.
 */
export function startsWithSlashCommand(text: string): boolean {
  return /^\s*\/[\p{L}\p{N}_-]+(?:\s|$)/u.test(text)
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
