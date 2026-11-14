import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { composeMail, draftProblem, draftRecipients, isMailAddress, mailMessageId, type MailDraft } from './compose'
import { mailOverTls, type MailOptions, type MailServer, type MailSignIn } from './read'
import { SmtpConnection, SmtpProtocolError, type SmtpReply } from './smtpWire'

/**
 * Sending one message from a mail account over SMTP (ADR-0205, slice 9). A send is a connection of its own, from
 * sign-in to goodbye, to the one server it is given and no other, over TLS from its first byte. The message goes
 * only once every recipient has been taken: one the server turns away sends nothing to anyone. The password goes to
 * the server and nowhere else: it is in no error and no result.
 *
 * Nothing here asks the user. Whoever calls this has their yes for this message already.
 */

export const MAIL_SEND_TIMEOUT_MS = 60_000

/**
 * Why a message was not sent, or may not have been. `input`: it is not something this sends; `said` says why.
 * `refused`: the server did not take the address and password. `busy`: it is turning this away for now. `recipient`:
 * it would not take mail for `recipient`. `unreachable`: it could not be reached, or stopped answering before the
 * message was handed over. `failed`: it answered something else. Each of those sent nothing.
 *
 * `unsure` is the one that did not: the whole message was handed over and the server's answer never came, so it may
 * have been sent. Sending it again could send it twice.
 */
export interface MailSendFailure {
  readonly ok: false
  readonly reason: 'input' | 'refused' | 'busy' | 'recipient' | 'unreachable' | 'failed' | 'unsure'
  readonly said?: string
  readonly recipient?: string
}
/** A message the server took: how many people it goes to, and the name it was sent under. */
export interface MailSent { readonly ok: true; readonly recipients: number; readonly messageId: string }

export interface MailSendOptions extends MailOptions {
  readonly now?: () => Date
  /** The message's own name, unique to it. */
  readonly id?: () => string
}

const SAID_MAX = 200
/** Text without anything that is not a letter a person reads. */
const readable = (text: string): string => [...text].filter(character => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f).join('')
/** The finer code a server may put at the start of every line of an answer, such as `5.7.8` (RFC 3463). */
const ENHANCED_CODE = /^[245]\.\d{1,3}\.\d{1,3}(?:\s+|$)/u
/**
 * A server's words on one line. A finer code repeated at the start of each later line is said once, so the lines
 * join as the words they are and nothing the server put between them splits what they carry.
 */
const worded = (reply: SmtpReply): string => readable(reply.lines.map((line, index) => index === 0 ? line : line.replace(ENHANCED_CODE, '')).join(' ')).trim()
const failure = (reason: MailSendFailure['reason'], said?: string, recipient?: string): MailSendFailure =>
  ({ ok: false, reason, ...(said ? { said } : {}), ...(recipient ? { recipient } : {}) })
/** A code that says not now (4xx) is `busy`; anything else that is not a yes is `otherwise`. */
const turnedAway = (reply: SmtpReply, otherwise: MailSendFailure['reason'], recipient?: string): MailSendFailure =>
  failure(reply.code >= 400 && reply.code < 500 ? 'busy' : otherwise, worded(reply), recipient)

/** What a sign-in is sent as: nothing, the address and the password, apart by null bytes, in base64 (RFC 4616). */
const plainAuth = (signIn: MailSignIn): string => Buffer.from(`\0${signIn.address}\0${signIn.password}`, 'utf8').toString('base64')

/**
 * Sends `draft` from the account that `signIn` signs in to. The sender is that account's own address: a message is
 * never sent as anyone else.
 */
