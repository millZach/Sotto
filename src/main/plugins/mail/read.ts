import type { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'
import { atomOf, IMAP_LITERAL_MAX, ImapConnection, ImapProtocolError, listOf, textOf, type ImapAnswer, type ImapArg, type ImapItem } from './imapWire'
import { attachedParts, decodeMailboxName, decodePart, htmlToText, mailHeaders, mailParts, textPart } from './message'

/**
 * Reading a mail account over IMAP (ADR-0205): whether a sign-in is good, a search, and one message opened. Each
 * read is a connection of its own, from sign-in to goodbye, to the one server it is given and no other. Nothing
 * here can change a mailbox: a mailbox is opened for reading only (`EXAMINE`), a message is read without being
 * marked as read (`BODY.PEEK`), and there is no command here that sends, moves, flags or deletes. A file that came
 * with a message is named and never fetched. The password goes to the server and nowhere else: it is in no error
 * and no result.
 */

/** A mail server: its name and port. The connection is TLS from its first byte. */
export interface MailServer { readonly host: string; readonly port: number }
/** What signs in to it: the address, and the password the service gave for apps. */
export interface MailSignIn { readonly address: string; readonly password: string }
/** How this module reaches the network: TLS to the server, or a stand-in. The stream is closed when `signal` fires. */
export type MailConnect = (server: MailServer, signal: AbortSignal) => Promise<Duplex>
export interface MailOptions {
  readonly connect?: MailConnect
  /** How long one read may take, from connecting to its answer. */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export const MAIL_TIMEOUT_MS = 30_000
/** How many messages a search lists when it does not say, and the most it lists. */
export const MAIL_SEARCH_DEFAULT = 20
export const MAIL_SEARCH_MAX = 50
/** The longest word or phrase searched for, and the longest mailbox name taken. */
export const MAIL_TERM_MAX = 200
/** The most of a message's text handed over. A longer one is cut and says so. */
export const MAIL_TEXT_MAX_CHARS = 200_000
/** The most of a message's text fetched, as the server holds it. */
const TEXT_FETCH_BYTES = 400_000
/** How many of a message's files are named, and how many mailbox names are offered when one is not found. */
const LISTED_MAX = 50

/**
 * Why a read did not happen. `input`: what was asked for is not something this reads. `refused`: the server did not
 * take the address and password. `busy`: it is turning sign-ins away for now. `unreachable`: it could not be reached,
 * or did not answer in time. `mailbox`: the account has no such mailbox; `mailboxes` names the ones it has. `moved`:
 * the mailbox was rebuilt since the search, so its messages have new names. `gone`: the message is no longer there.
 * `failed`: the server answered something else. `said` is the server's own words for it, where it gave any.
 */
export interface MailFailure {
  readonly ok: false
  readonly reason: 'input' | 'refused' | 'busy' | 'unreachable' | 'mailbox' | 'moved' | 'gone' | 'failed'
  readonly said?: string
  readonly mailboxes?: readonly string[]
}

/** What to look for. Every word given must match; none given lists the mailbox's newest messages. */
export interface MailSearch {
  /** `inbox` (the default), `all`, `sent`, `drafts`, `trash`, `spam` or `starred`, or a mailbox's own name. */
  readonly mailbox?: string
  readonly from?: string
  readonly to?: string
  readonly subject?: string
  /** Words anywhere in a message. */
  readonly text?: string
  /** Days as `2026-11-13`: received on or after, and before. */
  readonly since?: string
  readonly before?: string
  readonly unread?: boolean
  readonly limit?: number
}

/** A message as a search lists it. */
export interface MailSummary {
  /** The message's name within its mailbox, to open it by. */
  readonly id: string
  /** When the server received it. */
  readonly date: string | null
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly unread: boolean
  /** Its whole size in bytes, files included. */
  readonly size: number
}
export interface MailFile { readonly name: string | null; readonly type: string; readonly size: number }
export interface MailMessage extends MailSummary {
  readonly cc: string
  /** The message's text. From its HTML where it has no plain text, which `fromHtml` says. */
  readonly text: string
  readonly fromHtml: boolean
  readonly truncated: boolean
  /** The files that came with it, by name. Their contents are not read. */
  readonly files: readonly MailFile[]
}
export type MailCheck = { readonly ok: true } | MailFailure
export type MailFound = { readonly ok: true; readonly mailbox: string; /** How many messages matched; `messages` is the newest of them. */ readonly found: number; readonly messages: readonly MailSummary[] } | MailFailure
export type MailOpened = { readonly ok: true; readonly mailbox: string; readonly message: MailMessage } | MailFailure

const overTls: MailConnect = (server, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('Stopped before connecting.'))
  // The certificate is checked against the server's name, as Node does unless told otherwise.
  const socket = connectTls({ host: server.host, port: server.port })
  const stop = (): void => { socket.destroy() }
  signal.addEventListener('abort', stop, { once: true })
  socket.once('secureConnect', () => {
    socket.off('error', reject)
    resolve(socket)
  })
  socket.once('error', reject)
  socket.once('close', () => signal.removeEventListener('abort', stop))
})

