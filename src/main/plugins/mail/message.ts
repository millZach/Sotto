import { listOf, textOf, type ImapItem } from './imapWire'

/**
 * A mail message as a person reads it, from what a mail server holds: header lines in their own words, the part of
 * the message that is its text, and the files that came with it by name. Nothing here reaches a network.
 */

/** Text from bytes in the character set a message names. One Sotto does not know is read as UTF-8. */
function inCharset(bytes: Buffer, charset: string | null): string {
  // RFC 2231 lets a language follow the character set: `utf-8*en`.
  const label = (charset ?? 'utf-8').split('*')[0]!.trim().toLowerCase() || 'utf-8'
  try { return new TextDecoder(label).decode(bytes) } catch { return new TextDecoder('utf-8').decode(bytes) }
}

/** Quoted-printable's bytes. Where the text is only the start of a piece (`cut`), a last `=` with nothing whole after it is left out. */
function fromQuotedPrintable(text: string, header: boolean, cut = false): Buffer {
  const out: number[] = []
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]!
    if (character === '_' && header) { out.push(0x20); continue }
    if (character !== '=') { out.push(text.charCodeAt(at) & 0xff); continue }
    const hex = text.slice(at + 1, at + 3)
    if (/^[0-9A-Fa-f]{2}$/u.test(hex)) { out.push(Number.parseInt(hex, 16)); at += 2; continue }
    // A soft line break: the line goes on.
    if (text[at + 1] === '\r' && text[at + 2] === '\n') { at += 2; continue }
    if (text[at + 1] === '\n') { at += 1; continue }
    if (cut && at + 3 > text.length) break
    out.push(0x3d)
  }
  return Buffer.from(out)
}

/** A header's value with its encoded words (RFC 2047) in their own letters: `=?utf-8?B?…?=` and `=?utf-8?Q?…?=`. */
export function decodeWords(value: string): string {
  // White space between two encoded words is not part of the text.
  return value.replace(/(\?=)\s+(?==\?)/gu, '$1').replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/gu, (_whole, charset: string, kind: string, text: string) =>
    inCharset(kind.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : fromQuotedPrintable(text, true), charset))
}

/** A header block's lines by name, in lower case, each unfolded and in its own letters. The first of a name wins. */
export function mailHeaders(block: Buffer): Map<string, string> {
  const headers = new Map<string, string>()
  for (const line of block.toString('utf8').replace(/\r?\n[ \t]+/gu, ' ').split(/\r?\n/u)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    if (!headers.has(name)) headers.set(name, decodeWords(line.slice(colon + 1).trim()))
  }
  return headers
}

/** One part of a message that is not made of other parts. */
export interface MailPart {
  /** Where the part is, as the server is asked for it: `1`, `2.1`. */
  readonly section: string
  /** Its kind in lower case: `text/plain`, `application/pdf`. */
  readonly type: string
  readonly charset: string | null
  /** How its bytes are written: `base64`, `quoted-printable`, or as they stand. */
  readonly encoding: string
  /** Its size as written, in bytes. */
  readonly size: number
  /** Its file name, where it has one. */
  readonly name: string | null
  /** Whether the sender marked it as a file to keep and not as part of the text. */
  readonly attached: boolean
}

/** Name and value pairs, names in lower case: `("charset" "utf-8" "name" "a.pdf")`. */
function pairs(item: ImapItem | undefined): Map<string, string> {
  const list = listOf(item)
  const found = new Map<string, string>()
  for (let at = 0; at + 1 < list.length; at += 2) found.set(textOf(list[at]).toLowerCase(), textOf(list[at + 1]))
  return found
}

