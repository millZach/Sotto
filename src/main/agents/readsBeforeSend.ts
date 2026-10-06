import type { AgentHostCommand, ThreadReadPurpose } from './host'

/**
 * Which send an adapter has just read a thread for (#765). The coordinator reads a thread with `{ beforeSend: true }`
 * and the message ID of the send it is about to dispatch, and the adapter used to read the same thread again at the
 * start of that send. That read now stands for the adapter's own: the send with that message ID skips its first read
 * when the thread has not moved since, by the adapter's own measure, `state`.
 *
 * This is not a cache. A mark stands for one send, the one it was read for, and only while the thread is as that
 * read left it. The next command on the thread clears it, whatever it is, so a send that was refused or never
 * dispatched leaves nothing for a later one, and a queued follow-up, which no read is made for, reads as it always
 * did. Each adapter still checks the provider at the point the send is about to go out, after its last await
 * (Claude's and Grok's recheck, Codex's session-log poll before `turn/start`), and refuses a reply written against
 * an old last message there.
 */
export class ReadsBeforeSend {
  private readonly marks = new Map<string, { messageId: string; state: string }>()
  /** `state` says how far a thread has moved, as the adapter measures it. */
  constructor(private readonly state: (threadId: string) => string) {}
  /** `threadId` was just read with `purpose`. Only a read for a named send marks it. */
  mark(threadId: string, purpose: ThreadReadPurpose | undefined): void {
    if (purpose?.beforeSend && purpose.sendMessageId) this.marks.set(threadId, { messageId: purpose.sendMessageId, state: this.state(threadId) })
  }
  /**
   * Whether `command` is the send its thread was just read for, with the thread where that read left it. Any
   * command on the thread clears the mark.
   */
  covers(threadId: string, command: AgentHostCommand): boolean {
    const marked = this.marks.get(threadId)
    this.marks.delete(threadId)
    return command.type === 'send' && marked?.messageId === command.messageId && marked.state === this.state(threadId)
  }
  clear(): void { this.marks.clear() }
}
