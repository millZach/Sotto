import { lastUserMessageIdOf, type AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, DELEGATION_PROMPTS_PER_THREAD, type DelegatedView, type DelegationOutcome, type RefusedView } from '../../../shared/delegation'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { clockLabel } from './threadFacts'
import { WORKER_SYSTEM_WORDS } from '../../../shared/workerMachine'

/**
 * The words delegation shows in the window (#1029, design A): a card's outcome and its wait line, "Delegated by", and
 * what Stop will stop. Outcomes are worded as Watcher's are, as the placement prototype words them.
 */
export const DELEGATION_OUTCOME_WORDS: Readonly<Record<DelegationOutcome, string>> = {
  working: 'Working', background: 'Background work', answered: 'Answered', failed: 'Failed', stopped: 'Stopped', paused: 'Paused', unknown: 'Unknown', refused: 'Refused',
}

/** "12 s", "5 min", "1 min 40 s", "1 h 4 min": a wait or an answer's time, to the second under a minute. */
export function delegationDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60), rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`
  const hours = Math.floor(minutes / 60), left = minutes % 60
  return left ? `${hours} h ${left} min` : `${hours} h`
}

/** Whether the thread that delegated knows the outcome yet: a wake-up can wait in its queue, or not be taken at all. */
const toldWords = (view: DelegatedView, who: string): string => view.told ? `${who} has been told.` : `${who} has not been told yet.`
const at = (iso: string | undefined): string => {
  const time = iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isFinite(time) ? ` at ${clockLabel(time)}` : ''
}
const between = (from: string | undefined, to: string | undefined): number | undefined => {
  const start = from === undefined ? Number.NaN : Date.parse(from), end = to === undefined ? Number.NaN : Date.parse(to)
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined
}

/**
 * The line under a card: how the delegating thread's wait went, or what the outcome means for it. `now` is the clock a
 * wait in progress counts from. The card is in the delegating thread, so it is "this thread"; Tools › Agents names the
 * delegating thread instead where it is not the roster's own (`delegator`).
 */
export function delegationWaitLine(view: DelegatedView, now: number, delegator?: string): string {
  const Who = delegator ?? 'This thread', who = delegator ?? 'this thread'
  const wait = view.wait
  const wentOn = wait !== undefined && (wait.wentOnAt !== undefined || wait.seconds === 0)
  switch (view.outcome) {
    case 'working': {
      if (view.waiting && !wait) return view.action === 'start' ? 'Sotto is starting it and sending the brief.' : 'Sotto is sending it the brief.'
      if (view.waiting && wait) {
        const so = Number.isFinite(Date.parse(wait.startedAt)) ? ` ${delegationDuration(now - Date.parse(wait.startedAt))} so far.` : ''
        return `${Who} waits up to ${delegationDuration(wait.seconds * 1000)} for it.${so}`
      }
      if (wait && wait.seconds === 0) return `${Who} did not wait for it. The answer comes back as a wake-up.`
      if (wait) return `${Who} waited ${delegationDuration(wait.seconds * 1000)}, then went on. The answer comes back as a wake-up.`
      return 'The answer comes back as a wake-up.'
    }
    case 'background': return `Its turn ended with background work still running. ${Who} hears when it settles.`
    case 'answered': {
      const took = between(wait?.startedAt ?? view.createdAt, view.outcomeAt)
      const answered = took === undefined ? 'Answered' : `Answered in ${delegationDuration(took)}`
      return wentOn ? `${answered}, after ${who} went on. ${toldWords(view, Who)}` : `${answered}, while ${who} waited for it.`
    }
    case 'failed':
      if (view.notSent === 'provider') return 'Sotto could not start it or send it the brief. Nothing was sent.'
      return `Its last turn failed.${view.told ? '' : ` ${Who} has not been told yet.`} Open it to see why.`
    case 'stopped':
      return view.notSent === 'stopped' ? `Stopped${at(view.outcomeAt)}, before the brief was sent.` : `Stopped${at(view.outcomeAt)}. Nothing more will come of it.`
    case 'paused':
      if (view.notSent === 'target-changed') return `You sent to it${at(view.outcomeAt)}, so Sotto did not send this brief.`
      if (view.notSent === 'paused') return `You were working in it${at(view.outcomeAt)}, so Sotto did not send this brief.`
      return `You sent to it${at(view.outcomeAt)}. ${Who} sends it nothing more until your turn there ends.`
    case 'unknown':
      if (view.notSent === 'restarted') return 'Sotto restarted before the brief was sent. Nothing was sent.'
      if (view.unknownWhy === 'gone') return 'Its thread is gone from Sotto, so nothing more will come of it.'
      return view.unknownWhy === 'unconfirmed' ? 'Its provider did not confirm the brief arrived. Sotto has not sent it again. Open it to see whether it is working on it.'
        : 'Sotto restarted while it worked. Nothing was resent. Open it to see where it got to.'
  }
}

/**
 * Why Sotto refused a delegation, in the words the user reads on its card in the delegating thread ("this thread"):
 * what turned it down, that nothing was started or sent, and what would let it through where the user can change that.
 * Main's own words for a refusal were written for the agent that asked, so the card words the rule itself.
 */
export function delegationRefusalLine(view: Pick<RefusedView, 'action' | 'refusal'>, parentMachine?: string, asked?: string): string {
  const start = view.action === 'start'
  const nothing = start ? 'Nothing was started.' : 'Nothing was sent.'
  // A thread on another machine delegates only on its own machine until #1316 (#1310). With what it asked for recorded,
  // Zach's words (October 23, 2026); without, as the remote roster prototype words it.
  if (view.refusal === 'MACHINE_UNAVAILABLE' && parentMachine !== undefined) {
    return asked !== undefined ? `Asked for ${asked}. ${parentMachine} can start threads only on ${parentMachine} for now. ${nothing}`
      : `This thread runs on ${parentMachine}, and a thread on ${parentMachine} can start threads only on ${parentMachine}. ${nothing} Ask again without naming a machine to start it on ${parentMachine}.`
  }
  switch (view.refusal) {
    case 'NOT_ADMITTED': return `This thread cannot delegate. Only Claude Code, Codex, Grok Build and Muse threads can, outside Watcher, host setup and provider jobs, on this computer or on a machine whose Sotto offers it. ${nothing}`
    case 'LEVEL_LIMIT': return `This thread was started by a delegated thread, and delegation goes two levels deep, so it cannot delegate. ${nothing}`
    case 'NO_USER_MESSAGE': return `A delegation answers your own message to this thread, and Sotto could not find one. ${nothing}`
    case 'PROVIDER_UNAVAILABLE': return start
      ? `The model it asked for was not ready on this computer, or Sotto could not save the delegation. ${nothing}`
      : `That thread's provider or model was not available, or Sotto could not save the delegation. ${nothing}`
    case 'PERMISSION_NOT_COMPARABLE': return start
      ? `Sotto could not compare the permission it asked for with this thread's own, so it could not tell how much a new thread may have. ${nothing}`
      : `Sotto could not compare that thread's permission with this thread's safely. ${nothing}`
    case 'PERMISSION_TOO_WIDE': return `It asked for more permission than this thread has, or than your new-thread default allows. A delegated thread gets no more than either. ${nothing} To give it more, raise the lower of the two first.`
    // Refused only by versions of Sotto before #1183, which had a Threads in flight limit.
    case 'IN_FLIGHT_LIMIT': return `This computer already had as many new threads working as Threads in flight allowed, a limit Sotto no longer has. ${nothing}`
    case 'PROMPT_LIMIT': return `That thread already had ${DELEGATION_PROMPTS_PER_THREAD} briefs from this thread in this turn. Your next message to this thread renews the limit. ${nothing}`
    case 'PAUSED': return `You were working in that thread, so it takes no brief until your turn there ends. ${nothing}`
    case 'TARGET_CHANGED': return `You had sent your own message in that thread since this thread last read it. ${nothing}`
    case 'PENDING_USER_REQUEST': return `That thread was waiting for your answer on its own card. ${nothing}`
    case 'UNKNOWN_THREAD': return `That thread is gone or archived, or this thread did not delegate to it. ${nothing}`
    case 'QUEUE_HELD': return `That thread's own queue was paused, or a message to it had an unknown result, so it takes no brief until you resume, clear or check it there. ${nothing}`
    case 'MACHINE_UNAVAILABLE': return `The machine or system it asked for could not take it: none was connected, it had no copy of this project, or it was not This computer, where delegated threads start for now. ${nothing}`
    default: return `Sotto turned it down. ${nothing}`
  }
}

