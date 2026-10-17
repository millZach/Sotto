import { isVisualMessage, PROVIDER_LABELS, type AgentAttachmentReference, type AgentMessage, type ProviderId } from '../../shared/agents'
import { HANDOVER_LEAD } from '../../shared/handover'
import type { ThreadStore } from './threadStore'

/**
 * A handover: a fixed-rule summary of one thread's history that a new thread can start from, built from Sotto's own
 * record of what was said (ADR-0016) and costing no model call. It is the same for every provider, because it reads
 * the event store rather than any provider's transcript.
 *
 * It keeps the thread's first user message, the latest request and its answer, then the most recent history, newest
 * first, until its character budget is spent, and shows what it kept oldest first. A message longer than its share of
 * the budget is left out whole and named; nothing is cut mid-way. Attachments, images, visuals, tool calls and their
 * results are never carried, and the handover says which of them it left out. It says plainly that the history is
 * context, not a new request.
 *
 * `buildHandover` is pure: messages and options in, text and a summary out. `readHandover` is the thin reader that
 * loads one thread's messages from the store. Neither logs; the text is the user's and the agents' words.
 */

/** How many characters of history a handover carries by default, counting each message with its heading. */
export const HANDOVER_BUDGET = 24_000
/** No single message may take more than this fraction of the budget, so the three kept messages always fit. */
const SHARE_DIVISOR = 4
/** The reader's page, and the most messages it reads back from the newest before it stops looking. */
const READ_PAGE = 50
const READ_MAX = 2_000
const TITLE_MAX = 200

export interface HandoverSource {
  /** The Sotto thread ID of the thread the history comes from (ADR-0002). */
  readonly threadId: string
  readonly title?: string | undefined
  readonly provider: ProviderId
}

export interface HandoverOptions {
  readonly source: HandoverSource
  /** False while Keep local history is off: the history is only what Sotto holds in memory since it started. */
  readonly historyKept: boolean
  readonly budget?: number | undefined
  /** How many tool-call records the thread holds. None of them is carried; the handover says how many it left out. */
  readonly toolRecords?: number | undefined
}

/** One message read for a handover, with its place among all the thread's messages, counting from 0 at the oldest. */
export interface PlacedMessage { readonly ordinal: number; readonly message: AgentMessage }

/**
 * What a handover is built from when the whole thread was not read: the messages that were, each in its place, and how
 * many the thread holds. The places not read are counted as not carried.
 */
export interface HandoverHistory {
  readonly messages: readonly PlacedMessage[]
  readonly total: number
}

/** One message left out because it was longer than its share of the budget: who said it, when and how long it was. */
export interface HandoverOmission {
  readonly messageId: string
  readonly role: AgentMessage['role']
  readonly createdAt: string
  readonly characters: number
}

/** What a handover carried and what it left out, without any of the words. */
export interface HandoverSummary {
  readonly total: number
  /** The IDs of the messages carried, oldest first. */
  readonly carried: readonly string[]
  readonly tooLong: readonly HandoverOmission[]
  /** Messages left out because the budget was spent before them, or because they were never read. */
  readonly notCarried: number
  /** Attachments on the carried messages, none of which is carried. */
  readonly images: number
  readonly files: number
  readonly visuals: number
  readonly toolRecords: number
  readonly historyKept: boolean
  /** False when the latest request has no answer yet. */
  readonly answered: boolean
}

export interface Handover {
  readonly text: string
  readonly summary: HandoverSummary
}

