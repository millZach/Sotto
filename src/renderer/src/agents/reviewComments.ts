import { useCallback, useSyncExternalStore } from 'react'

/** One quoted line of a review comment, as Changes drew it when the comment was written. */
export interface ReviewLine {
  readonly kind: 'context' | 'add' | 'remove'
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

/**
 * Lines of a thread's Changes with the user's words about them, waiting on that thread's composer. The lines are
 * kept as they read when the comment was written, so what goes with the message is what the user looked at even
 * if the diff has moved on since.
 */
export interface ReviewComment {
  readonly id: string
  readonly threadId: string
  /** Relative to the thread's working copy. */
  readonly path: string
  readonly lines: readonly ReviewLine[]
  readonly text: string
}

/** Most comments one message carries; the composer says so rather than dropping one silently. */
export const MAX_REVIEW_COMMENTS = 20

/**
 * The lines a comment names: new-file numbers, or the old file's marked "(before)" when every line was removed,
 * because removed lines have no number in the file as it is now.
 */
export function reviewRange(lines: readonly ReviewLine[]): { readonly first: number; readonly last: number; readonly before: boolean } | null {
  const before = lines.length > 0 && lines.every(line => line.kind === 'remove')
  const numbers = lines.map(line => before ? line.oldLine : line.newLine).filter((value): value is number => value !== null)
  if (numbers.length === 0) return null
  return { first: Math.min(...numbers), last: Math.max(...numbers), before }
}

/** `voice.ts L12 to L15`, or with `full` the working-copy path, as the message names it. */
export function reviewLabel(comment: Pick<ReviewComment, 'path' | 'lines'>, full = false): string {
  const name = full ? comment.path : comment.path.slice(comment.path.lastIndexOf('/') + 1)
  const range = reviewRange(comment.lines)
  if (range === null) return name
  return `${name} L${range.first}${range.last !== range.first ? ` to L${range.last}` : ''}${range.before ? ' (before)' : ''}`
}

/** The longest run of backticks in some text, so a fence or code span around it can be longer. */
function longestTicks(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/gu)].map(match => match[0].length))
}