/**
 * A delegated thread's outcome as Sotto last read it, its machine not connected now (#1310, Zach's word on October 23,
 * 2026): "Working when last read", never Unknown for what was known.
 */
export const lastReadWord = (outcome: DelegationOutcome): string => `${DELEGATION_OUTCOME_WORDS[outcome]} when last read`

const LAST_READ_WAS: Readonly<Record<DelegationOutcome | 'needs', string>> = {
  working: 'It was working', background: 'Its background work was still running', answered: 'It had answered', failed: 'It had failed',
  stopped: 'It had stopped', paused: 'It was paused', unknown: 'Sotto could not tell how it stood', refused: 'It was refused', needs: 'It was waiting for you',
}
/**
 * How a delegated thread stood when Sotto last read it on `machine`, which is not connected now, at `asOf` when known: what
 * a roster row's details and a card's line say (#1310). Losing the connection stops nothing there.
 */
export function lastReadOutcome(machine: string, outcome: DelegationOutcome | 'needs' | undefined, asOf: number): string {
  const when = Number.isFinite(asOf) ? ` at ${clockLabel(asOf)}` : ''
  const was = outcome === undefined ? '' : `${LAST_READ_WAS[outcome]}${when}, when Sotto last read it. `
  return `${was}${machine} is not connected, so Sotto cannot read how it went since. It reads it again when ${machine} reconnects.`
}

