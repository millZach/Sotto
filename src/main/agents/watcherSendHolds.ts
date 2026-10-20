import type { CheckoutPendingWork } from './checkoutMutations'

/**
 * What a Watcher send waits on, said in its refusal (#1203, ADR-0073). Only the thread's foreground turn and its own queue
 * hold a send. Background work a finished turn left running never does: an idle thread takes a send now and starts a new
 * turn, and a queued prompt goes as soon as the turn is free.
 */
export const RUNNING_TURN_HOLD = 'This thread’s turn is running. Steer it, or queue this prompt to go when the turn ends. Nothing was sent.'

export const NO_TURN_TO_STEER = 'No turn is running in this thread, so there is nothing to steer. Send it now instead: background work does not hold a send. Nothing was sent.'

/** The refusal for a `now` send to an idle thread whose queue goes first. `heldByStop` is a user prompt a machine Stop holds. */
export function queueHold(reason: CheckoutPendingWork, heldByStop: boolean): string {
  switch (reason) {
    case 'uncertain-send': return 'Sotto has not confirmed an earlier send to this thread. Read the thread before sending again. Nothing was sent.'
    case 'failed-followups': return 'A queued prompt in this thread failed and waits for the user to review it. Nothing was sent.'
    case 'paused-followups': return 'This thread’s queue is paused until the user reviews it. Nothing was sent.'
    case 'pending-work': return heldByStop
      ? 'This thread’s queue holds a user prompt from before this thread was stopped, until the user reviews it. Nothing was sent.'
      : 'This thread has a queued prompt that goes first, as soon as its turn is free. Queue this one behind it. Nothing was sent.'
  }
}
