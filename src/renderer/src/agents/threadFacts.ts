import { i18n } from '@lingui/core'
import { useSyncExternalStore } from 'react'
import { t } from '@lingui/core/macro'

import { hostForThread, PROVIDER_LABELS, isThreadProviderConnected, providerIdOfLabel, threadSummaryOf, type AgentModel, type AgentProject, type AgentRequest, type AgentState, type AgentThread, type ProviderId } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { continuedWordsOf } from '../../../shared/continueThread'
import { HANDOVER_LEAD } from '../../../shared/handover'
import { babysittingWord } from './babysitting'
import { restartRowWords } from './restartWords'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../shared/threadActivity'
import { failureUnseen } from '../../../shared/threadFailures'
import { localeFormatKey, localeFormatter } from './localeFormat'
import { share } from './stateSharing'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** What the Threads page says a thread is doing; every value derives from Sotto's own state. */
export type ThreadRowState = 'needs' | 'working' | 'done'

/** The badge tint for a provider; `other` is the neutral badge for a provider Sotto has no colour for. */
export type ProviderKey = ProviderId | 'other'

export interface ThreadLastMessage {
  readonly who: string
  readonly at: number
  readonly text: string
}

export interface ThreadRequestView {
  readonly requestId: string
  readonly kind: 'question' | 'permission'
  readonly text: string
}

export interface ThreadRow {
  readonly thread: AgentThread
  readonly project: AgentProject | undefined
  readonly model: AgentModel | undefined
  /** "Claude, in workshop": the model's provider name, or the connected provider when the model is unknown. */
  readonly provider: string
  readonly providerKey: ProviderKey
  /** The thread's native provider when Sotto can tell; undefined for an unrecognized provider. */
  readonly providerId: ProviderId | undefined
  /** Whether the thread's own provider is connected; history stays readable either way. */
  readonly connected: boolean
  /** Set while the thread's host restarts for an update and this computer connects to it again (ADR-0040). */
  readonly reconnecting: boolean
  /** Why the row sits in Settled: its project, its own choice, or the provider closed it. Null when open. */
  readonly settledBy: 'project' | 'thread' | 'provider' | null
  readonly state: ThreadRowState
  readonly stateLabel: string
  /** What a row that needs you is waiting for: a permission to allow or deny, or a question to answer. */
  readonly waitingFor: 'approval' | 'question' | null
  /** The first pending request, with permissions ahead of questions. */
  readonly request: ThreadRequestView | undefined
  /** A pending request. Search never hides these rows. */
  readonly attention: boolean
  /** One sentence of what is happening now. */
  readonly sentence: string
  /** Last known activity for ordering and the row clock; NaN when unknown. */
  readonly activityAt: number
  /** Beside the state: how long a working thread has been at it, otherwise the clock of its last activity. */
  readonly when: string
  /** When the run on screen started, for the sidebar's live clock; NaN when the thread is not working. */
  readonly workingSince: number
  /** Your side of the thread, shown under an open row; the sentence already carries the provider's. */
  readonly lastMessage: ThreadLastMessage | undefined
  /**
   * The delegated thread below this one whose request the row's needs-you stands for (ADR-0081, October 17, 2026): set
   * only on a sidebar row that says Needs your approval or Needs your answer for a thread it delegated, never its own.
   */
  readonly waitingIn?: string | undefined
}

export interface ThreadGroup {
  readonly id: string
  readonly label: string
  readonly tone: 'needs' | 'plain'
  readonly rows: readonly ThreadRow[]
}

const parse = (value: string | null | undefined): number => {
  if (value == null || value === '') return Number.NaN
  return Date.parse(value)
}

/** Other names a label may give a provider than its id or its name: its company's, or ChatGPT for Codex. */
const OTHER_NAMES: Readonly<Record<string, ProviderKey>> = {
  anthropic: 'claude', openai: 'codex', chatgpt: 'codex', xai: 'grok', cognition: 'devin', meta: 'muse',
}

/** The badge tint for a provider name as the provider reports it (a model's `provider` field), never a model's display name. */
export function providerKey(provider: string): ProviderKey {
  return providerIdOfLabel(provider) ?? OTHER_NAMES[provider.trim().toLocaleLowerCase()] ?? 'other'
}

/** Sotto's badge glyph for an agent provider; an unknown provider gets its initial. */
export function providerGlyph(provider: string): string {
  const glyphs: Readonly<Record<ProviderKey, string>> = { claude: 'C', codex: '›_', grok: 'X', devin: 'D', muse: 'M', opencode: 'O', cursor: 'Cu', deepseek: 'DS', other: provider.trim().charAt(0).toLocaleUpperCase() }
  const glyph = glyphs[providerKey(provider)]
  return glyph === '' ? '?' : glyph
}

