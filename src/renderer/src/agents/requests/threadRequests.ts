import { hostForThread, isThreadBusy, type AgentCommand, type AgentRequest, type AgentState, type AgentThread } from '../../../../shared/agents'
import type { RequestDraftOwner } from '../../../../shared/requestDrafts'
import type { ThreadRow } from '../threadFacts'
import { answeredChoices, answerWords } from './answeredChoices'
import type { RequestAnswer, SubmitOutcome } from './requestAnswers'

/** The window's one way of sending a command to main, as every surface that answers a request receives it. */
export type RequestCommand = (command: AgentCommand) => Promise<AgentState | null>

/**
 * Whose saved answers a thread's request cards keep: the thread's own, by its provider. Every card for the same request
 * passes this, wherever it is drawn, so they share one answer in the window (`requestAnswerOwnerKey`).
 */
export function threadRequestOwner(row: ThreadRow, state: AgentState): RequestDraftOwner {
  return { kind: 'thread', ownerId: row.thread.id, providerId: row.providerId ?? state.configuration.provider }
}

/** Why a thread's request cards cannot be answered right now, in the words the card shows, or null when they can. */
export function threadRequestBlocked(row: ThreadRow, state: AgentState): string | null {
  return isThreadBusy(state, row.thread.id) ? 'Waiting for Sotto…' : !row.connected ? `Reconnect ${row.provider} to answer.` : null
}

/**
 * The send behind every surface that answers a thread's request (ADR-0135): the `answer` command for this request's
 * own ID, with what main took noted for Watcher's lines where `noteAnswered` says this window keeps them. Delivery
 * itself — once, held when unconfirmed — is `RequestAnswerStore.submit`'s, whichever surface asked it to send.
 */
export function threadRequestSubmit(command: RequestCommand, thread: Pick<AgentThread, 'id'>, request: AgentRequest, noteAnswered: boolean): (answer: RequestAnswer) => Promise<SubmitOutcome> {
  return answer => command({ type: 'answer', threadId: thread.id, requestId: request.id, ...answer }).then(result => {
    // What main took is kept for this window, so Watcher's line for this request can say what was chosen.
    if (noteAnswered && result !== null && result.error === null) answeredChoices.note(thread.id, request.id, answerWords(request, answer), true)
    return result === null ? null : { error: result.error }
  })
}

/** Check again, for a surface with no reader of its own: reread the thread and say whether the read truly landed. */
export function threadRequestCheck(command: RequestCommand, threadId: string): Promise<boolean> {
  return command({ type: 'observe-threads', threadIds: [threadId] }).then(result => checkedOnConnectedHost(result, threadId))
}

/**
 * Whether Check again read the thread afresh. Main lets a dropped connection pass an observation quietly, so the reply
 * counts only while the thread's host is still connected.
 */
export function checkedOnConnectedHost(result: AgentState | null, threadId: string): boolean {
  const checked = result?.host.threads.find(item => item.id === threadId)
  return result !== null && result.error === null && checked !== undefined && hostForThread(result.host, checked).connected
}