const failure = (reason: MailFailure['reason'], said?: string): MailFailure => {
  // The server's words on one line, without anything that is not a letter a person reads.
  const words = [...said ?? ''].filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f).join('').trim().slice(0, 200)
  return { ok: false, reason, ...(words ? { said: words } : {}) }
}
const isFailure = (value: unknown): value is MailFailure => typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false

/** The response codes (RFC 5530) and words a server turns a sign-in away with when the trouble is its load, not the password. */
const BUSY_CODES: ReadonlySet<string> = new Set(['UNAVAILABLE', 'LIMIT', 'INUSE'])
const BUSY_WORDS = /too many|throttl|temporar|try again later|rate limit/iu

/**
 * Signs in, does one piece of work, and says goodbye. A connection that fails or runs out of time is `unreachable`;
 * a server that says something this cannot read is `failed`.
 */
async function signedIn<Result extends { readonly ok: true }>(server: MailServer, signIn: MailSignIn, options: MailOptions, work: (imap: ImapConnection) => Promise<Result | MailFailure>): Promise<Result | MailFailure> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  const timer = setTimeout(stop, options.timeoutMs ?? MAIL_TIMEOUT_MS)
  if (options.signal?.aborted) stop()
  options.signal?.addEventListener('abort', stop, { once: true })
  let imap: ImapConnection | undefined
  try {
    // A read its caller has already stopped connects to nothing.
    if (controller.signal.aborted) return failure('unreachable')
    let socket: Duplex
    try { socket = await (options.connect ?? overTls)(server, controller.signal) } catch { return failure('unreachable') }
    imap = new ImapConnection(socket, controller.signal)
    const greeting = await imap.greeting()
    // A server that takes the connection as signed in already has not been told who by: it is not read from.
    if (greeting.status !== 'OK') return failure(greeting.status === 'BYE' ? 'busy' : 'failed', greeting.text)
    const capability = await imap.run('CAPABILITY')
    if (capability.data.some(line => line.some(item => atomOf(item) === 'LOGINDISABLED'))) return failure('failed', 'The mail server does not take a password on this connection.')
    const login = await imap.run('LOGIN', { text: signIn.address }, { text: signIn.password })
    if (login.status !== 'OK') {
      const busy = BUSY_CODES.has(login.code ?? '') || BUSY_WORDS.test(login.text)
      return failure(login.status === 'BAD' ? 'failed' : busy ? 'busy' : 'refused', login.text)
    }
    return await work(imap)
  } catch (error) {
    return failure(error instanceof ImapProtocolError ? 'failed' : 'unreachable')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    imap?.close()
  }
}

/** Whether text is something to send a mail server: not empty, not too long, and with no character that is not a letter. */
const plain = (text: string, max: number): boolean => text.length > 0 && text.length <= max && ![...text].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)

