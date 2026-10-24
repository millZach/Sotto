import { createContext } from 'react'

/**
 * The message rows a transcript draws, while they are drawn: each one's element by its message ID, and every row in the
 * order the transcript shows them, which is not always the order the messages were written (a reply that carries receipt
 * cards stays in view after an open fold of the replies around it). Rows add themselves as they are drawn and leave as
 * they go, so the transcript finds a message, and the first one in view, without searching the page or walking the
 * messages it does not draw (#1452).
 *
 * The order is put right only when it is read, for every row that came or went since. A few new rows each take their place
 * by halves, as a new message at the end does; more are sorted in with the rest at once, as Show earlier draws them. Rows
 * that went are taken out in one pass. So drawing or letting go of many rows costs about what sorting them does, never a
 * shift of the whole order for each row, and a transcript that goes takes nothing out at all.
 */
export class MessageRows {
  private readonly byId = new Map<string, HTMLElement>()
  private readonly ids = new WeakMap<HTMLElement, string>()
  private shown: HTMLElement[] = []
  private readonly came = new Set<HTMLElement>()
  private readonly went = new Set<HTMLElement>()
  /** Adds a drawn row; the function it returns lets that row go. */
  add(messageId: string, element: HTMLElement): () => void {
    this.byId.set(messageId, element)
    this.ids.set(element, messageId)
    if (!this.went.delete(element)) this.came.add(element)
    return () => {
      if (this.byId.get(messageId) === element) this.byId.delete(messageId)
      if (!this.came.delete(element)) this.went.add(element)
    }
  }
  /** The row drawn for a message, when one is. */
  element(messageId: string): HTMLElement | undefined {
    return this.byId.get(messageId)
  }
  /** How many rows are drawn. */
  get size(): number { return this.settled().length }
  /** The row at a place among the rows shown, top first. */
  at(index: number): HTMLElement | undefined { return this.settled()[index] }
  /** The message a drawn row shows. */
  messageOf(element: HTMLElement): string | undefined { return this.ids.get(element) }
  /** The rows in the order shown, with every row that came or went since it was last read put right. */
  private settled(): HTMLElement[] {
    if (this.went.size) {
      const went = this.went
      this.shown = this.shown.filter(element => !went.has(element))
      went.clear()
    }
    if (this.came.size > FEW_ROWS) {
      this.shown = this.shown.concat([...this.came]).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      this.came.clear()
    } else if (this.came.size) {
      for (const element of this.came) this.shown.splice(this.place(element), 0, element)
      this.came.clear()
    }
    return this.shown
  }
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
/** Up to this many rows that came since the order was read take their places one by one; more are sorted in at once. */
const FEW_ROWS = 16

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

/** Where Space presses the control instead of scrolling: a button, a link, a disclosure's summary. */
const PRESSED_BY_SPACE = 'button, [role="button"], a[href], summary'

/**
 * Whether a key pressed in the transcript is the reader scrolling it: a scrolling key that no control took for itself.
 * Space typed into a request card's answer or pressing Copy, or an arrow moving through a menu, is not.
 */
export function scrollsTranscript(event: { readonly key: string; readonly target: EventTarget | null; readonly defaultPrevented: boolean }): boolean {
  if (event.defaultPrevented || !SCROLL_KEYS.has(event.key)) return false
  if (!(event.target instanceof Element)) return true
  return event.target.closest(event.key === ' ' ? `${OWNS_KEYS}, ${PRESSED_BY_SPACE}` : OWNS_KEYS) === null
}
