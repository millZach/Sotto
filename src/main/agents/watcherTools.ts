import { z } from 'zod'
import { watcherToolSchemas, type WatcherToolName } from '../../shared/watcher'
import { ThreadToolServer, type ThreadToolCallContext, type ThreadToolDefinition, type ThreadMcpServer, type ThreadToolResult } from './threadToolServer'
import { watcherRefusal, type WatcherService } from './watcher'
import type { WatcherProfileTools } from './host'

const descriptions: Record<WatcherToolName, string> = {
  watch_thread: 'Keep watching and managing a thread until the user stops watching. This does not send a prompt or answer a card.',
  unwatch_thread: 'Stop watching a thread and fence automatic messages for its standing watch. Does not interrupt the user\'s turn.',
  list_threads: 'List worker threads and their state using Sotto identities. Does not mark anything read by the user.',
  read_thread: 'Read a bounded window of a worker thread. Questions and permissions must be answered by the user on that thread.',
  start_thread: 'Start one worker in a known project and send its first prompt under an active user Watcher request. Retry with the same key to read the original receipt.',
  send_to_thread: 'Send now, queue or steer explicitly under an active Watcher request. Cannot answer pending questions or permissions.',
  stop_thread: 'Request interrupt of one eligible worker under the active Watcher request. Does not delete or reclaim anything.',
  settle_thread: 'Move an idle worker to Settled, preserving the thread and working copy. Does not stop background work.',
  list_projects: 'List known worker projects and available models and comparable default permissions. Project roots are display information.',
  list_machines: 'List This computer and each connected machine: its operating system, architecture, memory and CPUs, how many threads it is running, and your starts in flight on it against the limit. A machine that does not report these reads unknown; one not connected says so.',
  list_working_copies: 'Read host-issued working-copy and base-ref choices for a known project. No arbitrary paths or remote fetch.',
  read_operation: 'Read an admitted operation’s receipt and, for a start or send, its outcome: working, background, answered, failed, stopped, paused or unknown. Accepted means delivered; the outcome says how its turn ended. Once answered it carries that turn’s reply, the worker’s own words. Uncertain or unknown means reconcile, never resend.',
}
export const WATCHER_TOOL_DEFINITIONS: readonly ThreadToolDefinition[] = Object.freeze(
  (Object.keys(watcherToolSchemas) as WatcherToolName[]).map(name => Object.freeze({ name, description: descriptions[name],
    inputSchema: z.toJSONSchema(watcherToolSchemas[name].input), outputSchema: z.toJSONSchema(watcherToolSchemas[name].output),
    annotations: { readOnlyHint: name.startsWith('list_') || name.startsWith('read_'), destructiveHint: false,
      idempotentHint: true, openWorldHint: false } })),
)

/** Tokens attach only to main's one current identity. Admission is repeated for every invocation. */
export class WatcherToolServer implements WatcherProfileTools {
  readonly name = 'sotto_threads'
  readonly definitions = WATCHER_TOOL_DEFINITIONS
  private readonly transport: ThreadToolServer
  private running = 0
  constructor(private readonly service: WatcherService) {
    this.transport = new ThreadToolServer({ name: this.name, serverName: 'Sotto threads',
      instructions: 'Use explicit Sotto host and thread IDs. Use the requestId supplied with the user’s Watcher instruction. Native project reads use your own tools. No tool answers a request, approves a permission or changes policy. Read receipts instead of replaying uncertain delivery.',
      unavailable: 'Watcher’s thread tools are unavailable.', failed: 'This Watcher call could not be completed. Check its receipt before trying again.' },
    this.definitions, (threadId, name, args, context) => this.call(threadId, name, args, context), threadId => this.service.isCurrent(threadId) ? this.definitions : [])
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.service.isCurrent(threadId)) return undefined
    const server = await this.transport.mcpServer(threadId)
    if (!this.service.isCurrent(threadId)) { this.revoke(threadId); return undefined }
    return server
  }
  /** `context` says how long the calling client waits, when it says (Muse, ADR-0079); a call is answered inside it. */
  async call(threadId: string, name: string, args: unknown, context: ThreadToolCallContext = {}): Promise<ThreadToolResult> {
    let result: unknown
    if (!this.service.isCurrent(threadId)) result = watcherRefusal('NOT_CURRENT_WATCHER', 'Only the current Watcher can use these tools.')
    else if (!Object.hasOwn(watcherToolSchemas, name)) result = watcherRefusal('INVALID_INPUT', 'That tool is unavailable. Watcher cannot answer requests or change permissions.')
    else if (this.running >= 8) result = watcherRefusal('IN_FLIGHT_LIMIT', 'Watcher already has eight tool calls in progress. Wait for one to finish.', true)
    else {
      this.running++
      try {
        result = await this.service.invoke(threadId, name as WatcherToolName, args, context)
        // Validate what main exposes, as well as what the caller supplied.
        result = watcherToolSchemas[name as WatcherToolName].output.parse(result)
      } catch { result = watcherRefusal('PROVIDER_UNAVAILABLE', 'This Watcher result could not be read safely. Check its receipt before trying again.', true) }
      finally { this.running-- }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>,
      ...((result as { status: string }).status === 'refused' ? { isError: true } : {}) }
  }
  revoke(threadId: string): void { this.transport.revoke(threadId) }
  close(): Promise<void> { return this.transport.close() }
}
