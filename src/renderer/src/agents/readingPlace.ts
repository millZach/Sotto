import { createContext } from 'react'

/**
 * The message rows a transcript draws, while they are drawn: each one's element by its message ID, and every row in the
 * order the transcript shows them, which is not always the order the messages were written (a reply that carries receipt
 * cards stays in view after an open fold of the replies around it). Rows add themselves as they are drawn and leave as
 * they go, so the transcript finds a message, and the first one in view, without searching the page or walking the
 * messages it does not draw (#1452).
 */
export class MessageRows {
  private readonly byId = new Map<string, HTMLElement>()
  private readonly ids = new WeakMap<HTMLElement, string>()
  private readonly shown: HTMLElement[] = []
  /** Adds a drawn row at its place among the rows shown, found by halves; the function it returns lets that row go. */
  add(messageId: string, element: HTMLElement): () => void {
    this.byId.set(messageId, element)
    this.ids.set(element, messageId)
    this.shown.splice(this.place(element), 0, element)
    return () => {
      if (this.byId.get(messageId) === element) this.byId.delete(messageId)
      // Found by halves while the row is still on the page, as React lets it go before taking it off; looked for through the
      // rows only if the page no longer places it.
      const near = this.place(element)
      const at = this.shown[near] === element ? near : this.shown.indexOf(element)
      if (at >= 0) this.shown.splice(at, 1)
    }
  }
  /** The row drawn for a message, when one is. */
  element(messageId: string): HTMLElement | undefined {
    return this.byId.get(messageId)
  }
  /** How many rows are drawn. */
  get size(): number { return this.shown.length }
  /** The row at a place among the rows shown, top first. */
  at(index: number): HTMLElement | undefined { return this.shown[index] }
  /** The message a drawn row shows. */
  messageOf(element: HTMLElement): string | undefined { return this.ids.get(element) }
  /** Where a row goes among the rows shown: after every row the page puts before it. */
  private place(element: HTMLElement): number {
    let low = 0, high = this.shown.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (element.compareDocumentPosition(this.shown[middle]!) & Node.DOCUMENT_POSITION_PRECEDING) low = middle + 1
      else high = middle
    }
    return low
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

/** The first row shown that reaches below `top`, found by halves over the rows drawn, or `rows.size` when none does. */
function firstReaching(rows: MessageRows, top: number): number {
  let low = 0, high = rows.size
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows.at(middle)!.getBoundingClientRect().bottom > top) high = middle
    else low = middle + 1
  }
  return low
}

/** The place of a reader in a transcript, or null when no message reaches into the view. */
export function readingPlace(scroller: HTMLElement, rows: MessageRows, threadId: string): ReadingPlace | null {
  const view = scroller.getBoundingClientRect()
  const bottom = view.top + scroller.clientHeight
  const marks: { messageId: string; offset: number }[] = []
  for (let index = firstReaching(rows, view.top); index < rows.size && marks.length < READING_MARKS; index++) {
    const row = rows.at(index)!
    const box = row.getBoundingClientRect()
    if (box.top >= bottom) break
    marks.push({ messageId: rows.messageOf(row)!, offset: box.top - view.top })
  }
  return marks.length ? { threadId, marks, top: scroller.scrollTop } : null
}

/**
 * Scrolls the first of the place's messages still drawn back to where it was. The place that stands after: read afresh
 * once it is back, or held, at the scroll the transcript allows, while the transcript is too short to put it back.
 */
export function keepReadingPlace(scroller: HTMLElement, rows: MessageRows, place: ReadingPlace): ReadingPlace | null {
  for (const mark of place.marks) {
    const row = rows.element(mark.messageId)
    if (row === undefined) continue
    const offset = (): number => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    const moved = offset() - mark.offset
    if (Math.abs(moved) >= 1) scroller.scrollTop += moved
    if (Math.abs(offset() - mark.offset) >= 1) return { ...place, top: scroller.scrollTop, held: true }
    break
  }
  return readingPlace(scroller, rows, place.threadId)
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
const SCROLL_KEYS: ReadonlySet<string> = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])
/** Where a key is the control's own: a field, and a widget that moves through its items with the arrow keys or Space. */
const OWNS_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], '
  + '[role="menu"], [role="menubar"], [role="radiogroup"], [role="slider"], [role="spinbutton"], [role="tablist"], [role="tree"], [role="grid"]'

/**
 * Whether a key pressed in the transcript is the reader scrolling it: a scrolling key that no control took for itself.
 * Space typed into a request card's answer, or an arrow moving through a menu, is not.
 */
export function scrollsTranscript(event: { readonly key: string; readonly target: EventTarget | null; readonly defaultPrevented: boolean }): boolean {
  if (event.defaultPrevented || !SCROLL_KEYS.has(event.key)) return false
  return !(event.target instanceof Element && event.target.closest(OWNS_KEYS) !== null)
}
