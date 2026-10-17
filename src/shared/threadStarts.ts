/**
 * The plain sentences of continuing an agent as its own thread and forking a thread at a reply (#1028). Main answers with
 * these exact sentences and the window reads them, as it reads `RESTORE_BRANCH_NEEDS_CONFIRMATION`: the agent's row offers
 * a handover in place of Codex's own fork only on `AGENT_FORK_GONE`.
 */

/** The agent is still working: nothing is made until it has finished. */
export const AGENT_STILL_WORKING = 'This agent is still working, so nothing was made. Continue it once it finishes.'
/** Sotto last saw the agent working, before a restart or a lost connection, and has not seen it finish. */
export const AGENT_NOT_SEEN_FINISHING = 'Sotto last saw this agent working and hasn’t seen it finish, so nothing was made. Continue it once it shows as finished.'
/** Codex no longer has the agent's own conversation, so it cannot fork it; a thin handover is offered instead. */
export const AGENT_FORK_GONE = 'Codex no longer has this agent’s conversation, so nothing was made. Sotto still has its title and result: a new thread can start from a handover of those instead. It would be thin.'
/** Codex keeps the agent's conversation archived. Sotto leaves the user's Codex archive alone. */
export const AGENT_FORK_ARCHIVED = 'Codex has this agent’s conversation archived, so it can’t be forked, and nothing was made. Sotto leaves Codex’s archive as it is: unarchive the conversation in Codex, then try again.'
/** Codex no longer has the conversation the source was itself forked from, so it cannot copy it. */
export const FORK_SOURCE_MISSING = 'Codex no longer has the conversation this one was forked from, so it can’t be forked, and nothing was made. What Sotto shows of it is unchanged.'
/** A forked thread whose source conversation Codex no longer has cannot be opened in Codex. */
export const FORKED_THREAD_SOURCE_MISSING = 'Codex no longer has the conversation this thread was forked from, so it can’t open this thread. What Sotto shows here is kept. Start a new thread to carry on.'
/** The agent's task and result are no longer held, so there is nothing to hand over. */
export const AGENT_HANDOVER_UNAVAILABLE = 'Sotto no longer holds this agent’s task and result, so there is no handover to start from, and nothing was made.'
/** Sent with the first message when its handover can no longer be built: the message goes back to the composer. */
export const START_HANDOVER_UNREADABLE = 'Sotto could not read what this thread’s handover carries, so nothing was sent. Your message is back in the composer; send it again to start without the handover.'
/** A host whose Sotto predates continuing agents. */
export const THREAD_STARTS_UNSUPPORTED = 'This host can’t continue an agent as a thread yet, and nothing was made. Update Sotto on the host, then try again.'

/** The line after a handover that says where the user's own words begin. */
export const START_HANDOVER_CLOSE = '[End of the handover. The user’s message follows.]'
/** What goes ahead of the user's words in a started thread's first message: the handover, then the line that closes it. */
export function startHandoverPrefix(text: string): string {
  return `${text}\n\n${START_HANDOVER_CLOSE}\n\n`
}
