/**
 * The water under the room that a press disturbs (the click effect, Zach's pick N on October 27, 2026, of
 * `docs/prototypes/click-binary-prototype.html`): a 2D wave simulation on a grid of CELL pixels. A press throws a
 * handful of drops around the pointer; their waves run out at a speed that varies across the room, so the fronts bend and
 * break up rather than spreading as rings, bounce off the window's edges, cross each other and fade over about LIFE_S
 * seconds; the last speckles go within about ten. Drawing reads the height of the water under each glyph cell: a 0 or a 1 in the accent shows only where
 * the water is high or low enough, each cell at its own threshold, so the edges are speckled.
 *
 * Nothing here touches the DOM, so the stepping and the drawing can be tested without a window.
 */

/** The simulation's cell, in CSS pixels. */
export const CELL = 8
/** The glyph grid the 0s and 1s sit on, as dense as a line of monospace text. */
export const GLYPH_W = 7
export const GLYPH_H = 13
/** Every LIFE_S seconds the water keeps a fiftieth of its energy, so a press's waves fade over about that long. */
export const LIFE_S = 4
/** Steps a second; the drawing loop runs as many as are due each frame, so the waves keep their speed at any refresh rate. */
export const STEP_HZ = 60
/** The strongest a glyph is drawn. */
export const GLYPH_ALPHA = 0.65
/** The height a glyph needs before it shows, and the spread it reaches full strength over. */
const SHOW_AT = 0.14
const SHOW_OVER = 0.4
/** How far each glyph's own threshold strays from SHOW_AT, as a share of it. */
const RAGGED = 0.85
/** Below the height the faintest glyph needs, everywhere, the water is calm: nothing would show, so the loop stops. */
export const CALM = SHOW_AT * (1 - RAGGED)
/** What each step keeps of the water's energy; its height keeps the square root of this. */
const DAMPING = Math.pow(0.02, 1 / (LIFE_S * STEP_HZ))

type Random = () => number

/** Smooth noise in 0..1 over the grid, two octaves, so the water is faster in some places than others. */
function speedField(cols: number, rows: number, random: Random): Float32Array {
  const octaves = ([[9, 1], [4, 0.5]] as const).map(([size, weight]) => {
    const across = Math.ceil(cols / size) + 2, down = Math.ceil(rows / size) + 2
    return { size, weight, across, values: Float32Array.from({ length: across * down }, () => random()) }
  })
  const field = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let n = 0
      for (const { size, weight, across, values } of octaves) {
        const fx = x / size, fy = y / size, ix = Math.floor(fx), iy = Math.floor(fy)
        const sx = (fx - ix) ** 2 * (3 - 2 * (fx - ix)), sy = (fy - iy) ** 2 * (3 - 2 * (fy - iy))
        const at = (a: number, b: number): number => values[b * across + a]!
        n += weight * ((at(ix, iy) * (1 - sx) + at(ix + 1, iy) * sx) * (1 - sy) + (at(ix, iy + 1) * (1 - sx) + at(ix + 1, iy + 1) * sx) * sy)
      }
      field[y * cols + x] = n / 1.5
    }
  }
  return field
}

export class ClickWater {
  readonly cols: number
  readonly rows: number
  /** The highest the water stands anywhere after the last step or drop. */
  peak = 0
  private prev: Float32Array
  private cur: Float32Array
  private next: Float32Array
  /** How fast the water carries a wave in each cell: 0.06 to 0.48 of the grid's limit. */
  private readonly reach: Float32Array
  /** The highest the water stands in each row, so drawing skips the rows it would draw nothing in. */
  private readonly rowPeak: Float32Array
  /** Each glyph's digit, and how far its threshold strays (-1..1). */
  private readonly bits: Uint8Array
  private readonly ragged: Float32Array
  private readonly glyphCols: number

  constructor(readonly width: number, readonly height: number, private readonly random: Random = Math.random) {
    // A border cell on every side stays still, so waves reflect off the window's edges.
    this.cols = Math.ceil(width / CELL) + 2
    this.rows = Math.ceil(height / CELL) + 2
    const cells = this.cols * this.rows
    this.prev = new Float32Array(cells)
    this.cur = new Float32Array(cells)
    this.next = new Float32Array(cells)
    this.reach = speedField(this.cols, this.rows, random).map(n => 0.06 + 0.42 * n)
    this.rowPeak = new Float32Array(this.rows)
    this.glyphCols = Math.ceil(width / GLYPH_W)
    const glyphs = this.glyphCols * Math.ceil(height / GLYPH_H)
    this.bits = Uint8Array.from({ length: glyphs }, () => (random() < 0.5 ? 1 : 0))
    this.ragged = Float32Array.from({ length: glyphs }, () => random() * 2 - 1)
  }

  /** The water's height at a point in the room, in CSS pixels. */
  heightAt(x: number, y: number): number {
    return this.cur[this.index(x, y)]!
  }

  get calm(): boolean {
    return this.peak < CALM
  }

