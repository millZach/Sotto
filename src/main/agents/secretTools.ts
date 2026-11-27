import { z } from 'zod'
import {
  RELEASE_SECRET_TOOL, REQUEST_SECRET_TOOL, SECRET_REQUEST_MAX_WAIT_MS, SECRET_REQUESTS_MCP_SERVER, releaseSecretInputSchema, requestSecretInputSchema,
} from '../../shared/secretRequests'
import type { SecretOutcome, SecretRequests } from '../secrets/secretRequests'
import { ThreadToolServer, type ScopedThreadTools, type ThreadMcpServer, type ThreadToolCallContext, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const schema = (input: z.ZodType): Record<string, unknown> => z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>

export const secretToolDefinitions: readonly ThreadToolDefinition[] = [
  { name: REQUEST_SECRET_TOOL, inputSchema: schema(requestSecretInputSchema), description: [
    'Ask the user for a password, API key, token, pairing code or any value you must not see, on a private card in this thread. Open it, don\'t offer it, and never ask for such a value in chat.',
    'One value, or up to eight on one card with fields (a user name can be shown with secret: false). url adds a button that opens a sign-in or setup page.',
    'Returns a one-use secretRef (secretRefs by field name) that Sotto\'s own tools take, such as browser_action type with secretRef, or with delivery: "file" a file (files by name) your command reads,',
    'as `sudo -S cmd < "$file"` or `adb pair host:port "$(cat "$file")"`. Never print, copy or echo a file\'s contents. Call release_secret when you are done.',
  ].join(' '), _meta: { 'anthropic/alwaysLoad': true } },
  { name: RELEASE_SECRET_TOOL, inputSchema: schema(releaseSecretInputSchema), description:
    'Let go of secretRefs or files request_secret gave you once you are done: each is forgotten or deleted now. Unused ones go by themselves after an hour, or when the thread closes.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
]
const INSTRUCTIONS = `When you need a password, API key, token, one-time or pairing code, or any value the user should not paste into the chat, call ${REQUEST_SECRET_TOOL} instead of asking for it in a message. The user types it on a private card; you get a reference or a file and never the value itself, and it never reaches the chat, your context or Sotto's records. If the user pasted one into the chat anyway, tell them to change it and ask again with ${REQUEST_SECRET_TOOL}. Where tools are found by search and called through use_tool, call them by their full names, such as ${SECRET_REQUESTS_MCP_SERVER}__${REQUEST_SECRET_TOOL}.`

/** What the agent reads when a card ends without a value: never ask in chat instead. */
const UNSAVED: Record<'declined' | 'cancelled' | 'timed_out', string> = {
  declined: 'The user declined. Don\'t ask for it in chat or another way; say what is blocked and go on without it.',
  cancelled: 'The card closed with your call or the thread. Ask again only if the value is still needed.',
  timed_out: 'No answer in time. Don\'t ask in chat; ask again only if it is still needed.',
}

export interface SecretToolHandlers {
  /** A thread this computer holds, on a provider that takes Sotto's tools. */
  admits(threadId: string): boolean
  readonly service: Pick<SecretRequests, 'ask' | 'release'>
}

/**
 * `sotto_secrets` (ADR-0219): the loopback MCP server through which an agent asks the user for a value it must not
 * see. Nothing it returns holds a value: a saved card answers with references or file paths alone.
 */
export class SecretToolServer implements ScopedThreadTools {
  readonly name = SECRET_REQUESTS_MCP_SERVER
  readonly definitions = secretToolDefinitions
  /** A card may wait an hour for the user; the call is held that long, with a minute to spare. */
  readonly timeoutMs = SECRET_REQUEST_MAX_WAIT_MS + 60_000
  private readonly server: ThreadToolServer
  constructor(private readonly handlers: SecretToolHandlers) {
    this.server = new ThreadToolServer({ name: SECRET_REQUESTS_MCP_SERVER, serverName: 'sotto-secrets', instructions: INSTRUCTIONS,
      unavailable: 'Sotto\'s secret requests are unavailable. Nothing was asked.', failed: 'Sotto could not ask for the value just now. Nothing was kept; try again.' },
    this.definitions, (threadId, name, args, context) => this.invoke(threadId, name, args, context))
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer | undefined> {
    if (!this.admits(threadId)) return undefined
    return this.server.mcpServer(threadId)
  }
  call(threadId: string, name: string, args: unknown, context?: ThreadToolCallContext): Promise<ThreadToolResult> { return this.server.call(threadId, name, args, context) }
  close(): Promise<void> { return this.server.close() }
  private admits(threadId: string): boolean { try { return this.handlers.admits(threadId) } catch { return false } }
  private async invoke(threadId: string, name: string, args: unknown, context: ThreadToolCallContext): Promise<ThreadToolResult> {
    const reply = (value: unknown, isError = false): ThreadToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) })
    if (!this.admits(threadId)) return reply({ message: 'This thread cannot ask for secrets with Sotto\'s tools. Nothing was asked.' }, true)
    if (name === RELEASE_SECRET_TOOL) {
      const input = releaseSecretInputSchema.safeParse(args)
      if (!input.success) return reply({ message: 'Pass the secretRefs or files request_secret gave you.' }, true)
      return reply({ released: this.handlers.service.release(threadId, input.data) })
    }
    const input = requestSecretInputSchema.safeParse(args)
    if (!input.success) return reply({ message: `This request is invalid: ${input.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ').slice(0, 600)}. Nothing was asked.` }, true)
    const outcome = await this.handlers.service.ask(threadId, input.data, { ...(context.signal ? { signal: context.signal } : {}), ...(context.waitMs !== undefined ? { waitMs: context.waitMs } : {}) })
    return reply(secretResult(outcome, input.data.fields !== undefined))
  }
}

/** The tool's answer: references or files by field name for a card with fields, the one of each for a single value. */
export function secretResult(outcome: SecretOutcome, named: boolean): Record<string, unknown> {
  if (outcome.status !== 'saved') return { status: outcome.status, note: UNSAVED[outcome.status] }
  if (outcome.delivery === 'secretRef') return named ? { status: 'saved', secretRefs: outcome.refs } : { status: 'saved', secretRef: outcome.refs.value }
  const note = 'Owner-only file. Read it inside a command and never print it. Deleted after an hour, when you call release_secret, or when the thread closes.'
  return named ? { status: 'saved', files: outcome.files, note } : { status: 'saved', file: outcome.files.value, note }
}
