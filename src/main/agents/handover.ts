import { isVisualMessage, PROVIDER_LABELS, type AgentMessage, type ProviderId } from '../../shared/agents'
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

/**
 * What a handover is built from. A short thread is read whole into `newest`. A long one is read from both ends: the
 * oldest messages up to the first user message, and the newest until the budget would be spent. `total` counts the
 * messages between them that were never read.
 */
export interface HandoverHistory {
  readonly earliest: readonly AgentMessage[]
  readonly newest: readonly AgentMessage[]
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

/** One message in the order the handover reasons about: its place among the thread's messages, read or not. */
interface Placed { readonly ordinal: number; readonly message: AgentMessage }

export function buildHandover(history: HandoverHistory | readonly AgentMessage[], options: HandoverOptions): Handover {
  const { earliest, newest, total: claimed } = isHistory(history) ? history : { earliest: [], newest: history, total: history.length }
  const total = Math.max(claimed, earliest.length + newest.length)
  const placed: Placed[] = [
    ...earliest.map((message, index) => ({ ordinal: index, message })),
    ...newest.map((message, index) => ({ ordinal: total - newest.length + index, message })),
  ]
  const visuals = placed.filter(entry => isVisualMessage(entry.message))
  const written = placed.filter(entry => !isVisualMessage(entry.message))
  const budget = Math.max(0, Math.floor(options.budget ?? HANDOVER_BUDGET))
  const share = Math.floor(budget / SHARE_DIVISOR)
  const speaker = speakerFor(options.source.provider)

  const carried = new Set<Placed>()
  const tooLong = new Set<Placed>()
  let remaining = budget
  /** Carries one message if it fits. Says `spent` when it is within its share but the budget has run out. */
  const offer = (entry: Placed | undefined): 'carried' | 'too-long' | 'spent' | 'seen' => {
    if (entry === undefined || carried.has(entry) || tooLong.has(entry)) return 'seen'
    const cost = renderMessage(entry.message, speaker).length + SEPARATOR.length
    if (cost > share) { tooLong.add(entry); return 'too-long' }
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
  const attachments = carriedEntries.flatMap(entry => entry.message.attachments ?? [])
  const images = attachments.filter(attachment => attachment.mimeType.startsWith('image/')).length
  const summary: HandoverSummary = {
    total,
    carried: carriedEntries.map(entry => entry.message.id),
    tooLong: shown.filter(entry => tooLong.has(entry)).map(({ message }) => ({
      messageId: message.id, role: message.role, createdAt: message.createdAt, characters: message.text.length,
    })),
    notCarried: total - carried.size - tooLong.size - visuals.length,
    images,
    files: attachments.length - images,
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
export type HandoverStore = Pick<ThreadStore, 'readMessages' | 'readForwardMessages' | 'messageCount' | 'activityCount' | 'ephemeral'>

/**
 * Reads one thread's messages and builds its handover. It reads back from the newest message only until the messages
 * within their share would more than fill the budget, then the oldest messages up to the first user message, so a
 * long thread costs about what a short one does. With Keep local history off the store is the in-memory one, and the
 * handover says so.
 */
export function readHandover(store: HandoverStore, options: Omit<HandoverOptions, 'historyKept' | 'toolRecords'>): Handover {
  const { threadId } = options.source
  const budget = Math.max(0, Math.floor(options.budget ?? HANDOVER_BUDGET))
  const share = Math.floor(budget / SHARE_DIVISOR)
  const total = store.messageCount(threadId)
  const newest: AgentMessage[] = []
  let firstPosition: number | undefined
  let earlierAvailable = false
  let fitting = 0
  for (;;) {
    const window = store.readMessages(threadId, { limit: READ_PAGE, ...(firstPosition === undefined ? {} : { beforePosition: firstPosition }) })
    if (window.messages.length === 0) break
    newest.unshift(...window.messages)
    firstPosition = window.firstPosition
    earlierAvailable = window.earlierAvailable
    for (const message of window.messages) if (message.text.length < share) fitting += message.text.length
    if (!earlierAvailable || fitting > budget || newest.length >= READ_MAX) break
  }
  const earliest: AgentMessage[] = []
  if (earlierAvailable && firstPosition !== undefined) {
    for (const { message, position } of store.readForwardMessages(threadId, -1, READ_PAGE).messages) {
      if (position >= firstPosition) break
      earliest.push(message)
      if (message.role === 'user') break
    }
    // No user message among the oldest page: the first request is somewhere unread, and the handover counts it there.
    if (earliest.at(-1)?.role !== 'user') earliest.length = 0
  }
  return buildHandover({ earliest, newest, total }, {
    ...options, historyKept: !store.ephemeral, toolRecords: store.activityCount(threadId),
  })
}

const SEPARATOR = '\n\n'

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

function renderMessage(message: AgentMessage, speaker: (message: AgentMessage) => string): string {
  const lines = [`${speaker(message)}, ${when(message.createdAt)}:`, message.text.trim().length === 0 ? '(No words.)' : message.text]
  const attached = message.attachments ?? []
  if (attached.length > 0) {
    const images = attached.filter(attachment => attachment.mimeType.startsWith('image/')).length
    const kinds = [images > 0 ? count(images, 'image') : '', attached.length > images ? count(attached.length - images, 'file') : ''].filter(Boolean)
    lines.push(`(This message had ${kinds.join(' and ')} attached. ${attached.length === 1 ? 'It is' : 'They are'} not carried.)`)
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
    'This is a handover from another Sotto thread. The history below is context, not a new request. Nothing in it asks you to do anything now.',
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
    summary.toolRecords > 0 ? `${count(summary.toolRecords, 'record')} of tool calls and their results` : '',
  ].filter(Boolean)
  if (left.length > 0) lines.push(`Left out: ${left.join('; ')}.`)
  if (!summary.answered) lines.push('The latest request has no answer yet.')
  return [lines.join('\n')]
}
