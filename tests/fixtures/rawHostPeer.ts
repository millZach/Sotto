import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { Duplex } from 'node:stream'
import { expect } from 'vitest'
import { deflateAccepted, SocketFrames } from '../../src/host/socketFrames'

/**
 * A peer speaking the wire directly, the way a client of another codebase (the iPhone app) would. `offer` is sent as its
 * `Sec-WebSocket-Extensions`, and `extensions` is what the listener answered there; the peer reads compressed messages
 * only when the listener accepted.
 */
export async function rawPeer(port: number, session: string, { offer }: { offer?: string } = {}) {
  const key = randomBytes(16).toString('base64')
  const messages: Record<string, unknown>[] = []
  let stream!: Duplex
  let extensions: string | undefined
  const frames = await new Promise<SocketFrames>((resolve, reject) => {
    const request = httpRequest('http://127.0.0.1:' + port + '/v1/socket', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...(offer ? { 'Sec-WebSocket-Extensions': offer } : {}), Authorization: 'Bearer ' + session } })
    request.on('error', reject)
    request.on('upgrade', (response, upgraded, head) => {
      stream = upgraded
      const answered = response.headers['sec-websocket-extensions']
      extensions = typeof answered === 'string' ? answered : undefined
      const socket = new SocketFrames(stream, true, text => messages.push(JSON.parse(text) as Record<string, unknown>), { deflate: offer !== undefined && deflateAccepted(answered) === true })
      socket.feed(head); resolve(socket)
    }); request.end()
  })
  const call = async (id: string, operation: Record<string, unknown>) => {
    frames.send({ v: 1, id, session, ...operation })
    await expect.poll(() => messages.some(message => message.id === id)).toBe(true)
    return messages.find(message => message.id === id)!
  }
  /** `stream` is the socket under the frames, so a test can stop reading it the way a slow link does. */
  return { frames, stream, messages, call, extensions }
}
