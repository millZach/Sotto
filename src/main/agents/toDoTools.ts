import { z } from 'zod'
import { TO_DO_LIMIT, TO_DO_LIMIT_WINDOW_MS, TO_DO_MCP_SERVER, TO_DO_TOOL, toDoAddSchema } from '../../shared/toDos'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'
import { ToDoRefused, type ToDoStore } from './toDos'

const DESCRIPTION = [
  'Put something on the user\'s to-do list: what only their hands can do, such as a hand test, something to send or a walkthrough to run.',
  'They see it under a list icon in the corner of Sotto, and check it off when it is done. Use this rather than ending your reply with a list of what they must do.',
  'Never use it for a question, a decision or a permission: ask those on a card. Set waits to true only when this thread cannot go on until they have done it.',
  'Checking one off approves nothing.',
].join(' ')
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const INSTRUCTIONS = `${TO_DO_TOOL} puts what only the user's hands can do on their to-do list. A question, a decision or a permission goes on a card instead. Where tools are found by search and called through use_tool, call it by its full name, ${TO_DO_MCP_SERVER}__${TO_DO_TOOL}.`
const NOTHING = 'Nothing was added.'

export const toDoDefinition: ThreadToolDefinition = { name: TO_DO_TOOL, description: DESCRIPTION,
  inputSchema: z.toJSONSchema(toDoAddSchema, { io: 'input' }) as Record<string, unknown>,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }

export interface ToDoToolHandlers {
  /** Whether this thread may add one: one this host holds, on a provider that takes Sotto's tools. */
  admits(threadId: string): boolean
}

/**
 * `sotto_to_do`: the loopback MCP server through which a thread adds to the user's to-do list (ADR-0188). The
 * caller is known by its token, so a thread speaks only for itself. Adding changes nothing in any thread and approves nothing,
 * so no call asks the user anything.
 */
export class ToDoToolServer implements ScopedThreadTools {
  readonly name = TO_DO_MCP_SERVER
  readonly definitions: readonly ThreadToolDefinition[] = [toDoDefinition]
  private readonly server: ThreadToolServer
  private readonly recent = new Map<string, number[]>()
  constructor(private readonly store: Pick<ToDoStore, 'add' | 'open'>, private readonly handlers: ToDoToolHandlers, private readonly clock: () => number = Date.now) {
    this.server = new ThreadToolServer({ name: TO_DO_MCP_SERVER, serverName: 'sotto-to-do', instructions: INSTRUCTIONS,
      unavailable: `This tool is unavailable. ${NOTHING} Tell the user in your reply.`, failed: `Sotto could not add this. ${NOTHING} Tell the user in your reply.` },
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
  /** Takes a slot on this thread's limit, and answers the one it took, or nothing when there is none left. */
  private takeSlot(threadId: string): number | undefined {
    const now = this.clock(), times = (this.recent.get(threadId) ?? []).filter(at => now - at < TO_DO_LIMIT_WINDOW_MS)
    for (const [other, kept] of this.recent) if (other !== threadId && kept.every(at => now - at >= TO_DO_LIMIT_WINDOW_MS)) this.recent.delete(other)
    this.recent.set(threadId, times)
    if (times.length >= TO_DO_LIMIT) return undefined
    times.push(now)
    return now
  }
  /** Gives back the slot this call took, not whichever was taken last: another call's add may have been kept since. */
  private giveBackSlot(threadId: string, slot: number): void {
    const times = this.recent.get(threadId), at = times?.indexOf(slot) ?? -1
    if (at >= 0) times?.splice(at, 1)
  }
  private async invoke(threadId: string, args: unknown): Promise<ThreadToolResult> {
    const text = (value: string, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) })
    if (!this.admits(threadId)) return text(`This thread cannot add to the user's to-do list. ${NOTHING}`, true)
    const input = toDoAddSchema.safeParse(args)
    if (!input.success) return text(`Give a short title, and for a link its label and a web address. ${NOTHING}`, true)
    // A retry of words it already has open changes nothing, so it costs nothing either.
    const again = this.store.open(input.data.title, threadId) !== undefined
    const slot = again ? undefined : this.takeSlot(threadId)
    if (!again && slot === undefined) return text(`This thread has added ${TO_DO_LIMIT} to-dos in the last ${TO_DO_LIMIT_WINDOW_MS / 60_000} minutes, so ${NOTHING.toLowerCase()} Put it in your reply.`, true)
    try {
      await this.store.add(input.data, 'thread', threadId)
    } catch (error) {
      // Only an add that was kept counts: a thread retrying while the list is full is not locked out once it has room.
      if (slot !== undefined) this.giveBackSlot(threadId, slot)
      if (error instanceof ToDoRefused) return text(error.message, true)
      throw error
    }
    return text(input.data.waits ? 'It is on the user\'s to-do list. Sotto will tell you when they check it off, or say it did not work. It approves nothing. Do not list it in your reply as well.' : 'It is on the user\'s to-do list. Do not list it in your reply as well.')
  }
}
