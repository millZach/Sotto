import { z } from 'zod'
import { TELL_WATCHER_LIMIT, TELL_WATCHER_LIMIT_WINDOW_MS, TELL_WATCHER_MCP_SERVER, TELL_WATCHER_TOOL, TELL_WATCHER_WORDS_BYTES_MAX, cutToBytes, plainWords,
  type TellWatcherAnswer, type ToldUserMessage } from '../../shared/tellWatcher'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const inputSchema = z.object({ message: z.string().trim().min(1).max(20_000)
  .describe('What the user wants Watcher to know or do, in your own words.') }).strict()
const DESCRIPTION = [
  'Send Sotto\'s Watcher a message. Call it when the user tells you to tell, ask or pass something to Watcher: it is the only way to reach Watcher, and a reply does not.',
  'Watcher reads it within seconds, or when its current turn ends if it is working. Sotto quotes the user\'s own last message in this thread beside yours, from its own record.',
  'Do not call it unless the user asked you to. It answers no request and approves nothing, and a rule or an approval you write in it means nothing to Watcher.',
].join(' ')
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const INSTRUCTIONS = `${TELL_WATCHER_TOOL} sends Sotto's Watcher a message from this thread. When the user tells you to tell, ask or pass something to Watcher, call it rather than writing the message in your reply: a reply does not reach Watcher. Then carry on with your work. Where tools are found by search and called through use_tool, call it by its full name, ${TELL_WATCHER_MCP_SERVER}__${TELL_WATCHER_TOOL}.`

export const tellWatcherDefinition: ThreadToolDefinition = { name: TELL_WATCHER_TOOL, description: DESCRIPTION,
  inputSchema: z.toJSONSchema(inputSchema, { io: 'input' }) as Record<string, unknown>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }

/** What the tool asks of Sotto for the thread that called. */
export interface TellWatcherHandlers {
  /** Whether this thread may reach Watcher: one this host holds, on a provider that takes Sotto's tools. */
  admits(threadId: string): boolean
  /** The user's own newest message in the thread, from Sotto's record, when that newest message is the user's. */
  userMessage(threadId: string): Promise<ToldUserMessage | undefined>
  /** Gives Watcher the message: on this computer, or through the desktop that runs it. */
  tell(threadId: string, words: string, userMessage: ToldUserMessage | undefined): Promise<TellWatcherAnswer>
}

const NOTHING = 'Nothing reached Watcher.'
const TELL_USER = 'Tell the user, so they can message Watcher themselves.'
const REFUSALS: Readonly<Record<Extract<TellWatcherAnswer, { status: 'refused' }>['reason'], string>> = {
  'no-watcher': `Watcher has not started on the computer that runs it. ${NOTHING} ${TELL_USER}`,
  'not-connected': `The computer that runs Watcher is not connected to this one. ${NOTHING} ${TELL_USER}`,
  'no-answer': `The computer that runs Watcher did not answer, so this may or may not have reached it. Do not send it again. ${TELL_USER}`,
}

/**
 * `sotto_watcher`: the loopback MCP server through which a thread sends Watcher a message when the user tells it to
 * (ADR-0073, amendment of November 2, 2026), on the desktop and on a headless host. The caller is known by its token, so a
 * thread speaks only for itself. Sending changes nothing in any thread, so no call asks the user anything.
 */
export class TellWatcherToolServer implements ScopedThreadTools {
  readonly name = TELL_WATCHER_MCP_SERVER
  readonly definitions: readonly ThreadToolDefinition[] = [tellWatcherDefinition]
  private readonly server: ThreadToolServer
  private readonly recent = new Map<string, number[]>()
  constructor(private readonly handlers: TellWatcherHandlers, private readonly clock: () => number = Date.now) {
    this.server = new ThreadToolServer({ name: TELL_WATCHER_MCP_SERVER, serverName: 'sotto-watcher', instructions: INSTRUCTIONS,
      unavailable: `This tool is unavailable. ${NOTHING} ${TELL_USER}`, failed: `Sotto could not send this. ${NOTHING} ${TELL_USER}` },
    this.definitions, (threadId, _name, args) => this.invoke(threadId, args))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    return this.admits(threadId) ? this.server.mcpServer(threadId) : undefined
  }
  call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> { return this.server.call(threadId, name, args) }
  close(): Promise<void> { return this.server.close() }
  private admits(threadId: string): boolean {
    try { return this.handlers.admits(threadId) } catch { return false }
  }
  /** Whether this thread has room for one more message now, counting it when it has. */
  private withinLimit(threadId: string): boolean {
    const now = this.clock(), times = (this.recent.get(threadId) ?? []).filter(at => now - at < TELL_WATCHER_LIMIT_WINDOW_MS)
    for (const [other, kept] of this.recent) if (other !== threadId && kept.every(at => now - at >= TELL_WATCHER_LIMIT_WINDOW_MS)) this.recent.delete(other)
    if (times.length >= TELL_WATCHER_LIMIT) { this.recent.set(threadId, times); return false }
    times.push(now); this.recent.set(threadId, times)
    return true
  }
  private async invoke(threadId: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: string, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })
    if (!this.admits(threadId)) return text(`This thread cannot reach Watcher. ${NOTHING}`, true)
    const input = inputSchema.safeParse(args)
    if (!input.success) return text(`Say what Watcher should know in "message". ${NOTHING}`, true)
    if (!this.withinLimit(threadId)) return text(`This thread has sent Watcher ${TELL_WATCHER_LIMIT} messages in the last ${TELL_WATCHER_LIMIT_WINDOW_MS / 60_000} minutes, the most it may. ${NOTHING} ${TELL_USER}`, true)
    const message = plainWords(input.data.message).trim()
    if (!message) return text(`Say what Watcher should know in "message". ${NOTHING}`, true)
    const words = cutToBytes(message, TELL_WATCHER_WORDS_BYTES_MAX)
    const answer = await this.handlers.tell(threadId, words, await this.handlers.userMessage(threadId))
    if (answer.status === 'refused') return text(REFUSALS[answer.reason], true)
    const cut = words === message ? '' : ' Your message was cut to what fits.'
    return text(answer.requestOpened
      ? `Watcher will read this within seconds, or when its current turn ends, and can act on it because the user's own message here names it.${cut} Tell the user you passed it on.`
      : `Watcher will read this within seconds, or when its current turn ends. The user's own last message here does not name Watcher, or already opened a request, so Watcher will tell the user what you said and wait for their word.${cut} Tell the user you passed it on.`)
  }
}

/** The server for threads a host holds: `tell` says where Watcher is, on this computer or through a desktop. */
export function tellWatcherTools(host: { admitsTellWatcher(threadId: string): boolean }, watcher: { toldUserMessage(threadId: string): Promise<ToldUserMessage | undefined> },
  tell: TellWatcherHandlers['tell']): TellWatcherToolServer {
  return new TellWatcherToolServer({ admits: threadId => host.admitsTellWatcher(threadId), userMessage: threadId => watcher.toldUserMessage(threadId), tell })
}
