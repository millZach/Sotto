import type { Duplex } from 'node:stream'

/**
 * IMAP as it goes over the wire (RFC 3501), as far as reading mail needs it: what a server says is cut into answers
 * and read into values, and a command is written with its strings quoted or sent as literals. A mail server is an
 * outside service, so everything it sends is counted and anything too long ends the connection.
 */

/** One value in a server's answer: an atom, a string (quoted or a literal, as its bytes), or a list of values. */
export type ImapItem = Buffer | readonly ImapItem[] | { readonly atom: string }

/** The server said something this client cannot read, or more than it takes. Never carries what was said. */
export class ImapProtocolError extends Error {}
/** The connection ended, or ran out of time, before the server answered. */
export class ImapClosed extends Error {}

/**
 * The longest line read, apart from its literals. A search's answer is one line with a number for every message that
 * matched, and a mailbox can hold hundreds of thousands.
 */
const LINE_MAX = 4_000_000
/** The largest literal read. A message's text is asked for in a piece no larger than this. */
export const IMAP_LITERAL_MAX = 1_000_000
/** The most read from one connection, whatever it is. */
const SESSION_MAX = 24_000_000
/** How deep lists may nest. A message's structure nests as its parts do. */
const DEPTH_MAX = 64
/** The start of a line that says how a command or the connection stands. */
const STATUS_LINE = /^\S+ (?:OK|NO|BAD|BYE|PREAUTH)(?: |$)/iu

/**
 * What a server sends, cut into whole answers as it arrives: each answer is its text, with every literal as bytes
 * where it stood. It keeps its place between arrivals, so a long answer that comes in many pieces is looked through
 * once and not once for every piece.
 */
export class ImapFrames {
  private buffer: Buffer = Buffer.alloc(0)
  private parts: (string | Buffer)[] = []
  /** How many bytes of a literal are awaited, or -1 while the end of a line is. */
  private literal = -1
  /** How far the awaited line has been looked through for its end. */
  private looked = 0

  add(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
  }

  /** The next whole answer, or null while more has to arrive. */
  next(): (string | Buffer)[] | null {
    for (;;) {
      if (this.literal >= 0) {
        if (this.buffer.length < this.literal) return null
        this.parts.push(Buffer.from(this.buffer.subarray(0, this.literal)))
        this.buffer = this.buffer.subarray(this.literal)
        this.literal = -1
        continue
      }
      const end = this.buffer.indexOf('\r\n', this.looked)
      if ((end < 0 ? this.buffer.length : end) > LINE_MAX) throw new ImapProtocolError('A line was too long.')
      if (end < 0) {
        // The last byte may be the first half of the line's end.
        this.looked = Math.max(0, this.buffer.length - 1)
        return null
      }
      const line = this.buffer.toString('latin1', 0, end)
      this.buffer = this.buffer.subarray(end + 2)
      this.looked = 0
      // A line that ends `{12}` is followed by a literal of that many bytes, and then goes on. A line that says how
      // things stand (`* OK …`, `S1 NO …`, `+ …`) is words to its end, and words may end in anything.
      const words = this.parts.length === 0 && (line.startsWith('+') || STATUS_LINE.test(line))
      const open = !words && line.endsWith('}') ? line.lastIndexOf('{') : -1
      const digits = open < 0 ? '' : line.slice(open + 1, -1)
      if (!/^\d{1,10}$/u.test(digits)) {
        const whole = [...this.parts, line]
        this.parts = []
        return whole
      }
      if (Number(digits) > IMAP_LITERAL_MAX) throw new ImapProtocolError('A literal was too long.')
      this.parts.push(line.slice(0, open))
      this.literal = Number(digits)
    }
  }
}

