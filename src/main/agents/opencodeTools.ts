import { z } from 'zod'
import { BROWSER_MCP_SERVER, type BrowserAgentTools } from './browserAgentServer'
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
}

/** A thread server's MCP config for one of Sotto's servers: loopback HTTP with the thread's bearer token (ADR-0087). */
export function opencodeToolServer(server: Pick<ThreadMcpServer, 'name' | 'url' | 'headers'>, waitMs?: number): OpenCodeToolServer {
  return { name: server.name, config: { type: 'remote', url: server.url, headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
    oauth: false, codemode: false, ...(waitMs ? { timeout: { execution: waitMs } } : {}) } }
}

/**
 * Sotto's own tool servers for one thread, as Grok Build and Muse get them: the browser's, and each scoped server that
 * answers for the thread (the host setup tools while a setup runs, the visual tool while visuals are on, ADR-0056).
 */
export async function opencodeToolServers(browser: BrowserAgentTools | undefined, scoped: readonly ScopedThreadTools[], threadId: string): Promise<OpenCodeToolServer[]> {
  const servers = browser ? [opencodeToolServer(await browser.mcpServer(threadId), BROWSER_TOOL_WAIT_MS)] : []
  for (const { server, tools } of await scopedThreadServers(scoped, threadId)) servers.push(opencodeToolServer(server, tools.timeoutMs))
  return servers
}

/**
 * The permission actions OpenCode names Sotto's tools by: `<server>_<tool>`, the name the model is offered and the action
 * a permission request carries (checked against 2.0.31). Every server a thread's own OpenCode server is given is Sotto's
 * and that thread's alone, because each thread has a server of its own and runtime MCP servers are per process.
 */
export function opencodeToolActions(browser: BrowserAgentTools | undefined, scoped: readonly ScopedThreadTools[]): string[] {
  return [...(browser ? browser.definitions.map(tool => `${BROWSER_MCP_SERVER}_${tool.name}`) : []),
    ...scoped.flatMap(entry => entry.definitions.map(tool => `${entry.name}_${tool.name}`))]
}

const mcpListSchema = z.looseObject({ data: z.array(z.looseObject({ name: z.string(), status: z.looseObject({ status: z.string() }).optional() })) })
/** The names of the servers OpenCode lists as connected, from `GET /api/mcp`; an answer Sotto cannot read lists none. */
export function connectedToolServers(value: unknown): ReadonlySet<string> {
  const parsed = mcpListSchema.safeParse(value)
  return new Set(parsed.success ? parsed.data.data.filter(server => server.status?.status === 'connected').map(server => server.name) : [])
}
