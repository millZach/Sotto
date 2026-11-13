import { connect, createServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * A mail server for tests: enough of IMAP (RFC 3501) to sign in, list mailboxes, open one, search it and fetch from
 * a message, over a plain socket on this computer. It reads commands with its own small reader, not Sotto's, so a
 * mistake in one is not hidden by the same mistake in the other. Every address, password and message is made up.
 */

/** A part of a message that is not made of other parts. `body` is the part as it is written, already encoded. */
export interface FakeMailLeaf {
  readonly type: string
  readonly params?: Readonly<Record<string, string>>
  readonly encoding?: string
  readonly body: string | Buffer
  readonly disposition?: 'attachment' | 'inline'
  readonly filename?: string
}
export interface FakeMailMultipart { readonly multipart: string; readonly parts: readonly FakeMailBody[] }
export type FakeMailBody = FakeMailLeaf | FakeMailMultipart
export interface FakeMail {
  readonly uid: number
  /** Whether it has been read. A fetch that does not peek sets it, as a real server does. */
  seen?: boolean
  /** When the server received it, as IMAP writes it: `13-Nov-2026 09:30:00 +0000`. */
  readonly received: string
  /** Header lines as they are written, encoded words and all. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: FakeMailBody
  /** What a search finds besides the header lines: the message's words in their own letters. */
  readonly words?: string
}
export interface FakeMailbox { readonly name: string; readonly marks?: readonly string[]; readonly validity: number; readonly messages: FakeMail[] }
export interface FakeImapOptions {
  readonly address: string
  readonly password: string
  readonly mailboxes: readonly FakeMailbox[]
  readonly capabilities?: readonly string[]
  /** What it says first. Null says nothing at all. */
  readonly greeting?: string | null
  /** Its whole answer to a sign-in, in place of checking the password: `NO [UNAVAILABLE] Too many simultaneous connections`. */
  readonly loginSays?: string
  /** A command at which it drops the connection without answering: `UID SEARCH`. */
  readonly dropAt?: string
  /** Makes it claim a piece of a message this many bytes long. */
  readonly claimedBytes?: number
}
export interface FakeImapServer {
  /** The port it listens on, on this computer, without TLS. */
  readonly port: number
  /** Connects to it, whatever server is named, and keeps the name it was asked for. */
  readonly connect: (server: { readonly host: string; readonly port: number }, signal: AbortSignal) => Promise<Duplex>
  readonly asked: { readonly host: string; readonly port: number }[]
  /** Every command it received, in order, without the strings of a sign-in. */
  readonly commands: string[]
  close(): Promise<void>
}

const cat = (...pieces: readonly (string | Buffer)[]): Buffer => Buffer.concat(pieces.map(piece => typeof piece === 'string' ? Buffer.from(piece, 'latin1') : piece))
/** A string as a server writes it: quoted, or as a literal where it holds letters outside ASCII. */
const written = (text: string): Buffer => {
  if (/^[\x20-\x7e]*$/u.test(text)) return cat(`"${text.replace(/[\\"]/gu, '\\$&')}"`)
  const bytes = Buffer.from(text, 'utf8')
  return cat(`{${bytes.length}}\r\n`, bytes)
}
const isMultipart = (body: FakeMailBody): body is FakeMailMultipart => 'multipart' in body
const bytesOf = (leaf: FakeMailLeaf): Buffer => typeof leaf.body === 'string' ? Buffer.from(leaf.body, 'utf8') : leaf.body

function structure(body: FakeMailBody): Buffer {
  if (isMultipart(body)) return cat('(', ...body.parts.map(structure), ' ', written(body.multipart), ' ("boundary" "made-up") NIL NIL NIL)')
  const [kind = 'text', subtype = 'plain'] = body.type.split('/')
  const params = Object.entries(body.params ?? {})
  const size = bytesOf(body).length
  return cat('(', written(kind), ' ', written(subtype), ' ',
    params.length === 0 ? 'NIL' : cat('(', ...params.flatMap(([key, value], index) => [index === 0 ? '' : ' ', written(key), ' ', written(value)]), ')'),
    ' NIL NIL ', written(body.encoding ?? '7bit'), ` ${size}`, kind === 'text' ? ` ${bytesOf(body).toString('latin1').split('\n').length}` : '', ' NIL ',
    body.disposition ? cat('(', written(body.disposition), ' ', body.filename === undefined ? 'NIL' : cat('("filename" ', written(body.filename), ')'), ')') : 'NIL', ' NIL NIL)')
}
function leafAt(body: FakeMailBody, section: string): FakeMailLeaf | undefined {
  let at: FakeMailBody | undefined = body
  if (!isMultipart(body)) return section === '1' ? body : undefined
  for (const step of section.split('.')) at = at && isMultipart(at) ? at.parts[Number(step) - 1] : undefined
  return at && !isMultipart(at) ? at : undefined
}
const leaves = (body: FakeMailBody): FakeMailLeaf[] => isMultipart(body) ? body.parts.flatMap(leaves) : [body]

/** A command's words: atoms, quoted strings and literals as text, and a list in brackets kept as it was written. */
function wordsOf(pieces: readonly (string | Buffer)[]): string[] {
  const out: string[] = []
  for (const piece of pieces) {
    if (typeof piece !== 'string') { out.push(piece.toString('utf8')); continue }
    let at = 0
    while (at < piece.length) {
      if (piece[at] === ' ') { at += 1; continue }
      if (piece[at] === '"') {
        let text = ''
        for (at += 1; at < piece.length && piece[at] !== '"'; at += 1) {
          if (piece[at] === '\\') at += 1
          text += piece[at]
        }
        at += 1
        out.push(text)
        continue
      }
      let end = at
      if (piece[at] === '(') {
        let depth = 0
        do { depth += piece[end] === '(' ? 1 : piece[end] === ')' ? -1 : 0; end += 1 } while (depth > 0 && end < piece.length)
      } else {
        while (end < piece.length && piece[end] !== ' ') end += 1
      }
      out.push(piece.slice(at, end))
      at = end
    }
  }
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** The day in `3-Nov-2026`, or at the start of `13-Nov-2026 09:30:00 +0000`, as a number that sorts. */
const dayOf = (text: string): number => {
  const found = /^ ?(\d{1,2})-([A-Za-z]{3})-(\d{4})/u.exec(text)
  return found ? Date.UTC(Number(found[3]), MONTHS.indexOf(found[2]!.toLowerCase()), Number(found[1])) : Number.NaN
}

function matches(mail: FakeMail, criteria: readonly string[]): boolean {
  const header = (name: string): string => `${Object.entries(mail.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? ''} ${mail.words ?? ''}`.toLowerCase()
  const everything = `${Object.values(mail.headers).join(' ')} ${mail.words ?? ''} ${leaves(mail.body).map(leaf => typeof leaf.body === 'string' ? leaf.body : '').join(' ')}`.toLowerCase()
  for (let at = 0; at < criteria.length; at += 1) {
    const key = criteria[at]!.toUpperCase()
    const value = (): string => criteria[at += 1] ?? ''
    if (key === 'CHARSET') value()
    else if (key === 'FROM' || key === 'TO' || key === 'SUBJECT') { if (!header(key.toLowerCase()).includes(value().toLowerCase())) return false }
    else if (key === 'TEXT') { if (!everything.includes(value().toLowerCase())) return false }
    else if (key === 'SINCE') { if (!(dayOf(mail.received) >= dayOf(value()))) return false }
    else if (key === 'BEFORE') { if (!(dayOf(mail.received) < dayOf(value()))) return false }
    else if (key === 'UNSEEN') { if (mail.seen) return false }
    else if (key !== 'ALL') return false
  }
  return true
}

export async function startFakeImapServer(options: FakeImapOptions): Promise<FakeImapServer> {
  const commands: string[] = []
  const asked: { host: string; port: number }[] = []
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffer: Buffer = Buffer.alloc(0)
    let pieces: (string | Buffer)[] = []
    let need = -1
    let signedIn = false
    let open: FakeMailbox | undefined
    const say = (...lines: readonly (string | Buffer)[]): void => { if (!socket.destroyed) socket.write(cat(...lines)) }

    const fetch = (tag: string, set: string, items: string): void => {
      if (!open) return say(`${tag} NO No mailbox is open\r\n`)
      const wanted = new Set(set.split(',').map(Number))
      open.messages.forEach((mail, index) => {
        if (!wanted.has(mail.uid)) return
        const fields: (string | Buffer)[] = [`UID ${mail.uid}`]
        if (/\bFLAGS\b/u.test(items)) fields.push(` FLAGS (${mail.seen ? '\\Seen' : ''})`)
        if (/\bINTERNALDATE\b/u.test(items)) fields.push(` INTERNALDATE "${mail.received}"`)
        if (/\bRFC822\.SIZE\b/u.test(items)) fields.push(` RFC822.SIZE ${leaves(mail.body).reduce((sum, leaf) => sum + bytesOf(leaf).length, 500)}`)
        if (/\bBODYSTRUCTURE\b/u.test(items)) fields.push(' BODYSTRUCTURE ', structure(mail.body))
        for (const piece of items.matchAll(/BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/gu)) {
          const [, peek, section = '', start, count] = piece
          // A fetch that does not peek marks the message as read.
          if (!peek) mail.seen = true
          let bytes: Buffer
          if (section.startsWith('HEADER.FIELDS')) {
            const names = (/\(([^)]*)\)/u.exec(section)?.[1] ?? '').split(' ').map(name => name.toLowerCase())
            bytes = cat(...Object.entries(mail.headers).filter(([key]) => names.includes(key.toLowerCase())).map(([key, value]) => Buffer.from(`${key}: ${value}\r\n`, 'utf8')), '\r\n')
          } else {
            const leaf = leafAt(mail.body, section)
            bytes = leaf ? bytesOf(leaf) : Buffer.alloc(0)
          }
          if (start !== undefined) bytes = bytes.subarray(Number(start), Number(start) + Number(count))
          const claimed = !section.startsWith('HEADER') && options.claimedBytes !== undefined ? options.claimedBytes : bytes.length
          fields.push(` BODY[${section}]${start === undefined ? '' : `<${start}>`} {${claimed}}\r\n`, bytes)
        }
        say(`* ${index + 1} FETCH (`, ...fields, ')\r\n')
      })
      say(`${tag} OK Success\r\n`)
    }

    const handle = (words: readonly string[]): void => {
      const [tag = '*', first = '', ...more] = words
      const uid = first.toUpperCase() === 'UID'
      const verb = uid ? `UID ${(more[0] ?? '').toUpperCase()}` : first.toUpperCase()
      const rest = uid ? more.slice(1) : more
      commands.push(verb === 'LOGIN' ? verb : [verb, ...rest].join(' '))
      if (options.dropAt === verb) return void socket.destroy()
      if (verb === 'CAPABILITY') return say(`* CAPABILITY IMAP4rev1 ${(options.capabilities ?? ['UIDPLUS', 'SPECIAL-USE']).join(' ')}\r\n${tag} OK Thats all she wrote!\r\n`)
      if (verb === 'LOGOUT') {
        say(`* BYE Logging out\r\n${tag} OK Bye\r\n`)
        return void socket.end()
      }
      if (verb === 'LOGIN') {
        if (options.loginSays !== undefined) return say(`${tag} ${options.loginSays}\r\n`)
        signedIn = rest[0] === options.address && rest[1] === options.password
        return say(signedIn ? `${tag} OK ${options.address} authenticated (Success)\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`)
      }
      if (!signedIn) return say(`${tag} BAD Sign in first\r\n`)
      if (verb === 'LIST') return say(...options.mailboxes.flatMap(box => [`* LIST (${(box.marks ?? ['\\HasNoChildren']).join(' ')}) "/" `, written(box.name), '\r\n']), `${tag} OK Success\r\n`)
      if (verb === 'EXAMINE' || verb === 'SELECT') {
        open = options.mailboxes.find(box => box.name === rest[0] || (box.name.toUpperCase() === 'INBOX' && rest[0]?.toUpperCase() === 'INBOX'))
        if (!open) return say(`${tag} NO [NONEXISTENT] Unknown Mailbox: ${rest[0] ?? ''} (Failure)\r\n`)
        return say(`* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n* ${open.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${open.validity}] UIDs valid.\r\n${tag} OK [${verb === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${open.name} selected. (Success)\r\n`)
      }
      if (verb === 'UID SEARCH') {
        if (!open) return say(`${tag} NO No mailbox is open\r\n`)
        return say(`* SEARCH${open.messages.filter(mail => matches(mail, rest)).map(mail => ` ${mail.uid}`).join('')}\r\n${tag} OK SEARCH completed (Success)\r\n`)
      }
      if (verb === 'UID FETCH') return fetch(tag, rest[0] ?? '', rest.slice(1).join(' '))
      return say(`${tag} BAD Unknown command\r\n`)
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (need >= 0) {
          if (buffer.length < need) return
          pieces.push(Buffer.from(buffer.subarray(0, need)))
          buffer = buffer.subarray(need)
          need = -1
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) return
        const line = buffer.toString('latin1', 0, end)
        buffer = buffer.subarray(end + 2)
        const literal = /\{(\d+)\}$/u.exec(line)
        if (literal) {
          pieces.push(line.slice(0, literal.index))
          need = Number(literal[1])
          say('+ Ready for literal data\r\n')
          continue
        }
        const whole = [...pieces, line]
        pieces = []
        handle(wordsOf(whole))
      }
    })
    if (options.greeting !== null) say(`${options.greeting ?? '* OK Made-up mail server ready'}\r\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port, commands, asked,
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
