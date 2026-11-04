/**
 * Marks over a picture (ADR-0170, part 5): arrows, circles, boxes, pen lines and notes, in the picture's own pixels, and
 * the marked copy they make. The editor draws them as SVG over the picture; the copy draws the same shapes on a canvas
 * at the picture's full size, so what goes into the reply is what the user saw.
 */

import { THEME_TOKEN_PROBE_ATTRIBUTE } from '../state/appearance'
import { contrastRatio, THEME_BLACK_FOREGROUND, THEME_WHITE_FOREGROUND, type ThemeRgb } from '../../../shared/themes/color'

export type MarkTool = 'arrow' | 'ellipse' | 'box' | 'pen' | 'note'
export type MarkInk = 'red' | 'amber' | 'plain'
/** What the editor's row of tools picks: a mark to draw, or Move, which picks marks up and never draws. */
export type EditorTool = MarkTool | 'move'

interface ShapeBase { readonly id: number; readonly ink: MarkInk }
/** Arrow, circle and box: from where the drag began to where it ended. */
export interface DragShape extends ShapeBase { readonly tool: 'arrow' | 'ellipse' | 'box'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** A pen line: each point with the pen's pressure, which widens the line only when a pen drew it. */
export interface PenShape extends ShapeBase { readonly tool: 'pen'; readonly points: readonly (readonly [number, number, number])[]; readonly pressure: boolean }
/**
 * A note: its words in its ink with a thin edge, their left middle where the user pressed, at a share of the picture's
 * usual text size. `on` is the mark it sits on, whose moves it follows, or null when it is free.
 */
export interface NoteShape extends ShapeBase { readonly tool: 'note'; readonly x0: number; readonly y0: number; readonly text: string; readonly scale: number; readonly on: number | null }
export type MarkupShape = DragShape | PenShape | NoteShape

/** The tools in the order the editor shows them, with the letter that picks each. */
export const MARKUP_TOOLS: readonly { readonly tool: EditorTool; readonly key: string }[] = [
  { tool: 'move', key: 'v' }, { tool: 'arrow', key: 'a' }, { tool: 'ellipse', key: 'o' }, { tool: 'box', key: 'b' }, { tool: 'pen', key: 'p' }, { tool: 'note', key: 't' },
]
export const MARKUP_INKS: readonly MarkInk[] = ['red', 'amber', 'plain']
/** The longest note, in characters. */
export const NOTE_MAX_LENGTH = 120
/** The sizes A− and A+ step through, as shares of the picture's usual text size. */
export const NOTE_SCALES: readonly number[] = [0.7, 1, 1.4, 1.9, 2.6]

/** Counts the redraws of marks already made, which `markupEditor.perf.test.tsx` holds at none while a line is drawn. */
export const markRedraws = { count: 0 }

/** The picture's own size. */
export interface MarkupSize { readonly width: number; readonly height: number }

/** How wide a line is on this picture: the same share of its longer side at any size. */
export function strokeWidth(size: MarkupSize): number { return Math.max(size.width, size.height) / 200 }

/** The size a note's words are set in on this picture, at `scale` of the usual size. */
export function noteFontSize(size: MarkupSize, scale = 1): number { return Math.max(size.width, size.height) / 48 * scale }

/** The next size up or down from `scale`, staying on the last one at either end. */
export function nextNoteScale(scale: number, by: -1 | 1): number {
  const nearest = NOTE_SCALES.reduce((best, step, index) => Math.abs(step - scale) < Math.abs(NOTE_SCALES[best]! - scale) ? index : best, 0)
  return NOTE_SCALES[Math.max(0, Math.min(NOTE_SCALES.length - 1, nearest + by))]!
}

/** Whether a drag made a mark, rather than a press that slipped: a shape at least an 80th of the picture, a line of three points. */
export function madeMark(mark: MarkupShape, size: MarkupSize): boolean {
  if (mark.tool === 'pen') return mark.points.length > 2
  if (mark.tool === 'note') return mark.text.trim().length > 0
  return Math.hypot(mark.x1 - mark.x0, mark.y1 - mark.y0) > Math.max(size.width, size.height) / 80
}

/** The arrow's shaft end and the three corners of its head. */
export function arrowGeometry(mark: DragShape, size: MarkupSize): { readonly shaft: readonly [number, number]; readonly head: readonly (readonly [number, number])[] } {
  const angle = Math.atan2(mark.y1 - mark.y0, mark.x1 - mark.x0), length = strokeWidth(size) * 6
  const corner = (turn: number): readonly [number, number] => [mark.x1 - length * Math.cos(angle + turn), mark.y1 - length * Math.sin(angle + turn)]
  return { shaft: [mark.x1 - Math.cos(angle) * length * 0.6, mark.y1 - Math.sin(angle) * length * 0.6], head: [[mark.x1, mark.y1], corner(-0.45), corner(0.45)] }
}

/** How wide a pen line is between two points: wider where a pen pressed harder. */
export function penWidth(mark: PenShape, pressure: number, size: MarkupSize): number {
  return strokeWidth(size) * (mark.pressure ? 0.5 + pressure * 1.6 : 1)
}

/** The CSS font a note is set in, at this picture's size. */
export function noteFont(size: MarkupSize, scale = 1): string { return `600 ${noteFontSize(size, scale)}px Figtree, system-ui, sans-serif` }

let measuring: CanvasRenderingContext2D | null | undefined
/** How wide a note's words are set, measured where a canvas is to hand and estimated where it is not. */
export function noteTextWidth(text: string, size: MarkupSize, scale = 1): number {
  if (measuring === undefined) measuring = typeof document === 'undefined' ? null : document.createElement('canvas').getContext?.('2d') ?? null
  if (measuring) { measuring.font = noteFont(size, scale); const width = measuring.measureText(text).width; if (width > 0) return width }
  return noteFontSize(size, scale) * 0.55 * text.length
}

/** Where a note's baseline is, given the middle of its words. */
export function noteBaseline(mark: NoteShape, size: MarkupSize): number { return mark.y0 + noteFontSize(size, mark.scale) * 0.35 }

/** How wide the edge around a note's words is drawn; the words go over it, so half of it shows. */
export function noteEdgeWidth(mark: NoteShape, size: MarkupSize): number { return noteFontSize(size, mark.scale) * 0.1 }

/** A rectangle on the picture, in its pixels. */
export interface MarkBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The rectangle a mark takes up on the picture, not counting the width of its line. */
export function markBounds(mark: MarkupShape, size: MarkupSize): MarkBounds {
  if (mark.tool === 'note') {
    const height = noteFontSize(size, mark.scale) * 1.3
    return { x: mark.x0, y: mark.y0 - height / 2, width: noteTextWidth(mark.text, size, mark.scale), height }
  }
  if (mark.tool === 'pen') {
    const xs = mark.points.map(point => point[0]), ys = mark.points.map(point => point[1])
    const x = Math.min(...xs), y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
  return { x: Math.min(mark.x0, mark.x1), y: Math.min(mark.y0, mark.y1), width: Math.abs(mark.x1 - mark.x0), height: Math.abs(mark.y1 - mark.y0) }
}

function fromSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy
  const along = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0
  return Math.hypot(x - ax - along * dx, y - ay - along * dy)
}
function fromRectangle(x: number, y: number, box: MarkBounds): number {
  return Math.hypot(Math.max(box.x - x, 0, x - box.x - box.width), Math.max(box.y - y, 0, y - box.y - box.height))
}
function within(x: number, y: number, box: MarkBounds): boolean { return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height }

/** How far a place is from what a mark draws: its line, or a note's words. */
function fromMark(mark: MarkupShape, x: number, y: number, size: MarkupSize): number {
  if (mark.tool === 'note') return fromRectangle(x, y, markBounds(mark, size))
  if (mark.tool === 'arrow') return fromSegment(x, y, mark.x0, mark.y0, mark.x1, mark.y1)
  if (mark.tool === 'pen') {
    let nearest = Infinity
    for (let index = 1; index < mark.points.length; index++) {
      const from = mark.points[index - 1]!, to = mark.points[index]!
      nearest = Math.min(nearest, fromSegment(x, y, from[0], from[1], to[0], to[1]))
    }
    return nearest
  }
  const box = markBounds(mark, size)
  if (mark.tool === 'box') return within(x, y, box) ? Math.min(x - box.x, box.x + box.width - x, y - box.y, box.y + box.height - y) : fromRectangle(x, y, box)
  // A circle drawn or resized flat is a line, which is only near the places beside it.
  if (box.width === 0 || box.height === 0) return fromRectangle(x, y, box)
  return Math.abs(acrossEllipse(box, x, y) - 1) * Math.min(box.width, box.height) / 2
}
/** How far across an ellipse a place is: 1 on its line, less inside it. */
function acrossEllipse(box: MarkBounds, x: number, y: number): number {
  return Math.hypot((x - box.x - box.width / 2) / (box.width / 2 || 1), (y - box.y - box.height / 2) / (box.height / 2 || 1))
}
/** Whether a place is inside a box or a circle. */
function insideShape(mark: MarkupShape, x: number, y: number, size: MarkupSize): boolean {
  if (mark.tool !== 'box' && mark.tool !== 'ellipse') return false
  const box = markBounds(mark, size)
  if (mark.tool === 'box') return within(x, y, box)
  return box.width > 0 && box.height > 0 && acrossEllipse(box, x, y) <= 1
}
/** Of the marks around a place, the smallest, so a box inside a box can be reached. */
function smallest(marks: readonly MarkupShape[], size: MarkupSize): MarkupShape | null {
  let best: MarkupShape | null = null, area = Infinity
  for (const mark of marks) {
    const box = markBounds(mark, size), its = box.width * box.height
    if (its < area) { best = mark; area = its }
  }
  return best
}

/**
 * The mark Move picks up at a place: a note's words first, then the newest line within `reach`, then the smallest box or
 * circle the place is inside, so a note or an arrow on a box can still be reached.
 */
export function markAt(marks: readonly MarkupShape[], x: number, y: number, reach: number, size: MarkupSize): MarkupShape | null {
  const newestFirst = [...marks].reverse()
  return newestFirst.find(mark => mark.tool === 'note' && fromMark(mark, x, y, size) <= reach)
    ?? newestFirst.find(mark => mark.tool !== 'note' && fromMark(mark, x, y, size) <= reach)
    ?? smallest(marks.filter(mark => insideShape(mark, x, y, size)), size)
}

/** The mark a note at this place belongs to: the smallest one the place is inside or within `reach` of, and never another note. */
export function markUnder(marks: readonly MarkupShape[], x: number, y: number, reach: number, size: MarkupSize): MarkupShape | null {
  return smallest(marks.filter(mark => mark.tool !== 'note' && (insideShape(mark, x, y, size) || fromMark(mark, x, y, size) <= reach)), size)
}

/** The marks that move together with `id`: a note moves alone, and a shape brings the notes on it. */
export function movingWith(marks: readonly MarkupShape[], id: number): ReadonlySet<number> {
  const lead = marks.find(mark => mark.id === id)
  if (!lead) return new Set()
  if (lead.tool === 'note') return new Set([id])
  return new Set([id, ...marks.filter(mark => mark.tool === 'note' && mark.on === id).map(mark => mark.id)])
}

function shifted(mark: MarkupShape, dx: number, dy: number): MarkupShape {
  if (mark.tool === 'pen') return { ...mark, points: mark.points.map(([x, y, pressure]) => [x + dx, y + dy, pressure] as const) }
  if (mark.tool === 'note') return { ...mark, x0: mark.x0 + dx, y0: mark.y0 + dy }
  return { ...mark, x0: mark.x0 + dx, y0: mark.y0 + dy, x1: mark.x1 + dx, y1: mark.y1 + dy }
}

/**
 * `marks` with `moving` shifted by as much of `dx`, `dy` as keeps them on the picture. Anything wider or taller than the
 * picture keeps its start on it. Marks that stay are the same objects, so nothing redraws them.
 */
export function moveMarks(marks: readonly MarkupShape[], moving: ReadonlySet<number>, dx: number, dy: number, size: MarkupSize): readonly MarkupShape[] {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const mark of marks) {
    if (!moving.has(mark.id)) continue
    const box = markBounds(mark, size)
    left = Math.min(left, box.x); top = Math.min(top, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height)
  }
  const keep = (by: number, low: number, high: number): number => low > high ? low : Math.min(high, Math.max(low, by))
  const x = keep(dx, -left, size.width - right), y = keep(dy, -top, size.height - bottom)
  return marks.map(mark => moving.has(mark.id) ? shifted(mark, x, y) : mark)
}