  /** A press at (x, y): a drop under the pointer and a handful around it, each its own size, strength and sign. */
  press(x: number, y: number): void {
    this.drop(x, y, 0.8, 5, 6)
    for (let n = 0; n < 6; n++) {
      const angle = this.random() * Math.PI * 2, distance = 12 + this.random() * 46
      const strength = (0.35 + this.random() * 0.6) * (this.random() < 0.5 ? 1 : -1)
      this.drop(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance, strength, 4, 2 + this.random() * 6)
    }
  }

  /** One step of the waves. */
  step(): void {
    const { cols, rows, prev, cur, next, reach, rowPeak } = this
    let top = 0
    for (let y = 1; y < rows - 1; y++) {
      let rowTop = 0
      for (let x = 1, i = y * cols + 1; x < cols - 1; x++, i++) {
        const c = cur[i]!
        const v = (2 * c - prev[i]! + reach[i]! * (cur[i - 1]! + cur[i + 1]! + cur[i - cols]! + cur[i + cols]! - 4 * c)) * DAMPING
        next[i] = v
        const a = v < 0 ? -v : v
        if (a > rowTop) rowTop = a
      }
      rowPeak[y] = rowTop
      if (rowTop > top) top = rowTop
    }
    this.prev = cur
    this.cur = next
    this.next = prev
    this.peak = top
  }

  /**
   * The water `steps` steps older without moving it: it fades as far as those steps would have damped it. A frame that
   * comes late runs only a few steps and ages the water by the rest, so a press dies away in the same time on a window
   * the system draws slowly.
   */
  age(steps: number): void {
    if (steps <= 0) return
    // The step's recurrence keeps the square root of DAMPING of the height each step, so ageing does the same.
    const keep = DAMPING ** (steps / 2)
    for (const field of [this.prev, this.cur]) for (let i = 0; i < field.length; i++) field[i]! *= keep
    for (let row = 0; row < this.rows; row++) this.rowPeak[row]! *= keep
    this.peak *= keep
  }

  /** Stills the water at once. */
  clear(): void {
    this.prev.fill(0)
    this.cur.fill(0)
    this.rowPeak.fill(0)
    this.peak = 0
  }

  /**
   * Stamps a glyph wherever the water shows one: `glyph(digit, x, y, alpha)` with x and y the glyph's centre, nudged
   * along the water's slope so the 0s and 1s lean into a passing crest. A 0 on a crest is a 1 in a trough, so the digits
   * flip as the water passes. Returns how many glyphs it stamped.
   */
  draw(glyph: (digit: 0 | 1, x: number, y: number, alpha: number) => void): number {
    const { cols, cur, rowPeak, bits, ragged, glyphCols } = this
    let stamped = 0
    for (let gy = 0, k = 0; gy * GLYPH_H < this.height; gy++, k = gy * glyphCols) {
      const py = gy * GLYPH_H + GLYPH_H / 2
      const row = Math.min(this.rows - 2, Math.floor(py / CELL) + 1)
      if (rowPeak[row]! < CALM) continue
      for (let gx = 0; gx < glyphCols; gx++, k++) {
        const px = gx * GLYPH_W + GLYPH_W / 2
        const i = row * cols + Math.min(cols - 2, Math.floor(px / CELL) + 1)
        const h = cur[i]!
        const lift = ((h < 0 ? -h : h) - SHOW_AT * (1 + RAGGED * ragged[k]!)) / SHOW_OVER
        if (lift <= 0) continue
        const alpha = Math.min(1, lift) ** 1.3 * GLYPH_ALPHA
        const dx = Math.max(-5, Math.min(5, (cur[i + 1]! - cur[i - 1]!) * 6))
        const dy = Math.max(-5, Math.min(5, (cur[i + cols]! - cur[i - cols]!) * 6))
        glyph((bits[k]! ^ (h > 0 ? 1 : 0)) as 0 | 1, px + dx, py + dy, alpha)
        stamped++
      }
    }
    return stamped
  }

  private index(x: number, y: number): number {
    const col = Math.max(1, Math.min(this.cols - 2, Math.floor(x / CELL) + 1))
    const row = Math.max(1, Math.min(this.rows - 2, Math.floor(y / CELL) + 1))
    return row * this.cols + col
  }

  private drop(x: number, y: number, strength: number, radius: number, spread: number): void {
    const cx = x / CELL + 1, cy = y / CELL + 1
    for (let row = Math.max(1, Math.floor(cy - radius)); row <= Math.min(this.rows - 2, Math.ceil(cy + radius)); row++) {
      for (let col = Math.max(1, Math.floor(cx - radius)); col <= Math.min(this.cols - 2, Math.ceil(cx + radius)); col++) {
        this.cur[row * this.cols + col]! += 4 * strength * Math.exp(-((col - cx) ** 2 + (row - cy) ** 2) / spread)
      }
    }
    this.peak = Math.max(this.peak, 4 * Math.abs(strength))
  }
}
