import type { AgentState, AgentThread, AgentThreadDetailUpdate } from '../../shared/agents'

/**
 * What main sends the popup (ADR-0181): the records and the history of the threads it observes, and nothing else. The
 * main window's broadcasts are never sent to it. While it observes nothing, a publish costs one size check.
 */
export class PopupFeed {
  private observed: ReadonlySet<string> = new Set()
  /** The record last sent for each observed thread, by reference: a publish that kept a record sends nothing for it. */
  private readonly sent = new Map<string, AgentThread>()

  constructor(
    private readonly sendThread: (thread: AgentThread) => void,
    private readonly sendDetail: (update: AgentThreadDetailUpdate) => void,
  ) {}

  /** The popup's threads now, in the window's IDs; an empty list when it is hidden or gone. */
  observe(threadIds: readonly string[]): void {
    this.observed = new Set(threadIds)
    for (const id of [...this.sent.keys()]) if (!this.observed.has(id)) this.sent.delete(id)
  }

  observes(threadId: string): boolean {
    return this.observed.has(threadId)
  }

  /** A published state: each observed thread's record goes when it is not the one last sent. */
  published(state: AgentState): void {
    if (this.observed.size === 0) return
    let left = this.observed.size
    for (const thread of state.host.threads) {
      if (!this.observed.has(thread.id)) continue
      if (this.sent.get(thread.id) !== thread) {
        this.sent.set(thread.id, thread)
        this.sendThread(thread)
      }
      if (--left === 0) return
    }
  }

  detail(update: AgentThreadDetailUpdate): void {
    if (this.observed.has(update.threadId)) this.sendDetail(update)
  }
}
