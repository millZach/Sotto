/** A string longer than this that is only base64, or a base64 `data:` URL, is a picture's bytes. */
export const PICTURE_CHARS = 16 * 1024
const PICTURE = /^(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/]*={0,2}$/u
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
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
 * Everything else is kept as it came. A string is held while it may still be a picture and judged once it ends, so a
 * long run of base64 letters followed by words is kept whole. `size` counts what is kept and held, so the caller can
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

  /** What the line holds now: the bytes kept and the characters of a string still held. */
  get size(): number { return this.bytes + this.heldChars }

  push(text: string): void {
    let index = 0
    while (index < text.length) {
      if (!this.inString) {
        const quote = text.indexOf('"', index), end = quote < 0 ? text.length : quote + 1
        this.keep(text.slice(index, end)); index = end
        if (quote >= 0) { this.inString = true; this.held = []; this.heldChars = 0 }
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
    if (!this.held) { this.keep(content); return }
    const before = this.heldChars
    this.held.push(content); this.heldChars += content.length
    // The opening is read whole once there is enough of it, so a `data:` URL split between pieces is still known.
    if (this.heldChars < OPENING_CHARS || (before < OPENING_CHARS ? PICTURE.test(this.held.join('')) : BASE64.test(content))) return
    const text = this.held.join('')
    this.held = undefined; this.heldChars = 0; this.keep(text)
  }

  private endString(): void {
    if (this.held && this.heldChars <= PICTURE_CHARS) this.keep(this.held.join(''))
    this.held = undefined; this.heldChars = 0
    this.keep('"'); this.inString = false
  }

  private keep(text: string): void {
    if (!text) return
    this.parts.push(text); this.bytes += Buffer.byteLength(text)
    if (this.head.length < HEAD_CHARS) this.head += text.slice(0, HEAD_CHARS - this.head.length)
  }
}
