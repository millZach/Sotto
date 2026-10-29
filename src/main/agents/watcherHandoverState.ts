import type { WatcherKeptState, WatcherMergeQueueItem, WatcherPullRequestSummary, WatcherStateThread, WatcherWaitingOnUser } from '../../shared/watcher'

/**
 * What a new Watcher's handover says beside the last one's words (#1735). Zach, October 28, 2026: "the handoff should note
 * everything important for the new watcher." The conversation alone left out what Sotto knows and the new Watcher would
 * otherwise have to find: what read_state works out from live data, and what only the replacement knows. It is built
 * when the handover is sent, from what the room already holds, and costs no model call. Neither it nor its caller logs.
 */

/** What only the replacement knows: what it did to the last Watcher's work so the new one could start. */
export interface WatcherCarried {
  /** The questions and permissions the last Watcher was waiting on the user for, closed unanswered when its turn was stopped. */
  readonly questions: readonly string[]
  /** How many of the user's messages to the last Watcher that had not gone now wait, paused, in the new one's queue. */
  readonly moved: number
  /** Whether the user's last message to the last Watcher, sent at once, was never confirmed. */
  readonly unconfirmed: boolean
  /** Whether what the user left in the last Watcher's message box now waits in the new one's. */
  readonly draftMoved?: boolean
  /** Threads the last Watcher started on another computer, still working, that the new one cannot direct there yet. */
  readonly cannotStop: readonly { readonly title: string; readonly host: string }[]
}

export interface WatcherHandoverStateInput {
  readonly watching: readonly (WatcherStateThread & { readonly host?: string | undefined; readonly pullRequests: readonly WatcherPullRequestSummary[] })[]
  readonly mergeQueue: readonly WatcherMergeQueueItem[]
  readonly waitingOnUser: readonly WatcherWaitingOnUser[]
  /** Starts and sends Watcher made that have not been confirmed as gone: queued behind a turn, sending or unconfirmed. */
  readonly pending: readonly { readonly operationId: string; readonly action: 'start' | 'send' | 'stop' | 'settle'; readonly title: string; readonly state: 'queued' | 'dispatching' | 'uncertain' }[]
  readonly carried: WatcherCarried | null
  readonly kept: Pick<WatcherKeptState, 'decisions' | 'rules' | 'issues'>
}

/** The most rows of any one list, so a long history cannot crowd out the conversation it goes with. */
const ROWS_MAX = 40
const LINE_MAX = 400
const one = (text: string): string => { const flat = text.replace(/\s+/gu, ' ').trim(); return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat }
const named = (title: string): string => `“${one(title) || 'Untitled thread'}”`
const pullRequest = (pr: WatcherPullRequestSummary): string => [pr.number === undefined ? 'a pull request' : `#${pr.number}`, pr.url,
  pr.checks ? `checks ${pr.checks}` : undefined, pr.approved ? 'approved' : undefined, pr.autoMerge ? 'set to merge itself' : undefined].filter(Boolean).join(', ')
const PENDING: Record<WatcherHandoverStateInput['pending'][number]['state'], string> = {
  queued: 'queued behind its turn', dispatching: 'sending now', uncertain: 'not confirmed yet',
}
const ACTION: Record<WatcherHandoverStateInput['pending'][number]['action'], string> = { start: 'A start of', send: 'A send to', stop: 'A stop of', settle: 'A settle of' }
const WAITS_FOR: Record<WatcherWaitingOnUser['waitsFor'], string> = { question: 'a question', permission: 'a permission', 'prototype-review': 'a prototype to review' }

/** One list, at most `ROWS_MAX` rows, then `more` for the rest, which says how many there are and where to read them. */
function list(heading: string, rows: readonly string[], more: (rest: number) => string = rest => `And ${rest} more.`): string[] {
  if (!rows.length) return []
  const shown = rows.slice(0, ROWS_MAX).map(row => `- ${row}`)
  return [heading, ...shown, ...rows.length > ROWS_MAX ? [`- ${more(rows.length - ROWS_MAX)}`] : [], '']
}
const inReadState = (rest: number) => `And ${rest} more. read_state lists them all.`

/** The section, or an empty string when there is nothing to say. Each part appears only when it has something in it. */
export function watcherHandoverState(input: WatcherHandoverStateInput): string {
  const carried = input.carried
  const lines = [
    ...list('The last Watcher was waiting on the user for this when it was replaced. Its turn was stopped and the card closed unanswered, so ask again if it still matters:',
      (carried?.questions ?? []).map(one)),
    ...carried && carried.moved > 0 ? [carried.moved === 1
      ? 'One message the user wrote to the last Watcher had not gone. It waits, paused, in your queue for the user to send or remove.'
      : `${carried.moved} messages the user wrote to the last Watcher had not gone. They wait, paused, in your queue for the user to send or remove.`, ''] : [],
    ...carried?.draftMoved ? ['What the user had written in the last Watcher’s message box and not sent is now in yours, unsent.', ''] : [],
    ...carried?.unconfirmed ? ['The user’s last message to the last Watcher was never confirmed. If it arrived it is in the history above; if not, the user may send it again.', ''] : [],
    ...list('Threads the last Watcher started on another computer that are still working. That computer runs an older Sotto, so you cannot stop, settle or send to them there until it is updated:',
      (carried?.cannotStop ?? []).map(row => `${named(row.title)} on ${one(row.host)}`)),
    ...list('Starts and sends made before you that have not gone yet. They are yours now and go as they were made; read_operation reads each:',
      input.pending.map(row => `${ACTION[row.action]} ${named(row.title)}, ${PENDING[row.state]} (operation ${row.operationId})`),
      // read_state lists none of them and read_operation needs each ID, so every one is named, however many there are.
      rest => `And ${rest} more, by operation: ${input.pending.slice(ROWS_MAX).map(row => row.operationId).join(', ')}.`),
    ...list('The threads you watch and what each waits on:', input.watching.map(row => [`${named(row.title)}${row.host ? ` on ${one(row.host)}` : ''}: ${one(row.waitsOn)}`,
      ...row.pullRequests.length ? [`Open pull requests: ${row.pullRequests.map(pullRequest).join('; ')}.`] : []].join(' ')), inReadState),
    ...list('The merge queue, oldest passing checks first:', input.mergeQueue.map(row => `${named(row.title)}: ${pullRequest(row.pullRequest)}`), inReadState),
    ...list('What waits on the user now:', input.waitingOnUser.map(row => `${named(row.title)} waits for ${WAITS_FOR[row.waitsFor]}`), inReadState),
    ...list('Decisions the user left pending, as kept:', input.kept.decisions.filter(line => !line.closedAt).map(line => `${line.id}: ${one(line.text)}`), inReadState),
    ...list('Standing rules the user gave, as kept:', input.kept.rules.filter(line => !line.closedAt).map(line => `${line.id}: ${one(line.text)}`), inReadState),
    ...list('Issues filed, as kept:', input.kept.issues.filter(line => !line.closedAt).map(line => `${line.id}: ${one(line.text)}`), inReadState),
  ]
  if (!lines.length) return ''
  return ['[How things stand as you take over, from Sotto’s own records. This is context, not a new request; read_state reads it again live.]', '', ...lines].join('\n').trimEnd()
}
