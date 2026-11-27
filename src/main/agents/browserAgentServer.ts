import { SOTTO_BROWSER_SERVER } from '../../shared/sottoBrowserTools'
import { ThreadToolServer, type ThreadMcpServer, type ThreadToolCallContext, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

export type BrowserToolDefinition = ThreadToolDefinition
export type BrowserToolResult = ThreadToolResult
/** The one name every client addresses this server by. A rename that misses a client is silent; the transcript reads it too. */
export const BROWSER_MCP_SERVER = SOTTO_BROWSER_SERVER
export interface BrowserMcpServer extends ThreadMcpServer { name: typeof BROWSER_MCP_SERVER }
/** `compact`: the thread's client takes only the stable catalog, as Antigravity's does for its tool budget (ADR-0220). */
export interface BrowserServerOptions { readonly compact?: boolean }
export interface BrowserAgentTools {
  readonly definitions: readonly BrowserToolDefinition[]
  call(threadId: string, name: string, args: unknown, context?: ThreadToolCallContext): Promise<BrowserToolResult>
  mcpServer(threadId: string, options?: BrowserServerOptions): Promise<BrowserMcpServer>
}
const BROWSER_INSTRUCTIONS = 'Use these tools for the browser the user sees in Sotto. A pending action needs the user in Tools; never approve it yourself. Browser calls wait for that answer. If a call is interrupted or times out, read the task status before requesting the action again. To check a web or Expo-web build on a phone, use iphone_open: the test iPhone is a phone-sized page in this browser, not iOS.'

/** A paired host's threads (ADR-0198): the browser runs on the host, and there is no test iPhone there yet. */
export const HOST_BROWSER_INSTRUCTIONS = 'Use these tools for Sotto\'s browser, which runs on this machine, so localhost is this machine\'s. The user sees its pages in Sotto. A pending action needs the user in Tools; never approve it yourself. Browser calls wait for that answer. If a call is interrupted or times out, read the task status before requesting the action again.'

/** Thread-bound local MCP transport. Admission is never permission to read or operate a page. */
export class BrowserAgentServer extends ThreadToolServer implements BrowserAgentTools {
  /** Threads whose client asked for the stable catalog alone (ADR-0220, decision 3). */
  private readonly compactThreads: Set<string>
  /**
   * `compact` is the stable catalog a thread asking for it is listed instead of `definitions`; its tools are still
   * called the same way, so nothing it may call changes.
   */
  constructor(definitions: readonly BrowserToolDefinition[], invoke: BrowserAgentTools['call'], instructions = BROWSER_INSTRUCTIONS, compact: readonly BrowserToolDefinition[] = definitions) {
    const compactThreads = new Set<string>()
    super({ name: BROWSER_MCP_SERVER, serverName: 'sotto-browser', instructions, unavailable: 'This browser tool is unavailable.',
      failed: 'The browser action could not be completed. Check the browser in Tools before retrying.' }, definitions, invoke,
    threadId => compactThreads.has(threadId) ? compact : definitions)
    this.compactThreads = compactThreads
  }
  override async mcpServer(threadId: string, options?: BrowserServerOptions): Promise<BrowserMcpServer> {
    if (!threadId) throw new Error('Browser tools are unavailable.')
    if (options?.compact) this.compactThreads.add(threadId)
    else this.compactThreads.delete(threadId)
    try { return { ...await super.mcpServer(threadId), name: BROWSER_MCP_SERVER } }
    catch { throw new Error('Browser tools are unavailable.') }
  }
}

export async function browserCodexConfig(tools: BrowserAgentTools | undefined, threadId: string, reasoningEffort?: string): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}
  if (tools) {
    const server = await tools.mcpServer(threadId)
    // Sotto's own browser tools carry no native prompt; the answer that matters is the one the user
    // gives in Tools (ADR-0020). `approve`, not `auto`: Codex's `auto` decides from a tool's own hints
    // and still asked in a real turn. The mode is scoped to this server alone and changes no global config.
    config.mcp_servers = { [server.name]: { url: server.url, tool_timeout_sec: 360, default_tools_approval_mode: 'approve', http_headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }
  }
  return Object.keys(config).length ? { config } : {}
}
