/**
 * Where a prototype's pages were found (ADR-0108): a question waiting in the thread, by its request ID, or a reply, by
 * its message ID. QuestionPages keys its searches by it, a Prototype ready mark names it as `source`, and Watcher's
 * `prototype-ready` news carries it. Written `request:<ID>` or `reply:<message ID>`.
 */
export type PrototypeSource = { readonly kind: 'request' | 'reply'; readonly id: string }

/** The source of a question's pages. */
export const requestSource = (requestId: string): string => `request:${requestId}`
/** The source of a reply's pages. */
export const replySource = (messageId: string): string => `reply:${messageId}`

/** A source read back; undefined for anything else, an empty ID included. */
export function parsePrototypeSource(source: string): PrototypeSource | undefined {
  const at = source.indexOf(':')
  const kind = source.slice(0, at)
  const id = source.slice(at + 1)
  return at > 0 && id && (kind === 'request' || kind === 'reply') ? { kind, id } : undefined
}
