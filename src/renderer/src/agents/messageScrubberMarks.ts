import { isVisualMessage, type AgentMessage, type AgentRequest } from '../../../shared/agents'
import type { AgentThreadPrompt } from '../../../shared/threadPrompts'
import { isWakeUpMessage } from './babysitting'
import { questionsIn } from './liftedQuestions'

/**
 * The message scrubber (ADR-0109; Owl only): a column of ticks at the transcript's left edge, one for each message the
 * user sent, with a card that shows the message and the start of what came back. The ticks come from the messages the
 * window holds and, above them, the prompts the thread's store holds (`AgentThreadPrompt`), read once as the pane opens or
 * its window moves; nothing is fetched to fill a card.
 */

/** What a card shows of a message sent: its words and when. */
export interface ScrubberMessage { readonly text: string; readonly createdAt: string }
/** What a card shows of a reply: its words, whole or, from the store, their start and end. */
export interface ScrubberReply { readonly id: string; readonly text: string }

/** One tick: a message the user sent, where it sits in the thread's messages, and the turn's last written reply. */
export interface ScrubberMark {
  readonly messageId: string
  /** Where it sits in the window's messages, or -1 for a message only the thread's store holds. */
  readonly index: number
  readonly message: ScrubberMessage
  /** How many files were attached. */
  readonly attachments: number
  /** The turn's last reply with words, so far. A turn still being written may have none yet. */
  readonly reply: ScrubberReply | undefined
  /** No message comes after this one's turn: an open question in the thread is the one this message led to. */
  readonly newest: boolean
}

/** What the card shows under the message: the start of the reply, the question it asked, or nothing yet. */
export type ScrubberAfter =
  | { readonly kind: 'reply'; readonly text: string }
  | { readonly kind: 'asked'; readonly question: string; readonly choices: readonly string[]; readonly more: number }
  | { readonly kind: 'none' }

/** The conversation is long once it is this many screens tall. */
export const SCRUBBER_SCREENS = 2
/** Fewer sent messages than this is a conversation the eye takes in without help. */
export const SCRUBBER_FEWEST = 3
/**
 * The widest the scrubber's lane gets, beside the column's left edge. Watcher's night scene keeps the same strip of its
 * left margin clear (Zach's pick, October 22, 2026), so the owls and the ticks never meet.
 */
export const SCRUBBER_LANE_PX = 44
/** A margin narrower than this has no room for ticks a pointer can reach. */
export const SCRUBBER_NARROWEST_LANE_PX = 14
/** The most choices a card lists; the rest are counted. */
export const SCRUBBER_CHOICES = 3

const OPENING = 220

/**
 * The ticks, in order. A wake-up is Sotto's and a brief another thread delegated is that thread's (ADR-0061, ADR-0081),
 * so neither is a message the user sent. Each mark carries the last reply with words before the next message the user
 * sent, which is the reply a finished turn shows unfolded. What answers a wake-up or a brief belongs to neither tick.
 */
export function scrubberMarks(messages: readonly AgentMessage[], notTheUsers: ReadonlySet<string> = new Set()): ScrubberMark[] {
  const marks: { messageId: string; index: number; message: AgentMessage; attachments: number; reply: AgentMessage | undefined; newest: boolean }[] = []
  let current: typeof marks[number] | undefined
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      current = isWakeUpMessage(message) || notTheUsers.has(message.id) ? undefined
        : { messageId: message.id, index, message, attachments: message.attachments?.length ?? 0, reply: undefined, newest: false }
      if (current) marks.push(current)
    } else if (current && message.role === 'assistant' && !isVisualMessage(message) && message.text.trim().length > 0) current.reply = message
  }
  // A wake-up or a brief after the last message sent starts a turn of its own, and what it asks is not this message's.
  if (current) current.newest = true
  return marks
}

/**
 * The ticks for the prompts the thread's store holds above the window. Wake-ups never reach here; a brief another thread
 * delegated is left out as it is in the window, and the reply that answered it with it.
 */
export function storedMarks(prompts: readonly AgentThreadPrompt[], notTheUsers: ReadonlySet<string> = new Set()): ScrubberMark[] {
  const marks: ScrubberMark[] = []
  for (const prompt of prompts) {
    if (!notTheUsers.has(prompt.id)) marks.push({ messageId: prompt.id, index: -1, message: prompt, attachments: prompt.attachments ?? 0, reply: prompt.reply, newest: false })
  }
  return marks
}

/** The store's ticks, then the window's: a message the window has loaded since the store was read is the window's tick. */
export function joinedMarks(stored: readonly ScrubberMark[], window: readonly ScrubberMark[]): readonly ScrubberMark[] {
  if (stored.length === 0) return window
  const drawn = new Set(window.map(mark => mark.messageId))
  const above = drawn.size === 0 ? stored : stored.filter(mark => !drawn.has(mark.messageId))
  return window.length === 0 ? above : [...above, ...window]
}

