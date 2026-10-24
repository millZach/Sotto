import { AGENT_MAX_ATTACHMENT_BYTES } from '../../shared/agents'

/**
 * Whether a PDF may also go to a provider as part of the prompt itself (ADR-0127), beside its copy in the working folder.
 * A PDF block Claude cannot read stays in its session and fails every later turn, so this is strict: a PDF goes natively
 * only when its page count can be read from its uncompressed page tree and is at most 100, and only while the message's
 * native bytes, images included, stay within 20 MiB. Anything else goes by path alone.
 */

/** The most pages a PDF sent as part of the prompt may have: Anthropic's limit under a 200K context. */
export const NATIVE_PDF_MAX_PAGES = 100
/** The most bytes one message's images and native PDFs may hold between them, which keeps a Claude request under 32 MB. */
export const NATIVE_ATTACHMENT_BYTES = AGENT_MAX_ATTACHMENT_BYTES

const PDF_SIGNATURE = '%PDF-'

/** Whether these bytes start as a PDF does. */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_SIGNATURE.length && Buffer.from(bytes.buffer, bytes.byteOffset, PDF_SIGNATURE.length).toString('latin1') === PDF_SIGNATURE
}

/** A value in a PDF's object syntax, as far as counting pages needs one. Strings and booleans are `null`: nothing here reads them. */
type PdfValue = number | PdfName | PdfReference | PdfDictionary | PdfValue[] | null
interface PdfName { readonly name: string }
interface PdfReference { readonly reference: string }
type PdfDictionary = Map<string, PdfValue>
type Token =
  | { readonly kind: 'number'; readonly value: number; readonly integer: boolean }
  | { readonly kind: 'name' | 'keyword'; readonly value: string }
  | { readonly kind: 'string' | '<<' | '>>' | '[' | ']' | 'end' }

/** Anything the reader cannot follow, which makes the count unknown. */
class Unreadable extends Error {}
const WHITESPACE = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])
const MAX_DEPTH = 64
const isKeyword = (token: Token, value: string): boolean => token.kind === 'keyword' && token.value === value

/**
 * Reads a PDF's top level: its `N G obj ... endobj` objects, cross-reference tables and trailers, and nothing else. A
 * stream's body is skipped unread, and a `%` comment outside a string is no part of anything, so neither can pass for a
 * page. Anything else at the top level, or any object it cannot parse, is `Unreadable`.
 */
class PdfReader {
  private at = 0
  private readonly ahead: Token[] = []
  /** Each object by `N G`, the last definition winning, as an incremental update's does. */
  readonly objects = new Map<string, PdfValue>()
  /** The trailers and cross-reference stream dictionaries, in the order they appear. */
  readonly trailers: PdfDictionary[] = []
  constructor(private readonly text: string) {}

  read(): void {
    for (let token = this.next(); token.kind !== 'end'; token = this.next()) {
      if (token.kind === 'number' && token.integer) {
        const generation = this.next()
        if (generation.kind !== 'number' || !generation.integer || !isKeyword(this.next(), 'obj')) throw new Unreadable()
        this.object(`${token.value} ${generation.value}`)
      } else if (isKeyword(token, 'xref')) {
        while (this.peek().kind === 'number' || isKeyword(this.peek(), 'f') || isKeyword(this.peek(), 'n')) this.next()
      } else if (isKeyword(token, 'trailer')) {
        const trailer = this.value(this.next(), 0)
        if (!(trailer instanceof Map)) throw new Unreadable()
        this.trailers.push(trailer)
      } else if (isKeyword(token, 'startxref')) {
        if (this.next().kind !== 'number') throw new Unreadable()
      } else throw new Unreadable()
    }
  }

  private object(key: string): void {
    const value = this.value(this.next(), 0)
    let token = this.next()
    if (isKeyword(token, 'stream')) {
      if (!(value instanceof Map) || this.ahead.length) throw new Unreadable()
      this.skipStream(value)
      if (nameOf(value.get('Type')) === 'XRef') this.trailers.push(value)
      token = this.next()
    }
    if (!isKeyword(token, 'endobj')) throw new Unreadable()
    this.objects.set(key, value)
  }

  /** Past a stream's body: by its direct `/Length` when `endstream` is there, otherwise to the next `endstream`. */
  private skipStream(dictionary: PdfDictionary): void {
    let start = this.at
    if (this.text[start] === '\r') start++
    if (this.text[start] === '\n') start++
    const length = dictionary.get('Length')
    if (typeof length === 'number' && Number.isInteger(length) && length >= 0) {
      let end = start + length
      while (end < this.text.length && WHITESPACE.has(this.text[end]!)) end++
      if (this.text.startsWith('endstream', end)) { this.at = end + 'endstream'.length; return }
    }
    const end = this.text.indexOf('endstream', start)
    if (end < 0) throw new Unreadable()
    this.at = end + 'endstream'.length
  }

  private value(token: Token, depth: number): PdfValue {
    if (depth > MAX_DEPTH) throw new Unreadable()
    switch (token.kind) {
      case 'number': {
        // `N G R` is a reference; a number alone is itself.
        const generation = this.peek(0)
        if (token.integer && generation.kind === 'number' && generation.integer && isKeyword(this.peek(1), 'R')) {
          this.next(); this.next()
          return { reference: `${token.value} ${generation.value}` }
        }
        return token.value
      }
      case 'name': return { name: token.value }
      case 'string': return null
      case 'keyword':
        if (token.value === 'true' || token.value === 'false' || token.value === 'null') return null
        throw new Unreadable()
      case '[': {
        const items: PdfValue[] = []
        for (let next = this.next(); next.kind !== ']'; next = this.next()) items.push(this.value(next, depth + 1))
        return items
      }
      case '<<': {
        const dictionary: PdfDictionary = new Map()
        for (let key = this.next(); key.kind !== '>>'; key = this.next()) {
          if (key.kind !== 'name') throw new Unreadable()
          dictionary.set(key.value, this.value(this.next(), depth + 1))
        }
        return dictionary
      }
      default: throw new Unreadable()
    }
  }