export function buildHandover(history: HandoverHistory | readonly AgentMessage[], options: HandoverOptions): Handover {
  const read = isHistory(history) ? history : { messages: history.map((message, ordinal) => ({ ordinal, message })), total: history.length }
  const placed = [...read.messages].sort((left, right) => left.ordinal - right.ordinal)
  const total = Math.max(read.total, (placed.at(-1)?.ordinal ?? -1) + 1)
  const visuals = placed.filter(entry => isVisualMessage(entry.message))
  const written = placed.filter(entry => !isVisualMessage(entry.message))
  const budget = budgetOf(options)
  const share = shareOf(budget)
  const speaker = speakerFor(options.source.provider)

  const carried = new Set<PlacedMessage>()
  const tooLong = new Set<PlacedMessage>()
  // The gap note after the last message shown is the one no message pays for.
  let remaining = budget - GAP_ALLOWANCE
  /** Carries one message if it fits. Says `spent` when it is within its share but the budget has run out. */
  const offer = (entry: PlacedMessage | undefined): 'carried' | 'too-long' | 'spent' | 'seen' => {
    if (entry === undefined || carried.has(entry) || tooLong.has(entry)) return 'seen'
    const cost = costOf(entry.message, speaker)
    if (cost > share) {
      // Naming it costs its notice, so a thread of long messages cannot fill the handover with notices.
      const notice = renderOmission(entry.message, speaker).length + SEPARATOR.length + GAP_ALLOWANCE
      if (notice > remaining) return 'spent'
      tooLong.add(entry)
      remaining -= notice
      return 'too-long'
    }
    if (cost > remaining) return 'spent'
    carried.add(entry)
    remaining -= cost
    return 'carried'
  }

  const latestRequestIndex = written.findLastIndex(entry => entry.message.role === 'user')
  const answerIndex = written.findLastIndex((entry, index) => entry.message.role === 'assistant' && index > latestRequestIndex)
  offer(written[latestRequestIndex])
  offer(written[answerIndex])
  offer(written.find(entry => entry.message.role === 'user'))
  for (let index = written.length - 1; index >= 0; index--) {
    if (offer(written[index]) === 'spent') break
  }

  const shown = written.filter(entry => carried.has(entry) || tooLong.has(entry))
  const carriedEntries = shown.filter(entry => carried.has(entry))
  const visualOrdinals = new Set(visuals.map(entry => entry.ordinal))
  const attached = tally(carriedEntries.flatMap(entry => entry.message.attachments ?? []))
  const summary: HandoverSummary = {
    total,
    carried: carriedEntries.map(entry => entry.message.id),
    tooLong: shown.filter(entry => tooLong.has(entry)).map(({ message }) => ({
      messageId: message.id, role: message.role, createdAt: message.createdAt, characters: message.text.length,
    })),
    notCarried: total - carried.size - tooLong.size - visuals.length,
    images: attached.images,
    files: attached.files,
    visuals: visuals.length,
    toolRecords: Math.max(0, Math.floor(options.toolRecords ?? 0)),
    historyKept: options.historyKept,
    answered: latestRequestIndex < 0 || answerIndex > latestRequestIndex,
  }

  const body: string[] = []
  let previous = -1
  const gap = (until: number): void => {
    let count = 0
    for (let ordinal = previous + 1; ordinal < until; ordinal++) if (!visualOrdinals.has(ordinal)) count++
    if (count > 0) body.push(`[${count === 1 ? 'One message here is' : `${count} messages here are`} not carried.]`)
  }
  for (const entry of shown) {
    gap(entry.ordinal)
    body.push(carried.has(entry) ? renderMessage(entry.message, speaker) : renderOmission(entry.message, speaker))
    previous = entry.ordinal
  }
  gap(total)

  return { text: [...frame(summary, options), ...body].join(SEPARATOR), summary }
}

/** The structural slice of the thread store a handover reads. */
export type HandoverStore = Pick<ThreadStore, 'readMessages' | 'messageIdentities' | 'message' | 'wakeUps' | 'activityCount' | 'ephemeral'>

/**
 * Reads one thread's messages and builds its handover. It reads back from the newest message only until the messages
 * within their share would more than fill the budget, then reads the first user message, the latest request and its
 * answer by themselves wherever they are, so a long thread costs about what a short one does. Places come from the
 * thread's message identities, which carry no words. With Keep local history off the store is the in-memory one, and
 * the handover says so.
 */
