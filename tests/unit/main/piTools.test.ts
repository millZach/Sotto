// @vitest-environment node
import { expect, it } from 'vitest'
import { PiTools } from '../../../src/main/agents/piTools'
import { ThreadToolServer, type ThreadMcpServer } from '../../../src/main/agents/threadToolServer'

const call = async (server: ThreadMcpServer, method: string, params = {}) => {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return response.json() as Promise<{ result: Record<string, unknown> }>
}
it('uses one Pi config address but keeps each thread’s tool list, instructions and destination separate', async () => {
  const make = (name: string) => new ThreadToolServer({ name, serverName: name, instructions: `Instructions for ${name}`, unavailable: 'Unavailable', failed: 'Failed' },
    [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }], async thread => ({ content: [{ type: 'text', text: `${name}:${thread}` }] }))
  const alpha = make('alpha'), beta = make('beta'), tools = new PiTools()
  try {
    const first = await tools.mount('first', [await alpha.mcpServer('first')])
    const second = await tools.mount('second', [await beta.mcpServer('second')])
    expect(first.url).toBe(second.url)
    expect(first.headers).not.toEqual(second.headers)
    expect((await call(first, 'initialize', { protocolVersion: '2025-06-18' })).result.instructions).toContain('Instructions for alpha')
    expect((await call(second, 'tools/list')).result.tools).toEqual([expect.objectContaining({ name: 'beta__read' })])
    expect((await call(first, 'tools/call', { name: 'alpha__read', arguments: {} })).result.content).toEqual([{ type: 'text', text: 'alpha:first' }])
    expect((await call(second, 'tools/call', { name: 'alpha__read', arguments: {} })).result.isError).toBe(true)
    tools.revoke('first')
    const response = await fetch(first.url, { method: 'POST', headers: Object.fromEntries(first.headers.map(header => [header.name, header.value])) })
    expect(response.status).toBe(401)
  } finally { await tools.close(); await alpha.close(); await beta.close() }
})