/** A file name from a part's parameters: plain, in encoded words, or in RFC 2231's form, `utf-8''na%C3%AFve.pdf`. */
function fileName(...sets: readonly Map<string, string>[]): string | null {
  for (const set of sets) {
    for (const key of ['filename*', 'name*']) {
      const coded = /^([^']*)'[^']*'(.*)$/u.exec(set.get(key) ?? '')
      if (!coded) continue
      const bytes = Buffer.from(coded[2]!.replace(/%([0-9A-Fa-f]{2})/gu, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1')
      return inCharset(bytes, coded[1]!) || null
    }
    const plain = set.get('filename') ?? set.get('name')
    if (plain) return decodeWords(plain)
  }
  return null
}

/**
 * The parts of a message, in its own order, from the structure a server gives for it (`BODYSTRUCTURE`). A message
 * sent along inside another is one part and is not opened.
 */
export function mailParts(structure: ImapItem | undefined): MailPart[] {
  const parts: MailPart[] = []
  const walk = (item: ImapItem | undefined, section: string, attached: boolean): void => {
    const fields = listOf(item)
    if (fields.length === 0) return
    if (Array.isArray(fields[0])) {
      const count = fields.findIndex(child => !Array.isArray(child))
      const children = count < 0 ? fields : fields.slice(0, count)
      // Past the parts stand the group's kind, its parameters and how it was sent. A group sent as a file is files throughout.
      const within = attached || (count >= 0 && textOf(listOf(fields[count + 2])[0]).toLowerCase() === 'attachment')
      children.forEach((child, index) => walk(child, section ? `${section}.${index + 1}` : String(index + 1), within))
      return
    }
    const kind = textOf(fields[0]).toLowerCase()
    const subtype = textOf(fields[1]).toLowerCase()
    const parameters = pairs(fields[2])
    // Past the size stand a text's line count, or a carried message's own envelope, structure and line count.
    const extension = kind === 'text' ? 8 : kind === 'message' && subtype === 'rfc822' ? 10 : 7
    const disposition = listOf(fields[extension + 1])
    const size = Number(textOf(fields[6]))
    parts.push({
      section: section || '1', type: `${kind}/${subtype}`, charset: parameters.get('charset') || null, encoding: textOf(fields[5]).toLowerCase(),
      size: Number.isSafeInteger(size) && size >= 0 ? size : 0, name: fileName(pairs(disposition[1]), parameters),
      attached: attached || textOf(disposition[0]).toLowerCase() === 'attachment',
    })
  }
  walk(structure, '', false)
  return parts
}

/**
 * The part that is the message's text: its plain text where it has one, or its HTML. Never a file: a part the sender
 * marked as attached, or one with a file name, is not read as text. A message that is one text part and nothing else
 * is that text, whatever it is called.
 */
export function textPart(parts: readonly MailPart[]): MailPart | null {
  const [only] = parts
  if (parts.length === 1 && only && !only.attached && (only.type === 'text/plain' || only.type === 'text/html')) return only
  const text = (type: string): MailPart | undefined => parts.find(part => part.type === type && !part.attached && part.name === null)
  return text('text/plain') ?? text('text/html') ?? null
}

/** The files that came with a message: every part with a name or marked as attached, and every part that is not text. */
export function attachedParts(parts: readonly MailPart[], text: MailPart | null): MailPart[] {
  return parts.filter(part => part !== text && (part.attached || part.name !== null || !part.type.startsWith('text/')))
}

/**
 * A part's text from its bytes as the server sent them. `cut` says the bytes are only the start of the part, so a
 * last character or group that is not whole is dropped and not shown as damage.
 */
export function decodePart(bytes: Buffer, part: Pick<MailPart, 'encoding' | 'charset'>, cut: boolean): string {
  let plain = bytes
  if (part.encoding === 'base64') {
    const letters = bytes.toString('latin1').replace(/[^A-Za-z0-9+/]/gu, '')
    plain = Buffer.from(cut ? letters.slice(0, letters.length - letters.length % 4) : letters, 'base64')
  } else if (part.encoding === 'quoted-printable') {
    plain = fromQuotedPrintable(bytes.toString('latin1'), false, cut)
  }
  const text = inCharset(plain, part.charset).replace(/\r\n?/gu, '\n')
  if (!cut) return text
  // The mark a character that is not whole is read as (U+FFFD).
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 0xfffd) end -= 1
  return text.slice(0, end)
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

/** HTML without what a page never shows: comments, scripts, styles and its head. One that never closes takes the rest with it. */
function withoutHidden(html: string): string {
  const opener = /<!--|<(script|style|head|title)\b/giu
  let out = ''
  let at = 0
  for (;;) {
    opener.lastIndex = at
    const open = opener.exec(html)
    if (!open) return out + html.slice(at)
    out += html.slice(at, open.index)
    const close = open[1] ? new RegExp(`</${open[1]}[ \t\n]*>`, 'giu') : /-->/gu
    close.lastIndex = open.index
    const end = close.exec(html)
    if (!end) return out
    at = end.index + end[0].length
  }
}

/**
 * An HTML message as plain text: what is not shown is dropped, a block ends its line, and a link keeps its address
 * beside its words. Enough for an agent to read a message by; it draws nothing. A message is whatever its sender
 * wrote, so every step here takes time in step with the message's length and no more.
 */
export function htmlToText(html: string): string {
  const shown = withoutHidden(html).replace(/\s+/gu, ' ')
  // A link's address is set after its words, unless the words already say it. A link does not hold another: one
  // that opens while another is open takes its place, so each stretch of words is looked through once.
  let link: { readonly address: string; readonly from: number } | null = null
  const linked = shown.replace(/<a\b[^<>]*>|<\/a\s*>/giu, (tag, offset: number) => {
    if (tag[1] !== '/') {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(tag)
      link = { address: (href?.[1] ?? href?.[2] ?? '').trim(), from: offset + tag.length }
      return ''
    }
    const closed = link
    link = null
    return closed && /^https?:/iu.test(closed.address) && !shown.slice(closed.from, offset).includes(closed.address) ? ` (${closed.address})` : ''
  })
  return linked
    .replace(/<br\b[^<>]*>/giu, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote|pre)\s*>/giu, '\n')
    .replace(/<[^<>]*>/gu, '')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/giu, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const point = name[1]!.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : whole
    })
    .replace(/[ \t]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** A mailbox's name in its own letters. IMAP writes one in a UTF-7 of its own: `Entw&APw-rfe` is Entwürfe. */
export function decodeMailboxName(raw: string): string {
  return raw.replace(/&([A-Za-z0-9+,]*)-/gu, (_whole, coded: string) => {
    if (coded === '') return '&'
    const bytes = Buffer.from(coded.replace(/,/gu, '/'), 'base64')
    let text = ''
    for (let at = 0; at + 1 < bytes.length; at += 2) text += String.fromCharCode(bytes.readUInt16BE(at))
    return text
  })
}
