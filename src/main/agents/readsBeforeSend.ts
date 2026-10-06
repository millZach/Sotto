import type { AgentHostCommand, ThreadReadPurpose } from './host'

/**
 * Which send an adapter has just read a thread for (#765). The coordinator reads a thread with `{ beforeSend: true }`
 * and the message ID of the send it is about to dispatch, and the adapter used to read the same thread again at the
 * start of that send. That read now stands for the adapter's own: the send with that message ID skips its first read
 * when the thread has not moved since, by the adapter's own measure, `progress`.
 *
 * This is not a cache. A mark stands for one send, the one it was read for, and only while the thread is as that
 * read left it. The next command on the thread clears it, whatever it is, so a send that was refused or never
 * dispatched leaves nothing for a later one, and a queued follow-up, which no read is made for, reads as it always
 * did. Each adapter still checks the provider where the send is about to go out (Claude's and Grok's recheck,
 * Codex's session-log poll before `turn/start`), and refuses a reply written against an old last message there.
 */
export class ReadsBeforeSend {
  private readonly marks = new Map<string, { messageId: string; progress: string }>()
  /** `progress` says how far a thread has moved, as the adapter measures it. */
  constructor(private readonly progress: (threadId: string) => string) {}
  /** `threadId` was just read with `purpose`. Only a read for a named send marks it. */
  mark(threadId: string, purpose: ThreadReadPurpose | undefined): void {
    if (purpose?.beforeSend && purpose.sendMessageId) this.marks.set(threadId, { messageId: purpose.sendMessageId, progress: this.progress(threadId) })
  }
  /**
   * Takes the thread's mark for `command`, clearing it whatever the command is. What it hands back is asked where the
   * send would make its own read, after any await in between: whether `command` is the send the thread was read
   * for and the thread is still where that read left it. For any other command it always answers false.
   */
  take(threadId: string, command: AgentHostCommand): () => boolean {
    const marked = this.marks.get(threadId)
    this.marks.delete(threadId)
    if (command.type !== 'send' || !marked || marked.messageId !== command.messageId) return () => false
    return () => marked.progress === this.progress(threadId)
  }
  clear(): void { this.marks.clear() }
}
