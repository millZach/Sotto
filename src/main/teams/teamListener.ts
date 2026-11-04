import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { TEAM_BODY_BYTES_MAX, TEAM_ROUTE, teamWireSchema, type TeamWire } from '../../shared/teams'

/**
 * The team link's own listener (ADR-0186): loopback, carried on the tailnet by Tailscale Serve. It knows one route and one
 * closed list, and nothing about threads or the host protocol. What it cannot parse is refused here, so no command outside
 * the list ever reaches `handle`, however well signed.
 */
export interface TeamListenerHandlers { handle(message: TeamWire, token: string | undefined): Promise<unknown> }
export interface TeamListener { readonly port: number; close(): Promise<void> }

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  response.end(text)
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > TEAM_BODY_BYTES_MAX) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const NOT_ON_THE_LIST = { status: 'refused', reason: 'not-on-the-list' } as const

export function startTeamListener(handlers: TeamListenerHandlers, port = 0): Promise<TeamListener> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      // A page in a browser on the tailnet has no business here, and only this route exists.
      if (request.method !== 'POST' || request.url !== TEAM_ROUTE || request.headers.origin !== undefined) return reply(response, 404, NOT_ON_THE_LIST)
      const body = await readBody(request)
      let json: unknown
      try { json = body === undefined ? undefined : JSON.parse(body) } catch { json = undefined }
      const parsed = teamWireSchema.safeParse(json)
      if (!parsed.success) return reply(response, 400, NOT_ON_THE_LIST)
      const bearer = /^Bearer ([A-Za-z0-9_-]{20,512})$/u.exec(request.headers.authorization ?? '')?.[1]
      const answer = await handlers.handle(parsed.data, bearer)
      reply(response, 200, answer)
    })().catch(() => { if (!response.headersSent) reply(response, 500, NOT_ON_THE_LIST); else response.destroy() })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() }) })
    })
  })
}
