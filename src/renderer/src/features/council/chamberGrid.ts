import type { BubbleSide } from './chamberLayout'

/**
 * The chamber's crisp glyphs, laid over the drawn shapes: faces, plates, bubbles, letters and the verdict's words. One
 * cell per glyph, held in typed arrays sized once per chamber size and cleared each frame, so a frame allocates nothing
 * that grows. Also where bubbles find room: each takes the first place near its speaker that no plate or other bubble
 * holds.
 */

/** Nothing written in the cell. */
const EMPTY = 0
/** Written blank: the shapes under it are cleared, as inside a bubble. */
export const BLANK = 32

export class GlyphGrid {
  readonly code: Uint16Array
  readonly strength: Float32Array
  readonly accent: Uint8Array
  constructor(readonly cols: number, readonly rows: number) {
    this.code = new Uint16Array(cols * rows)
    this.strength = new Float32Array(cols * rows)
    this.accent = new Uint8Array(cols * rows)
  }
  clear(): void { this.code.fill(EMPTY) }
  put(c: number, r: number, glyph: string, strength = 0.95, accent = false): void {
    c = Math.round(c); r = Math.round(r)
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return
    const k = r * this.cols + c
    this.code[k] = glyph.charCodeAt(0) || BLANK
    this.strength[k] = strength
    this.accent[k] = accent ? 1 : 0
  }
  text(c: number, r: number, words: string, strength?: number, accent?: boolean): void {
    for (let i = 0; i < words.length; i++) this.put(c + i, r, words[i]!, strength, accent)
  }
  centered(cx: number, r: number, words: string, strength?: number, accent?: boolean): void {
    this.text(Math.round(cx - words.length / 2), r, words, strength, accent)
  }
  blank(l: number, t: number, w: number, h: number): void {
    for (let r = t; r < t + h; r++) for (let c = l; c < l + w; c++) this.put(c, r, ' ')
  }
}

/** A box of cells: its left column, top row, width and height. */
export interface CellRect { readonly l: number; readonly t: number; readonly w: number; readonly h: number }

/** Whether two boxes touch, keeping a column clear between them side by side. */
export function overlaps(one: CellRect, other: CellRect): boolean {
  return one.l < other.l + other.w + 1 && one.l + one.w + 1 > other.l && one.t < other.t + other.h && one.t + one.h > other.t
}