/**
 * Text on a mark belongs to it and text off every mark is free: `marks` with this note on whatever is under the middle
 * of its words or, failing that, their start, or `marks` itself when that is what it was already on. Placing a note and
 * letting one go both ask this, so a long note placed near a mark's edge doesn't come off it at the next nudge.
 */
export function settleNote(marks: readonly MarkupShape[], id: number, reach: number, size: MarkupSize): readonly MarkupShape[] {
  const note = marks.find(mark => mark.id === id)
  if (note?.tool !== 'note') return marks
  const box = markBounds(note, size)
  const on = (markUnder(marks, box.x + box.width / 2, box.y + box.height / 2, reach, size) ?? markUnder(marks, note.x0, note.y0, reach, size))?.id ?? null
  return on === note.on ? marks : marks.map(mark => mark === note ? { ...note, on } : mark)
}

/** What can be dragged on a selected mark: the two ends of an arrow, the corners of the rest. A note is sized by A− and A+, so it has none. */
export type MarkHandle = 'start' | 'end' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export function markHandles(mark: MarkupShape, size: MarkupSize): readonly { readonly handle: MarkHandle; readonly x: number; readonly y: number }[] {
  if (mark.tool === 'note') return []
  if (mark.tool === 'arrow') return [{ handle: 'start', x: mark.x0, y: mark.y0 }, { handle: 'end', x: mark.x1, y: mark.y1 }]
  const box = markBounds(mark, size), right = box.x + box.width, bottom = box.y + box.height
  return [{ handle: 'top-left', x: box.x, y: box.y }, { handle: 'top-right', x: right, y: box.y }, { handle: 'bottom-left', x: box.x, y: bottom }, { handle: 'bottom-right', x: right, y: bottom }]
}

