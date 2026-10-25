import type { AgentThread } from '../../shared/agents'

/**
 * The threads whose provider session an adapter holds open, kept on each thread as `providerSessionOpen` as the set
 * changes, so a window knows a send will not start the session and asks for no early start (#769). The flag lives on
 * the adapter's own thread record and reaches the snapshot with it; a thread the adapter has not made yet gets it
 * when it is added again.
 */
export class OpenSessions extends Set<string> {
  /** `changed` hears each thread whose flag this set wrote, so an adapter that marks its thread changes marks it (#925). */
  constructor(private readonly thread: (id: string) => Pick<AgentThread, 'providerSessionOpen'> | undefined,
    private readonly changed: (id: string) => void = () => undefined) { super() }
  override add(id: string): this {
    super.add(id)
    const thread = this.thread(id)
    if (thread) { thread.providerSessionOpen = true; this.changed(id) }
    return this
  }
  override delete(id: string): boolean {
    const thread = this.thread(id)
    if (thread) { delete thread.providerSessionOpen; this.changed(id) }
    return super.delete(id)
  }
  override clear(): void {
    for (const id of this) { const thread = this.thread(id); if (thread) { delete thread.providerSessionOpen; this.changed(id) } }
    super.clear()
  }
}
