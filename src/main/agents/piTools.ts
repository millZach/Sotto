import { z } from 'zod'
import { ThreadToolServer, type ThreadMcpServer, type ThreadToolDefinition, type ThreadToolResult } from './threadToolServer'

const initializeSchema = z.object({ result: z.object({ instructions: z.string().optional() }) })
const toolsSchema = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.unknown()) }).passthrough()) }) })
const resultSchema = z.object({ result: z.object({ content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })])), isError: z.boolean().optional() }).passthrough() })

/** One shared Pi config, with a different token and tool list for every thread. Provider credentials can then stay in Pi's one locked auth file. */
export class PiTools {
  private readonly definitions: ThreadToolDefinition[] = []
  private readonly instructions = new Map<string, string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly routes = new Map<string, Map<string, { server: ThreadMcpServer; name: string }>>()
  private readonly lists = new Map<string, ThreadToolDefinition[]>()
  private readonly server = new ThreadToolServer({ name: 'sotto', serverName: 'sotto-pi-tools', instructions: 'Use these Sotto tools for the work the user requested.', unavailable: 'This tool is unavailable.', failed: 'The tool could not finish.', maxRequestBytes: 16 * 1024 * 1024 }, this.definitions,
    async (threadId, name, args) => {
      const route = this.routes.get(threadId)?.get(name)
      if (!route) return { isError: true, content: [{ type: 'text', text: 'This tool is unavailable for this thread.' }] }
      return resultSchema.parse(await this.request(route.server, 'tools/call', { name: route.name, arguments: args }, 3_600_000, this.controllers.get(threadId)?.signal)).result as ThreadToolResult
    }, id => this.lists.get(id) ?? [], id => this.instructions.get(id) ?? 'Use Sotto tools only for the work the user requested.')

  private async request(server: ThreadMcpServer, method: string, params: unknown, timeout = 15_000, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error('The Sotto tool server did not answer.')
    return response.json()
  }
  async mount(id: string, servers: readonly ThreadMcpServer[]): Promise<ThreadMcpServer> {
    this.controllers.get(id)?.abort(); this.controllers.set(id, new AbortController())
    const instructions: string[] = []
    const routes = new Map<string, { server: ThreadMcpServer; name: string }>(), list: ThreadToolDefinition[] = []
    await Promise.all(servers.map(async server => {
      try {
        const initial = initializeSchema.parse(await this.request(server, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'sotto-pi', version: '1' }, capabilities: {} }))
        if (initial.result.instructions) instructions.push(initial.result.instructions)
        const tools = toolsSchema.parse(await this.request(server, 'tools/list', {})).result.tools
        for (const tool of tools) {
          const name = `${server.name}__${tool.name}`
          routes.set(name, { server, name: tool.name })
          list.push({ name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema })
        }
      } catch { /* A failed optional server does not stop the thread or grant its tools. */ }
    }))
    for (const tool of list) if (!this.definitions.some(item => item.name === tool.name)) this.definitions.push(tool)
    this.instructions.set(id, instructions.join('\n\n'))
    this.routes.set(id, routes); this.lists.set(id, list)
    return this.server.mcpServer(id)
  }
  revoke(id: string): void { this.controllers.get(id)?.abort(); this.controllers.delete(id); this.instructions.delete(id); this.routes.delete(id); this.lists.delete(id); this.server.revoke(id) }
  close(): Promise<void> { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); this.instructions.clear(); this.routes.clear(); this.lists.clear(); return this.server.close() }
}
