import { createContext } from 'react'

/**
 * The message rows a transcript draws, each one's element by its message ID while it is drawn. Rows add themselves as they
 * are drawn and leave as they go, so the transcript finds a message without searching the page (#1452).
 */
export class MessageRows {
  private readonly rows = new Map<string, HTMLElement>()
  /** Adds a drawn row; the function it returns lets that row go. */
  add(messageId: string, element: HTMLElement): () => void {
    this.rows.set(messageId, element)
    return () => { if (this.rows.get(messageId) === element) this.rows.delete(messageId) }
  }
  /** The row drawn for a message, when one is. */
  element(messageId: string): HTMLElement | undefined {
    return this.rows.get(messageId)
  }
}

/** The rows of the transcript a message is drawn in. Outside a transcript, a row adds itself nowhere. */
export const MessageRowsContext = createContext<MessageRows | null>(null)

/**
 * Where a reader is reading: the first messages reaching into the view and how far below its top each one starts, and
 * how far the transcript was scrolled when this was read or last put back. `held` while the transcript was too short to put
 * the place back, at the scroll it allowed.
 */
export interface ReadingPlace {
  readonly threadId: string
  readonly marks: readonly { readonly messageId: string; readonly offset: number }[]
  readonly top: number
  readonly held?: true
}

/** How many messages in view the place is kept by, for when the first of them is folded away by an update. */
const READING_MARKS = 3

/**
 * The first message drawn whose row reaches below `top`, as an index into the messages in order, found by halves. A folded
 * reply has no row, so a halving step that lands on one moves to the next row drawn: what is read grows with the
 * messages folded together around that step, never with the history.
 */
function firstReaching(rows: MessageRows, order: readonly { readonly id: string }[], top: number): number {
  let low = 0, high = order.length, found = order.length
  while (low < high) {
    const middle = (low + high) >> 1
    let index = middle
    while (index < high && rows.element(order[index]!.id) === undefined) index++
    if (index === high) { high = middle; continue }
    if (rows.element(order[index]!.id)!.getBoundingClientRect().bottom > top) { found = index; high = middle }
    else low = index + 1
  }
  return found
}

/** The place of a reader in a transcript drawing `order`, or null when no message reaches into the view. */
export function readingPlace(scroller: HTMLElement, rows: MessageRows, order: readonly { readonly id: string }[], threadId: string): ReadingPlace | null {
  const view = scroller.getBoundingClientRect()
  const bottom = view.top + scroller.clientHeight
  const marks: { messageId: string; offset: number }[] = []
  for (let index = firstReaching(rows, order, view.top); index < order.length && marks.length < READING_MARKS; index++) {
    const messageId = order[index]!.id
    const row = rows.element(messageId)
    if (row === undefined) continue
    const box = row.getBoundingClientRect()
    if (box.top >= bottom) break
    marks.push({ messageId, offset: box.top - view.top })
  }
  return marks.length ? { threadId, marks, top: scroller.scrollTop } : null
}

/**
 * Scrolls the first of the place's messages still drawn back to where it was. The place that stands after: read afresh
 * once it is back, or held, at the scroll the transcript allows, while the transcript is too short to put it back.
 */
export function keepReadingPlace(scroller: HTMLElement, rows: MessageRows, order: readonly { readonly id: string }[], place: ReadingPlace): ReadingPlace | null {
  for (const mark of place.marks) {
    const row = rows.element(mark.messageId)
    if (row === undefined) continue
    const offset = (): number => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    const moved = offset() - mark.offset
    if (Math.abs(moved) >= 1) scroller.scrollTop += moved
    if (Math.abs(offset() - mark.offset) >= 1) return { ...place, top: scroller.scrollTop, held: true }
    break
  }
  return readingPlace(scroller, rows, order, place.threadId)
}

/**
 * Whether the transcript's scroll moved since the keeper last read or set it, other than by being cut short: a transcript
 * cut short pulls the scroll up to its new end, which is not the reader's doing.
 */
export function scrolledSince(scroller: HTMLElement, place: ReadingPlace): boolean {
  const top = scroller.scrollTop
  if (Math.abs(top - place.top) < 1) return false
  return !(top < place.top && top >= scroller.scrollHeight - scroller.clientHeight - 1)
}

/** The keys that scroll a transcript, whose press is the reader taking the scroll back. */
export const SCROLL_KEYS: ReadonlySet<string> = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])
