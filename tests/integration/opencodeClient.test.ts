// @vitest-environment node
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { OpenCodeClient, type OpenCodeEvent } from '../../src/main/agents/opencodeClient'
import { OpenCodeUncertain } from '../../src/main/agents/opencodeServer'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

/** A local HTTP server answering every request with `answer`. */
async function serving(answer: (response: ServerResponse) => void): Promise<{ url: string; requests: () => number }> {
  let count = 0
  const server: Server = createServer((_request, response) => { count++; answer(response) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return { url: `http://127.0.0.1:${address.port}`, requests: () => count }
}

it('stops retrying a request OpenCode is not ready for once the thread’s server is being stopped', async () => {
  const unavailable = await serving(response => { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"_tag":"ServiceUnavailableError"}') })
  const closed = new AbortController()
  const client = new OpenCodeClient(unavailable.url, 'fixture-password', 5_000, closed.signal)
  const asking = client.request('GET', '/api/model').then(() => undefined, (error: unknown) => error)
  await expect.poll(() => unavailable.requests()).toBeGreaterThan(0)
  closed.abort()
  const settled = await asking
  // A request a stopped server never admitted ends there, with nothing claimed about it, rather than retrying for 30 s.
  expect(settled).toBeInstanceOf(OpenCodeUncertain)
  const after = unavailable.requests()
  expect(after).toBeLessThan(10)
})

it('stops waiting to retry a request OpenCode is not ready for as soon as its caller gives up', async () => {
  const unavailable = await serving(response => { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"_tag":"ServiceUnavailableError"}') })
  const client = new OpenCodeClient(unavailable.url, 'fixture-password', 5_000)
  const caller = new AbortController()
  const asking = client.request('GET', '/api/model', { signal: caller.signal }).then(() => undefined, (error: unknown) => error)
  // By the fourth try the wait between tries is a second long.
  await expect.poll(() => unavailable.requests(), { interval: 10 }).toBeGreaterThanOrEqual(4)
  const gaveUp = Date.now()
  caller.abort()
  const settled = await asking
  expect(settled).toBeInstanceOf(OpenCodeUncertain)
  // It ends with its caller rather than at the end of that wait.
  expect(Date.now() - gaveUp).toBeLessThan(400)
  expect(unavailable.requests()).toBe(4)
})

it('reads events whatever pieces the stream arrives in, a long one included', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024)
  const frames = [
    { type: 'server.connected', data: {} },
    { type: 'session.text.delta', data: { sessionID: 'ses_1', delta: big } },
    { type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'after' } },
  ].map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(': heartbeat\n\n')
  const stream = await serving(response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // Small pieces that cut lines, a CRLF and the long frame anywhere.
    let at = 0
    const write = (): void => {
      if (at >= frames.length) return
      const size = at === 0 ? 7 : 61_441
      response.write(frames.slice(at, at + size)); at += size
      setImmediate(write)
    }
    write()
  })
  const closed = new AbortController()
  cleanup.push(async () => { closed.abort() })
  const seen: OpenCodeEvent[] = []
  const client = new OpenCodeClient(stream.url, 'fixture-password', 5_000)
  const { connected } = client.events(event => seen.push(event), closed.signal)
  await connected
  await expect.poll(() => seen.length, { timeout: 15_000 }).toBe(3)
  expect(seen.map(event => event.type)).toEqual(['server.connected', 'session.text.delta', 'session.text.delta'])
  expect((seen[1]!.data as { delta: string }).delta).toHaveLength(big.length)
  expect((seen[2]!.data as { delta: string }).delta).toBe('after')
})