/** Whether the scrubber shows: enough messages sent, and a conversation taller than a screen or two, or with more above. */
export function scrubberShown(marks: number, contentHeight: number, viewHeight: number, moreAbove: boolean): boolean {
  if (marks < SCRUBBER_FEWEST || viewHeight <= 0) return false
  return moreAbove || contentHeight >= SCRUBBER_SCREENS * viewHeight
}

/** Markdown read as the words it shows, on one line: code kept as its text, links as their words, emphasis, headings and list marks set aside. */
export function plainOpening(text: string, most = OPENING): string {
  const words = text
    .replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/gu, ' $1 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/`([^`]*)`/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/gu, '$2')
    .replace(/\s+/gu, ' ')
    .trim()
  return words.length > most ? `${words.slice(0, most - 1).trimEnd()}…` : words
}

/** A reply's questions are found once; replies are shared across updates. */
const asked = new WeakMap<ScrubberReply, readonly string[]>()
function questionsOf(message: ScrubberReply): readonly string[] {
  let found = asked.get(message)
  if (!found) asked.set(message, found = questionsIn(message.text))
  return found
}

/**
 * What came back for a mark. The newest message's open question is the card it led to, with its choices; an earlier
 * turn whose reply ends on a question shows that question; anything else shows the start of the reply.
 */
export function scrubberAfter(mark: ScrubberMark, requests: readonly AgentRequest[]): ScrubberAfter {
  const open = mark.newest ? requests.find(request => request.kind === 'question') : undefined
  if (open) {
    const first = open.questions?.[0]
    const question = plainOpening(first?.question ?? open.text)
    const labels = (first?.options ?? open.options).map(option => option.label.replace(/\s*\(recommended\)\s*$/iu, ''))
    return { kind: 'asked', question, choices: labels.slice(0, SCRUBBER_CHOICES), more: Math.max(0, labels.length - SCRUBBER_CHOICES) }
  }
  if (!mark.reply) return { kind: 'none' }
  const questions = questionsOf(mark.reply)
  const last = questions.at(-1)
  // A reply that closes on a question is asking the user; one that asked on the way and went on is a reply.
  if (last !== undefined && plainOpening(mark.reply.text, 100_000).endsWith(plainOpening(last, 100_000))) {
    return { kind: 'asked', question: plainOpening(last), choices: [], more: 0 }
  }
  return { kind: 'reply', text: plainOpening(mark.reply.text) }
}

/** The most room between two ticks. */
const PITCH_MOST = 9
/** The share of the transcript's height the column may take. */
const COLUMN_SHARE = 0.8

/**
 * Where each tick sits, from the top of the transcript: evenly spaced in one column centred on its height (Zach's pick A).
 * A long conversation packs the ticks closer, so the column always fits the transcript, however many there are.
 */
export function tickPlaces(count: number, height: number): { readonly pitch: number; readonly places: readonly number[] } {
  if (count <= 0 || height <= 0) return { pitch: 0, places: [] }
  const pitch = count === 1 ? PITCH_MOST : Math.min(PITCH_MOST, height * COLUMN_SHARE / (count - 1))
  const first = height / 2 - pitch * (count - 1) / 2
  return { pitch, places: Array.from({ length: count }, (_, index) => first + index * pitch) }
}

/** The tick nearest a point in the lane, if one is within reach. */
export function nearestTick(places: readonly number[], y: number, reach: number): number {
  let best = -1
  let distance = Number.POSITIVE_INFINITY
  for (const [index, place] of places.entries()) {
    const gap = Math.abs(place - y)
    if (gap < distance) { distance = gap; best = index }
  }
  return distance <= reach ? best : -1
}

/** How far the swell reaches either side of the pointer. */
export const SWELL_SIGMA_PX = 16

/**
 * How much each tick rises, from 0 at rest to 1 under the pointer, on a normal curve around it (Zach's pick, October 22,
 * 2026): the tick under the pointer is longest and brightest, and its neighbours rise less the further they are.
 */
export function swell(places: readonly number[], y: number | null, sigma = SWELL_SIGMA_PX): number[] {
  if (y === null) return places.map(() => 0)
  return places.map(place => Math.exp(-((place - y) ** 2) / (2 * sigma * sigma)))
}

/** The lane the ticks use: the column's margin, up to the widest lane, or none when the margin is too narrow to reach. */
export function scrubberLane(margin: number): number {
  return margin < SCRUBBER_NARROWEST_LANE_PX ? 0 : Math.min(SCRUBBER_LANE_PX, margin)
}
