import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export interface ThreadToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ThreadToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}
/** How a native client reaches one of Sotto's tool servers for one thread: loopback HTTP and a bearer token. */
export interface ThreadMcpServer { name: string; type: 'http'; url: string; headers: { name: string; value: string }[] }
/** What a server says about itself: its MCP name, the name in its handshake, and its instructions to the model. */
export interface ThreadToolServerIdentity { readonly name: string; readonly serverName: string; readonly instructions: string; readonly unavailable: string; readonly failed: string }
const MAX_REQUEST_BYTES = 128 * 1024
const frameSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(), method: z.string().max(128), params: z.unknown().optional() })
const toolCallSchema = z.object({ name: z.string().max(128), arguments: z.unknown().optional() })

/**
 * A thread-bound local MCP transport: `127.0.0.1` only, one bearer token per Sotto thread, no browser origin,
 * bounded bodies. The token says which thread is calling and nothing more; admission is never permission to
 * act, and each tool decides what its thread may do. `sotto_browser` (ADR-0020) and `sotto_host_setup`
 * (ADR-0035) are two of these.
 */
export class ThreadToolServer {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  private readonly tokens = new Map<string, string>()
  private readonly threads = new Map<string, string>()
  private closed = false
  private running = 0
  /** `listFor` narrows what one thread is shown, when threads get different tools from the same server; every tool otherwise. */
  constructor(protected readonly identity: ThreadToolServerIdentity, readonly definitions: readonly ThreadToolDefinition[],
    private readonly invoke: (threadId: string, name: string, args: unknown) => Promise<ThreadToolResult>,
    private readonly listFor?: (threadId: string) => readonly ThreadToolDefinition[]) {}
  async call(threadId: string, name: string, args: unknown): Promise<ThreadToolResult> {
    if (this.closed || !this.definitions.some(tool => tool.name === name)) return { isError: true, content: [{ type: 'text', text: this.identity.unavailable }] }
    try { return await this.invoke(threadId, name, args) }
    catch { return { isError: true, content: [{ type: 'text', text: this.identity.failed }] } }
  }
  async mcpServer(threadId: string): Promise<ThreadMcpServer> {
    if (this.closed || !threadId) throw new Error(this.identity.unavailable)
    const url = await (this.starting ??= this.start())
    let token = this.threads.get(threadId)
    if (!token) { token = randomBytes(32).toString('base64url'); this.threads.set(threadId, token); this.tokens.set(token, threadId) }
    return { name: this.identity.name, type: 'http', url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }
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
      server.once('error', () => reject(new Error(this.identity.unavailable)))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error(this.identity.unavailable)); return }
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
        reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.identity.serverName, version: '1.0.0' }, instructions: this.identity.instructions }); return
      }
      if (method === 'ping') { reply({}); return }
      if (method === 'tools/list') { reply({ tools: this.listFor?.(threadId) ?? this.definitions }); return }
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

/**
 * A tool server only some threads get: `mcpServer` answers undefined for every other thread, so an adapter asks for
 * it at each launch and offers nothing when there is nothing to offer. The host setup tools are one (ADR-0035), and
 * the visual tool another (ADR-0055). An adapter is handed every one of them as a list.
 */
export interface ScopedThreadTools {
  readonly name: string
  readonly definitions: readonly ThreadToolDefinition[]
  /** How long one call may take before the client gives up, when that is longer than the client's own default. */
  readonly timeoutMs?: number
  mcpServer(threadId: string): Promise<ThreadMcpServer | undefined>
}

/** The servers of `tools` this thread is given, in list order, each beside the tools that serve it. */
export async function scopedThreadServers(tools: readonly ScopedThreadTools[], threadId: string): Promise<{ server: ThreadMcpServer; tools: ScopedThreadTools }[]> {
  const servers: { server: ThreadMcpServer; tools: ScopedThreadTools }[] = []
  for (const entry of tools) {
    const server = await entry.mcpServer(threadId)
    if (server) servers.push({ server, tools: entry })
  }
  return servers
}
