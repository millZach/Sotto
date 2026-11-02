import type { CouncilLayout } from '../../../../shared/council'

/**
 * Where everyone sits in the Council's chamber (ADR-0177 decision 6, `docs/prototypes/council-chamber-prototype.html`):
 * each figure's place and size for a layout, a chamber size and a panel of two to five, in the chamber's pixels. Panelists
 * come in letter order; the chair is apart. Pure, so every layout and panel size can be checked without a canvas.
 */

export interface ChamberPoint { readonly x: number; readonly y: number }
export type BubbleSide = 'up' | 'down' | 'left' | 'right'

export interface ChamberFigure {
  /** The seat: a panelist's letter, or `chair`. */
  readonly key: string
  /** Where its seat meets the table, and its size: 1 is a figure about 92 by 118 pixels. */
  readonly x: number
  readonly y: number
  readonly s: number
  readonly chair: boolean
  /** Seen from behind, on the round table's near side. */
  readonly back: boolean
  /** Its depth on the half circle, 1 at the back, drawn first. */
  readonly depth: number
  /** Its angle round the round table. */
  readonly angle: number
  /** Which way it turns its head at rest, toward the middle. */
  readonly turn: number
  /** Where its answer's scroll lies, and where a scroll lands for it. */
  readonly desk: ChamberPoint
  /** Its name plate's centre. */
  readonly plate: ChamberPoint
  /** Where its bubble's tail points, and which side the bubble opens to. */
  readonly bubble: ChamberPoint & { readonly side: BubbleSide }
  /** Its bubble's widest, in glyph cells. */
  readonly maxCols: number
}

interface Common { readonly width: number; readonly height: number; readonly panelists: readonly ChamberFigure[]; readonly chair: ChamberFigure; readonly s: number }
export type ChamberGeometry =
  | Common & { readonly layout: 'long-table'; readonly tableY: number; readonly faceH: number; readonly spacing: number; readonly half: number }
  | Common & { readonly layout: 'half-circle' | 'round-table'; readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number }

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const LETTERS = 'ABCDE'

function figure(key: string, x: number, y: number, s: number, rest: Partial<ChamberFigure> & Pick<ChamberFigure, 'desk' | 'plate' | 'bubble' | 'maxCols'>): ChamberFigure {
  return { key, x, y, s, chair: key === 'chair', back: false, depth: 0, angle: 0, turn: 0, ...rest }
}