export async function sendMail(server: MailServer, signIn: MailSignIn, draft: MailDraft, options: MailSendOptions = {}): Promise<MailSent | MailSendFailure> {
  if (!isMailAddress(signIn.address) || signIn.password.length === 0 || /[\r\n\0]/u.test(signIn.password)) return failure('input', 'This account\'s address or password is not one a mail server takes.')
  const problem = draftProblem(draft)
  if (problem !== null) return failure('input', problem)
  const id = (options.id ?? randomUUID)()
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(id)) return failure('input', 'The message could not be named.')
  const result = await inSession(server, signIn, draft, id, options)
  if (result.ok || result.said === undefined) return result
  // A server can repeat what it was sent. Its answer to the sign-in, the one command that carries the password, is
  // never handed on: the reason says enough. Any other words are dropped where they hold the password or the address,
  // as typed or as the sign-in sent them, wherever in them that is. Both sides are looked through without spaces or
  // control characters, since an answer of several lines is joined by spaces and could carry a secret in pieces.
  // Only then are they cut to a line.
  const squeezed = (text: string): string => readable(text).toLowerCase().replace(/\s+/gu, '')
  const said = squeezed(result.said)
  if ([signIn.password, signIn.address, plainAuth(signIn)].some(sent => said.includes(squeezed(sent)))) return failure(result.reason, undefined, result.recipient)
  return { ...result, said: result.said.slice(0, SAID_MAX) }
}

async function inSession(server: MailServer, signIn: MailSignIn, draft: MailDraft, id: string, options: MailSendOptions): Promise<MailSent | MailSendFailure> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  const timer = setTimeout(stop, options.timeoutMs ?? MAIL_SEND_TIMEOUT_MS)
  if (options.signal?.aborted) stop()
  options.signal?.addEventListener('abort', stop, { once: true })
  let smtp: SmtpConnection | undefined
  // Whether the whole message has been handed to the server. Before that, a connection that ends sent nothing.
  let handedOver = false
  try {
    if (controller.signal.aborted) return failure('unreachable')
    const outOfTime = new Promise<never>((_resolve, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('Out of time.')), { once: true }) })
    let socket: Duplex
    try { socket = await Promise.race([(options.connect ?? mailOverTls)(server, controller.signal), outOfTime]) } catch { return failure('unreachable') }
    smtp = new SmtpConnection(socket, controller.signal)
    const greeting = await smtp.reply()
    if (greeting.code !== 220) return turnedAway(greeting, 'failed')
    // The name a client gives itself. An address of this computer's own says nothing of whose computer it is.
    const hello = await smtp.command('EHLO [127.0.0.1]')
    if (hello.code !== 250) return turnedAway(hello, 'failed')
    if (!hello.lines.some(line => { const words = line.toUpperCase().split(/[ =]+/u); return words[0] === 'AUTH' && words.includes('PLAIN') })) return failure('failed', 'The mail server does not take a password on this connection.')
    const auth = await smtp.command(`AUTH PLAIN ${plainAuth(signIn)}`)
    // Its words are not kept: they answer the command that carried the password, and could repeat any part of it.
    if (auth.code !== 235) return failure(auth.code >= 400 && auth.code < 500 ? 'busy' : auth.code === 535 || auth.code === 534 || auth.code === 530 ? 'refused' : 'failed')
    const from = await smtp.command(`MAIL FROM:<${signIn.address}>`)
    if (from.code !== 250) return turnedAway(from, 'failed')
    const recipients = draftRecipients(draft)
    for (const recipient of recipients) {
      const taken = await smtp.command(`RCPT TO:<${recipient}>`)
      // One recipient turned away sends nothing to anyone: the connection ends before any message is handed over.
      if (taken.code !== 250 && taken.code !== 251) return turnedAway(taken, 'recipient', recipient)
    }
    const ready = await smtp.command('DATA')
    if (ready.code !== 354) return turnedAway(ready, 'failed')
    const message = composeMail(signIn.address, draft, (options.now ?? (() => new Date()))(), id)
    smtp.hand(message)
    handedOver = true
    const sent = await smtp.reply()
    // Any yes (2xx) is a message taken. A not-now (4xx) or a no (5xx) is one the server says it did not take. An
    // answer that is none of those says nothing either way, so it stays unknown whether the message went.
    if (sent.code >= 200 && sent.code < 300) return { ok: true, recipients: recipients.length, messageId: mailMessageId(signIn.address, id) }
    if (sent.code >= 400 && sent.code < 600) return turnedAway(sent, 'failed')
    return failure('unsure')
  } catch (error) {
    return failure(handedOver ? 'unsure' : error instanceof SmtpProtocolError ? 'failed' : 'unreachable')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
    smtp?.close()
  }
}
