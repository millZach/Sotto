import { lastUserMessageIdOf, type AgentRequest, type AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, DELEGATION_PROMPTS_PER_THREAD, DELEGATION_WORK_TITLES, type DelegatedView, type DelegationOutcome, type DelegationView, type DelegationWork, type RefusedView } from '../../../shared/delegation'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { clockLabel } from './threadFacts'

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
export function delegationRefusalLine(view: Pick<RefusedView, 'action' | 'refusal'>): string {
  const start = view.action === 'start'
  const nothing = start ? 'Nothing was started.' : 'Nothing was sent.'
  switch (view.refusal) {
    case 'NOT_ADMITTED': return `This thread cannot delegate. Only Claude Code, Codex, Grok Build and Muse threads on this computer can, outside Watcher, host setup and provider jobs. ${nothing}`
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
    default: return `Sotto turned it down. ${nothing}`
  }
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

/**
 * What kind of delegated work a delegation is, as its row's mark and word say it: a code review, a code review on Muse,
 * or any other kind of work. Not "subagent", which is a provider's own agent (CONTEXT.md, Delegation).
 */
export type DelegatedKind = 'review' | 'muse-review' | 'work'
export const delegatedKind = (work: DelegationWork, provider: string | undefined): DelegatedKind =>
  work !== 'code-review' ? 'work' : provider === 'muse' ? 'muse-review' : 'review'
export const delegatedKindWord = (kind: DelegatedKind, work: DelegationWork): string =>
  kind === 'muse-review' ? 'Muse review' : kind === 'review' ? 'Review' : DELEGATION_WORK_TITLES[work]

/**
 * Where a row of delegated work stands: the outcome, told apart where the row says more than the outcome does. A brief
 * still being started or sent is Starting, a working thread that waits on the user's answer is Needs you, and an
 * answered review is Returned, since what it found is in its thread.
 */
export type DelegatedState = DelegationOutcome | 'starting' | 'needs-you' | 'returned'
export function delegatedState(view: DelegationView, kind: DelegatedKind, asking: boolean): { readonly id: DelegatedState; readonly word: string } {
  if (view.outcome === 'working' && asking) return { id: 'needs-you', word: 'Needs you' }
  if (view.outcome === 'working' && view.waiting && !view.wait) return { id: 'starting', word: 'Starting' }
  if (view.outcome === 'answered' && kind !== 'work') return { id: 'returned', word: 'Returned' }
  return { id: view.outcome, word: DELEGATION_OUTCOME_WORDS[view.outcome] }
}

/** A delegation with nothing more to come while no one sends to it: neither working nor running background work. */
export const settledDelegation = (view: DelegationView): boolean => view.outcome !== 'working' && view.outcome !== 'background'

const MOST_COMMAND = 80
/** What a delegated thread waits on the user for, from its own pending request. The user answers in that thread. */
function askingLine(request: AgentRequest): string {
  if (request.kind === 'question') return 'Waiting for your answer to its question. Open it to answer.'
  const command = request.context?.command?.trim()
  const what = command ? `: ${command.length > MOST_COMMAND ? `${command.slice(0, MOST_COMMAND - 1)}…` : command}` : request.context?.toolName ? ` to use ${request.context.toolName}` : ''
  return `Waiting for your permission${what}. Open it to answer.`
}

/**
 * The line under a row of delegated work: why Sotto refused it, what it waits on the user for, or how the wait went, and
 * for a returned review, where to read what it found. `now` is the clock a wait in progress counts from.
 */
export function delegatedLine(view: DelegationView, state: DelegatedState, now: number, request: AgentRequest | undefined): string {
  if (view.outcome === 'refused') return delegationRefusalLine(view)
  if (state === 'needs-you' && request) return askingLine(request)
  const line = delegationWaitLine(view, now)
  return state === 'returned' ? `${line} Open it to read what it found.` : line
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
/**
 * A turn's delegated work in a few words, after its Worked for line: how many of each kind, then how many wait on the
 * user, failed or were refused, so a closed fold still says so. Empty when there is none.
 */
export function delegatedSummary(views: readonly DelegationView[], threadOf: (view: DelegationView) => Pick<AgentThread, 'providerId' | 'requests'> | undefined): string {
  const kinds: Record<DelegatedKind, number> = { work: 0, review: 0, 'muse-review': 0 }
  let asking = 0, failed = 0, refused = 0
  for (const view of views) {
    const thread = threadOf(view)
    kinds[delegatedKind(view.work, thread?.providerId ?? (view.outcome === 'refused' ? view.provider : undefined))]++
    if (view.outcome === 'working' && thread?.requests.length) asking++
    if (view.outcome === 'failed' || view.outcome === 'unknown') failed++
    if (view.outcome === 'refused') refused++
  }
  return [
    kinds.work && counted(kinds.work, 'delegated thread', 'delegated threads'),
    kinds.review && counted(kinds.review, 'review', 'reviews'),
    kinds['muse-review'] && (kinds['muse-review'] === 1 ? 'Muse review' : `${kinds['muse-review']} Muse reviews`),
    asking && `${asking} ${asking === 1 ? 'needs' : 'need'} you`,
    failed && `${failed} failed`,
    refused && `${refused} refused`,
  ].filter(Boolean).join(' · ')
}