/**
 * `marks` with `id` resized by dragging `handle` to a place, and each note on it moved to keep its place on the mark and
 * stay on the picture. Null when that would leave the mark smaller than a slip, so the mark can't be lost to a resize.
 */
export function resizeMark(marks: readonly MarkupShape[], id: number, handle: MarkHandle, x: number, y: number, size: MarkupSize): readonly MarkupShape[] | null {
  const mark = marks.find(item => item.id === id)
  if (!mark || mark.tool === 'note') return null
  let next: MarkupShape
  if (mark.tool === 'arrow') {
    next = handle === 'start' ? { ...mark, x0: x, y0: y } : { ...mark, x1: x, y1: y }
  } else {
    const box = markBounds(mark, size)
    const fixedX = handle.endsWith('left') ? box.x + box.width : box.x, fixedY = handle.startsWith('top') ? box.y + box.height : box.y
    if (mark.tool === 'pen') {
      const startX = handle.endsWith('left') ? box.x : box.x + box.width, startY = handle.startsWith('top') ? box.y : box.y + box.height
      const acrossX = (x - fixedX) / (startX - fixedX || 1), acrossY = (y - fixedY) / (startY - fixedY || 1)
      next = { ...mark, points: mark.points.map(([px, py, pressure]) => [fixedX + (px - fixedX) * acrossX, fixedY + (py - fixedY) * acrossY, pressure] as const) }
    } else {
      next = { ...mark, x0: fixedX, y0: fixedY, x1: x, y1: y }
    }
  }
  const after = markBounds(next, size)
  if (Math.hypot(after.width, after.height) <= Math.max(size.width, size.height) / 80) return null
  const before = markBounds(mark, size)
  // On an arrow a note turns and stretches with it, since the arrow's rectangle says little about where along it the note sat.
  const place = mark.tool === 'arrow' && next.tool === 'arrow' ? alongArrow(mark, next)
    : (px: number, py: number): readonly [number, number] => [after.x + (px - before.x) / (before.width || 1) * after.width, after.y + (py - before.y) / (before.height || 1) * after.height]
  let resized: readonly MarkupShape[] = marks.map(item => {
    if (item.id === id) return next
    if (item.tool !== 'note' || item.on !== id) return item
    const [x0, y0] = place(item.x0, item.y0)
    return { ...item, x0, y0 }
  })
  for (const item of resized) if (item.tool === 'note' && item.on === id) resized = moveMarks(resized, new Set([item.id]), 0, 0, size)
  return resized
}
/** Where a place beside an arrow goes as the arrow changes: turned and stretched from one to the other about its start. */
function alongArrow(from: DragShape, to: DragShape): (x: number, y: number) => readonly [number, number] {
  const ux = from.x1 - from.x0, uy = from.y1 - from.y0, vx = to.x1 - to.x0, vy = to.y1 - to.y0, length = ux * ux + uy * uy || 1
  const cos = (ux * vx + uy * vy) / length, sin = (ux * vy - uy * vx) / length
  return (x, y) => {
    const dx = x - from.x0, dy = y - from.y0
    return [to.x0 + dx * cos - dy * sin, to.y0 + dx * sin + dy * cos]
  }
}