type HostHold = NonNullable<DelegatedView['held']>
/**
 * Why a delegated thread on another machine started at Ask for approval, on its row and card (#1310): the prototype's
 * words for a host never told, and Zach's (October 23, 2026) for one this computer cannot answer on, which give the reason
 * only until a control of its own lets this computer answer there (#1447), and for a grant taken away, with no fix.
 */
export function heldLine(held: HostHold, machine: string): string {
  if (held === 'not-told') return `Started at Ask for approval: ${machine} had no new-thread default from this computer yet.`
  if (held === 'answers-revoked') return `Held at Ask for approval: ${machine} no longer lets this computer answer there.`
  return `Held at Ask for approval: this computer can't answer on ${machine}.`
}
/** The same, in full, where a row's details say its latest outcome. */
export function heldOutcome(held: HostHold, machine: string): string {
  if (held === 'not-told') return `${machine} hasn't had this computer's defaults yet. It gets them the next time this computer connects to it; new threads there use them from then.`
  if (held === 'answers-revoked') return `It started at Ask for approval, because ${machine} no longer lets this computer answer permission requests there, so a thread there cannot be given more.`
  return `It started at Ask for approval, because this computer can't answer permission requests on ${machine}, so a thread there cannot be given more.`
}
/** What a refused start asked for, by the window's names for its machines (#1310): "this computer", "forge", "a Mac". */
export function askedFor(asked: NonNullable<RefusedView['asked']>, machineName: (hostId: string) => string | undefined): string | undefined {
  if (asked.machine !== undefined) return machineName(asked.machine) ?? 'another machine'
  return asked.os !== undefined ? WORKER_SYSTEM_WORDS[asked.os].a : undefined
}

/** The delegated threads below this one, at both levels, whose turn is running now: what Stop on it also stops. */
export function workingDelegatedThreads(threads: readonly Pick<AgentThread, 'id' | 'delegatedBy' | 'status' | 'lastTurn'>[], threadId: string): number {
  const below = new Set(delegatedThreadsBelow(threads, threadId))
  if (!below.size) return 0
  return threads.filter(thread => below.has(thread.id) && isThreadTurnRunning(thread)).length
}

const threadsWord = (count: number): string => count === 1 ? 'the thread it delegated that is working' : `the ${count} threads it delegated that are working`

/** The Stop control's name: what a press stops, the delegated threads included. */
export const stopLabel = (working: number): string => working ? `Stop agent and ${threadsWord(working)}` : 'Stop agent'
/** The line under the composer while a press of Stop would stop delegated threads too. */
export const stopLine = (working: number): string => `Stop also stops ${threadsWord(working)}.`
/**
 * Whether the turn running in a delegated thread is the user's own: its newest user message is neither a brief the
 * thread that delegated sent nor one of Sotto's wake-ups, such as a resume note, as main decides it (decision 6). Not
 * known, so false, until the thread's briefs are read.
 */
export function userTurnRunning(thread: Pick<AgentThread, 'status' | 'lastTurn' | 'messages' | 'lastUserMessageId' | 'summary' | 'wakeUpMessageIds'>, received: readonly DelegatedView[]): boolean {
  if (!isThreadTurnRunning(thread) || !received.length) return false
  const head = lastUserMessageIdOf(thread) ?? thread.summary?.lastUser?.id
  return head !== undefined && head !== null && !received.some(view => view.briefMessageId === head) && !thread.wakeUpMessageIds?.includes(head)
}

/**
 * The line under a delegated thread's composer (decision 6), or none. While the user's own turn there runs, the thread
 * that delegated sends nothing here until it ends; while that thread's newest brief is still being worked on, a send of
 * the user's would hold it back. Otherwise nothing holds either thread back, so nothing is said.
 */
export function delegatedNote(parent: string, newest: Pick<DelegatedView, 'outcome'> | undefined, userTurn: boolean, running: boolean): string | undefined {
  if (userTurn || newest?.outcome === 'paused' && running) return `Your turn is running. ${parent} sends nothing here until it ends.`
  if (newest?.outcome === 'working' || newest?.outcome === 'background') return `If you send here, ${parent} sends nothing more until your turn ends.`
  return undefined
}