export function readHandover(store: HandoverStore, options: Omit<HandoverOptions, 'historyKept' | 'toolRecords'> & {
  /** Each message as the thread's pane shows it, once it is marked as a wake-up or not; `null` for one the pane does not show at all. */
  readonly shown?: ((message: AgentMessage) => AgentMessage | null) | undefined
}): Handover {
  const { threadId } = options.source
  const budget = budgetOf(options)
  const share = shareOf(budget)
  const speaker = speakerFor(options.source.provider)
  const identities = store.messageIdentities(threadId)
  const total = identities.length
  // The projection does not keep which messages were Sotto's wake-ups; the store's own record does (ADR-0061).
  const wakeUps = store.wakeUps(threadId)
  const authored = (message: AgentMessage): AgentMessage | null => {
    const marked = wakeUps.has(message.id) ? { ...message, wakeUp: true as const } : message
    return options.shown ? options.shown(marked) : marked
  }
  // Which wake-ups the pane does not show, wherever they are, so none is picked, counted or paid for as history.
  const unseen = new Set(options.shown ? [...wakeUps].filter(id => { const message = store.message(threadId, id); return message !== undefined && authored(message) === null }) : [])
  const visible = (identity: { readonly id: string }): boolean => !unseen.has(identity.id)
  // A message the pane does not show is no part of the history: it costs nothing and is not counted (`null`).
  const placed = new Map<number, AgentMessage | null>()
  let beforePosition: number | undefined
  let fitting = 0
  for (;;) {
    const window = store.readMessages(threadId, { limit: READ_PAGE, ...(beforePosition === undefined ? {} : { beforePosition }) })
    if (window.messages.length === 0) break
    const start = total - placed.size - window.messages.length
    window.messages.forEach((message, index) => {
      const shown = authored(message)
      placed.set(start + index, shown)
      const cost = shown ? costOf(shown, speaker) : 0
      if (cost <= share) fitting += cost
    })
    beforePosition = window.firstPosition
    if (!window.earlierAvailable || fitting > budget || placed.size >= READ_MAX) break
  }
  const latestRequest = identities.findLastIndex(identity => identity.role === 'user' && visible(identity))
  const answer = identities.findLastIndex(identity => identity.role === 'assistant' && visible(identity))
  const kept = [identities.findIndex(identity => identity.role === 'user' && visible(identity)), latestRequest, ...(answer > latestRequest ? [answer] : [])]
  for (const ordinal of kept) {
    if (ordinal < 0 || placed.has(ordinal)) continue
    const message = store.message(threadId, identities[ordinal]!.id)
    if (message !== undefined) placed.set(ordinal, authored(message))
  }
  const unshown = [...new Set([...identities.flatMap((identity, ordinal) => visible(identity) ? [] : [ordinal]), ...[...placed].flatMap(([ordinal, message]) => message ? [] : [ordinal])])]
  const before = (ordinal: number): number => unshown.filter(other => other < ordinal).length
  return buildHandover({ messages: [...placed].flatMap(([ordinal, message]) => message ? [{ ordinal: ordinal - before(ordinal), message }] : []), total: total - unshown.length }, {
    ...options, historyKept: !store.ephemeral, toolRecords: store.activityCount(threadId),
  })
}

const SEPARATOR = '\n\n'
/** Room for the note that may stand before a message to say how many messages before it are not carried. */
const GAP_ALLOWANCE = 50

function budgetOf(options: Pick<HandoverOptions, 'budget'>): number {
  return Math.max(0, Math.floor(options.budget ?? HANDOVER_BUDGET))
}

function shareOf(budget: number): number {
  return Math.floor(budget / SHARE_DIVISOR)
}