/** The colours the inks resolve to in the current theme, and the edge a note's words take in each. */
export interface InkColours { readonly stroke: Readonly<Record<MarkInk, string>>; readonly noteEdge: Readonly<Record<MarkInk, string>> }

const INK_ROLES: Readonly<Record<MarkInk, string>> = { red: '--tt-ink-red', amber: '--tt-ink-amber', plain: '--tt-text' }

let painting: CanvasRenderingContext2D | null | undefined
/** A colour as the bytes a canvas paints it with, whatever space the theme gives it in (OKLCH, a mix), or null without a canvas. */
function painted(colour: string): ThemeRgb | null {
  if (painting === undefined) {
    try { painting = document.createElement('canvas').getContext?.('2d', { willReadFrequently: true }) ?? null } catch { painting = null }
  }
  if (!painting) return null
  painting.clearRect(0, 0, 1, 1)
  painting.fillStyle = colour
  painting.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = painting.getImageData(0, 0, 1, 1).data
  return { r, g, b }
}

/**
 * The edge around a note's words in this ink: black or white, whichever stands further from it. The picture under the
 * words could be anything, so the edge is what keeps them readable; one of the two is always at least 4.5:1 on any ink.
 */
export function noteEdge(ink: ThemeRgb): ThemeRgb {
  return contrastRatio(ink, THEME_WHITE_FOREGROUND) >= contrastRatio(ink, THEME_BLACK_FOREGROUND) ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND
}

