// @vitest-environment node
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAgentServer } from '../../../src/main/agents/browserAgentServer'

const definitions = [{ name: 'browser_test', description: 'Read a shared browser page.', inputSchema: { type: 'object', properties: {} } }]
const servers: BrowserAgentServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })
function setup() {
  const call = vi.fn(async (threadId: string) => ({ content: [{ type: 'text' as const, text: threadId }] }))
  const server = new BrowserAgentServer(definitions, call); servers.push(server)
  return { server, call }
}
async function post(server: Awaited<ReturnType<BrowserAgentServer['mcpServer']>>, body: unknown, headers: Record<string, string> = {}) {
  return fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])), ...headers }, body: JSON.stringify(body) })
}
const invoke = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_test', arguments: { threadId: 'forged' } } }
describe('Sotto browser tool admission', () => {
  it('initializes MCP, discovers tools and binds requests to the admitted thread, never caller arguments', async () => {
    const { server, call } = setup()
    const first = await server.mcpServer('thread-one'); const second = await server.mcpServer('thread-two')
    expect(first.headers).not.toEqual(second.headers)
    expect(await (await post(first, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()).toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })
    expect(await (await post(first, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).toMatchObject({ result: { tools: definitions } })
    expect(await (await post(first, invoke)).json()).toMatchObject({ result: { content: [{ text: 'thread-one' }] } })
    await post(second, invoke)
    expect(call.mock.calls.map(args => args[0])).toEqual(['thread-one', 'thread-two'])
  })
  it('rejects webpage origins, forged hosts, absent credentials and revoked admission before dispatch', async () => {
    const { server, call } = setup(); const endpoint = await server.mcpServer('thread')
    expect((await post(endpoint, invoke, { Origin: 'http://127.0.0.1:3000' })).status).toBe(403)
    expect(await new Promise<number | undefined>((resolve, reject) => {
      const forged = request(endpoint.url, { method: 'POST', headers: { Host: 'attacker.test', Authorization: endpoint.headers[0]!.value, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode) })
      forged.on('error', reject); forged.end(JSON.stringify(invoke))
    })).toBe(403)
    expect((await post(endpoint, invoke, { Authorization: '' })).status).toBe(401)
    server.revoke('thread')
    expect((await post(endpoint, invoke)).status).toBe(401)
    expect(call).not.toHaveBeenCalled()
  })
  it('bounds request bodies, rejects unknown tools and never returns thrown page details', async () => {
    const { server, call } = setup(); const endpoint = await server.mcpServer('thread')
    expect((await post(endpoint, { ...invoke, padding: 'x'.repeat(131073) })).status).toBe(413)
    expect((await post(endpoint, { ...invoke, params: { name: 'approve_browser_permission' } })).status).toBe(200)
    expect(call).not.toHaveBeenCalled()
    call.mockRejectedValueOnce(new Error('private page content'))
    const result = await (await post(endpoint, invoke)).text()
    expect(result).toContain('could not be completed')
    expect(result).not.toContain('private page content')
  })
})
