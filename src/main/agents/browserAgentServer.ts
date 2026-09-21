import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export interface BrowserToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface BrowserToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
/** The one name every client addresses this server by. A rename that misses a client is silent. */
export const BROWSER_MCP_SERVER = 'sotto_browser'
export interface BrowserMcpServer {
  name: typeof BROWSER_MCP_SERVER; type: 'http'; url: string; headers: { name: string; value: string }[]
}
export interface BrowserAgentTools {
  readonly definitions: readonly BrowserToolDefinition[]
  call(threadId: string, name: string, args: unknown): Promise<BrowserToolResult>
  mcpServer(threadId: string): Promise<BrowserMcpServer>
}
const MAX_REQUEST_BYTES = 128 * 1024
const frameSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(), method: z.string().max(128), params: z.unknown().optional() })
const toolCallSchema = z.object({ name: z.string().max(128), arguments: z.unknown().optional() })

/** Thread-bound local MCP transport. Admission is never permission to read or operate a page. */
export class BrowserAgentServer implements BrowserAgentTools {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly tokens = new Map<string, string>()
  private readonly threads = new Map<string, string>()
  private closed = false
  private running = 0
  constructor(readonly definitions: readonly BrowserToolDefinition[], private readonly invoke: BrowserAgentTools['call']) {}
  async call(threadId: string, name: string, args: unknown): Promise<BrowserToolResult> {
    if (this.closed || !this.definitions.some(tool => tool.name === name)) return { isError: true, content: [{ type: 'text', text: 'This browser tool is unavailable.' }] }
    try { return await this.invoke(threadId, name, args) }
    catch { return { isError: true, content: [{ type: 'text', text: 'The browser action could not be completed. Check the browser in Tools before retrying.' }] } }
  }
  async mcpServer(threadId: string): Promise<BrowserMcpServer> {
    if (this.closed || !threadId) throw new Error('Browser tools are unavailable.')
    const url = await (this.starting ??= this.start())
    let token = this.threads.get(threadId)
    if (!token) { token = randomBytes(32).toString('base64url'); this.threads.set(threadId, token); this.tokens.set(token, threadId) }
    return { name: BROWSER_MCP_SERVER, type: 'http', url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }
  }
  revoke(threadId: string): void {
    const token = this.threads.get(threadId)
    if (token) this.tokens.delete(token)
    this.threads.delete(threadId)
  }
  async close(): Promise<void> {
    this.closed = true; this.tokens.clear(); this.threads.clear()
    if (!this.server) return
    const server = this.server
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
  private start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.receive(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
      this.server = server; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 32
      server.once('error', () => reject(new Error('Browser tools could not start.')))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('Browser tools could not start.')); return }
        resolve(`http://127.0.0.1:${address.port}/mcp`)
      })
    })
  }
  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    const address = this.server?.address()
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
    if (this.closed || request.headers.origin !== undefined || request.headers.host !== expectedHost || request.url !== '/mcp') { response.writeHead(403).end(); return }
    const authorization = request.headers.authorization
    const threadId = authorization?.startsWith('Bearer ') ? this.tokens.get(authorization.slice(7)) : undefined
    if (!threadId) { response.writeHead(401).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end(); return }
    if (this.running >= 16) { response.writeHead(429).end(); return }
    this.running++
    try {
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        size += bytes.length
        if (size > MAX_REQUEST_BYTES) { response.writeHead(413).end(); return }
        chunks.push(bytes)
      }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { response.writeHead(400).end(); return }
      const frame = frameSchema.safeParse(parsed)
      if (!frame.success) { response.writeHead(400).end(); return }
      const { id, method, params } = frame.data
      if (id === undefined) { response.writeHead(202).end(); return }
      const reply = (result: unknown) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      if (method === 'initialize') {
        const version = z.object({ protocolVersion: z.string() }).safeParse(params)
        const protocolVersion = version.success && ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(version.data.protocolVersion) ? version.data.protocolVersion : '2025-06-18'
        reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sotto-browser', version: '1.0.0' }, instructions: 'Use these tools for the browser the user sees in Sotto. A pending action needs the user in Tools; never approve it yourself. Browser calls wait for that answer. If a call is interrupted or times out, read the task status before requesting the action again.' }); return
      }
      if (method === 'ping') { reply({}); return }
      if (method === 'tools/list') { reply({ tools: this.definitions }); return }
      if (method === 'tools/call') {
        const call = toolCallSchema.safeParse(params)
        if (!call.success) { response.writeHead(400).end(); return }
        // Recheck admission after receiving the body; revoked clients cannot dispatch queued calls.
        if (this.tokens.get(authorization!.slice(7)) !== threadId) { response.writeHead(401).end(); return }
        reply(await this.call(threadId, call.data.name, call.data.arguments ?? {})); return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'This method is unavailable.' } }))
    } finally { this.running-- }
  }
}

export async function browserCodexConfig(tools: BrowserAgentTools | undefined, threadId: string, reasoningEffort?: string): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}
  if (tools) {
    const server = await tools.mcpServer(threadId)
    // Sotto's own browser tools carry no native prompt; the answer that matters is the one the user
    // gives in Tools (ADR-0020). The mode is scoped to this server alone and changes no global config.
    config.mcp_servers = { [server.name]: { url: server.url, tool_timeout_sec: 360, default_tools_approval_mode: 'auto', http_headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) } }
  }
  return Object.keys(config).length ? { config } : {}
}
