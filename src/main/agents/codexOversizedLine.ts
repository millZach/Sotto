/** A string longer than this that is only base64, or a base64 `data:` URL, is a picture's bytes. */
export const PICTURE_CHARS = 16 * 1024
const PICTURE = /^(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/]*={0,2}$/u
const QUOTE_OR_ESCAPE = /["\\]/gu
const HEAD_CHARS = 64

/**
 * A line from a Codex app-server longer than one frame may hold, read on without the pictures in it. Codex 0.166.0
 * keeps each generated picture's bytes in its `imageGeneration` item, and a whole `thread/read` hands every one of
 * them back in its one line: 341 MB for a thread that had made 106 paintings. Each JSON string here longer than
 * `PICTURE_CHARS` that is only base64 is kept as an empty string. Sotto reads such a picture from the file Codex saved
 * it to, and a record that holds it already keeps its own (`codexActivity.ts`), so a whole read loses nothing it shows.
 * Everything else is kept as it came, and counted as it is kept, so the caller can tell a line that is still too long.
 */
export class OversizedLine {
  /** UTF-8 bytes kept so far. */
  bytes = 0
  /** The line's first characters, enough to say which request it answers. */
  head = ''
  private readonly parts: string[] = []
  private inString = false
  private escaped = false
  /** What the open string holds while it may still be a picture, then whether it is kept or dropped. */
  private held: string[] | 'kept' | 'dropped' = 'kept'
  private heldChars = 0

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
    if (!content || this.held === 'dropped') return
    if (this.held === 'kept') { this.keep(content); return }
    this.held.push(content); this.heldChars += content.length
    if (this.heldChars <= PICTURE_CHARS) return
    const text = this.held.join('')
    if (PICTURE.test(text)) this.held = 'dropped'
    else { this.held = 'kept'; this.keep(text) }
  }

  private endString(): void {
    if (Array.isArray(this.held)) this.keep(this.held.join(''))
    this.keep('"'); this.inString = false; this.held = 'kept'
  }

  private keep(text: string): void {
    if (!text) return
    this.parts.push(text); this.bytes += Buffer.byteLength(text)
    if (this.head.length < HEAD_CHARS) this.head += text.slice(0, HEAD_CHARS - this.head.length)
  }
}
