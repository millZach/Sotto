import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'

/** What a `tools/call` to one of Sotto's tool servers answers. */
export type McpReply = { result: { content: { type: string; text: string }[]; isError?: boolean } }

/**
 * Calls `visualize` the way a provider does (ADR-0056): a JSON-RPC `tools/call` to the endpoint and headers the provider
 * was given at launch. Answers the tool's result.
 */
export async function callVisualize(server: Pick<ThreadMcpServer, 'url' | 'headers'>, args: unknown): Promise<McpReply['result']> {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'visualize', arguments: args } }) })
  return (await response.json() as McpReply).result
}
