import { lastUserMessageIdOf, type AgentRequest, type AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, DELEGATION_PROMPTS_PER_THREAD, DELEGATION_WORK_TITLES, type DelegatedView, type DelegationOutcome, type DelegationView, type DelegationWork, type RefusedView } from '../../../shared/delegation'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import { clockLabel } from './threadFacts'
import { t } from '@lingui/core/macro'

/**
 * The words delegation shows in the window (#1029, design A): a row of delegated work's outcome and its wait line, "Delegated by", and
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
 * The line under a row of delegated work: how the delegating thread's wait went, or what the outcome means for it. `now` is the clock a
 * wait in progress counts from. The row is in the delegating thread, so it is "this thread"; Tools › Agents names the
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
 * Why Sotto refused a delegation, in the words the user reads on its row in the delegating thread ("this thread"):
 * what turned it down, that nothing was started or sent, and what would let it through where the user can change that.
 * Main's own words for a refusal were written for the agent that asked, so the row words the rule itself.
 */
export function delegationRefusalLine(view: Pick<RefusedView, 'action' | 'refusal'>, parentMachine?: string, asked?: string): string {
  const start = view.action === 'start'
  const nothing = start ? 'Nothing was started.' : 'Nothing was sent.'
  // A thread on another machine delegates only on its own machine until #1316 (#1310). With what it asked for recorded,
  // Zach's words (October 23, 2026); without, as the remote roster prototype words it.
  if (view.refusal === 'MACHINE_UNAVAILABLE' && parentMachine !== undefined) {
    const machine = parentMachine
    return asked !== undefined ? t`Asked for ${asked}. ${machine} can start threads only on ${machine} for now. Nothing was started.`
      : t`This thread runs on ${machine}, and a thread on ${machine} can start threads only on ${machine}. Nothing was started. Ask again without naming a machine to start it on ${machine}.`
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
 * 2026): "Working when last read", never Unknown for what was known. Each a message of its own (ADR-0123).
 */
export function lastReadWord(outcome: DelegationOutcome): string {
  switch (outcome) {
    case 'working': return t`Working when last read`
    case 'background': return t`Background work when last read`
    case 'answered': return t`Answered when last read`
    case 'failed': return t`Failed when last read`
    case 'stopped': return t`Stopped when last read`
    case 'paused': return t`Paused when last read`
    case 'unknown': return t`Unknown when last read`
    case 'refused': return t`Refused when last read`
  }
}

/** How it stood when Sotto last read it, at `time` when known: the first sentence of `lastReadOutcome`. */
function lastReadStood(outcome: DelegationOutcome | 'needs', time: string | undefined): string {
  if (time === undefined) {
    switch (outcome) {
      case 'working': return t`It was working when Sotto last read it.`
      case 'background': return t`Its background work was still running when Sotto last read it.`
      case 'answered': return t`It had answered when Sotto last read it.`
      case 'failed': return t`It had failed when Sotto last read it.`
      case 'stopped': return t`It had stopped when Sotto last read it.`
      case 'paused': return t`It was paused when Sotto last read it.`
      case 'unknown': return t`Sotto could not tell how it stood when it last read it.`
      case 'refused': return t`It was refused when Sotto last read it.`
      case 'needs': return t`It was waiting for you when Sotto last read it.`
    }
  }
  switch (outcome) {
    case 'working': return t`It was working at ${time}, when Sotto last read it.`
    case 'background': return t`Its background work was still running at ${time}, when Sotto last read it.`
    case 'answered': return t`It had answered at ${time}, when Sotto last read it.`
    case 'failed': return t`It had failed at ${time}, when Sotto last read it.`
    case 'stopped': return t`It had stopped at ${time}, when Sotto last read it.`
    case 'paused': return t`It was paused at ${time}, when Sotto last read it.`
    case 'unknown': return t`Sotto could not tell how it stood at ${time}, when it last read it.`
    case 'refused': return t`It was refused at ${time}, when Sotto last read it.`
    case 'needs': return t`It was waiting for you at ${time}, when Sotto last read it.`
  }
}
/**
 * How a delegated thread stood when Sotto last read it on `machine`, at `asOf` when known: what a roster row's details and
 * a card's line say (#1310). Not connected, losing the connection stops nothing there; connected, the last read failed.
 */
export function lastReadOutcome(machine: string, outcome: DelegationOutcome | 'needs' | undefined, asOf: number, connected = false): string {
  const was = outcome === undefined ? undefined : lastReadStood(outcome, Number.isFinite(asOf) ? clockLabel(asOf) : undefined)
  const now = connected ? t`Sotto could not read it again on ${machine} just now. It reads it again when ${machine} says it changed.`
    : t`${machine} is not connected, so Sotto cannot read how it went since. It reads it again when ${machine} reconnects.`
  return was === undefined ? now : `${was} ${now}`
}

type HostHold = NonNullable<DelegatedView['held']>
/**
 * Why a delegated thread on another machine started at Ask for approval, on its row and card (#1310): the prototype's
 * words for a host never told, and Zach's (October 23, 2026) for one this computer cannot answer on, which give the reason
 * only until a control of its own lets this computer answer there (#1447), and for a grant taken away, with no fix.
 */
export function heldLine(held: HostHold, machine: string): string {
  if (held === 'not-told') return t`Started at Ask for approval: ${machine} had no new-thread default from this computer yet.`
  if (held === 'answers-revoked') return t`Held at Ask for approval: ${machine} no longer lets this computer answer there.`
  return t`Held at Ask for approval: this computer can't answer on ${machine}.`
}
/** The same, in full, where a row's details say its latest outcome. */
export function heldOutcome(held: HostHold, machine: string): string {
  // Zach's words (October 23, 2026), held to what is true: a start after that can still be held where this computer cannot answer.
  if (held === 'not-told') return t`${machine} hasn't had this computer's defaults yet. It gets them the next time this computer connects to it; new threads there use them from then, unless this computer can't answer there.`
  if (held === 'answers-revoked') return t`It started at Ask for approval, because ${machine} no longer lets this computer answer permission requests there, so a thread there cannot be given more.`
  return t`It started at Ask for approval, because this computer can't answer permission requests on ${machine}, so a thread there cannot be given more.`
}
/** What a refused start asked for, by the window's names for its machines (#1310): "this computer", "forge", "a Mac". */
export function askedFor(asked: NonNullable<RefusedView['asked']>, machineName: (hostId: string) => string | undefined): string | undefined {
  if (asked.machine !== undefined) return machineName(asked.machine) ?? t`another machine`
  if (asked.os === 'windows') return t`a Windows machine`
  if (asked.os === 'macos') return t`a Mac`
  return asked.os === 'linux' ? t`a Linux machine` : undefined
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
  if (!settledDelegation(view) && asking) return { id: 'needs-you', word: 'Needs you' }
  if (view.outcome === 'working' && view.waiting && !view.wait) return { id: 'starting', word: 'Starting' }
  if (view.outcome === 'answered' && kind !== 'work') return { id: 'returned', word: 'Returned' }
  return { id: view.outcome, word: DELEGATION_OUTCOME_WORDS[view.outcome] }
}

/** A delegation with nothing more to come while no one sends to it: neither working nor running background work. */
export const settledDelegation = (view: DelegationView): boolean => view.outcome !== 'working' && view.outcome !== 'background'

/**
 * What a delegated thread still at work waits on the user for, as its sidebar row picks it: a permission ahead of a
 * question, and nothing for a closed thread or a delegation that has settled.
 */
export function pendingRequestOf(view: DelegationView, thread: Pick<AgentThread, 'requests' | 'settledAt' | 'settledOverride' | 'archivedAt'> | undefined): AgentRequest | undefined {
  if (thread === undefined || settledDelegation(view) || isThreadClosed(thread)) return undefined
  return thread.requests.find(request => request.kind === 'permission') ?? thread.requests[0]
}

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
export function delegatedLine(view: DelegationView, state: DelegatedState, now: number, request: AgentRequest | undefined, listed = true): string {
  if (view.outcome === 'refused') return delegationRefusalLine(view)
  if (state === 'needs-you' && request) return askingLine(request)
  const line = delegationWaitLine(view, now)
  // Only a thread the window still lists can be opened to read what it found.
  return state === 'returned' && listed ? `${line} Open it to read what it found.` : line
}

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
/**
 * A turn's delegated work in a few words, after its Worked for line: how many of each kind were started or sent, then
 * how many wait on the user, failed, are unknown or were refused, so a closed fold still says so. A refused delegation
 * started nothing, so it counts only as refused. Empty when there is none.
 */
export function delegatedSummary(views: readonly DelegationView[], threadOf: (view: DelegationView) => Pick<AgentThread, 'providerId' | 'requests' | 'settledAt' | 'settledOverride' | 'archivedAt'> | undefined): string {
  const kinds: Record<DelegatedKind, number> = { work: 0, review: 0, 'muse-review': 0 }
  let asking = 0, failed = 0, unknown = 0, refused = 0
  for (const view of views) {
    if (view.outcome === 'refused') { refused++; continue }
    const thread = threadOf(view)
    kinds[delegatedKind(view.work, thread?.providerId)]++
    if (pendingRequestOf(view, thread)) asking++
    if (view.outcome === 'failed') failed++
    if (view.outcome === 'unknown') unknown++
  }
  return [
    kinds.work && counted(kinds.work, 'delegated thread', 'delegated threads'),
    kinds.review && counted(kinds.review, 'review', 'reviews'),
    kinds['muse-review'] && (kinds['muse-review'] === 1 ? 'Muse review' : `${kinds['muse-review']} Muse reviews`),
    asking && `${asking} ${asking === 1 ? 'needs' : 'need'} you`,
    failed && `${failed} failed`,
    unknown && `${unknown} unknown`,
    refused && `${refused} refused`,
  ].filter(Boolean).join(' · ')
}