const clockTime = localeFormatter({ hour: 'numeric', minute: '2-digit' })
/** "2:02 pm" in the window's own locale; empty when the moment cannot be read. One formatter serves every call (#1328). */
export function clockLabel(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.valueOf())) return ''
  return clockTime(date).toLocaleLowerCase()
}

/** "4 min", "2 h", "3 d": how long a working thread has been at it. */
export function elapsedLabel(since: number, now: number): string {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return ''
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** "12s", "4m 05s", "2h 07m": a working thread's clock, counted in whole seconds so it can tick. */
export function workingLabel(since: number, now: number): string {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return ''
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d`
}

/**
 * A continued thread's first message begins with the handover of the thread it continues (ADR-0089), which no row
 * shows: its excerpt is the user's words after it, or, where the excerpt was cut before they began, none at all.
 */
function continuedExcerpt<T extends { readonly id: string; readonly text: string }>(thread: AgentThread, excerpt: T | undefined): T | undefined {
  if (excerpt === undefined || thread.continuedFrom?.handover === undefined || !excerpt.text.startsWith(HANDOVER_LEAD)) return excerpt
  const proof = thread.continuedFrom.handover
  if (proof.messageId !== undefined && proof.messageId !== excerpt.id) return excerpt
  const words = continuedWordsOf(thread, excerpt)
  return words === undefined ? undefined : { ...excerpt, text: words }
}

/** When the run on screen began: the provider's running turn if it reported one, otherwise your last prompt. */
function runStartedAt(thread: AgentThread, lastUserAt: number, activityAt: number): number {
  // The shell stream carries the running turn's start in the summary; a full state still has the record.
  const started = parse(threadSummaryOf(thread).runningTurnStartedAt)
  return Number.isFinite(started) ? started : Number.isFinite(lastUserAt) ? lastUserAt : activityAt
}

/**
 * Everything a row reads from the state besides its own thread record. `describe` reads the state through this alone, so
 * a row described from the same thread record and the same inputs, with the same words and clock, is the same row.
 */
interface RowInputs {
  /** The thread's project, the first with its ID. */
  readonly project: AgentProject | undefined
  /** The model catalog of the host the thread runs on. */
  readonly models: readonly AgentModel[]
  /** The host's name, the provider a row names when neither its model nor its thread says one. */
  readonly hostName: string
  readonly connected: boolean
}

function describe(thread: AgentThread, inputs: RowInputs, now: number, continued: boolean): ThreadRow {
  const { project } = inputs
  const model = resolveModel(inputs.models, thread.modelId)
  const provider = model?.provider ?? (thread.providerId ? PROVIDER_LABELS[thread.providerId] : inputs.hostName)
  // A row's history facts come from the thread's summary: the shell stream carries it in place of the
  // messages, and a thread whose messages did arrive derives exactly the same thing.
  const { lastAssistant, lastUser: lastUserExcerpt, lastMessageAt } = threadSummaryOf(thread)
  const lastUser = continued ? continuedExcerpt(thread, lastUserExcerpt) : lastUserExcerpt
  const closed = isThreadClosed(thread)
  const pending = closed ? undefined : thread.requests.find(request => request.kind === 'permission') ?? thread.requests[0]
  const decision: ThreadRequestView | undefined = pending === undefined ? undefined : { requestId: pending.id, kind: pending.kind, text: pending.text }
  const attention = !closed && thread.requests.length > 0
  const activityAt = [parse(thread.updatedAt), parse(thread.settledAt), parse(thread.archivedAt),
    parse(lastMessageAt)]
    .reduce((latest, at) => Number.isFinite(at) && (!Number.isFinite(latest) || at > latest) ? at : latest, Number.NaN)

  let state_: ThreadRowState
  let stateLabel: string
  let sentence: string
  let sentenceFromUser = false
  let waitingFor: ThreadRow['waitingFor'] = null
  if (closed) {
    state_ = 'done'
    stateLabel = Number.isFinite(parse(thread.archivedAt)) ? t({ message: 'Archived', comment: 'A thread row\'s state.' }) : t({ message: 'Settled', comment: 'A thread row\'s state: the thread or its project was put away.' })
    sentence = lastAssistant?.text ?? t`This thread is closed. Its history is still available.`
  } else if (decision !== undefined || failureUnseen(thread)) {
    // A failed turn a client has shown, or the user dismissed, is no longer news: it reads Done below (ADR-0092).
    state_ = 'needs'
    // A permission holds the agent still until you allow or deny it, so it outranks a question here as it does in the composer.
    const kinds = [decision?.kind, ...thread.requests.map(request => request.kind)]
    waitingFor = kinds.includes('permission') ? 'approval' : kinds.includes('question') ? 'question' : null
    stateLabel = waitingFor === 'approval' ? t`Needs your approval` : waitingFor === 'question' ? t`Needs your answer`
      : thread.status === 'error' && decision === undefined ? t`Needs attention` : t`Waiting on you`
    sentence = decision !== undefined
      ? (lastAssistant?.text ?? decision.text)
      : (lastAssistant?.text ?? t`The agent reported an error. Open the transcript to see what happened.`)
  } else if (thread.compaction?.status === 'running') {
    // Compaction keeps the thread running without the agent working, so the row says which of the two it is.
    state_ = 'working'
    stateLabel = t`Compacting context`
    sentence = t`Compacting the context. Nothing can be sent until it finishes.`
  } else if (thread.status === 'running') {
    state_ = 'working'
    stateLabel = t({ message: 'Working', comment: 'A thread row\'s state: its agent is working.' })
    if (lastAssistant !== undefined && (lastUser === undefined || parse(lastAssistant.createdAt) >= parse(lastUser.createdAt))) sentence = lastAssistant.text
    else if (lastUser !== undefined) {
      const prompt = lastUser.text
      sentence = t({ message: `Working on “${prompt}”.`, comment: '{prompt} is your last message to the thread.' })
      sentenceFromUser = true
    } else sentence = t`Working on your prompt.`
  } else if (thread.backgroundWork?.length) {
    // The turn has ended but work it started is still running, so the thread has not reported back yet.
    // Agents work; a command on its own is waited on, the word the composer's creature uses for it.
    state_ = 'working'
    stateLabel = thread.backgroundWork.some(task => task.type !== 'command')
      ? t({ message: 'Working', comment: 'A thread row\'s state: its agent is working.' })
      : t({ message: 'Waiting', comment: 'A thread row\'s state: a command it started is still running.' })
    sentence = lastAssistant?.text ?? t`Working in the background.`
  } else {
    state_ = 'done'
    stateLabel = t({ message: 'Done', context: 'thread state', comment: 'A thread row\'s state: its turn has finished.' })
    if (lastAssistant !== undefined) sentence = lastAssistant.text
    else if (thread.status === 'error') sentence = t`The last turn failed. Open the thread to see why.`
    else if (lastUser !== undefined) {
      const prompt = lastUser.text
      sentence = t({ message: `Waiting to start on “${prompt}”.`, comment: '{prompt} is your last message to the thread.' })
      sentenceFromUser = true
    } else sentence = t`Ready for your next prompt.`
  }

  // The card never repeats the sentence: it shows your latest prompt, or nothing.
  const lastUserAt = parse(lastUser?.createdAt)
  const lastMessage: ThreadLastMessage | undefined = lastUser === undefined || sentenceFromUser ? undefined : {
    // Babysitting's wake-ups are Sotto's, by the record of who sent them, never by their text.
    who: thread.wakeUpMessageIds?.includes(lastUser.id) ? 'Sotto' : t({ message: 'You', comment: 'Who sent a thread\'s last message.' }),
    at: Number.isFinite(lastUserAt) ? lastUserAt : activityAt,
    text: lastUser.text,
  }

  const workingSince = state_ === 'working' ? runStartedAt(thread, lastUserAt, activityAt) : Number.NaN
  const key = providerKey(provider)
  const settledBy: ThreadRow['settledBy'] = isWorkspaceThreadSettled({ workspaceSettledAt: null }, project) ? 'project'
    : isWorkspaceThreadSettled(thread) ? 'thread' : closed ? 'provider' : null
  return {
    thread, project, model, provider, providerKey: key, state: state_, stateLabel, waitingFor, request: decision, attention,
    providerId: thread.providerId ?? model?.providerId ?? (key === 'other' ? undefined : key),
    connected: inputs.connected, reconnecting: thread.clientReconnecting === true, settledBy,
    sentence, activityAt,
    when: state_ === 'working' ? workingLabel(workingSince, now) : clockLabel(activityAt), workingSince,
    lastMessage,
  }
}

/**
 * What Dismiss all names: every thread whose row says Needs attention for a failed turn, wherever it is listed, with the
 * host's name for the failure it showed, so a failure that comes after the press is not marked seen with it (ADR-0092).
 */
export function unseenFailures(threads: readonly AgentThread[]): { readonly threadId: string; readonly failure: string }[] {
  return threads.filter(failureUnseen).map(thread => ({ threadId: thread.id, failure: thread.failureId ?? '' }))
}

/**
 * The state a sidebar row says. A thread whose prototype waits for the user says Prototype ready (ADR-0108); one the
 * host marked finished while no client showed it says Just finished (ADR-0046); one that babysits a pull request says so
 * (ADR-0061, variant C). Each stands where the row would say Done, in that order, so Working and anything waiting on you
 * outrank all three. Settling says Settled, which ends babysitting anyway and leaves a prototype to the thread's pane.
 * `background` is a Done thread something will still wake, babysitting or a monitoring task, which says Monitoring there:
 * the status ring shows an hourglass for it rather than the idle outline.
 */
export function rowStatus(row: Pick<ThreadRow, 'thread' | 'state' | 'stateLabel' | 'settledBy'>, options: {
  /**
   * Restarting stopped threads is on (ADR-0144, an Owl feature): a thread with a restart scheduled says when, in place of
   * its failure line, and nothing says Babysitting, which the feature takes away.
   */
  readonly restart?: boolean
  readonly now?: number
} = {}): {
  readonly text: string; readonly finished: boolean; readonly babysitting: boolean; readonly prototype: boolean; readonly background: boolean
  /** The text says when Sotto restarts the thread. */
  readonly restart: boolean
} {
  const restart = options.restart === true && row.state !== 'working' ? restartRowWords(row.thread, options.now) : undefined
  if (restart !== undefined) return { text: restart, finished: false, babysitting: false, prototype: false, background: false, restart: true }
  const label = row.settledBy === 'provider' ? row.stateLabel
    : row.state === 'done' && row.settledBy !== null ? t({ message: 'Settled', comment: 'A thread row\'s state: the thread or its project was put away.' }) : row.stateLabel
  // A row says Done exactly when it is done and neither settled nor closed: its state says so, whatever language its words are in.
  const done = row.state === 'done' && row.settledBy === null
  const prototype = row.thread.prototypeReady !== undefined && done
  const finished = !prototype && row.thread.finishedUnread === true && done
  const babysitting = !prototype && !finished && done && options.restart !== true ? babysittingWord(row.thread) : undefined
  // A monitoring task alone says Monitoring, the creature's readout word for it; babysitting names its pull request.
  const monitoring = !prototype && !finished && done && (row.thread.monitoring?.length ?? 0) > 0
  const background = babysitting !== undefined || monitoring
  return { text: prototype ? t`Prototype ready` : finished ? t`Just finished`
    : babysitting ?? (monitoring ? t({ message: 'Monitoring', comment: 'A thread row\'s state: a task its agent started is being watched.' }) : label),
  finished, babysitting: babysitting !== undefined, prototype, background, restart: false }
}

/**
 * Every thread Sotto knows, described from its own state. `continued` is the Owl answer for continuing on another provider
 * (ADR-0089): with it, a continued thread's excerpt is the user's words rather than the handover ahead of them.
 */
export function describeThreads(state: AgentState, now: number, options: { readonly continued?: boolean } = {}): readonly ThreadRow[] {
  return threadDescriber()(state, now, options)
}

/** Every thread described from one state, with the same options as `describeThreads`. */
export type ThreadDescriber = (state: AgentState, now: number, options?: { readonly continued?: boolean }) => readonly ThreadRow[]

/** A row and everything it was described from. */
interface DescribedRow extends RowInputs {
  readonly thread: AgentThread
  /** The clock a working row counts its time on; undefined for a row that does not read the clock. */
  readonly now: number | undefined
  readonly row: ThreadRow
}

/** Moves on whenever the interface language or its messages change: a row's words are then those of another catalog. */
let wordsRevision = 0
i18n.on('change', () => { wordsRevision++ })
const subscribeToWords = (listener: () => void): (() => void) => i18n.on('change', listener)
const currentWords = (): number => wordsRevision

/**
 * The words revision a page's described rows and folders are in, for their memo dependencies. Unlike the locale, it also
 * moves when messages load into the language already shown, and the page renders again when it does.
 */
export function useWordsRevision(): number {
  return useSyncExternalStore(subscribeToWords, currentWords)
}

/**
 * `describeThreads` for a page that describes every new state: it describes again only the threads whose row could have
 * changed, and gives every other thread the row it gave last time, the same object. Main publishes every update
 * with the records of unchanged threads kept (issue #1330, and the window's own state sharing), so while threads stream
 * the work per update follows the threads that changed rather than all of them, and the shared rows let `useShared` and
 * the memoised sidebar and panes skip the rest at once.
 *
 * A row is kept only while everything `describe` reads is unchanged: the thread record, its project, its host's model
 * catalog, the host's name, whether its provider is connected, and, for a working row, the clock its time counts.
 * Continuing on another provider being turned on or off, a change of language or of its messages, and a change of the
 * window's language or time zone, which its clocks are formatted in, describe every row again. A row described again is
 * shared against the one it replaces, so a row whose facts did not change keeps its reference either way. The result is
 * always equal to `describeThreads` for the same state.
 */
export function threadDescriber(): ThreadDescriber {
  let held = new Map<string, DescribedRow>()
  let heldFor = ''
  let last: readonly ThreadRow[] = []
  return (state, now, options = {}) => {
    const continued = options.continued === true
    const describedFor = `${continued ? 1 : 0}|${wordsRevision}|${localeFormatKey()}`
    if (describedFor !== heldFor) { held = new Map(); heldFor = describedFor }
    const { host } = state
    const projects = new Map<string, AgentProject>()
    for (const project of host.projects) if (!projects.has(project.id)) projects.set(project.id, project)
    const catalogs = new Map<string | undefined, readonly AgentModel[]>()
    const next = new Map<string, DescribedRow>()
    let same = host.threads.length === last.length
    const rows = host.threads.map((thread, index) => {
      let models = catalogs.get(thread.hostId)
      if (models === undefined) { models = hostForThread(host, thread).models; catalogs.set(thread.hostId, models) }
      const inputs: RowInputs = { project: projects.get(thread.projectId), models, hostName: host.name, connected: isThreadProviderConnected(host, thread) }
      const previous = held.get(thread.id)
      const kept = previous !== undefined && previous.thread === thread && previous.project === inputs.project && previous.models === models
        && previous.hostName === inputs.hostName && previous.connected === inputs.connected && (previous.now === undefined || previous.now === now)
      let entry = previous!
      if (!kept) {
        const fresh = describe(thread, inputs, now, continued)
        entry = { ...inputs, thread, now: fresh.state === 'working' ? now : undefined, row: previous === undefined ? fresh : share(previous.row, fresh) }
      }
      next.set(thread.id, entry)
      if (entry.row !== last[index]) same = false
      return entry.row
    })
    held = next
    if (!same) last = rows
    return last
  }
}

/** A row matches when the query appears anywhere in it: title, project, provider, sentence or your last message. */
function matchesThreadQuery(row: ThreadRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  return [row.thread.title, row.project?.title ?? '', row.provider, row.model?.name ?? '', row.sentence, row.lastMessage?.text ?? '']
    .some(field => field.toLocaleLowerCase().includes(needle))
}

/**
 * The rows a search leaves on the page. `matching` is what the query found;
 * `listed` adds pending requests, which stay visible whatever you type.
 */
export function listThreads(rows: readonly ThreadRow[], query: string): { readonly matching: ThreadRow[]; readonly listed: ThreadRow[] } {
  const matching = rows.filter(row => matchesThreadQuery(row, query))
  const matched = new Set(matching)
  return { matching, listed: rows.filter(row => row.attention || matched.has(row)) }
}

/** Open work and Settled history (workspace-settled, provider-settled or archived); unknown activity sorts last. */
export function groupThreads(rows: readonly ThreadRow[], _now?: number): ThreadGroup[] {
  // Retain the old clock argument for callers; lifecycle grouping does not use it.
  void _now
  const sorted = [...rows].sort((first, second) => {
    const firstAt = Number.isFinite(first.activityAt) ? first.activityAt : Number.NEGATIVE_INFINITY
    const secondAt = Number.isFinite(second.activityAt) ? second.activityAt : Number.NEGATIVE_INFINITY
    return (secondAt - firstAt) || first.thread.id.localeCompare(second.thread.id)
  })
  const unsettled = sorted.filter(row => row.settledBy === null)
  const settled = sorted.filter(row => row.settledBy !== null)
  const groups: ThreadGroup[] = []
  if (unsettled.length > 0) groups.push({ id: 'unsettled', label: t`Unsettled`, tone: 'plain', rows: unsettled })
  if (settled.length > 0) groups.push({ id: 'settled', label: t({ message: 'Settled', comment: 'A thread row\'s state: the thread or its project was put away.' }), tone: 'plain', rows: settled })
  return groups
}

/** "3 active, 11 this week": active is needs you plus running; this week is any activity in the last seven days. */
export function threadCounts(rows: readonly ThreadRow[], now: number): { readonly active: number; readonly week: number } {
  return {
    active: rows.filter(row => row.state === 'needs' || row.state === 'working').length,
    week: rows.filter(row => row.activityAt >= now - WEEK_MS).length,
  }
}

/** One project folder in the sidebar: a Sotto project ID and the threads listed beneath it. */
export interface ProjectFolder {
  /** The Sotto project ID; a thread whose project is unknown keeps its own project ID. */
  readonly id: string
  readonly project: AgentProject | undefined
  readonly title: string
  /** The whole project was settled; its folder sits in Settled with every thread. */
  readonly settled: boolean
  readonly rows: readonly ThreadRow[]
  readonly working: number
  readonly needs: number
  readonly activityAt: number
}

/** Asleep at `now` (ADR-0175): snoozed until later, and not waiting on the user, since a thread that needs you wakes. */
export const isSnoozed = (row: ThreadRow, snoozes: ReadonlyMap<string, number> | undefined, now: number): boolean =>
  row.state !== 'needs' && (snoozes?.get(row.thread.id) ?? 0) > now

export interface WorkspaceOrganization {
  readonly open: readonly ProjectFolder[]
  /** Open threads the user snoozed until a later time (ADR-0175; Owl only), under their projects. */
  readonly snoozed?: readonly ProjectFolder[]
  readonly settled: readonly ProjectFolder[]
  /** The Needs you queue over every row, search or none (ADR-0135). */
  readonly needsYou: NeedsYouQueue
  /** Rows the query found, before attention rows are added back. */
  readonly matching: number
  /**
   * Each delegated thread the sidebar leaves out, with the listed thread it is reached from: the top of its delegation
   * (ADR-0081, October 17, 2026). The sidebar marks that row current while the delegated thread is in the pane. Absent
   * while the Owl list keeps delegation off.
   */
  readonly listedAs?: ReadonlyMap<string, string>
}

const byActivity = (first: { readonly activityAt: number; readonly id: string }, second: { readonly activityAt: number; readonly id: string }): number => {
  const firstAt = Number.isFinite(first.activityAt) ? first.activityAt : Number.NEGATIVE_INFINITY
  const secondAt = Number.isFinite(second.activityAt) ? second.activityAt : Number.NEGATIVE_INFINITY
  return (secondAt - firstAt) || first.id.localeCompare(second.id)
}

/**
 * Where each delegated thread is reached from (ADR-0081, as Zach settled it on October 17, 2026): the top of its
 * delegation, the thread at the end of its `delegatedBy` links, which the sidebar lists. A delegated thread whose
 * delegating thread is gone from the state is the top of its own, so it stays listed and is never out of reach; so is
 * every thread in a loop of links. So is an open delegated thread whose delegating thread is settled (`settled`, the
 * sidebar's own answer: the project or the thread settled, or the provider closed it), at either level: it stands in
 * Open with its own attention rather than under a thread on the Settled shelf. Threads no thread started are not in
 * the map.
 */
export function delegationTops(threads: readonly Pick<AgentThread, 'id' | 'delegatedBy' | 'swarm'>[], settled: (threadId: string) => boolean = () => false, swarms = false): ReadonlyMap<string, string> {
  // A swarm lead has its own row, even when another thread delegated the swarm. Its angles remain under that lead.
  const parents = new Map<string, string | undefined>(threads.map(thread => [thread.id, swarms && thread.swarm?.leadThreadId === thread.id ? undefined : thread.delegatedBy]))
  // A link holds unless it would put an open thread under a settled one.
  const linked = (child: string, parent: string): boolean => parents.has(parent) && (!settled(parent) || settled(child))
  const tops = new Map<string, string>()
  for (const thread of threads) {
    const parent = parents.get(thread.id)
    if (parent === undefined || !linked(thread.id, parent)) continue
    const seen = new Set([thread.id])
    let top = parent
    let loop = false
    for (let up = parents.get(top); up !== undefined && linked(top, up); up = parents.get(top)) {
      if (seen.has(top)) { loop = true; break }
      seen.add(top)
      top = up
    }
    if (!loop && !seen.has(top)) tops.set(thread.id, top)
  }
  return tops
}

/** How much a row below a thread needs the user, for the roll-up: a permission, then a question, then an error. */
const needRank = (row: Pick<ThreadRow, 'state' | 'waitingFor'>): number => row.waitingFor === 'approval' ? 3 : row.waitingFor === 'question' ? 2 : row.state === 'needs' ? 1 : 0

/**
 * The sidebar's rows while delegation is on: no row for a delegated thread, and each thread a delegated thread below it
 * needs the user for says so in the words its own row would: Needs your approval, then Needs your answer, then the
 * error's own words (Needs attention), as one row orders them. Its own waiting wins, and its own error outranks an
 * error below.
 */
function withoutDelegated(rows: readonly ThreadRow[], tops: ReadonlyMap<string, string>): ThreadRow[] {
  const waiting = new Map<string, ThreadRow>()
  for (const row of rows) {
    const top = tops.get(row.thread.id)
    if (top === undefined || needRank(row) === 0) continue
    const held = waiting.get(top)
    if (held === undefined || needRank(row) > needRank(held)) waiting.set(top, row)
  }
  return rows.filter(row => !tops.has(row.thread.id)).map((row): ThreadRow => {
    const below = waiting.get(row.thread.id)
    if (below === undefined || row.waitingFor !== null || (below.waitingFor === null && row.state === 'needs')) return row
    return { ...row, state: 'needs', waitingFor: below.waitingFor, stateLabel: below.stateLabel, attention: true,
      when: clockLabel(row.activityAt), workingSince: Number.NaN, waitingIn: below.thread.title }
  })
}

/** How many Needs you entries stand before the rest are counted in one line (ADR-0135). */
export const NEEDS_YOU_SHOWN_MAX = 3
export type NeedsYouKind = 'approval' | 'question' | 'failed'

/** One thread in the sidebar's Needs you queue: what it waits for, since when, and what a press there may do. */
export interface NeedsYouEntry {
  readonly row: ThreadRow
  readonly kind: NeedsYouKind
  /** The entry thread's own first pending request; undefined for a failure or a delegated wait reached from its top. */
  readonly request: AgentRequest | undefined
  /** When the wait began, from the host's stamp (ADR-0135); NaN when no stamp was published, which says no wait words. */
  readonly waitingSince: number
  /** "12 min", "2 h": how long it has waited, from its stamp alone; empty without one. */
  readonly wait: string
  /** Answer its own request in the card the entry pops open, dismiss its own failure, or open the thread where a
   * delegated thread below it waits (ADR-0135, October 29 amendment). */
  readonly action: 'answer' | 'dismiss' | 'open'
}

export interface NeedsYouQueue {
  readonly entries: readonly NeedsYouEntry[]
  readonly shown: readonly NeedsYouEntry[]
  readonly overflow: { readonly approval: number; readonly question: number; readonly failed: number; readonly total: number }
  /** The oldest blocking wait in words, for the heading; empty when nothing blocking carries a stamp. */
  readonly oldestBlockingWait: string
}

/** The queue with nobody in it, for a sidebar whose rows have not been described yet. */
export const EMPTY_NEEDS_YOU: NeedsYouQueue = { entries: [], shown: [], overflow: { approval: 0, question: 0, failed: 0, total: 0 }, oldestBlockingWait: '' }

/**
 * The Needs you queue over the sidebar's rows (ADR-0135): one entry per row that needs the user, blocking first —
 * permissions, then questions, then unseen failures, as `needRank` orders them — and oldest wait first inside each
 * kind. The wait reads the host's stamp where one stands and the row's last activity where none does, unknown last;
 * its words come from the stamp alone. Derived from the rows as given, settled rows included: what a row's state
 * already settled (seen failures, finishes, prototypes) never reaches this list.
 */
export function describeNeedsYou(rows: readonly ThreadRow[], now: number): NeedsYouQueue {
  const entries = rows.filter(row => row.state === 'needs').map((row): NeedsYouEntry => {
    const kind: NeedsYouKind = row.waitingFor ?? 'failed'
    const delegated = row.waitingIn !== undefined
    const request = delegated || row.request === undefined ? undefined
      : row.thread.requests.find(item => item.id === row.request!.requestId)
    const waitingSince = kind === 'failed' ? parse(row.thread.failureSince) : parse(request?.since)
    return {
      row, kind, request, waitingSince,
      wait: Number.isFinite(waitingSince) ? elapsedLabel(waitingSince, now) : '',
      action: delegated ? 'open' : kind === 'failed' ? 'dismiss' : request !== undefined ? 'answer' : 'open',
    }
  }).sort((first, second) => {
    const rank = needRank(second.row) - needRank(first.row)
    if (rank !== 0) return rank
    const at = (entry: NeedsYouEntry): number => Number.isFinite(entry.waitingSince) ? entry.waitingSince
      : Number.isFinite(entry.row.activityAt) ? entry.row.activityAt : Number.POSITIVE_INFINITY
    return (at(first) - at(second)) || first.row.thread.id.localeCompare(second.row.thread.id)
  })
  const rest = entries.slice(NEEDS_YOU_SHOWN_MAX)
  const oldestBlocking = entries.find(entry => entry.kind !== 'failed' && entry.wait !== '')
  return {
    entries,
    shown: entries.slice(0, NEEDS_YOU_SHOWN_MAX),
    overflow: {
      approval: rest.filter(entry => entry.kind === 'approval').length,
      question: rest.filter(entry => entry.kind === 'question').length,
      failed: rest.filter(entry => entry.kind === 'failed').length,
      total: rest.length,
    },
    oldestBlockingWait: oldestBlocking?.wait ?? '',
  }
}

function folder(id: string, project: AgentProject | undefined, rows: readonly ThreadRow[], settled: boolean): ProjectFolder {
  const sorted = [...rows].sort((first, second) => byActivity({ activityAt: first.activityAt, id: first.thread.id }, { activityAt: second.activityAt, id: second.thread.id }))
  return {
    id, project, title: project?.title ?? rows[0]?.provider ?? t`Project`, settled, rows: sorted,
    working: rows.filter(row => row.state === 'working').length,
    needs: rows.filter(row => row.state === 'needs').length,
    activityAt: rows.reduce((latest, row) => Number.isFinite(row.activityAt) && (!Number.isFinite(latest) || row.activityAt > latest) ? row.activityAt : latest, Number.NaN),
  }
}

const NOTHING_HELD: ReadonlyMap<string, string> = new Map()

/**
 * The open folders with each held thread's row put back where it stood, for the held gap (ADR-0167): a Settle pressed with
 * the pointer over the list leaves its row's place empty until the pointer leaves, so nothing slides under it. Settling
 * changes no row's activity, so a row put back by activity lands in its own place, and a folder the settle emptied, or
 * moved down by taking its latest thread, stands where it stood. A folder's counts stay those of its open rows. Only a
 * thread settled by itself is held, never one whose project was settled; one still open (its settle on its way, or
 * already restored) is left where it is. `placed` names each row put back with its folder.
 */
export function holdSettledRows(open: readonly ProjectFolder[], settled: readonly ProjectFolder[], held: ReadonlySet<string>): { readonly open: readonly ProjectFolder[]; readonly placed: ReadonlyMap<string, string> } {
  if (held.size === 0) return { open, placed: NOTHING_HELD }
  const back = settled.filter(item => !item.settled).flatMap(item => item.rows.filter(row => row.settledBy === 'thread' && held.has(row.thread.id)).map(row => ({ row, home: item })))
  if (back.length === 0) return { open, placed: NOTHING_HELD }
  const folders = new Map(open.map(item => [item.id, item]))
  const placed = new Map<string, string>()
  for (const { row, home } of back) {
    const base = folders.get(home.id) ?? { ...home, rows: [], working: 0, needs: 0, activityAt: Number.NaN }
    const rows = [...base.rows, row].sort((first, second) => byActivity({ activityAt: first.activityAt, id: first.thread.id }, { activityAt: second.activityAt, id: second.thread.id }))
    const activityAt = Number.isFinite(row.activityAt) && (!Number.isFinite(base.activityAt) || row.activityAt > base.activityAt) ? row.activityAt : base.activityAt
    folders.set(home.id, { ...base, rows, activityAt })
    placed.set(row.thread.id, home.id)
  }
  return { open: [...folders.values()].sort(byActivity), placed }
}

/**
 * Project folders for the sidebar. Open folders hold each unsettled project's open threads;
 * Settled holds whole settled projects plus individually settled threads under their own project.
 * A search keeps attention rows and projects whose name matches; without a search an open project
 * with no threads yet (or the selected project) still shows so a thread can be started there. With `delegation` (the Owl
 * answer for ADR-0081), a delegated thread has no row and no search finds it: it lives in the Tools › Agents of the thread
 * that delegated to it, whose row says when it waits on you. The Needs you queue is described from the same rows
 * before the search narrows them, so searching never changes it (ADR-0135).
 */
export function organizeWorkspace(state: AgentState, allRows: readonly ThreadRow[], query: string, activeProjectId: string | null = null, delegation = false, now: number = Date.now(), swarms = false, snoozes?: ReadonlyMap<string, number>): WorkspaceOrganization {
  const settledIds = delegation ? new Set(allRows.filter(row => row.settledBy !== null).map(row => row.thread.id)) : undefined
  const tops = delegation ? delegationTops(state.host.threads, threadId => settledIds!.has(threadId), swarms) : undefined
  const rows = tops?.size ? withoutDelegated(allRows, tops) : allRows
  const { matching, listed } = listThreads(rows, query)
  const isListed = new Set(listed)
  const needle = query.trim().toLocaleLowerCase()
  const projectMatches = (project: AgentProject): boolean => needle !== '' && `${project.title} ${project.path}`.toLocaleLowerCase().includes(needle)
  const projects = new Map(state.host.projects.map(project => [project.id, project]))
  const threadsByProject = new Map<string, ThreadRow[]>()
  for (const row of rows) {
    const held = threadsByProject.get(row.thread.projectId)
    if (held === undefined) threadsByProject.set(row.thread.projectId, [row]); else held.push(row)
  }
  const ids = new Set([...projects.keys(), ...threadsByProject.keys()])
  const open: ProjectFolder[] = []
  const snoozed: ProjectFolder[] = []
  const settled: ProjectFolder[] = []
  for (const id of ids) {
    const project = projects.get(id)
    const all = threadsByProject.get(id) ?? []
    const nameMatch = project !== undefined && projectMatches(project)
    const shown = nameMatch ? all : all.filter(row => isListed.has(row))
    if (isWorkspaceThreadSettled({ workspaceSettledAt: null }, project)) {
      if (shown.length || nameMatch || (needle === '' && all.length === 0)) settled.push(folder(id, project, shown, true))
      continue
    }
    const unsettled = shown.filter(row => row.settledBy === null)
    const asleep = snoozes?.size ? unsettled.filter(row => isSnoozed(row, snoozes, now)) : []
    const openRows = asleep.length ? unsettled.filter(row => !asleep.includes(row)) : unsettled
    const settledRows = shown.filter(row => row.settledBy !== null)
    const emptyOpen = needle === '' && (all.length === 0 || id === activeProjectId) && openRows.length === 0
    if (openRows.length || emptyOpen || (nameMatch && !settledRows.length && !asleep.length)) open.push(folder(id, project, openRows, false))
    if (asleep.length) snoozed.push(folder(id, project, asleep, false))
    if (settledRows.length) settled.push(folder(id, project, settledRows, false))
  }
  const ordered = (folders: ProjectFolder[]): ProjectFolder[] => folders.sort((first, second) => byActivity(first, second))
  return { open: ordered(open), ...snoozes?.size ? { snoozed: ordered(snoozed) } : {}, settled: ordered(settled), needsYou: describeNeedsYou(rows, now), matching: matching.length, ...(tops ? { listedAs: tops } : {}) }
}
