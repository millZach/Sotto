import { randomUUID } from 'node:crypto'
import { createServer, request, type IncomingMessage } from 'node:http'
import { connect, type Socket } from 'node:net'

/**
 * A stand-in for Tailscale Serve in front of a host's tailnet listener (ADR-0053): a loopback HTTP proxy that carries
 * requests and the socket upgrade to the listener's loopback port, and sets `X-Forwarded-For` to a tailnet address the
 * way Serve does. Real TLS and MagicDNS cannot run in a test, so the desktop opens it over plain HTTP on loopback.
 *
 * `upstream` is read for each request, so the stand-in follows a host that starts again on its remembered port. With no
 * upstream, or while `answering` is `502`, it answers 502 the way Serve does with nothing behind it; `cut()` ends every
 * connection it carries, the way a lost network does. `cut-upgrade` carries everything but ends each socket as soon as the
 * host has accepted it, and `impostor` answers health as another host. `requests` lists every path it was asked for.
 */
export async function serveStandIn(upstream: () => number | undefined, peer = '100.101.102.103') {
  let answering: 'proxy' | 502 | 'cut-upgrade' | 'impostor' = 'proxy'
  const open = new Set<Socket>()
  const requests: string[] = []
  const target = (): number | undefined => answering === 502 ? undefined : upstream()
  const headers = (incoming: IncomingMessage) => ({ ...incoming.headers, 'x-forwarded-for': peer })
  const server = createServer((incoming, response) => {
    requests.push(`${incoming.method ?? ''} ${incoming.url ?? ''}`)
    const port = target()
    if (!port) { response.statusCode = 502; response.end(); return }
    const impostor = answering === 'impostor' && incoming.url === '/v1/health'
    const outgoing = request({ host: '127.0.0.1', port, method: incoming.method, path: incoming.url, headers: headers(incoming) }, answer => {
      if (!impostor) { response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response); return }
      const chunks: Buffer[] = []
      answer.on('data', (chunk: Buffer) => chunks.push(chunk))
      answer.on('end', () => {
        const body = JSON.stringify({ ...JSON.parse(Buffer.concat(chunks).toString('utf8')) as object, hostId: randomUUID() })
        response.writeHead(answer.statusCode ?? 502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        response.end(body)
      })
    })
    outgoing.on('error', () => { if (!response.headersSent) response.statusCode = 502; response.end() })
    incoming.pipe(outgoing)
  })
  server.on('connection', socket => { open.add(socket); socket.on('close', () => open.delete(socket)) })
  server.on('upgrade', (incoming: IncomingMessage, client: Socket, head: Buffer) => {
    requests.push(`UPGRADE ${incoming.url ?? ''}`)
    const port = target()
    if (!port) { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return }
    const host = connect(port, '127.0.0.1', () => {
      const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`, ...Object.entries(headers(incoming)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`))]
      host.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) host.write(head)
      client.pipe(host).pipe(client)
      // The host accepted the socket; a network that drops just then ends it before the session can use it.
      if (answering === 'cut-upgrade') host.once('data', () => setImmediate(() => { client.destroy(); host.destroy() }))
    })
    open.add(host); host.on('close', () => open.delete(host))
    host.on('error', () => client.destroy())
    client.on('error', () => host.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The Serve stand-in has no loopback port.')
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    /** 502 for everything from now on, as Serve answers with nothing behind it, or carry requests again, or one of the faults above. */
    answer(value: 'proxy' | 502 | 'cut-upgrade' | 'impostor'): void { answering = value },
    /** Ends every connection it carries now. */
    cut(): void { for (const socket of open) socket.destroy() },
    close: async (): Promise<void> => {
      for (const socket of open) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
