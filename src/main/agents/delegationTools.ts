import { z } from 'zod'
import { CANCEL_DELEGATION_TOOL, cancelDelegationInputSchema, DELEGATE_MCP_SERVER, DELEGATE_TOOL, delegateInputSchema, DELEGATION_PROMPTS_PER_THREAD,
  DELEGATION_WAIT_MAX_SECONDS, READ_DELEGATION_TOOL, readDelegationInputSchema } from '../../shared/delegation'
import { NOT_ADMITTED, type DelegationService } from './delegation'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolCallContext, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const schema = (input: z.ZodType): Record<string, unknown> => z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
export const delegationToolDefinitions: readonly ThreadToolDefinition[] = [
  { name: DELEGATE_TOOL, inputSchema: schema(delegateInputSchema), description: [
    'Hand work to another thread on this computer: start a new Sotto thread on any provider with your brief, or send another brief to a thread you delegated to.',
    'The thread is the user\'s to open, answer and stop. It asks the user, never you, for any permission or answer, and nothing you send approves anything.',
    `For a new thread name the provider and model; call ${READ_DELEGATION_TOOL} with no delegation to see what is ready. Its permission is never wider than this thread's or the user's new-thread default.`,
    `It waits up to wait_seconds (at most ${DELEGATION_WAIT_MAX_SECONDS}) for the outcome and returns the reply once answered. When the wait ends first it returns working, and Sotto sends this thread a wake-up when the outcome changes: end your turn or carry on, and do not poll.`,
    `New threads share the computer's limit on threads in flight with Watcher's. Each thread takes ${DELEGATION_PROMPTS_PER_THREAD} briefs per user message to this thread; retries and wake-ups renew nothing.`,
  ].join(' ') },
  { name: READ_DELEGATION_TOOL, inputSchema: schema(readDelegationInputSchema), description:
    'Read one of this thread\'s delegations: its outcome (working, background, answered, failed, stopped, paused or unknown) and, once answered, the delegated thread\'s reply, labelled as its own words. With no delegation, list this thread\'s delegations, the ready models it can delegate to, and the limits. Reading charges nothing.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: CANCEL_DELEGATION_TOOL, inputSchema: schema(cancelDelegationInputSchema), description:
    'Cancel one of this thread\'s delegations: a brief still waiting is dropped, and a delegated thread working on it is stopped, with any thread it delegated to. Nothing is deleted.' },
]
// Grok asks before a call it cannot tie to a server, and a call by the bare name is one (#800): the full names are given.
const INSTRUCTIONS = `These tools let this thread hand work to threads it starts on this computer (ADR-0081), such as a review on another provider. Sotto starts the thread, sends your brief and tells you its outcome. A delegated thread is the user's: it asks the user, never you, and nothing you send approves anything. When ${DELEGATE_TOOL} returns working, end your turn or carry on; Sotto sends a wake-up when the outcome changes, carrying none of the delegated thread's words, and ${READ_DELEGATION_TOOL} reads its reply. Where tools are found by search and called through use_tool, call them by their full names, such as ${DELEGATE_MCP_SERVER}__${DELEGATE_TOOL}.`

/**
 * `sotto_delegate`: the loopback MCP server through which an ordinary thread on this computer delegates work to threads
 * it starts (ADR-0081). A thread is offered it only while delegation is on and the thread may delegate, asked at every
 * launch and every call; a second-level delegated thread, Watcher, host setup and provider jobs are offered none.
 */
export class DelegationToolServer implements ScopedThreadTools {
  readonly name = DELEGATE_MCP_SERVER
  readonly definitions = delegationToolDefinitions
  /** Above the longest wait, so the call returns working before Codex's and Claude Code's clients give up on it (decision 8). */
  readonly timeoutMs = (DELEGATION_WAIT_MAX_SECONDS + 30) * 1000
  private readonly server: ThreadToolServer
  constructor(private readonly service: DelegationService) {
    this.server = new ThreadToolServer({ name: DELEGATE_MCP_SERVER, serverName: 'sotto-delegate', instructions: INSTRUCTIONS,
      unavailable: 'Sotto\'s delegation tools are unavailable. Nothing was started.', failed: 'Sotto could not complete this delegation call. Call read_delegation to see where it stands before trying again.',
      maxRequestBytes: 256 * 1024 },
    this.definitions, (threadId, name, args, context) => this.invoke(threadId, name, args, context))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.service.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown, context: ThreadToolCallContext = {}): Promise<ThreadToolResult> { return this.server.call(threadId, name, args, context) }
  revoke(threadId: string): void { this.server.revoke(threadId) }
  close(): Promise<void> { return this.server.close() }
  private async invoke(threadId: string, name: string, args: unknown, context: ThreadToolCallContext): Promise<ThreadToolResult> {
    const result = !this.service.admits(threadId) ? { status: 'refused', code: 'NOT_ADMITTED', message: NOT_ADMITTED }
      : name === DELEGATE_TOOL ? await this.service.delegate(threadId, args, context)
        : name === READ_DELEGATION_TOOL ? await this.service.read(threadId, args) : await this.service.cancel(threadId, args)
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>,
      ...((result as { status: string }).status === 'refused' ? { isError: true } : {}) }
  }
}
