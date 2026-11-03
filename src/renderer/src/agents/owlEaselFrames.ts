/**
 * The owl at the easel (ADR-0170): Watcher's owl paints a picture on an easel under the night sky while an agent makes an
 * image. Zach picked it from the prototype (`docs/prototypes/inline-media-prototype.html`, scene 2) on October 31, 2026.
 * A frame is two layers of text the same size: `paint`, the picture as it is painted, in the accent colour, and `sketch`,
 * the easel, the owl, its brush and the stars, in a muted one. Nothing here draws; `OwlEasel` writes the text.
 */
export interface OwlEaselFrame { readonly paint: string; readonly sketch: string }

/** The rows a tile's scene uses: coarser than the prototype's 36, so its characters stay readable at 208x140. */
export const OWL_EASEL_TILE_ROWS = 12
/** Text frames a second while the scene is in view. Twelve is plenty for text. */
export const OWL_EASEL_FPS = 12

/** A character's width, and a line's height, as shares of the font size, for the mono face the scene is set in. */
const CHARACTER_WIDTH = 0.6
const LINE_HEIGHT = 1.15

/** The grid for a box: its rows fill the height with a little air between lines, and as many columns as then fit. */
export function owlEaselGrid(width: number, height: number, rows = OWL_EASEL_TILE_ROWS): { cols: number; rows: number; fontSize: number; lineHeight: number } {
  const lineHeight = height / rows
  const fontSize = lineHeight / LINE_HEIGHT
  return { cols: Math.max(20, Math.floor(width / (fontSize * CHARACTER_WIDTH))), rows, fontSize, lineHeight }
}

const RAMP = ' .:-=+*#%@'
const SEGMENT = 6

/** The painting's brightness at a point of its unit square: a dusk sky, a sun, a lighthouse and the sea below it. */
function light(u: number, v: number): number {
  const horizon = 0.64
  let value: number
  if (v < horizon) {
    value = 0.1 + 0.5 * Math.pow(v / horizon, 2.2)
    const dx = (u - 0.3) * 1.1, dy = v - 0.53
    if (dx * dx + dy * dy < 0.011) value = 0.97
  } else {
    value = 0.14 + 0.08 * Math.sin(u * 34 + v * 70)
    if (Math.abs(u - 0.3) < 0.07 * (1 - (v - horizon) * 2) && Math.sin(v * 140) > 0.1) value = 0.78
  }
  const bx = 0.72 - u, by = v - 0.27
  if (bx > 0 && Math.abs(by) < bx * 0.2 && v < horizon) value = Math.max(value, 0.5)
  if (v > 0.3 && v < 0.68) { const half = 0.024 + 0.034 * (v - 0.3) / 0.38; if (Math.abs(u - 0.72) < half) value = Math.floor((v - 0.3) / 0.075) % 2 ? 0.45 : 0.92 }
  if (v > 0.23 && v <= 0.3 && Math.abs(u - 0.72) < 0.032) value = 1
  if (v > 0.19 && v <= 0.23 && Math.abs(u - 0.72) < 0.03 - (0.23 - v)) value = 0.55
  if (v > 0.63 && v < 0.74 && u > 0.56 && u < 0.9 && v > 0.66 - 0.05 * Math.cos((u - 0.73) * 9)) value = 0.3
  return Math.max(0, Math.min(0.999, value))
}

function hash(x: number, y: number, seed = 1): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return n - Math.floor(n)
}

function grid(cols: number, rows: number, cell: (x: number, y: number) => string): string {
  const lines: string[] = []
  for (let y = 0; y < rows; y++) { let line = ''; for (let x = 0; x < cols; x++) line += cell(x, y); lines.push(line) }
  return lines.join('\n')
}

/** The order the owl lays its strokes for one canvas size, top to bottom with a little wander. Worked out once per size. */
const strokeOrders = new Map<string, readonly (readonly [number, number])[]>()
function strokeOrder(width: number, height: number): readonly (readonly [number, number])[] {
  const key = `${width}x${height}`
  const known = strokeOrders.get(key)
  if (known) return known
  const strokes: [number, number][] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x += SEGMENT) strokes.push([y, x])
  strokes.sort((a, b) => a[0] + hash(a[1], a[0]) * 6 - (b[0] + hash(b[1], b[0]) * 6))
  if (strokeOrders.size > 8) strokeOrders.clear()
  strokeOrders.set(key, strokes)
  return strokes
}

/**
 * How far along the painting is, `seconds` after the step started. No provider says how far an image has got, so it
 * slows as it goes and never finishes on its own: the picture arriving ends it.
 */
export function owlEaselProgress(seconds: number, expectedSeconds = 30): number {
  return Math.min(0.97, 1 - Math.exp(-Math.max(0, seconds) / (expectedSeconds / 3.2)))
}

/** One frame of the scene, `cols` by `rows` characters, `progress` of the way painted, `seconds` into it. */
export function owlEaselFrame(cols: number, rows: number, progress: number, seconds: number): OwlEaselFrame {
  const fx0 = Math.round(cols * 0.4), fx1 = cols - 2, fy0 = 1, fy1 = rows - 5
  const width = Math.max(1, fx1 - fx0 - 1), height = Math.max(1, fy1 - fy0 - 1)
  const strokes = strokeOrder(width, height)
  const done = Math.floor(Math.max(0, Math.min(1, progress)) * strokes.length)
  const painted = new Set<number>()
  for (let index = 0; index < done; index++) painted.add(strokes[index]![0] * 1000 + strokes[index]![1])
  const last = strokes[Math.max(0, done - 1)] ?? [0, 0]
  const owlRow = rows - 5, ox = 1
  // It blinks at the end of each 3.4 seconds, so the still frame reduced motion holds has its eyes open.
  const blink = seconds % 3.4 > 3.25
  const arm = Math.floor(seconds * 4) % 2 === 1
  const owl = [' ,___,', blink ? ' (-v-)' : ' (OvO)', arm ? ' (/ \\)_/' : ' (/ \\)-~', '  ^ ^']
  const paint = grid(cols, rows, (x, y) => {
    if (x <= fx0 || x >= fx1 || y <= fy0 || y >= fy1) return ' '
    const ix = x - fx0 - 1, iy = y - fy0 - 1
    return painted.has(iy * 1000 + Math.floor(ix / SEGMENT) * SEGMENT) ? RAMP[Math.floor(light(ix / width, iy / height) * 10)]! : ' '
  })
  const brushY = fy0 + 1 + last[0], brushX = fx0 + 1 + last[1] + Math.floor(seconds * 8 % SEGMENT)
  const sketch = grid(cols, rows, (x, y) => {
    if (y === brushY && x === brushX) return '/'
    if ((x === fx0 || x === fx1) && y >= fy0 && y <= fy1) return y === fy0 || y === fy1 ? '+' : '|'
    if ((y === fy0 || y === fy1) && x > fx0 && x < fx1) return '-'
    const leg = y - fy1
    if (leg > 0 && y < rows - 1) { if (x === fx0 + 2 - leg) return '/'; if (x === fx1 - 2 + leg) return '\\'; if (x === Math.round((fx0 + fx1) / 2)) return '|' }
    if (y === rows - 1) return '_'
    const oy = y - owlRow
    if (oy >= 0 && oy < owl.length && x >= ox && x - ox < owl[oy]!.length) return owl[oy]![x - ox]!
    if (y < owlRow - 1 && x < fx0 - 1) { const h = hash(x, y); if (h > 0.95) return Math.sin(seconds * 2 + h * 40) > 0.3 ? '*' : '.'; if (h > 0.92) return '.' }
    return ' '
  })
  return { paint, sketch }
}
