import { renderedPlainLines } from './richActions'
import { ThreadListStore, useThreadList } from './threadListStore'

/**
 * Words the user selected in one of the agent's replies, waiting on that thread's composer to go with the next prompt
 * (ADR-0129). The text is what the selection showed when Add to prompt was pressed, as plain text, so a code block in the
 * reply arrives as its lines without the fence, and the code block's own controls are left out.
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

/** The text without blank lines before or after it, and line ends trimmed; the first line keeps its indentation. */
export function trimBlankLines(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n').map(line => line.trimEnd())
  const first = lines.findIndex(line => line !== '')
  return first < 0 ? '' : lines.slice(first, lines.findLastIndex(line => line !== '') + 1).join('\n')
}

/** One quote as the provider reads it: a line saying where it is from, then each line as a Markdown blockquote. */
export function replyQuoteText(quote: Pick<ReplyQuote, 'text'>): string {
  const lines = trimBlankLines(quote.text).split('\n').map(line => line === '' ? '>' : `> ${line}`)
  return `From your earlier reply:\n${lines.join('\n')}`
}

/**
 * The quotes, then the user's own message, joined by blank lines. Quotes come first so "this" in the message has
 * something to point at. It is plain text in the message, so every provider reads it the same way.
 */
export function composeQuotedMessage(message: string, quotes: readonly Pick<ReplyQuote, 'text'>[]): string {
  return [...quotes.map(replyQuoteText), message.trim()].filter(part => part !== '').join('\n\n')
}

/**
 * Each thread's reply quotes for this session. The transcript adds them; the thread's composer shows them as chips and
 * takes them into the message on the press. They live in this window's memory only, are never logged and are not saved
 * with the draft. Once written into a prompt they are part of its text, which is saved and sent as any prompt is.
 */
export class ReplyQuoteStore extends ThreadListStore<ReplyQuote> {
  constructor(private readonly uuid: () => string = () => crypto.randomUUID()) { super(MAX_REPLY_QUOTES) }

  /** Add words from a reply. Null when there are no words or the prompt is full. */
  add(threadId: string, quote: { readonly messageId: string; readonly text: string }): ReplyQuote | null {
    const text = trimBlankLines(quote.text)
    if (text === '') return null
    return this.append(threadId, { id: this.uuid(), threadId, messageId: quote.messageId, text })
  }
}

/** The one store the transcripts and the thread composers share in this window. */
export const replyQuoteStore = new ReplyQuoteStore()

export function useReplyQuotes(store: ReplyQuoteStore, threadId: string | null): readonly ReplyQuote[] {
  return useThreadList(store, threadId)
}

/**
 * The words a selection holds in one of the agent's replies inside this scroller, with that reply's message ID. Null
 * unless both ends of the selection are in the same reply's own text: a selection that runs into another message, a
 * header, the work folded under a reply or the user's own words quotes nothing. The words are read as the reply shows
 * them, without a code block's language, its Copy control or text kept for screen readers.
 */
export function quoteFromSelection(selection: Selection | null, scroller: HTMLElement | null): { readonly messageId: string; readonly text: string } | null {
  if (selection === null || scroller === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const body = (node: Node | null): Element | null => {
    const element = node === null ? null : node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
    return element?.closest('.rich-message') ?? null
  }
  const reply = body(selection.anchorNode)
  if (reply === null || reply !== body(selection.focusNode) || !scroller.contains(reply)) return null
  // The reply's own text sits directly in its message; Markdown in the work folded under it is deeper.
  const message = reply.parentElement
  if (message === null || !message.matches('.thread-message[data-role="assistant"][data-message-id]')) return null
  const range = selection.getRangeAt(0)
  const codeOf = (node: Node): Element | null => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('pre') ?? null
  // A selection inside one code block is read as that block's text, so its spacing survives.
  const holder = document.createElement('div')
  const into = codeOf(range.commonAncestorContainer) === null ? holder : holder.appendChild(document.createElement('pre'))
  into.append(range.cloneContents())
  const lines = trimBlankLines(renderedPlainLines(holder))
  // Indentation counts only in code: a selection that starts in prose drops the space it began on.
  const text = codeOf(range.startContainer) === null ? lines.trimStart() : lines
  return text === '' ? null : { messageId: message.dataset.messageId!, text }
}