/** Words wrapped to `width` columns; a word longer than a line, such as a path, is broken across lines. */
export function wrapWords(words: string, width: number): string[] {
  const out: string[] = []
  const max = Math.max(1, width)
  let line = ''
  for (let word of words.split(' ')) {
    if (!word) continue
    while (word.length > max) {
      const room = line ? max - line.length - 1 : max
      if (room >= 4) { out.push(`${line ? `${line} ` : ''}${word.slice(0, room)}`); word = word.slice(room); line = '' }
      else { if (line) out.push(line); line = ''; out.push(word.slice(0, max)); word = word.slice(max) }
    }
    if (!word) continue
    if ((line ? line.length + 1 : 0) + word.length > max) { if (line) out.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

/** A bubble's words and size: a speech bubble keeps its newest three lines, a thought two, ending in its dots. */
export function bubbleShape(words: string, title: string, say: boolean, maxCols: number, dots: string): { readonly lines: readonly string[]; readonly title: string; readonly w: number; readonly h: number } {
  const cap = Math.max(10, maxCols)
  const name = title.length > cap - 6 ? `${title.slice(0, Math.max(1, cap - 7))}…` : title
  const width = Math.min(cap, Math.max(8, Math.max(words.length, name.length + 2) + 2))
  let lines = wrapWords(words, width - 4)
  if (!say) {
    lines = wrapWords(`${lines.join(' ').slice(0, Math.max(8, width * 2 - 10))} ${dots}`, width - 4)
    if (lines.length > 2) lines = [...lines.slice(0, 1), `${lines[1]!.slice(0, Math.max(1, width - 6))}…`]
  }
  if (lines.length > 3) lines = lines.slice(-3)
  const w = Math.max(name.length + 6, ...lines.map(line => line.length + 4))
  return { lines, title: name, w, h: lines.length + 2 }
}

/**
 * Where a `w` by `h` bubble goes for a speaker whose tail points at cell (c, r): opening to `side`, held inside the grid,
 * and moved to the first nearby place clear of everything in `taken`, or in a crowded room the nearest clear place in
 * the bands of rows round it. With no clear place anywhere it keeps its first.
 */
export function placeBubble(c: number, r: number, w: number, h: number, side: BubbleSide, cols: number, rows: number, taken: readonly CellRect[]): CellRect {
  const fit = (left: number, top: number): { l: number; t: number } => ({
    l: Math.max(0, Math.min(Math.max(1, cols - w - 1), left)), t: Math.max(0, Math.min(Math.max(1, rows - h - 1), top)),
  })
  const start = side === 'up' ? { l: c - Math.floor(w / 2), t: r - h - 1 } : side === 'down' ? { l: c - Math.floor(w / 2), t: r + 2 }
    : side === 'left' ? { l: c - w - 2, t: r - Math.floor(h / 2) } : { l: c + 3, t: r - Math.floor(h / 2) }
  const first = fit(start.l, start.t)
  const tries: readonly (readonly [number, number])[] = [[0, 0], [0, -(h + 1)], [-(Math.ceil(w / 2) + 1), 0], [Math.ceil(w / 2) + 1, 0], [0, h + 1],
    [-(w + 2), -(h + 1)], [w + 2, -(h + 1)], [-(w + 2), 0], [w + 2, 0], [0, -2 * (h + 1)]]
  const clear = (l: number, t: number): boolean => {
    for (const other of taken) if (l < other.l + other.w + 1 && l + w + 1 > other.l && t < other.t + other.h && t + h > other.t) return false
    return true
  }
  for (const [dx, dy] of tries) {
    const at = fit(first.l + dx, first.t + dy)
    if (clear(at.l, at.t)) return { l: at.l, t: at.t, w, h }
  }
  // A crowded room: the clear place nearest the speaker along its own band of rows or the bands above and below.
  let bestL = first.l, bestT = first.t, cost = Number.POSITIVE_INFINITY
  for (const band of [0, -1, 1, -2, 2]) {
    const top = fit(first.l, first.t + band * (h + 1)).t
    for (let left = 0; left + w < cols; left++) {
      const far = Math.abs(left - first.l) + 2 * Math.abs(top - first.t)
      if (far < cost && clear(left, top)) { bestL = left; bestT = top; cost = far }
    }
  }
  return { l: bestL, t: bestT, w, h }
}

/** A bubble written into the grid: a solid line round words said, a dotted one round a thought, its title on its top edge. */
export function drawBubble(grid: GlyphGrid, box: CellRect, shape: { readonly lines: readonly string[]; readonly title: string }, say: boolean, tail: { readonly c: number; readonly r: number }): void {
  const { l, t, w, h } = box
  const edge = say ? 0.75 : 0.42
  const [hz, vt] = say ? ['─', '│'] : ['┄', '┆']
  grid.blank(l, t, w, h)
  for (let c = l + 1; c < l + w - 1; c++) { grid.put(c, t, hz, edge, say); grid.put(c, t + h - 1, hz, edge, say) }
  for (let r = t + 1; r < t + h - 1; r++) { grid.put(l, r, vt, edge, say); grid.put(l + w - 1, r, vt, edge, say) }
  grid.put(l, t, '╭', edge, say); grid.put(l + w - 1, t, '╮', edge, say); grid.put(l, t + h - 1, '╰', edge, say); grid.put(l + w - 1, t + h - 1, '╯', edge, say)
  shape.lines.forEach((line, i) => grid.text(l + 2, t + 1 + i, line, say ? 0.98 : 0.7))
  if (shape.title) grid.text(l + 2, t, ` ${shape.title} `, say ? 0.95 : 0.6, say)
  const tc = Math.max(l + 1, Math.min(l + w - 2, Math.round(tail.c)))
  const tr = Math.max(t, Math.min(t + h - 1, Math.round(tail.r)))
  // The tail points at the speaker from whichever edge faces it.
  if (t + h <= tail.r) { grid.put(tc, t + h, say ? '╲' : '°', edge, say); if (say) grid.put(tc, t + h - 1, '┬', edge, say) }
  else if (t > tail.r) grid.put(tc, t - 1, say ? '╱' : '°', edge, say)
  else if (l > tail.c) grid.put(l - 1, tr, say ? '─' : '°', edge, say)
  else grid.put(l + w, tr, say ? '─' : '°', edge, say)
}
