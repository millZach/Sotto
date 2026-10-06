/**
 * Which threads an adapter has just read for a send it is about to be handed (#765). The coordinator reads a
 * thread with `{ beforeSend: true }` immediately before it dispatches the send, and the adapter used to read the
 * same thread again at the start of that send. That read now stands for the adapter's own: the send skips its
 * first read when the thread was read for it and has not moved since, by the adapter's own measure, `state`.
 *
 * This is not a cache. Nothing is trusted because of when it was read. Each adapter still checks the provider at
 * the point the send is about to go out, after its last await (Claude's and Grok's recheck, Codex's session-log
 * poll before `turn/start`), and still refuses a reply written against an old last message there. A mark is
 * taken by the next command on its thread, of any kind, and a send that finds none reads as it always did.
 */
export class ReadsBeforeSend {
  private readonly marks = new Map<string, string>()
  /** `id` was just read for a send, with the thread in `state`. */
  mark(id: string, state: string): void { this.marks.set(id, state) }
  /** True when `id` was read for a send and is still in `state`. The mark is gone either way. */
  take(id: string, state: string): boolean {
    const marked = this.marks.get(id)
    this.marks.delete(id)
    return marked === state
  }
  /** A command other than a send reached `id`, or the thread went away. */
  drop(id: string): void { this.marks.delete(id) }
  clear(): void { this.marks.clear() }
}