/** Whether a server takes an address and password. It signs in and reads nothing. */
export function checkMailSignIn(server: MailServer, signIn: MailSignIn, options: MailOptions = {}): Promise<MailCheck> {
  if (!plain(signIn.address, 320) || !plain(signIn.password, 1_000)) return Promise.resolve(failure('input'))
  return signedIn<{ readonly ok: true }>(server, signIn, options, async () => ({ ok: true }))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A day as IMAP writes it, `3-Nov-2026`, from `2026-11-03`. Null for anything that is not a day. */
function imapDay(day: string): string | null {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day)
  if (!found) return null
  const [year, month, date] = [Number(found[1]), Number(found[2]), Number(found[3])]
  const real = new Date(Date.UTC(year, month - 1, date))
  if (year < 1970 || real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== date) return null
  return `${date}-${MONTHS[month - 1]}-${year}`
}
/** When a server received a message, from `17-Jul-2026 02:44:25 -0700`. */
function receivedAt(text: string): string | null {
  const found = /^ ?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(text)
  if (!found) return null
  const month = MONTHS.findIndex(name => name.toLowerCase() === found[2]!.toLowerCase())
  if (month < 0) return null
  const offset = (Number(found[8]) * 60 + Number(found[9])) * (found[7] === '-' ? -1 : 1)
  const at = Date.UTC(Number(found[3]), month, Number(found[1]), Number(found[4]), Number(found[5]) - offset, Number(found[6]))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/** A search as IMAP's words, or null when it asks for something this does not read. */
function criteria(search: MailSearch): ImapArg[] | null {
  const words = ([['FROM', search.from], ['TO', search.to], ['SUBJECT', search.subject], ['TEXT', search.text]] as const).filter((entry): entry is readonly [typeof entry[0], string] => entry[1] !== undefined)
  if (words.some(([, text]) => !plain(text, MAIL_TERM_MAX))) return null
  const args: ImapArg[] = []
  // Words outside ASCII are sent as UTF-8, and the server is told so.
  if (words.some(([, text]) => [...text].some(character => character.charCodeAt(0) > 0x7f))) args.push('CHARSET', 'UTF-8')
  for (const [key, text] of words) args.push(key, { text })
  for (const [key, day] of [['SINCE', search.since], ['BEFORE', search.before]] as const) {
    if (day === undefined) continue
    const written = imapDay(day)
    if (!written) return null
    args.push(key, written)
  }
  if (search.unread) args.push('UNSEEN')
  return args.length === 0 ? ['ALL'] : args
}

/** The mailboxes people name by what they are for, and the mark a server sets on each (RFC 6154). */
const SPECIAL: Readonly<Record<string, string>> = { all: '\\ALL', sent: '\\SENT', drafts: '\\DRAFTS', trash: '\\TRASH', spam: '\\JUNK', starred: '\\FLAGGED' }

interface OpenMailbox { readonly name: string; readonly validity: number }

/** Opens a mailbox for reading only, by what it is for or by its own name. */
async function examine(imap: ImapConnection, wanted: string | undefined): Promise<OpenMailbox | MailFailure> {
  let raw = 'INBOX'
  let name = 'INBOX'
  if (wanted !== undefined && wanted.trim().toLowerCase() !== 'inbox') {
    const listed = await imap.run('LIST', { text: '' }, { text: '*' })
    if (listed.status !== 'OK') return failure('failed', listed.text)
    const boxes = listed.data.filter(line => atomOf(line[0]) === 'LIST' && line.length >= 4).map(line => {
      const marks = listOf(line[1]).map(mark => atomOf(mark) ?? '')
      const itsRaw = textOf(line[3])
      return { marks, raw: itsRaw, name: decodeMailboxName(itsRaw) }
    }).filter(box => box.raw !== '' && !box.marks.includes('\\NOSELECT') && !box.marks.includes('\\NONEXISTENT'))
    const key = wanted.trim().toLowerCase()
    const mark = SPECIAL[key]
    const found = (mark === undefined ? undefined : boxes.find(box => box.marks.includes(mark))) ?? boxes.find(box => box.name.toLowerCase() === key)
    if (!found) return { ...failure('mailbox'), mailboxes: boxes.slice(0, LISTED_MAX).map(box => box.name) }
    raw = found.raw
    name = found.name
  }
  const opened = await imap.run('EXAMINE', { text: raw })
  if (opened.status !== 'OK') return failure('mailbox', opened.text)
  const validity = /^UIDVALIDITY (\d{1,10})$/u.exec(opened.notes.find(note => note.code?.startsWith('UIDVALIDITY '))?.code ?? '')
  if (!validity) return failure('failed')
  return { name, validity: Number(validity[1]) }
}

/** What a `FETCH` answered for each message, by its number in the mailbox: each named thing and its value. */
function fetched(answer: ImapAnswer): Map<number, Map<string, ImapItem>> {
  const messages = new Map<number, Map<string, ImapItem>>()
  for (const line of answer.data) {
    if (atomOf(line[1]) !== 'FETCH') continue
    const fields = listOf(line[2])
    const values = new Map<string, ImapItem>()
    for (let at = 0; at + 1 < fields.length; at += 2) values.set(atomOf(fields[at]) ?? '', fields[at + 1]!)
    const uid = Number(textOf(values.get('UID')))
    if (!Number.isSafeInteger(uid) || uid < 1) continue
    // A server may answer for one message in more than one line.
    const known = messages.get(uid)
    if (known) for (const [key, value] of values) known.set(key, value)
    else messages.set(uid, values)
  }
  return messages
}
/** The value whose name starts as given: a server names a piece of a message back with where it starts, `BODY[1]<0>`. */
const startingWith = (values: Map<string, ImapItem>, start: string): ImapItem | undefined => [...values].find(([key]) => key.startsWith(start))?.[1]

const HEADERS = 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT)]'
function summary(validity: number, uid: number, values: Map<string, ImapItem>): { readonly listed: MailSummary; readonly cc: string } {
  const block = startingWith(values, 'BODY[HEADER.FIELDS')
  const headers = mailHeaders(Buffer.isBuffer(block) ? block : Buffer.alloc(0))
  const size = Number(textOf(values.get('RFC822.SIZE')))
  return {
    listed: {
      id: `${validity}-${uid}`, date: receivedAt(textOf(values.get('INTERNALDATE'))),
      from: headers.get('from') ?? '', to: headers.get('to') ?? '', subject: headers.get('subject') ?? '',
      unread: !listOf(values.get('FLAGS')).some(flag => atomOf(flag) === '\\SEEN'), size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
    },
    cc: headers.get('cc') ?? '',
  }
}