/** Reads the inks from the theme where `host` sits: red and amber are the theme's error and warning colours at full strength, and plain is its text. */
export function inkColours(host: Element): InkColours {
  const [red, amber, plain] = themeColours(host, [INK_ROLES.red, INK_ROLES.amber, INK_ROLES.plain]) as [string, string, string]
  const stroke = { red, amber, plain }
  const edge = (ink: string): string => {
    const shade = painted(ink)
    const { r, g, b } = shade ? noteEdge(shade) : THEME_BLACK_FOREGROUND
    return `rgb(${r} ${g} ${b})`
  }
  return { stroke, noteEdge: { red: edge(red), amber: edge(amber), plain: edge(plain) } }
}

/** The colours `roles` resolve to where `host` sits, read through one probe element, in the order asked. */
export function themeColours(host: Element, roles: readonly string[]): string[] {
  const probe = document.createElement('span')
  probe.hidden = true
  // Page observers, the theme inspector's among them, skip probe elements coming and going (ADR-0011).
  probe.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, '')
  host.appendChild(probe)
  const colours = roles.map(role => { probe.style.color = `var(${role})`; return getComputedStyle(probe).color || 'currentcolor' })
  probe.remove()
  return colours
}

/** Whether two readings of the inks are the same, so a root change that moved nothing redraws nothing. */
export function sameInks(a: InkColours | null, b: InkColours): boolean {
  return a !== null && MARKUP_INKS.every(ink => a.stroke[ink] === b.stroke[ink] && a.noteEdge[ink] === b.noteEdge[ink])
}