/** A Markdown code span that survives backticks in what it quotes. */
function codeSpan(value: string): string {
  const ticks = '`'.repeat(longestTicks(value) + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${value}${pad}${ticks}`
}

/** A fence longer than any backtick run in the quoted lines, so the quote can never close early. */
function fenceFor(body: string): string {
  return '`'.repeat(Math.max(3, longestTicks(body) + 1))
}

/** One comment as the provider reads it: what it covers, the user's words, then the lines as a fenced diff. */
export function reviewCommentText(comment: Pick<ReviewComment, 'path' | 'lines' | 'text'>): string {
  const body = comment.lines.map(line => `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`).join('\n')
  const fence = fenceFor(body)
  return `Comment on ${codeSpan(reviewLabel(comment, true))}:\n\n${comment.text.trim()}\n\n${fence}diff\n${body}\n${fence}`
}

/**
 * The text that goes to the provider: the user's own message, then each comment in the order it was written.
 * It is plain text in the message, so every provider reads it the same way and nothing else carries it.
 */
export function composeReviewMessage(message: string, comments: readonly Pick<ReviewComment, 'path' | 'lines' | 'text'>[]): string {
  const parts = [message.trim(), ...comments.map(reviewCommentText)].filter(part => part !== '')
  return parts.join('\n\n')
}

/** Whether a line drawn in Changes now is one a comment quotes: same kind, same numbers, same text. */
export function sameReviewLine(a: ReviewLine, b: ReviewLine): boolean {
  return a.kind === b.kind && a.oldLine === b.oldLine && a.newLine === b.newLine && a.text === b.text
}

/** A comment still being written under its lines in Changes. It is not on the composer until Comment is pressed. */
export interface ReviewDraft {
  readonly path: string
  readonly lines: readonly ReviewLine[]
  readonly text: string
}

const NONE: readonly ReviewComment[] = []

/**
 * Each thread's review comments for this session, and the one comment being written. Changes writes and deletes
 * them; the thread's composer shows them as chips and takes them into the message on the press. They live in this
 * window's memory only and are never logged. Once written into a prompt they are part of its text, which is saved
 * and sent as any prompt is.
 */
export class ReviewCommentStore {
  private readonly threads = new Map<string, readonly ReviewComment[]>()
  private readonly drafts = new Map<string, ReviewDraft>()
  private readonly listeners = new Set<() => void>()
  constructor(private readonly uuid: () => string = () => crypto.randomUUID()) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  list(threadId: string): readonly ReviewComment[] { return this.threads.get(threadId) ?? NONE }
  draft(threadId: string): ReviewDraft | null { return this.drafts.get(threadId) ?? null }

  /** Whether the thread's next message can carry another comment. */
  full(threadId: string): boolean { return this.list(threadId).length >= MAX_REVIEW_COMMENTS }

  /**
   * Open a draft on these lines. A draft that already has words in it is kept rather than replaced, so nothing
   * the user wrote goes without them asking; the caller shows that one instead. Says which draft is open and
   * whether this call opened it.
   */
  openDraft(threadId: string, path: string, lines: readonly ReviewLine[]): { readonly draft: ReviewDraft; readonly opened: boolean } {
    const current = this.draft(threadId)
    if (current !== null && current.text.trim() !== '') return { draft: current, opened: false }
    const next: ReviewDraft = { path, lines: lines.map(line => ({ ...line })), text: '' }
    this.drafts.set(threadId, next)
    this.emit()
    return { draft: next, opened: true }
  }

  editDraft(threadId: string, text: string): void {
    const current = this.draft(threadId)
    if (current === null || current.text === text) return
    this.drafts.set(threadId, { ...current, text })
    this.emit()
  }

  closeDraft(threadId: string): void {
    if (this.drafts.delete(threadId)) this.emit()
  }

  /** Close a draft only while it is still empty: a click elsewhere drops an empty draft, never written words. */
  closeEmptyDraft(threadId: string): void {
    if (this.draft(threadId)?.text.trim() === '') this.closeDraft(threadId)
  }

  /** Comment: the draft becomes a comment on the composer. Null when it is empty or the message is full. */
  addDraft(threadId: string): ReviewComment | null {
    const draft = this.draft(threadId)
    if (draft === null) return null
    const added = this.add(threadId, draft)
    if (added !== null) this.drafts.delete(threadId)
    this.emit()
    return added
  }

  /** Add a comment on lines of the thread's Changes. Null when the text is empty, no line is quoted or the message is full. */
  add(threadId: string, comment: { readonly path: string; readonly lines: readonly ReviewLine[]; readonly text: string }): ReviewComment | null {
    const text = comment.text.trim()
    if (text === '' || comment.lines.length === 0 || this.full(threadId)) return null
    const added: ReviewComment = { id: this.uuid(), threadId, path: comment.path, lines: comment.lines.map(line => ({ ...line })), text }
    this.threads.set(threadId, [...this.list(threadId), added])
    this.emit()
    return added
  }

  remove(threadId: string, id: string): void { this.without(threadId, [id]) }

  /** Take these comments off the composer: their message has gone, and they went with it. */
  sent(threadId: string, ids: readonly string[]): void { this.without(threadId, ids) }

  private without(threadId: string, ids: readonly string[]): void {
    const current = this.list(threadId)
    const next = current.filter(comment => !ids.includes(comment.id))
    if (next.length === current.length) return
    if (next.length === 0) this.threads.delete(threadId)
    else this.threads.set(threadId, next)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

/** The one store the Changes surface and the thread composers share in this window. */
export const reviewCommentStore = new ReviewCommentStore()

export function useReviewComments(store: ReviewCommentStore, threadId: string | null): readonly ReviewComment[] {
  const read = useCallback(() => threadId === null ? NONE : store.list(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

export function useReviewDraft(store: ReviewCommentStore, threadId: string | null): ReviewDraft | null {
  const read = useCallback(() => threadId === null ? null : store.draft(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}