/** An answer's values. An atom keeps what stands in its square brackets whole, as `BODY[HEADER.FIELDS (FROM TO)]` needs. */
export function imapItems(parts: readonly (string | Buffer)[]): ImapItem[] {
  const root: ImapItem[] = []
  const stack: ImapItem[][] = [root]
  const top = (): ImapItem[] => stack[stack.length - 1]!
  for (const part of parts) {
    if (typeof part !== 'string') {
      top().push(part)
      continue
    }
    let at = 0
    while (at < part.length) {
      const character = part[at]
      if (character === ' ') { at += 1; continue }
      if (character === '(') {
        if (stack.length >= DEPTH_MAX) throw new ImapProtocolError('A list was nested too deep.')
        const list: ImapItem[] = []
        top().push(list)
        stack.push(list)
        at += 1
        continue
      }
      if (character === ')') {
        if (stack.length === 1) throw new ImapProtocolError('A list closed that was not open.')
        stack.pop()
        at += 1
        continue
      }
      if (character === '"') {
        let text = ''
        at += 1
        for (;;) {
          if (at >= part.length) throw new ImapProtocolError('A quoted string did not end.')
          if (part[at] === '"') break
          if (part[at] === '\\') at += 1
          if (at >= part.length) throw new ImapProtocolError('A quoted string did not end.')
          text += part[at]
          at += 1
        }
        at += 1
        top().push(Buffer.from(text, 'latin1'))
        continue
      }
      let end = at
      let brackets = 0
      while (end < part.length) {
        const next = part[end]
        if (next === '[') brackets += 1
        else if (next === ']') brackets = Math.max(0, brackets - 1)
        else if (brackets === 0 && (next === ' ' || next === '(' || next === ')')) break
        end += 1
      }
      top().push({ atom: part.slice(at, end) })
      at = end
    }
  }
  if (stack.length !== 1) throw new ImapProtocolError('A list did not close.')
  return root
}

/** An atom's text, in upper case, or null for a string or a list. */
export const atomOf = (item: ImapItem | undefined): string | null => item !== undefined && !Buffer.isBuffer(item) && !Array.isArray(item) ? (item as { atom: string }).atom.toUpperCase() : null
/** A string's or an atom's text. Empty for `NIL`, a list, or nothing. */
export const textOf = (item: ImapItem | undefined): string => {
  if (item === undefined || Array.isArray(item)) return ''
  if (Buffer.isBuffer(item)) return item.toString('utf8')
  const { atom } = item as { atom: string }
  return atom.toUpperCase() === 'NIL' ? '' : atom
}
export const listOf = (item: ImapItem | undefined): readonly ImapItem[] => Array.isArray(item) ? item as readonly ImapItem[] : []

/** Where a command or a connection stands, as the server put it: `OK`, `NO`, `BAD`, and its words. */
export interface ImapStatus {
  readonly status: 'OK' | 'NO' | 'BAD' | 'BYE' | 'PREAUTH'
  /** The response code in square brackets, in upper case, such as `AUTHENTICATIONFAILED` or `UIDVALIDITY 7`. */
  readonly code: string | null
  readonly text: string
}
/** A command's answer: how it ended, what the server said on the way, and the data it sent. */
export interface ImapAnswer extends ImapStatus {
  readonly notes: readonly ImapStatus[]
  /** Each line of data without its leading `*`: `['LIST', […], '/', 'INBOX']`, `[12, 'EXISTS']`, `[3, 'FETCH', […]]`. */
  readonly data: readonly (readonly ImapItem[])[]
}

/** What a command is written from: its own words as they stand, and each string of the user's or an agent's as `{ text }`. */
export type ImapArg = string | { readonly text: string }

const STATUS = /^(\S+) (OK|NO|BAD|BYE|PREAUTH)(?: \[([^\]]*)\])?(?: (.*))?$/iu
/** Text that goes in quotes as it stands. Anything else is sent as a literal, so it can never end the command early. */
const QUOTABLE = /^[\x20-\x7e]{0,500}$/u

function statusOf(parts: readonly (string | Buffer)[]): (ImapStatus & { readonly tag: string }) | null {
  const [line] = parts
  if (parts.length !== 1 || typeof line !== 'string') return null
  const found = STATUS.exec(line)
  if (!found) return null
  return { tag: found[1]!, status: found[2]!.toUpperCase() as ImapStatus['status'], code: found[3] ? found[3].toUpperCase() : null, text: found[4] ?? '' }
}

