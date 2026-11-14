import type { Duplex } from 'node:stream'

/**
 * SMTP on the wire (RFC 5321): a server's answers and the lines sent to it. An answer is a three-digit code and
 * words, on one line or several, and a message ends at a line holding a single dot. Nothing here knows what a code
 * means; `send.ts` does.
 */

/** The server sent something that is not SMTP, or more than this reads. */
export class SmtpProtocolError extends Error {}
/** The connection ended, or the time its caller gave it ran out. */
export class SmtpClosed extends Error {}

/** One answer: its code, and the words of each of its lines. */
export interface SmtpReply { readonly code: number; readonly lines: readonly string[] }

/** The longest line read from a server, the most lines in one answer, and the most a whole connection may send. */
const LINE_MAX = 2_000
const REPLY_LINES_MAX = 100
const SESSION_MAX = 200_000
/** A line of an answer: its code, then a hyphen when more lines follow, then its words. A code alone is a whole answer. */
const REPLY = /^(\d{3})(?:([ -])(.*))?$/u

/**
 * A message's bytes as they are sent after DATA: a line that begins with a dot gets a second one, so no line of the
 * message can be read as its end, and the message ends with a line end of its own before the dot that ends it.
 */
export function smtpData(message: Buffer): Buffer {
  const text = message.toString('latin1').replace(/^\./gmu, '..')
  return Buffer.from(`${text.endsWith('\r\n') ? text : `${text}\r\n`}.\r\n`, 'latin1')
}

/**
 * One connection to a mail server that takes mail, from its greeting to its end. Commands run one at a time. Every
 * wait ends when the connection does or when `signal` fires, so no send outlasts the time its caller gave it.
 */
export class SmtpConnection {
  private buffered: Buffer = Buffer.alloc(0)
  private received = 0
  private failure: Error | null = null
  private wake: (() => void) | null = null
  private readonly ended = (): void => this.fail(new SmtpClosed())

  constructor(private readonly socket: Duplex, private readonly signal: AbortSignal) {
    socket.on('data', (chunk: Buffer) => {
      this.received += chunk.length
      if (this.received > SESSION_MAX) return this.fail(new SmtpProtocolError('The server sent too much.'))
      this.buffered = Buffer.concat([this.buffered, chunk])
      this.wake?.()
    })
    socket.on('error', this.ended)
    socket.on('end', this.ended)
    socket.on('close', this.ended)
    if (signal.aborted) this.ended()
    else signal.addEventListener('abort', this.ended, { once: true })
  }

  /** The server's next answer: what it says first, or what it says to the command just sent. */
  async reply(): Promise<SmtpReply> {
    const lines: string[] = []
    for (;;) {
      const found = REPLY.exec(await this.line())
      if (!found || lines.length >= REPLY_LINES_MAX) throw this.broken('The server answered something that is not an answer.')
      lines.push(found[3] ?? '')
      if (found[2] !== '-') return { code: Number(found[1]), lines }
    }
  }

  /** Sends one command and waits for its answer. A command is one line: a line end inside it is never sent. */
  async command(line: string): Promise<SmtpReply> {
    if (/[\r\n\0]/u.test(line)) throw new SmtpProtocolError('A command held a line end.')
    this.write(`${line}\r\n`)
    return this.reply()
  }

  /**
   * Hands a message over, once the server has said to go on. Whether it took it is its next answer. This throws
   * when the connection had already ended, or when the server has already said more than it was asked, since that
   * would be read as its answer to the message; then nothing of the message was sent.
   */
  hand(bytes: Buffer): void {
    if (this.buffered.length > 0) throw this.broken('The server answered before it was asked.')
    this.write(smtpData(bytes))
  }

  /** Ends the connection. One that is still good says goodbye first; nothing waits for the server's answer. */
  close(): void {
    this.signal.removeEventListener('abort', this.ended)
    if (this.failure) return void this.socket.destroy()
    this.failure = new SmtpClosed()
    this.socket.end('QUIT\r\n')
    setTimeout(() => this.socket.destroy(), 2_000).unref()
  }

  private write(bytes: string | Buffer): void {
    if (this.failure) throw this.failure
    this.socket.write(bytes)
  }

  private broken(words: string): SmtpProtocolError {
    const error = new SmtpProtocolError(words)
    this.fail(error)
    return error
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.socket.destroy()
    this.wake?.()
  }

  /** The next whole line. What had arrived before the connection ended is still read. */
  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffered.indexOf('\n')
      if (end >= 0) {
        const line = this.buffered.toString('latin1', 0, end).replace(/\r$/u, '')
        this.buffered = this.buffered.subarray(end + 1)
        if (line.length > LINE_MAX) throw this.broken('The server sent a line too long to read.')
        return line
      }
      if (this.buffered.length > LINE_MAX) throw this.broken('The server sent a line too long to read.')
      if (this.failure) throw this.failure
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = null
    }
  }
}
