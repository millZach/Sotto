/**
 * A message as it is sent (RFC 5322, with RFC 2045 and 2047 for anything that is not plain ASCII): who it is from
 * and to, its subject, the day, a name of its own, and its text. The text is plain text in UTF-8 and nothing else:
 * no HTML and no files. Whoever a message is hidden from, its Bcc, is named to the server and in no line of the
 * message.
 */

/** What a thread asks to send. */
export interface MailDraft {
  readonly to: readonly string[]
  readonly cc?: readonly string[] | undefined
  /** Sent the message without being named in it. */
  readonly bcc?: readonly string[] | undefined
  readonly subject: string
  readonly text: string
}

/**
 * The most people one message goes to, To, Cc and Bcc together: Gmail's own limit for mail sent this way, which Zach
 * picked on November 14, 2026 (#2494). Every message still asks, so this bounds one card, not a day.
 */
export const MAIL_RECIPIENTS_MAX = 100
export const MAIL_SUBJECT_MAX = 300
/**
 * The longest text sent, in characters. The card that asks shows all of it under a line for each of To, Cc, Bcc and
 * the subject, and a card's details are at most 100,000 characters (`AGENT_TEXT_MAX`): with 100 addresses of the
 * longest kind and the longest subject, this leaves the lines room.
 */
export const MAIL_SEND_TEXT_MAX = 70_000
const ADDRESS_MAX = 254

/**
 * One address and nothing else: a name, an at sign and a host with a dot in it, in ASCII, with none of the marks a
 * mail server reads as more than an address (a space, a comma, a bracket, a quote, a line end). It is written into
 * a command and a header line, so anything that could end one is refused here, not escaped. The name before the at
 * sign is at most 64 characters, and a dot in it sits between two others (RFC 5321 §4.1.2, §4.5.3.1.1).
 */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u
const LOCAL_MAX = 64
export const isMailAddress = (text: string): boolean => text.length <= ADDRESS_MAX && text.indexOf('@') <= LOCAL_MAX && ADDRESS.test(text)

/**
 * Everyone a draft goes to, each once, whichever line named them first. A host is the same host however it is
 * capitalised. The name before the at sign is the receiving server's to read, and it may tell capitals apart, so
 * two addresses that differ only there are two recipients.
 */
export function draftRecipients(draft: MailDraft): string[] {
  const seen = new Set<string>()
  return [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []].filter(address => {
    const at = address.lastIndexOf('@')
    const key = `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Why a draft cannot be sent as it is, in words for the agent that wrote it, or null when it can. */
export function draftProblem(draft: MailDraft): string | null {
  if (draft.to.length === 0) return 'Give at least one address in "to".'
  const everyone = [...draft.to, ...draft.cc ?? [], ...draft.bcc ?? []]
  const bad = everyone.find(address => !isMailAddress(address))
  if (bad !== undefined) return 'Each recipient is one plain address, such as ann@example.com, with no name, brackets or spaces around it.'
  // Counted as named, so naming someone twice cannot make the card that shows every line longer than it allows.
  if (everyone.length > MAIL_RECIPIENTS_MAX) return `A message goes to at most ${MAIL_RECIPIENTS_MAX} addresses, To, Cc and Bcc together.`
  if (draft.subject.trim().length === 0) return 'Give the message a subject.'
  if (draft.subject.length > MAIL_SUBJECT_MAX) return `A subject is at most ${MAIL_SUBJECT_MAX} characters.`
  if ([...draft.subject].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return 'A subject is one line, with no line ends or control characters.'
  if (draft.text.trim().length === 0) return 'Give the message some text.'
  if (draft.text.length > MAIL_SEND_TEXT_MAX) return `A message's text is at most ${MAIL_SEND_TEXT_MAX} characters.`
  if (draft.text.includes('\0')) return 'A message\'s text cannot hold a null character.'
  return null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (value: number): string => String(value).padStart(2, '0')
/** A moment as a message's Date line writes it, in UTC so the line says nothing of where the computer is. */
export function mailDate(at: Date): string {
  return `${DAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000`
}

/** The most bytes of text one encoded word carries, so the word with its marks stays within a line of 76. */
const WORD_BYTES = 39
/**
 * A subject as a header line carries it. Plain ASCII that fits one line is written as it is; anything else is
 * written as encoded words in UTF-8 (RFC 2047), each on a line of its own and none cut inside a character.
 */
export function encodedSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/u.test(subject) && subject.length <= 66 && !subject.includes('=?')) return subject
  const words: string[] = []
  let bytes: number[] = []
  for (const character of subject) {
    const encoded = [...Buffer.from(character, 'utf8')]
    if (bytes.length + encoded.length > WORD_BYTES) { words.push(Buffer.from(bytes).toString('base64')); bytes = [] }
    bytes.push(...encoded)
  }
  if (bytes.length > 0) words.push(Buffer.from(bytes).toString('base64'))
  return words.map(word => `=?utf-8?B?${word}?=`).join('\r\n ')
}

/** Addresses on a header line, a few to a line, so no line runs past what a server takes. */
function addressLines(name: string, addresses: readonly string[]): string {
  const lines: string[] = []
  let line = `${name}:`
  addresses.forEach((address, index) => {
    const piece = ` ${address}${index < addresses.length - 1 ? ',' : ''}`
    if (line.length + piece.length > 76 && line !== `${name}:`) { lines.push(line); line = piece } else line += piece
  })
  return [...lines, line].join('\r\n')
}

/**
 * The message's bytes. `id` is the message's own name, made by the caller so the caller can say which message it
 * sent; it is written with the sender's host after it. The text's line ends become the ones mail uses, and it is
 * sent as base64, so no line of it is too long for a server and none can be read as anything but text.
 */
export function composeMail(from: string, draft: MailDraft, at: Date, id: string): Buffer {
  const text = Buffer.from(draft.text.replace(/\r\n|\r|\n/gu, '\r\n'), 'utf8').toString('base64')
  const body = text.match(/.{1,76}/gu) ?? []
  return Buffer.from([
    `From: ${from}`,
    addressLines('To', draft.to),
    ...(draft.cc && draft.cc.length > 0 ? [addressLines('Cc', draft.cc)] : []),
    `Subject: ${encodedSubject(draft.subject)}`,
    `Date: ${mailDate(at)}`,
    `Message-ID: ${mailMessageId(from, id)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...body,
    '',
  ].join('\r\n'), 'latin1')
}

/** A message's own name as its Message-ID line writes it: the caller's `id` at the sender's host. */
export const mailMessageId = (from: string, id: string): string => `<${id}@${from.slice(from.lastIndexOf('@') + 1)}>`
