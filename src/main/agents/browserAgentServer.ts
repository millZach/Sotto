import { ThreadToolServer, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

export type BrowserToolDefinition = ThreadToolDefinition
export type BrowserToolResult = ThreadToolResult
/** The one name every client addresses this server by. A rename that misses a client is silent. */
export const BROWSER_MCP_SERVER = 'sotto_browser'
export interface BrowserMcpServer extends ThreadMcpServer { name: typeof BROWSER_MCP_SERVER }
export interface BrowserAgentTools {
  readonly definitions: readonly BrowserToolDefinition[]
  call(threadId: string, name: string, args: unknown): Promise<BrowserToolResult>
  mcpServer(threadId: string): Promise<BrowserMcpServer>
}
const BROWSER_INSTRUCTIONS = 'Use these tools for the browser the user sees in Sotto. A pending action needs the user in Tools; never approve it yourself. Browser calls wait for that answer. If a call is interrupted or times out, read the task status before requesting the action again. To check a web or Expo-web build on a phone, use iphone_open: the test iPhone is a phone-sized page in this browser, not iOS.'

/** Thread-bound local MCP transport. Admission is never permission to read or operate a page. */
export class BrowserAgentServer extends ThreadToolServer implements BrowserAgentTools {
  constructor(definitions: readonly BrowserToolDefinition[], invoke: BrowserAgentTools['call']) {
    super({ name: BROWSER_MCP_SERVER, serverName: 'sotto-browser', instructions: BROWSER_INSTRUCTIONS, unavailable: 'This browser tool is unavailable.',
      failed: 'The browser action could not be completed. Check the browser in Tools before retrying.' }, definitions, invoke)
  }
  override async mcpServer(threadId: string): Promise<BrowserMcpServer> {
    if (!threadId) throw new Error('Browser tools are unavailable.')
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
