// A small MCP client over streamable HTTP, speaking to the browser tools Sotto gives a Claude Code session,
// exactly as that session's own client would: the URL and headers come from the --mcp-config Sotto launched it with.
let next = 1

async function post(server, body, session) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`MCP ${body.method} failed with ${response.status}`)
  const sessionId = response.headers.get('mcp-session-id') ?? session
  if (!text) return { sessionId, message: null }
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(message => message.id === body.id)
    : JSON.parse(text)
  if (json?.error) throw new Error(`MCP ${body.method}: ${json.error.message}`)
  return { sessionId, message: json }
}

export async function connectMcp(server) {
  const { sessionId } = await post(server, { jsonrpc: '2.0', id: next++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.268' } } })
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
  return {
    async call(name, args) {
      const { message } = await post(server, { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } }, sessionId)
      const result = message?.result
      if (result?.isError) throw new Error(`${name}: ${result.content?.map(part => part.text).join(' ')}`)
      const text = result?.content?.find(part => part.type === 'text')?.text
      try { return JSON.parse(text) } catch { return text }
    },
  }
}
