import { connect, createServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * A mail server that takes mail, for tests: enough of SMTP (RFC 5321) to greet, take a sign-in, a sender, recipients
 * and one message, over a plain socket on this computer. It reads lines with its own small reader, not Sotto's, so
 * a mistake in one is not hidden by the same mistake in the other. Every address, password and message is made up,
 * and nothing it takes is sent anywhere.
 */
export interface FakeSmtpOptions {
  readonly address: string
  readonly password: string
  /** What it says first. Null says nothing at all. */
  readonly greeting?: string | null
  /** The lines it answers EHLO with, after its own name. Without them: `AUTH LOGIN PLAIN`, `8BITMIME`. */
  readonly offers?: readonly string[]
  /** Its whole answer to a sign-in, in place of checking the password: `454 4.7.0 Too many login attempts`. */
  readonly authSays?: string
  /** Its whole answer to the sender: `550 5.7.1 Not allowed`. */
  readonly fromSays?: string
  /** Recipients it turns away, each with its whole answer: `{ 'gone@example.com': '550 5.1.1 No such user' }`. */
  readonly refuses?: Readonly<Record<string, string>>
  /** Its whole answer to DATA, in place of `354`. */
  readonly dataSays?: string
  /** Its whole answer to a message, in place of `250`: `552 5.3.4 Message too big`. */
  readonly messageSays?: string
  /** A point at which it drops the connection without answering: a command's first word, or `message` for a message handed over. */
  readonly dropAt?: string
  /** Answers with a code and no words wherever its answer is one line, as SMTP lets a server do. */
  readonly terse?: boolean
}
export interface FakeSmtpMessage {
  /** Who the server was told the message is from and for: the envelope, which is where a Bcc is. */
  readonly from: string
  readonly to: readonly string[]
  /** The message as it was handed over, with the dots a client doubles taken out again. */
  readonly data: string
}
export interface FakeSmtpServer {
  /** The port it listens on, on this computer, without TLS. */
  readonly port: number
  /** Connects to it, whatever server is named, and keeps the name it was asked for. */
  readonly connect: (server: { readonly host: string; readonly port: number }, signal: AbortSignal) => Promise<Duplex>
  readonly asked: { readonly host: string; readonly port: number }[]
  /** Every command it received, in order, without what a sign-in carried. */
  readonly commands: string[]
  /** Every message it took. */
  readonly messages: FakeSmtpMessage[]
  close(): Promise<void>
}

export async function startFakeSmtpServer(options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  const commands: string[] = []
  const messages: FakeSmtpMessage[] = []
  const asked: { host: string; port: number }[] = []
  const sockets = new Set<Socket>()
  const good = Buffer.from(`\0${options.address}\0${options.password}`, 'utf8').toString('base64')
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    const say = (text: string): void => { if (!socket.destroyed) socket.write(`${options.terse ? text.replace(/^(\d{3}) .*$/gmu, '$1') : text}\r\n`) }
    let buffer = Buffer.alloc(0)
    let signedIn = false
    let from: string | null = null
    let to: string[] = []
    let taking = false
    const handle = (line: string): void => {
      const word = line.split(/[ :]/u)[0]!.toUpperCase()
      commands.push(word === 'AUTH' ? line.split(' ').slice(0, 2).join(' ') : line)
      if (options.dropAt === word) return void socket.destroy()
      if (word === 'EHLO') {
        const offers = options.offers ?? ['AUTH LOGIN PLAIN', '8BITMIME']
        say(['250-made-up.mail.example', ...offers.map((offer, index) => `250${index === offers.length - 1 ? ' ' : '-'}${offer}`)].join('\r\n'))
      } else if (word === 'AUTH') {
        if (options.authSays) return say(options.authSays)
        signedIn = line === `AUTH PLAIN ${good}`
        say(signedIn ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted')
      } else if (word === 'MAIL') {
        if (!signedIn) return say('530 5.7.0 Authentication Required')
        if (options.fromSays) return say(options.fromSays)
        from = /^MAIL FROM:<([^>]*)>$/u.exec(line)?.[1] ?? null
        say(from === options.address ? '250 2.1.0 OK' : '553 5.7.1 Sender address rejected')
      } else if (word === 'RCPT') {
        const address = /^RCPT TO:<([^>]*)>$/u.exec(line)?.[1]
        if (from === null || address === undefined) return say('503 5.5.1 Bad sequence of commands')
        const refusal = options.refuses?.[address]
        if (refusal) return say(refusal)
        to.push(address)
        say('250 2.1.5 OK')
      } else if (word === 'DATA') {
        if (to.length === 0) return say('503 5.5.1 RCPT first')
        if (options.dataSays) return say(options.dataSays)
        taking = true
        say('354 Go ahead')
      } else if (word === 'QUIT') {
        say('221 2.0.0 Bye')
        socket.end()
      } else say('502 5.5.1 Unrecognized command')
    }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (taking) {
          const end = buffer.indexOf('\r\n.\r\n')
          const empty = buffer.subarray(0, 3).toString('latin1') === '.\r\n'
          if (end < 0 && !empty) return
          const raw = empty ? '' : buffer.toString('latin1', 0, end + 2)
          buffer = buffer.subarray(empty ? 3 : end + 5)
          taking = false
          if (options.dropAt === 'message') return void socket.destroy()
          if (options.messageSays) { say(options.messageSays); continue }
          messages.push({ from: from!, to, data: raw.replace(/^\.\./gmu, '.') })
          from = null
          to = []
          say('250 2.0.0 OK made-up-queue-id')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.toString('latin1', 0, end)
        buffer = buffer.subarray(end + 2)
        handle(line)
      }
    })
    if (options.greeting !== null) say(options.greeting ?? '220 made-up.mail.example ESMTP ready')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port, commands, messages, asked,
    connect: (named, signal) => new Promise((resolve, reject) => {
      asked.push({ host: named.host, port: named.port })
      const socket = connect({ host: '127.0.0.1', port })
      const stop = (): void => { socket.destroy() }
      signal.addEventListener('abort', stop, { once: true })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
      socket.once('close', () => signal.removeEventListener('abort', stop))
    }),
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** A handed-over message's header lines, unfolded, and its text as it was written before it was encoded. */
export function readFakeSmtpMessage(data: string): { readonly headers: Readonly<Record<string, string>>; readonly text: string } {
  const split = data.indexOf('\r\n\r\n')
  const head = data.slice(0, split).replace(/\r\n[ \t]+/gu, ' ')
  const headers: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':')
    headers[line.slice(0, colon)] = line.slice(colon + 1).trim()
  }
  const body = data.slice(split + 4).replace(/\r\n/gu, '')
  return { headers, text: headers['Content-Transfer-Encoding'] === 'base64' ? Buffer.from(body, 'base64').toString('utf8') : body }
}