/** Searches one mailbox of an account and lists the newest messages that match. Nothing is marked as read. */
export function searchMail(server: MailServer, signIn: MailSignIn, search: MailSearch, options: MailOptions = {}): Promise<MailFound> {
  const wanted = criteria(search)
  const limit = search.limit ?? MAIL_SEARCH_DEFAULT
  if (!wanted || !Number.isInteger(limit) || limit < 1 || limit > MAIL_SEARCH_MAX || (search.mailbox !== undefined && !plain(search.mailbox, MAIL_TERM_MAX))) return Promise.resolve(failure('input'))
  return signedIn<Extract<MailFound, { ok: true }>>(server, signIn, options, async imap => {
    const mailbox = await examine(imap, search.mailbox)
    if (isFailure(mailbox)) return mailbox
    const matched = await imap.run('UID', 'SEARCH', ...wanted)
    if (matched.status !== 'OK') return failure('failed', matched.text)
    const uids = [...new Set(matched.data.filter(line => atomOf(line[0]) === 'SEARCH').flatMap(line => line.slice(1).map(item => Number(textOf(item)))))]
      .filter(uid => Number.isSafeInteger(uid) && uid > 0).sort((one, other) => other - one)
    const newest = uids.slice(0, limit)
    if (newest.length === 0) return { ok: true, mailbox: mailbox.name, found: 0, messages: [] }
    const listed = await imap.run('UID', 'FETCH', newest.join(','), `(UID FLAGS INTERNALDATE RFC822.SIZE ${HEADERS})`)
    if (listed.status !== 'OK') return failure('failed', listed.text)
    const values = fetched(listed)
    const messages = newest.flatMap(uid => {
      const its = values.get(uid)
      return its ? [summary(mailbox.validity, uid, its).listed] : []
    })
    return { ok: true, mailbox: mailbox.name, found: uids.length, messages }
  })
}

/**
 * Opens one message a search listed: its header lines, its text, and the names of the files that came with it. The
 * message stays unread, and no file's contents are fetched.
 */
export function openMail(server: MailServer, signIn: MailSignIn, message: { readonly mailbox?: string; readonly id: string }, options: MailOptions = {}): Promise<MailOpened> {
  const named = /^(\d{1,10})-(\d{1,10})$/u.exec(message.id)
  if (!named || Number(named[2]) < 1 || (message.mailbox !== undefined && !plain(message.mailbox, MAIL_TERM_MAX))) return Promise.resolve(failure('input'))
  const [validity, uid] = [Number(named[1]), Number(named[2])]
  return signedIn<Extract<MailOpened, { ok: true }>>(server, signIn, options, async imap => {
    const mailbox = await examine(imap, message.mailbox)
    if (isFailure(mailbox)) return mailbox
    // A mailbox that was rebuilt numbers its messages afresh, so the number may now be another message's.
    if (mailbox.validity !== validity) return failure('moved')
    const read = await imap.run('UID', 'FETCH', String(uid), `(UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE ${HEADERS})`)
    if (read.status !== 'OK') return failure('failed', read.text)
    const values = fetched(read).get(uid)
    if (!values) return failure('gone')
    const parts = mailParts(values.get('BODYSTRUCTURE'))
    const chosen = textPart(parts)
    let text = ''
    let truncated = false
    if (chosen && chosen.size > 0) {
      const piece = Math.min(TEXT_FETCH_BYTES, IMAP_LITERAL_MAX)
      const body = await imap.run('UID', 'FETCH', String(uid), `(BODY.PEEK[${chosen.section}]<0.${piece}>)`)
      if (body.status !== 'OK') return failure('failed', body.text)
      const bytes = startingWith(fetched(body).get(uid) ?? new Map<string, ImapItem>(), `BODY[${chosen.section}]`)
      const cut = chosen.size > piece
      const decoded = decodePart(Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0), chosen, cut)
      const whole = chosen.type === 'text/html' ? htmlToText(decoded) : decoded
      text = whole.slice(0, MAIL_TEXT_MAX_CHARS)
      truncated = cut || whole.length > MAIL_TEXT_MAX_CHARS
    }
    const files = attachedParts(parts, chosen).slice(0, LISTED_MAX).map(part => ({ name: part.name, type: part.type, size: part.size }))
    const { listed, cc } = summary(validity, uid, values)
    return { ok: true, mailbox: mailbox.name, message: { ...listed, cc, text, fromHtml: chosen?.type === 'text/html', truncated, files } }
  })
}
