import { clamp, rampGlyph } from './nightScene'

/**
 * Line art for Watcher's living night scene (ADR-0199, Zach's pick "Line art + depth" on November 10, 2026, of the
 * prototype kept at the tag `prototype/watcher-scene-life`): which character a glyph cell becomes when it is drawn by
 * the shape inside it rather than by how dense it is. The painter draws the landscape and Watcher's owl on a finer
 * field, sixty pixels to a cell, and asks here for each cell's character. Nothing here touches the DOM or a canvas.
 */

/** Field pixels per glyph cell on the line art's fields: 6 across and 10 down. */
export const LINE_PX = { w: 6, h: 10 } as const
/** Field pixels in one cell. */
export const CELL_PX = LINE_PX.w * LINE_PX.h

/**
 * In place of a character's code: a flat line lying in the top quarter of its cell. No character sits there, so the
 * painter draws it as the underline of the cell above when that cell is free, and leaves it out when it is not.
 */
export const RAISED = 1

/** What a cell is drawn as: a character's code, 0 for nothing or RAISED, and how strong its ink is, 0 to 1. */
export interface GlyphPick { code: number; strength: number }

/** The least a cell's strongest pixel must be, of 255, for the cell to count as holding a line. */
const LINE_INK = 46
/** A shape covering more of its cell than this is a fill, and less than the second is a speck. */
const FILL_COVER = 0.6, SPECK_COVER = 0.06
/** How much longer than wide the ink must lie, 0 to 1, to be a line rather than a blob, a fork or a corner. */
const LINE_STRETCH = 0.56
/** Under this many degrees from level a line is flat, and over the second it is upright; between them it slants. */
const FLAT = 22.5, UPRIGHT = 67.5
/** An upright line shorter than this share of the cell is a stub. */
const STUB = 0.6

/**
 * The character for one cell from its sixty field pixels at `at` in `px`, each a coverage from 0 to 255. A cell that is
 * mostly covered, or holds a blob, a fork or a corner, takes the density ramp exactly as it always has. With `lines`, a
 * cell that holds a line, or the edge of something filled, takes the line's own character: `_` or `-` for one lying
 * flat, by how high it lies, `/` and `\` for a slanted one, `|` for an upright one, and `'` or `,` for a short thin
 * upright stub. A band too thick to be a line, about half its cell, is a fill. A line is drawn in ink as strong as the
 * line itself, not as faint as the cell's average.
 *
 * Where the ink lies and which way it runs are measured in shares of the cell, so a cell covered all over runs no way
 * at all, a line from corner to corner runs at 45 degrees as `/` and `\` do, and the cell being taller than wide makes
 * nothing look upright. `noise` is the cell's own, from 0 to 1, and varies a fill's ramp step as the painter always has.
 */
export function pickGlyph(px: Uint8ClampedArray, at: number, lines: boolean, noise: number, out: GlyphPick): GlyphPick {
  let sum = 0, most = 0
  for (let k = 0; k < CELL_PX; k++) { const v = px[at + k]!; sum += v; if (v > most) most = v }
  const mean = sum / (CELL_PX * 255)
  out.code = 0; out.strength = 0
  if (lines && most >= LINE_INK) {
    const cover = sum / (CELL_PX * most)
    if (cover <= FILL_COVER && cover >= SPECK_COVER && line(px, at, sum, out)) { out.strength = Math.min(1, 0.16 + 0.62 * most / 255); return out }
  }
  if (mean < 0.1) return out
  const density = clamp(mean + (noise - 0.5) * 0.1, 0, 1)
  out.code = rampGlyph(density).charCodeAt(0); out.strength = 0.1 + 0.5 * density
  return out
}

/** Sets `out.code` to the line's character and returns true, or returns false when the cell's ink is not a line. */
function line(px: Uint8ClampedArray, at: number, sum: number, out: GlyphPick): boolean {
  const { w, h } = LINE_PX
  let mx = 0, my = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = px[at + y * w + x]!; mx += v * (x + 0.5) / w; my += v * (y + 0.5) / h }
  mx /= sum; my /= sum
  let sxx = 0, syy = 0, sxy = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = px[at + y * w + x]!, dx = (x + 0.5) / w - mx, dy = (y + 0.5) / h - my
    sxx += v * dx * dx; syy += v * dy * dy; sxy += v * dx * dy
  }
  sxx /= sum; syy /= sum; sxy /= sum
  // The ink's spread along the way it runs and across it: the two axes of the ellipse that fits it.
  const spread = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy), along = (sxx + syy + spread) / 2, across = (sxx + syy - spread) / 2
  if (along <= 0 || (along - across) / (along + across) < LINE_STRETCH) return false
  const degrees = 0.5 * Math.atan2(2 * sxy, sxx - syy) * 180 / Math.PI
  if (Math.abs(degrees) < FLAT) out.code = my < 0.25 ? RAISED : my < 0.7 ? 45 : 95
  else if (Math.abs(degrees) < UPRIGHT) out.code = degrees > 0 ? 92 : 47
  // A stub's length as a share of the cell: a line l long spreads l squared over 12.
  else out.code = Math.sqrt(along * 12) >= STUB ? 124 : my < 0.4 ? 39 : my > 0.62 ? 44 : 124
  return true
}

/**
 * Settles every RAISED cell of a grid `cols` wide: its line becomes the underline of the cell above when that cell is
 * free, taking the line's ink, and the cell itself is left empty either way. Under a cell already drawn, a line along
 * the top is the foot of something thicker and is left out.
 */
export function settleRaised(glyphs: Uint16Array, strengths: Float32Array, cols: number): void {
  for (let i = 0; i < glyphs.length; i++) {
    if (glyphs[i] !== RAISED) continue
    const above = i - cols
    if (above >= 0 && glyphs[above] === 0) { glyphs[above] = 95; strengths[above] = strengths[i]! }
    glyphs[i] = 0; strengths[i] = 0
  }
}