/** The chamber laid out for `count` panelists in a `width` by `height` room, in pixels. */
export function chamberLayout(layout: CouncilLayout, width: number, height: number, count: number): ChamberGeometry {
  const W = width, H = height, N = count
  const letter = (index: number): string => LETTERS[index] ?? String(index + 1)
  if (layout === 'half-circle') {
    // An exedra: tiered marble seats on a half circle round an altar, the chair at its back.
    const cx = W / 2, cy = H * 0.9, rx = W * 0.41, ry = H * 0.52, s = clamp(Math.min(H / 245, W / (N + 1) / 98), 0.5, 2.2)
    const at = (th: number): { x: number; y: number; depth: number } => ({ x: cx + Math.cos(th) * rx, y: cy + Math.sin(th) * ry, depth: -Math.sin(th) })
    const half = Math.ceil(N / 2), step = 1.05 / half
    const panelists = Array.from({ length: N }, (_, i) => {
      const side = i % 2 === 0 ? -1 : 1, k = Math.floor(i / 2) + 1, th = Math.PI * 1.5 + side * k * step
      const q = at(th), ss = s * (1.05 - 0.35 * q.depth)
      return figure(letter(i), q.x, q.y, ss, { depth: q.depth, turn: -Math.cos(th) * 0.7, desk: { x: q.x, y: q.y + 4 }, plate: { x: q.x, y: q.y + 26 * ss },
        bubble: { x: q.x, y: q.y - 116 * ss, side: 'up' }, maxCols: 28 })
    })
    const q = at(Math.PI * 1.5), cs = s * 0.92
    const chair = figure('chair', q.x, q.y, cs, { depth: 1, desk: { x: q.x, y: q.y + 4 }, plate: { x: q.x, y: q.y + 26 * cs }, bubble: { x: q.x, y: q.y - 156 * cs, side: 'up' }, maxCols: 32 })
    return { layout, width: W, height: H, panelists, chair, s, cx, cy, rx, ry }
  }
  if (layout === 'round-table') {
    // A round table seen from a little above: backs toward the user on the near side, the chair raised at the far side.
    // The table is held small enough in a short room that the raised chair's head stays in it.
    const cx = W / 2, cy = H * 0.6, rx = Math.min(W * 0.3, H * 0.52 - 4), ry = rx * 0.36, s = clamp(rx / 175, 0.5, 1.8)
    const seat = (key: string, angle: number): ChamberFigure => {
      // Everyone on the near half sits with their back to the user, in front of the table, so the table never hides them.
      const chair = key === 'chair', sn = Math.sin(angle), cs = Math.cos(angle), back = sn > 0.2
      const ss = s * (chair ? 1.16 : 1) * (0.9 + 0.16 * (sn + 1) / 2)
      const x = cx + cs * (rx + (back ? 0 : 6 * ss)), y = cy + sn * ry + (back ? 66 * ss : chair ? -16 * ss : 6 * ss)
      return figure(key, x, y, ss, { back, angle, turn: back ? 0 : -cs * 0.85, desk: { x: cx + cs * rx * 0.66, y: cy + sn * ry * 0.66 },
        plate: { x, y: back ? y + 14 * ss : chair ? y - 150 * ss : y + 20 * ss },
        bubble: chair ? { x: x + 70 * ss, y: y - 120 * ss, side: 'right' } : { x, y: y - (back ? 104 : 112) * ss, side: 'up' }, maxCols: 28 })
    }
    const panelists = Array.from({ length: N }, (_, i) => seat(letter(i), -Math.PI / 2 + (i + 1) * Math.PI * 2 / (N + 1)))
    return { layout, width: W, height: H, panelists, chair: seat('chair', -Math.PI / 2), s, cx, cy, rx, ry }
  }
  // The long table: the panelists in a row behind it, the chair raised at its centre.
  const tableY = H * 0.66, faceH = Math.max(40, H * 0.17)
  const half = Math.ceil(N / 2), slots = 2 * half + 1
  const spacing = Math.min(W * 0.9 / slots, 260)
  const s = clamp(Math.min(H * 0.67 / 132, spacing / 100), 0.5, 2.1)
  const plateY = tableY + 40 + (faceH - 40) * 0.25
  const maxCols = Math.max(18, Math.floor(spacing / 7) + 2)
  const panelists = Array.from({ length: N }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1, k = Math.floor(i / 2) + 1, x = W / 2 + side * k * spacing
    return figure(letter(i), x, tableY + 6, s, { desk: { x, y: tableY + 4 }, plate: { x, y: plateY }, bubble: { x, y: tableY - 112 * s, side: 'up' }, maxCols })
  })
  const cs = s * 1.16
  const chair = figure('chair', W / 2, tableY + 6, cs, { desk: { x: W / 2, y: tableY + 4 }, plate: { x: W / 2, y: plateY }, bubble: { x: W / 2, y: tableY - 150 * cs, side: 'up' }, maxCols: 32 })
  return { layout: 'long-table', width: W, height: H, panelists, chair, s, tableY, faceH, spacing, half }
}

/** The box a figure's button covers, in the chamber's pixels: its head, shoulders and hands. */
export function figureBox(figure: ChamberFigure): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const w = 92 * figure.s, h = 118 * figure.s
  return { x: figure.x - w / 2, y: figure.y - 58 * figure.s - h / 2, w, h }
}
