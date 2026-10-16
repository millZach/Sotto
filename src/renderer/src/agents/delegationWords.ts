import type { AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, type DelegationView } from '../../../shared/delegation'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import type { WatcherOutcome } from '../../../shared/watcher'
import { clockLabel } from './threadFacts'

/**
 * The words delegation shows in the window (#1029, design A): a card's outcome and its wait line, "Delegated by", and
 * what Stop will stop. Outcomes are worded as Watcher's are, as the placement prototype words them.
 */
export const DELEGATION_OUTCOME_WORDS: Readonly<Record<WatcherOutcome, string>> = {
  working: 'Working', background: 'Background work', answered: 'Answered', failed: 'Failed', stopped: 'Stopped', paused: 'Paused', unknown: 'Unknown',
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
 * wait in progress counts from.
 */
export function delegationWaitLine(view: DelegationView, now: number): string {
  const wait = view.wait
  const wentOn = wait !== undefined && (wait.wentOnAt !== undefined || wait.seconds === 0)
  switch (view.outcome) {
    case 'working': {
      if (view.waiting && !wait) return view.action === 'start' ? 'Sotto is starting it and sending the brief.' : 'Sotto is sending it the brief.'
      if (view.waiting && wait) {
        const so = Number.isFinite(Date.parse(wait.startedAt)) ? ` ${delegationDuration(now - Date.parse(wait.startedAt))} so far.` : ''
        return `This thread waits up to ${delegationDuration(wait.seconds * 1000)} for it.${so}`
      }
      if (wait && wait.seconds === 0) return 'This thread did not wait for it. The answer comes back as a wake-up.'
      if (wait) return `This thread waited ${delegationDuration(wait.seconds * 1000)}, then went on. The answer comes back as a wake-up.`
      return 'The answer comes back as a wake-up.'
    }
    case 'background': return 'Its turn ended with background work still running. This thread hears when it settles.'
    case 'answered': {
      const took = between(wait?.startedAt ?? view.createdAt, view.outcomeAt)
      const answered = took === undefined ? 'Answered' : `Answered in ${delegationDuration(took)}`
      return wentOn ? `${answered}, after this thread went on. It was told by wake-up.` : `${answered}, while this thread waited for it.`
    }
    case 'failed':
      if (view.notSent === 'provider') return 'Sotto could not start it or send it the brief. Nothing was sent.'
      return `Its last turn failed.${wentOn ? ' This thread was told by wake-up.' : ''} Open it to see why.`
    case 'stopped':
      return view.notSent === 'stopped' ? `Stopped${at(view.outcomeAt)}, before the brief was sent.` : `Stopped${at(view.outcomeAt)}. Nothing more will come of it.`
    case 'paused':
      if (view.notSent === 'target-changed') return `You sent to it${at(view.outcomeAt)}, so Sotto did not send this brief.`
      if (view.notSent === 'paused') return `You were working in it${at(view.outcomeAt)}, so Sotto did not send this brief.`
      return `You sent to it${at(view.outcomeAt)}. This thread sends it nothing more until your turn there ends.`
    case 'unknown':
      return view.notSent === 'restarted' ? 'Sotto restarted before the brief was sent. Nothing was sent.' : 'Sotto restarted while it worked. Nothing was resent. Open it to see where it got to.'
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
 * The line under a delegated thread's composer: what the user's own turn there does to the thread that delegated, from
 * the outcome of the newest brief it sent here (decision 6).
 */
export function delegatedNote(parent: string, outcome: WatcherOutcome | undefined, running: boolean): string {
  if (outcome === 'paused' && running) return `Your turn is running. ${parent} sends nothing here until it ends.`
  return outcome === 'working' || outcome === 'background'
    ? `If you send here, ${parent} sends nothing more until your turn ends.` : `${parent} cannot send here while you have a turn running.`
}
