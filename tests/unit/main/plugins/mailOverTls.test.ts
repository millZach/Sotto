// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

/**
 * The TLS a mail read and a mail send both start with (ADR-0205). Nothing here reaches a network: Node's TLS connect
 * is replaced, and only what it was asked for is read.
 */
const asked = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('node:tls', async original => ({
  ...await original<typeof import('node:tls')>(),
  connect: (options: Record<string, unknown>) => {
    asked.push(options)
    const socket = Object.assign(new EventEmitter(), { destroy: () => undefined })
    queueMicrotask(() => socket.emit('secureConnect'))
    return socket
  },
}))

describe('TLS to a mail server', () => {
  it('names the server it is reaching, so one with several names shows the certificate for this one', async () => {
    const { mailOverTls } = await import('../../../../src/main/plugins/mail/read')
    await mailOverTls({ host: 'smtp.gmail.com', port: 465 }, new AbortController().signal)
    // An address is not a name, and SNI does not carry one.
    await mailOverTls({ host: '127.0.0.1', port: 993 }, new AbortController().signal)
    expect(asked).toEqual([{ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' }, { host: '127.0.0.1', port: 993 }])
  })
})