/** Draws the marks on a canvas the picture's size. */
export function drawMarks(context: CanvasRenderingContext2D, marks: readonly MarkupShape[], size: MarkupSize, colours: InkColours): void {
  const line = strokeWidth(size)
  context.lineCap = 'round'; context.lineJoin = 'round'
  for (const mark of marks) {
    const ink = colours.stroke[mark.ink]
    context.strokeStyle = ink; context.fillStyle = ink; context.lineWidth = line
    if (mark.tool === 'box') {
      context.beginPath()
      context.roundRect(Math.min(mark.x0, mark.x1), Math.min(mark.y0, mark.y1), Math.abs(mark.x1 - mark.x0), Math.abs(mark.y1 - mark.y0), line * 2)
      context.stroke()
    } else if (mark.tool === 'ellipse') {
      context.beginPath()
      context.ellipse((mark.x0 + mark.x1) / 2, (mark.y0 + mark.y1) / 2, Math.abs(mark.x1 - mark.x0) / 2, Math.abs(mark.y1 - mark.y0) / 2, 0, 0, Math.PI * 2)
      context.stroke()
    } else if (mark.tool === 'arrow') {
      const { shaft, head } = arrowGeometry(mark, size)
      context.beginPath(); context.moveTo(mark.x0, mark.y0); context.lineTo(shaft[0], shaft[1]); context.stroke()
      context.beginPath(); context.moveTo(head[0]![0], head[0]![1]); for (const [x, y] of head.slice(1)) context.lineTo(x, y); context.closePath(); context.fill()
    } else if (mark.tool === 'pen') {
      for (let index = 1; index < mark.points.length; index++) {
        const [x0, y0, pressure] = mark.points[index - 1]!, [x1, y1] = mark.points[index]!
        context.lineWidth = penWidth(mark, pressure, size)
        context.beginPath(); context.moveTo(x0, y0); context.lineTo(x1, y1); context.stroke()
      }
    } else if (mark.tool === 'note') {
      context.font = noteFont(size, mark.scale)
      const baseline = noteBaseline(mark, size)
      context.strokeStyle = colours.noteEdge[mark.ink]; context.lineWidth = noteEdgeWidth(mark, size)
      context.strokeText(mark.text, mark.x0, baseline)
      context.fillText(mark.text, mark.x0, baseline)
    }
  }
}

/** The marked copy's name: the picture's own with "marked up" after it, as a PNG. */
export function markedName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/u, '').trim() || 'Picture'
  return `${stem} marked up.png`
}

/**
 * The picture with its marks drawn on it, at the picture's full size, as a PNG file named after it, and `under` drawn
 * beneath the marks. Null when the picture could not be read or drawn.
 */
export async function markedCopy(source: string, name: string, marks: readonly MarkupShape[], colours: InkColours,
  under?: (context: CanvasRenderingContext2D, size: MarkupSize) => void): Promise<File | null> {
  const picture = new Image()
  picture.decoding = 'async'
  picture.src = source
  try { await picture.decode() } catch { return null }
  const size = { width: picture.naturalWidth, height: picture.naturalHeight }
  if (!size.width || !size.height) return null
  const canvas = document.createElement('canvas')
  canvas.width = size.width; canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(picture, 0, 0)
  // What goes under the user's marks: the agent's callouts, when the copy keeps them (ADR-0170, part 6).
  under?.(context, size)
  drawMarks(context, marks, size, colours)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  return blob ? new File([blob], markedName(name), { type: 'image/png' }) : null
}
