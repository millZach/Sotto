import { z } from 'zod'
import type { BrowserAgentTools } from './browserAgentServer'
import { scopedThreadServers, type ScopedThreadTools, type ThreadMcpServer } from './threadToolServer'

/**
 * How long OpenCode waits on one browser call: an action waits there for the user's answer in Tools, so OpenCode is told
 * the same 6 minutes Claude Code and Codex are. A scoped server says its own wait (`timeoutMs`); one that says none gets
 * OpenCode's default.
 */
const BROWSER_TOOL_WAIT_MS = 360_000

/** One of Sotto's tool servers in the form OpenCode 2's runtime MCP route takes (`PUT /api/experimental/mcp/{name}`). */
export interface OpenCodeToolServer {
  readonly name: string
  readonly config: {
    readonly type: 'remote'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly oauth: false
    /** Off, so each tool reaches the model under its own name, as on every other provider, not only from a script. */
    readonly codemode: false
    readonly timeout?: { readonly execution: number }
  }
  /**
   * The permission actions OpenCode names this server's tools by: `<server>_<tool>`, the name the model is offered and
   * the action a permission request carries (checked against 2.0.31). Never sent to OpenCode as part of the server.
   */
  readonly actions: readonly string[]
}

/** A thread server's MCP config for one of Sotto's servers: loopback HTTP with the thread's bearer token (ADR-0087). */
export function opencodeToolServer(server: Pick<ThreadMcpServer, 'name' | 'url' | 'headers'>, tools: readonly { readonly name: string }[], waitMs?: number): OpenCodeToolServer {
  return { name: server.name, config: { type: 'remote', url: server.url, headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
    oauth: false, codemode: false, ...(waitMs ? { timeout: { execution: waitMs } } : {}) }, actions: tools.map(tool => `${server.name}_${tool.name}`) }
}

/**
 * Sotto's own tool servers for one thread, as Grok Build and Muse get them: the browser's, and each scoped server that
 * answers for the thread (the host setup tools while a setup runs, the visual tool while visuals are on, ADR-0056).
 */
export async function opencodeToolServers(browser: BrowserAgentTools | undefined, scoped: readonly ScopedThreadTools[], threadId: string): Promise<OpenCodeToolServer[]> {
  const servers = browser ? [opencodeToolServer(await browser.mcpServer(threadId), browser.definitions, BROWSER_TOOL_WAIT_MS)] : []
  for (const { server, tools } of await scopedThreadServers(scoped, threadId)) servers.push(opencodeToolServer(server, tools.definitions, tools.timeoutMs))
  return servers
}

const mcpListSchema = z.looseObject({ data: z.array(z.looseObject({ name: z.string(), status: z.looseObject({ status: z.string() }).optional() })) })
/**
 * Each server OpenCode lists in `GET /api/mcp`, by name, with its status: `connected`, `pending` while it is connecting,
 * `failed`, `needs_auth` or `disabled` (2.0.31's OpenAPI document). An answer Sotto cannot read gives none.
 */
export function toolServerStatuses(value: unknown): ReadonlyMap<string, string | undefined> | undefined {
  const parsed = mcpListSchema.safeParse(value)
  return parsed.success ? new Map(parsed.data.data.map(server => [server.name, server.status?.status])) : undefined
}
