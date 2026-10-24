import { useCallback, useSyncExternalStore } from 'react'

/**
 * Words the user selected in one of the agent's replies, waiting on that thread's composer to go with the next prompt
 * (ADR-0127). The text is what the selection read when Add to prompt was pressed: plain text, so a code block in the
 * reply arrives as its lines without the fence.
 */
export interface ReplyQuote {
  readonly id: string
  readonly threadId: string
  /** The reply the words came from, by its message ID in the thread. */
  readonly messageId: string
  readonly text: string
}

/** Most quotes one prompt carries; the transcript says so rather than dropping one silently. */
export const MAX_REPLY_QUOTES = 20

/** The words the chip shows: the first six, in curly quotes, with an ellipsis when there are more. */
export function replyQuoteLabel(text: string): string {
  const words = text.trim().split(/\s+/u).filter(Boolean)
  return `“${words.slice(0, 6).join(' ')}${words.length > 6 ? '…' : ''}”`
}

/** One quote as the provider reads it: a line saying where it is from, then each line as a Markdown blockquote. */
export function replyQuoteText(quote: Pick<ReplyQuote, 'text'>): string {
  const lines = quote.text.trim().replace(/\r\n?/gu, '\n').split('\n').map(line => line.trimEnd() === '' ? '>' : `> ${line.trimEnd()}`)
  return `From your earlier reply:\n${lines.join('\n')}`
}

/**
 * The quotes, then the user's own message, joined by blank lines. Quotes come first so "this" in the message has
 * something to point at. It is plain text in the message, so every provider reads it the same way.
 */
export function composeQuotedMessage(message: string, quotes: readonly Pick<ReplyQuote, 'text'>[]): string {
  return [...quotes.map(replyQuoteText), message.trim()].filter(part => part !== '').join('\n\n')
}

const NONE: readonly ReplyQuote[] = []

/**
 * Each thread's reply quotes for this session. The transcript adds them; the thread's composer shows them as chips and
 * takes them into the message on the press. They live in this window's memory only, are never logged and are not saved
 * with the draft. Once written into a prompt they are part of its text, which is saved and sent as any prompt is.
 */
export class ReplyQuoteStore {
  private readonly threads = new Map<string, readonly ReplyQuote[]>()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly uuid: () => string = () => crypto.randomUUID()) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(threadId: string): readonly ReplyQuote[] { return this.threads.get(threadId) ?? NONE }

  /** Whether the thread's next prompt can carry another quote. */
  full(threadId: string): boolean { return this.list(threadId).length >= MAX_REPLY_QUOTES }

  /** Add words from a reply. Null when there are no words or the prompt is full. */
  add(threadId: string, quote: { readonly messageId: string; readonly text: string }): ReplyQuote | null {
    const text = quote.text.trim()
    if (text === '' || this.full(threadId)) return null
    const added: ReplyQuote = { id: this.uuid(), threadId, messageId: quote.messageId, text }
    this.threads.set(threadId, [...this.list(threadId), added])
    this.emit()
    return added
  }

  remove(threadId: string, id: string): void { this.without(threadId, [id]) }

  /** Take these quotes off the composer: their prompt has gone, and they went with it. */
  sent(threadId: string, ids: readonly string[]): void { this.without(threadId, ids) }

  private without(threadId: string, ids: readonly string[]): void {
    const current = this.list(threadId)
    const next = current.filter(quote => !ids.includes(quote.id))
    if (next.length === current.length) return
    if (next.length === 0) this.threads.delete(threadId)
    else this.threads.set(threadId, next)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

/** The one store the transcripts and the thread composers share in this window. */
export const replyQuoteStore = new ReplyQuoteStore()

export function useReplyQuotes(store: ReplyQuoteStore, threadId: string | null): readonly ReplyQuote[] {
  const read = useCallback(() => threadId === null ? NONE : store.list(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

/**
 * The words a selection holds in one of the agent's replies inside this scroller, with that reply's message ID. Null
 * unless both ends of the selection are in the same reply's text: a selection that runs into another message, a
 * header or the user's own words quotes nothing.
 */
export function quoteFromSelection(selection: Selection | null, scroller: HTMLElement | null): { readonly messageId: string; readonly text: string } | null {
  if (selection === null || scroller === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const body = (node: Node | null): Element | null => {
    const element = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
    return element?.closest('.rich-message') ?? null
  }
  const reply = body(selection.anchorNode)
  if (reply === null || reply !== body(selection.focusNode) || !scroller.contains(reply)) return null
  const message = reply.closest<HTMLElement>('.thread-message[data-role="assistant"][data-message-id]')
  const messageId = message?.dataset.messageId
  if (messageId === undefined) return null
  const text = selection.toString().trim()
  return text === '' ? null : { messageId, text }
}