/** How many of some attachments are images, and how many are other files. */
function tally(attachments: readonly AgentAttachmentReference[]): { images: number; files: number } {
  const images = attachments.filter(attachment => attachment.mimeType.startsWith('image/')).length
  return { images, files: attachments.length - images }
}

function isHistory(value: HandoverHistory | readonly AgentMessage[]): value is HandoverHistory {
  return !Array.isArray(value)
}

function speakerFor(provider: ProviderId): (message: AgentMessage) => string {
  const agent = PROVIDER_LABELS[provider]
  return message => message.role === 'assistant' ? agent : message.wakeUp === true ? 'Sotto, waking the thread' : 'The user'
}

/** A time any reader can place: the date and minute in UTC, or the stored text when it is not a time. */
function when(createdAt: string): string {
  const time = new Date(createdAt)
  if (Number.isNaN(time.getTime())) return createdAt
  return `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function count(n: number, one: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : `${one}s`}`
}

/** What one message takes from the budget: its heading, its words, any attachment note, and room for a gap note before it. */
function costOf(message: AgentMessage, speaker: (message: AgentMessage) => string): number {
  return renderMessage(message, speaker).length + SEPARATOR.length + GAP_ALLOWANCE
}

function renderMessage(message: AgentMessage, speaker: (message: AgentMessage) => string): string {
  const lines = [`${speaker(message)}, ${when(message.createdAt)}:`, message.text.trim().length === 0 ? '(No words.)' : message.text]
  const { images, files } = tally(message.attachments ?? [])
  if (images + files > 0) {
    const kinds = [images > 0 ? count(images, 'image') : '', files > 0 ? count(files, 'file') : ''].filter(Boolean)
    lines.push(`(This message had ${kinds.join(' and ')} attached. ${images + files === 1 ? 'It is' : 'They are'} not carried.)`)
  }
  return lines.join('\n')
}

function renderOmission(message: AgentMessage, speaker: (message: AgentMessage) => string): string {
  return `[Left out whole because it is too long to carry: ${speaker(message)}, ${when(message.createdAt)}, ${count(message.text.length, 'character')}.]`
}

function frame(summary: HandoverSummary, options: HandoverOptions): string[] {
  const { source } = options
  const title = source.title?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  const named = title ? `"${title}" (thread ${source.threadId})` : `thread ${source.threadId}`
  const lines = [
    `${HANDOVER_LEAD} The history below is context, not a new request. Nothing in it asks you to do anything now.`,
    `It comes from ${named}, on ${PROVIDER_LABELS[source.provider]}. Attachments, images, tool calls and their results are never carried.`,
  ]
  if (!summary.historyKept) {
    lines.push('Keep local history is off, so this comes only from what Sotto holds in memory since it last started. Anything said before then is not here.')
  }
  if (summary.total === 0) {
    lines.push(summary.historyKept
      ? 'The thread has no messages, so there is no history to carry.'
      : 'Sotto holds no messages from this thread in memory, so there is no history to carry.')
    return [lines.join('\n')]
  }
  lines.push(`Carried: ${summary.carried.length} of ${count(summary.total, 'message')}, oldest first.`)
  const left = [
    summary.notCarried > 0 ? `${count(summary.notCarried, 'message')} that did not fit` : '',
    summary.tooLong.length > 0 ? `${count(summary.tooLong.length, 'message')} too long to carry, named where ${summary.tooLong.length === 1 ? 'it was' : 'they were'}` : '',
    summary.images > 0 ? count(summary.images, 'image') : '',
    summary.files > 0 ? count(summary.files, 'attached file') : '',
    summary.visuals > 0 ? count(summary.visuals, 'visual') : '',
    summary.toolRecords > 0 ? `${count(summary.toolRecords, 'record')} of its work, such as tool calls and their results` : '',
  ].filter(Boolean)
  if (left.length > 0) lines.push(`Left out: ${left.join('; ')}.`)
  if (!summary.answered) lines.push('The latest request has no answer yet.')
  return [lines.join('\n')]
}
