/** A string longer than this that is only base64, or a base64 `data:` URL, is a picture's bytes. */
export const PICTURE_CHARS = 16 * 1024
const PICTURE = /^(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/]*={0,2}$/u
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
/** The base64 letters from a point on. */
const BASE64_RUN = /[A-Za-z0-9+/=]*/uy
/** The next run of base64 letters. */
const NEXT_RUN = /[A-Za-z0-9+/=]+/gu
/** Where a nested JSON string opens, so a picture's bytes can follow: an escaped quote, then perhaps a `data:` URL's start. */
const NESTED_OPENING = /"(?:data:[\w.+-]+\/[\w.+-]+;base64,)?$/u
/** How much of a string's latest text is kept to find a nested string's opening split between pieces. */
const RECENT_CHARS = 128
/** How much of a string is held before its opening is judged whole; each later piece is judged alone. */
const OPENING_CHARS = 256
const QUOTE_OR_ESCAPE = /["\\]/gu
const HEAD_CHARS = 64

/**
 * A line from a Codex app-server longer than one frame may hold, read on without the pictures in it. Codex 0.166.0
 * keeps each generated picture's bytes in its `imageGeneration` item, and a whole `thread/read` hands every one of
 * them back in its one line: 341 MB for a thread that had made 106 paintings. Each JSON string here longer than
 * `PICTURE_CHARS` that is only base64 is kept as an empty string. Sotto reads such a picture from the file Codex saved
 * it to, and a record that holds it already keeps its own (`codexActivity.ts`), so a whole read loses nothing it shows.
 * A picture can also be a JSON string of its own inside another string: Computer Use's `node_repl` tool hands back each
 * screenshot as `{"content":[{"type":"image","data":"..."}]}` in a text result, and Codex 0.170.0 answered a thread
 * that took 4,294 of them with one 260 MiB line. Codex cuts a long result in its middle (`…169519 chars truncated…`),
 * so a screenshot's bytes may open the nested string without closing it, or close it without opening it. A run of more
 * than `PICTURE_CHARS` base64 letters that opens or closes on an escaped quote, a `data:` URL's start allowed after the
 * opening, is such a picture's, and is left out too. Sotto shows no picture from a text result (`picturesIn`), so that
 * loses nothing it shows either. Everything else is kept as it came. A string is held while it may still be a picture
 * and judged once it ends, so a long run of base64 letters followed by words, outside a nested string, is kept whole. `size` counts what is kept and held, so the caller can
 * tell a line that is still too long.
 */
export class OversizedLine {
  /** UTF-8 bytes kept so far. */
  bytes = 0
  /** The line's first characters, enough to say which request it answers. */
  head = ''
  private readonly parts: string[] = []
  private inString = false
  private escaped = false
  /** What the open string holds while every piece of it so far could be a picture's; undefined once it cannot be. */
  private held: string[] | undefined
  private heldChars = 0
  /** The open string's latest text, enough to tell a nested string's opening. */
  private recent = ''
  /** A run of base64 letters that may be a picture's, held until it ends; undefined outside one. */
  private run: string[] | undefined
  private runChars = 0
  /** Whether the held run opened a nested string. */
  private runOpened = false
  /** The run ended on a backslash, the last character of a piece, so the next piece says whether a quote closed it. */
  private closing = false

  /** What the line holds now: the bytes kept and the characters of a string still held. */
  get size(): number { return this.bytes + this.heldChars + this.runChars }

  push(text: string): void {
    let index = 0
    while (index < text.length) {
      if (!this.inString) {
        const quote = text.indexOf('"', index), end = quote < 0 ? text.length : quote + 1
        this.keep(text.slice(index, end)); index = end
        if (quote >= 0) { this.inString = true; this.held = []; this.heldChars = 0; this.recent = '' }
        continue
      }
      // Inside a string: find the quote that closes it, stepping over each escaped character, one split from its
      // backslash by the chunk boundary included.
      let scan = index, close = -1
      if (this.escaped) { this.escaped = false; scan++ }
      while (scan < text.length) {
        QUOTE_OR_ESCAPE.lastIndex = scan
        const found = QUOTE_OR_ESCAPE.exec(text)
        if (!found) break
        if (found[0] === '"') { close = found.index; break }
        if (found.index + 1 < text.length) scan = found.index + 2
        else { this.escaped = true; break }
      }
      this.string(text.slice(index, close < 0 ? text.length : close))
      if (close < 0) return
      this.endString(); index = close + 1
    }
  }

  /** The line as kept. */
  line(): string { return this.parts.join('') }

  private string(content: string): void {
    if (!content) return
    if (!this.held) { this.text(content); return }
    const before = this.heldChars
    this.held.push(content); this.heldChars += content.length
    // The opening is read whole once there is enough of it, so a `data:` URL split between pieces is still known.
    if (this.heldChars < OPENING_CHARS || (before < OPENING_CHARS ? PICTURE.test(this.held.join('')) : BASE64.test(content))) return
    const text = this.held.join('')
    this.held = undefined; this.heldChars = 0; this.text(text)
  }

  /** A string's text that is not a picture of its own, read for pictures nested in it as JSON strings. */
  private text(content: string): void {
    let index = 0
    while (index < content.length) {
      if (this.closing) {
        // The backslash that ended the run was left for this piece's first character to explain.
        this.closing = false
        this.endRun(content[index] === '"'); this.kept('\\')
        continue
      }
      if (this.run) {
        BASE64_RUN.lastIndex = index; BASE64_RUN.exec(content)
        const end = BASE64_RUN.lastIndex
        if (end > index) { this.run.push(content.slice(index, end)); this.runChars += end - index; index = end }
        if (index === content.length) return
        if (content[index] === '\\' && index + 1 === content.length) { this.closing = true; return }
        this.endRun(content.startsWith('\\"', index))
        continue
      }
      // Text up to the next run long enough to be a picture's, or one the piece's end may yet make so, is kept as it is.
      const from = index
      for (;;) {
        NEXT_RUN.lastIndex = index
        const found = NEXT_RUN.exec(content)
        if (!found) { this.kept(content.slice(from)); return }
        const end = found.index + found[0].length
        if (found[0].length <= PICTURE_CHARS && end < content.length) { index = end; continue }
        this.kept(content.slice(from, found.index)); index = found.index
        this.run = []; this.runChars = 0; this.runOpened = NESTED_OPENING.test(this.recent)
        break
      }
    }
  }

  /** The run of base64 letters ended: long enough to be a picture's and opening or closing a nested string, it is left out. */
  private endRun(closedByQuote: boolean): void {
    const run = this.run!.join(''), picture = (closedByQuote || this.runOpened) && this.runChars > PICTURE_CHARS
    this.run = undefined; this.runChars = 0
    if (!picture) this.kept(run)
  }

  /** Keep a string's text, remembering its end to find a nested string's opening. */
  private kept(text: string): void {
    this.keep(text)
    this.recent = (this.recent + text.slice(-RECENT_CHARS)).slice(-RECENT_CHARS)
  }

  private endString(): void {
    if (this.held && this.heldChars <= PICTURE_CHARS) this.text(this.held.join(''))
    // A run the string's end cut short was never closed as a string of its own.
    if (this.run) this.endRun(false)
    this.held = undefined; this.heldChars = 0
    this.keep('"'); this.inString = false
  }

  private keep(text: string): void {
    if (!text) return
    this.parts.push(text); this.bytes += Buffer.byteLength(text)
    if (this.head.length < HEAD_CHARS) this.head += text.slice(0, HEAD_CHARS - this.head.length)
  }
}