  private peek(index = 0): Token {
    while (this.ahead.length <= index) this.ahead.push(this.lex())
    return this.ahead[index]!
  }
  private next(): Token { return this.ahead.shift() ?? this.lex() }

  private lex(): Token {
    const text = this.text
    for (;;) {
      while (this.at < text.length && WHITESPACE.has(text[this.at]!)) this.at++
      if (text[this.at] !== '%') break
      while (this.at < text.length && text[this.at] !== '\n' && text[this.at] !== '\r') this.at++
    }
    if (this.at >= text.length) return { kind: 'end' }
    const c = text[this.at]!
    if (c === '(') {
      // A literal string, with its balanced parentheses and escapes: nothing inside it is syntax.
      let depth = 0
      do {
        if (this.at >= text.length) throw new Unreadable()
        const character = text[this.at++]
        if (character === '\\') this.at++
        else if (character === '(') depth++
        else if (character === ')') depth--
      } while (depth > 0)
      return { kind: 'string' }
    }
    if (c === '<') {
      if (text[this.at + 1] === '<') { this.at += 2; return { kind: '<<' } }
      const end = text.indexOf('>', this.at)
      if (end < 0 || !/^[0-9A-Fa-f\0\t\n\f\r ]*$/u.test(text.slice(this.at + 1, end))) throw new Unreadable()
      this.at = end + 1
      return { kind: 'string' }
    }
    if (c === '>') {
      if (text[this.at + 1] !== '>') throw new Unreadable()
      this.at += 2
      return { kind: '>>' }
    }
    if (c === '[' || c === ']') { this.at++; return { kind: c } }
    if (c === '/') {
      this.at++
      // `#xx` stands for a byte, so `/Pa#67e` is `/Page`.
      return { kind: 'name', value: this.regular().replace(/#([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) }
    }
    if (DELIMITERS.has(c)) throw new Unreadable()
    const word = this.regular()
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(word)) return { kind: 'number', value: Number(word), integer: /^\d+$/u.test(word) }
    return { kind: 'keyword', value: word }
  }
  private regular(): string {
    const start = this.at
    while (this.at < this.text.length && !WHITESPACE.has(this.text[this.at]!) && !DELIMITERS.has(this.text[this.at]!)) this.at++
    return this.text.slice(start, this.at)
  }
}

const nameOf = (value: PdfValue | undefined): string | undefined => value && typeof value === 'object' && 'name' in value ? value.name : undefined
/** The dictionary an indirect reference points at, or undefined. */
const dictionaryAt = (objects: ReadonlyMap<string, PdfValue>, value: PdfValue | undefined): PdfDictionary | undefined => {
  const target = value && typeof value === 'object' && 'reference' in value ? objects.get(value.reference) : undefined
  return target instanceof Map ? target : undefined
}

/**
 * A PDF's page count, read from its uncompressed page tree. Every `N G obj ... endobj` object is read with stream bodies
 * skipped and comments left out; the leaf `/Type /Page` objects are counted, and the root page tree is the `/Pages` of
 * the catalog the newest trailer's `/Root` names. The count stands only when there is at least one page and the leaves
 * agree with the root's `/Count`. Anything else is unknown: not a PDF, encrypted, any object kept in a compressed object
 * stream (where page objects may hide), counts that disagree, or anything the reader cannot follow.
 */
export function pdfPageCount(bytes: Uint8Array): number | undefined {
  if (!isPdfBytes(bytes)) return undefined
  const reader = new PdfReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'))
  try { reader.read() } catch (error) {
    if (error instanceof Unreadable) return undefined
    throw error
  }
  if (reader.trailers.some(trailer => trailer.has('Encrypt'))) return undefined
  let leaves = 0
  for (const value of reader.objects.values()) {
    if (!(value instanceof Map)) continue
    const type = nameOf(value.get('Type'))
    if (type === 'ObjStm') return undefined
    if (type === 'Page') leaves++
  }
  const trailer = [...reader.trailers].reverse().find(candidate => candidate.has('Root'))
  const catalog = dictionaryAt(reader.objects, trailer?.get('Root'))
  const tree = catalog && nameOf(catalog.get('Type')) === 'Catalog' ? dictionaryAt(reader.objects, catalog.get('Pages')) : undefined
  const count = tree && nameOf(tree.get('Type')) === 'Pages' ? tree.get('Count') : undefined
  return typeof count === 'number' && Number.isInteger(count) && leaves >= 1 && leaves === count ? count : undefined
}

/** Whether a PDF of this many pages may go natively. */
export function pdfFitsNatively(pages: number | undefined): boolean {
  return pages !== undefined && pages >= 1 && pages <= NATIVE_PDF_MAX_PAGES
}

/**
 * Which of a message's PDFs go natively, in the order attached: each whose page count fits, while the images'
 * `imageBytes` and the PDFs taken before it leave room for it under `NATIVE_ATTACHMENT_BYTES`.
 */
export function nativePdfSelection(imageBytes: number, pdfs: readonly Uint8Array[]): boolean[] {
  let used = imageBytes
  return pdfs.map(bytes => {
    if (used + bytes.byteLength > NATIVE_ATTACHMENT_BYTES || !pdfFitsNatively(pdfPageCount(bytes))) return false
    used += bytes.byteLength
    return true
  })
}