/**
 * One connection to a mail server, from its greeting to its end. Commands run one at a time. Every wait ends when
 * the connection does or when `signal` fires, so no read outlasts the time its caller gave it.
 */
export class ImapConnection {
  private readonly frames = new ImapFrames()
  private received = 0
  private failure: Error | null = null
  private wake: (() => void) | null = null
  private tags = 0
  private readonly ended = (): void => this.fail(new ImapClosed())

  constructor(private readonly socket: Duplex, private readonly signal: AbortSignal) {
    socket.on('data', (chunk: Buffer) => {
      this.received += chunk.length
      if (this.received > SESSION_MAX) return this.fail(new ImapProtocolError('The server sent too much.'))
      this.frames.add(chunk)
      this.wake?.()
    })
    socket.on('error', this.ended)
    socket.on('end', this.ended)
    socket.on('close', this.ended)
    if (signal.aborted) this.ended()
    else signal.addEventListener('abort', this.ended, { once: true })
  }

  /** What the server says first. */
  async greeting(): Promise<ImapStatus> {
    const status = statusOf(await this.frame())
    if (!status || status.tag !== '*') throw new ImapProtocolError('The server did not greet.')
    return status
  }

  /** Sends one command and waits for its answer. */
  async run(...args: readonly ImapArg[]): Promise<ImapAnswer> {
    this.tags += 1
    const tag = `S${this.tags}`
    const notes: ImapStatus[] = []
    const data: ImapItem[][] = []
    /** Reads on until the server ends the command, or, for a literal, says to go on. */
    const until = async (literal: boolean): Promise<ImapAnswer | null> => {
      for (;;) {
        const parts = await this.frame()
        if (literal && typeof parts[0] === 'string' && parts[0].startsWith('+')) return null
        const status = statusOf(parts)
        if (status?.tag === tag) return { status: status.status, code: status.code, text: status.text, notes, data }
        if (status?.tag === '*') notes.push(status)
        else if (typeof parts[0] === 'string' && parts[0].startsWith('* ')) data.push(imapItems([parts[0].slice(2), ...parts.slice(1)]))
        else throw new ImapProtocolError('The server answered out of turn.')
      }
    }
    let line = tag
    for (const arg of args) {
      if (typeof arg === 'string') { line += ` ${arg}`; continue }
      if (arg.text.includes('\0')) throw new ImapProtocolError('A string held a character mail servers do not take.')
      if (QUOTABLE.test(arg.text)) { line += ` "${arg.text.replace(/[\\"]/gu, '\\$&')}"`; continue }
      const bytes = Buffer.from(arg.text, 'utf8')
      this.write(`${line} {${bytes.length}}\r\n`)
      // The server refused the command before its string was sent.
      const refused = await until(true)
      if (refused) return refused
      this.write(bytes)
      line = ''
    }
    this.write(`${line}\r\n`)
    return (await until(false))!
  }

  /** Ends the connection. One that is still good says goodbye first; nothing waits for the server's answer. */
  close(): void {
    this.signal.removeEventListener('abort', this.ended)
    if (this.failure) return void this.socket.destroy()
    this.failure = new ImapClosed()
    this.socket.end(`S${this.tags + 1} LOGOUT\r\n`)
    setTimeout(() => this.socket.destroy(), 2_000).unref()
  }

  private write(bytes: string | Buffer): void {
    if (this.failure) throw this.failure
    this.socket.write(bytes)
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.socket.destroy()
    this.wake?.()
  }

  /** The next whole answer. What had arrived before the connection ended is still read. */
  private async frame(): Promise<(string | Buffer)[]> {
    for (;;) {
      let parts: (string | Buffer)[] | null
      try { parts = this.frames.next() } catch (error) {
        this.fail(error as Error)
        throw error
      }
      if (parts) return parts
      if (this.failure) throw this.failure
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = null
    }
  }
}
