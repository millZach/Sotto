/**
 * Marks over a picture (ADR-0170, part 5): arrows, circles, boxes, pen lines and notes, in the picture's own pixels, and
 * the marked copy they make. The editor draws them as SVG over the picture; the copy draws the same shapes on a canvas
 * at the picture's full size, so what goes into the reply is what the user saw.
 */

export type MarkTool = 'arrow' | 'ellipse' | 'box' | 'pen' | 'note'
export type MarkInk = 'red' | 'amber' | 'plain'

interface MarkBase { readonly id: number; readonly ink: MarkInk }
/** Arrow, circle and box: from where the drag began to where it ended. */
export interface ShapeMark extends MarkBase { readonly tool: 'arrow' | 'ellipse' | 'box'; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
/** A pen line: each point with the pen's pressure, which widens the line only when a pen drew it. */
export interface PenMark extends MarkBase { readonly tool: 'pen'; readonly points: readonly (readonly [number, number, number])[]; readonly pressure: boolean }
/** A note: its words on a label of its ink, the label's left middle where the user pressed. */
export interface NoteMark extends MarkBase { readonly tool: 'note'; readonly x0: number; readonly y0: number; readonly text: string }
export type Mark = ShapeMark | PenMark | NoteMark

/** The tools in the order the editor shows them, with the letter that picks each. */
export const MARKUP_TOOLS: readonly { readonly tool: MarkTool; readonly key: string }[] = [
  { tool: 'arrow', key: 'a' }, { tool: 'ellipse', key: 'o' }, { tool: 'box', key: 'b' }, { tool: 'pen', key: 'p' }, { tool: 'note', key: 't' },
]
export const MARKUP_INKS: readonly MarkInk[] = ['red', 'amber', 'plain']
/** The longest note, in characters. */
export const NOTE_MAX_LENGTH = 120

/** Counts the redraws of marks already made, which `markupEditor.perf.test.tsx` holds at none while a line is drawn. */
export const markRedraws = { count: 0 }

/** The picture's own size. */
export interface MarkupSize { readonly width: number; readonly height: number }

/** How wide a line is on this picture: the same share of its longer side at any size. */
export function strokeWidth(size: MarkupSize): number { return Math.max(size.width, size.height) / 200 }

/** The size a note's words are set in on this picture. */
export function noteFontSize(size: MarkupSize): number { return Math.max(size.width, size.height) / 48 }

/** Whether a drag made a mark, rather than a press that slipped: a shape at least an 80th of the picture, a line of three points. */
export function madeMark(mark: Mark, size: MarkupSize): boolean {
  if (mark.tool === 'pen') return mark.points.length > 2
  if (mark.tool === 'note') return mark.text.trim().length > 0
  return Math.hypot(mark.x1 - mark.x0, mark.y1 - mark.y0) > Math.max(size.width, size.height) / 80
}

/** The arrow's shaft end and the three corners of its head. */
export function arrowGeometry(mark: ShapeMark, size: MarkupSize): { readonly shaft: readonly [number, number]; readonly head: readonly (readonly [number, number])[] } {
  const angle = Math.atan2(mark.y1 - mark.y0, mark.x1 - mark.x0), length = strokeWidth(size) * 6
  const corner = (turn: number): readonly [number, number] => [mark.x1 - length * Math.cos(angle + turn), mark.y1 - length * Math.sin(angle + turn)]
  return { shaft: [mark.x1 - Math.cos(angle) * length * 0.6, mark.y1 - Math.sin(angle) * length * 0.6], head: [[mark.x1, mark.y1], corner(-0.45), corner(0.45)] }
}

/** How wide a pen line is between two points: wider where a pen pressed harder. */
export function penWidth(mark: PenMark, pressure: number, size: MarkupSize): number {
  return strokeWidth(size) * (mark.pressure ? 0.5 + pressure * 1.6 : 1)
}

/** A note's label: where it stands and how big, given how wide its words are set. */
export function noteBox(mark: NoteMark, size: MarkupSize, textWidth: number): { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number; readonly textX: number; readonly textY: number } {
  const font = noteFontSize(size), height = font * 1.7
  return { x: mark.x0, y: mark.y0 - height / 2, width: textWidth + font * 1.2, height, radius: font * 0.3, textX: mark.x0 + font * 0.6, textY: mark.y0 + font * 0.35 }
}

/** The CSS font a note is set in, at this picture's size. */
export function noteFont(size: MarkupSize): string { return `600 ${noteFontSize(size)}px Figtree, system-ui, sans-serif` }

let measuring: CanvasRenderingContext2D | null | undefined
/** How wide a note's words are set, measured where a canvas is to hand and estimated where it is not. */
export function noteTextWidth(text: string, size: MarkupSize): number {
  if (measuring === undefined) measuring = typeof document === 'undefined' ? null : document.createElement('canvas').getContext?.('2d') ?? null
  if (measuring) { measuring.font = noteFont(size); const width = measuring.measureText(text).width; if (width > 0) return width }
  return noteFontSize(size) * 0.55 * text.length
}

/** The colours the inks resolve to in the current theme, and the colour a note's words take on each. */
export interface InkColours { readonly stroke: Readonly<Record<MarkInk, string>>; readonly noteText: Readonly<Record<MarkInk, string>> }

const INK_ROLES: Readonly<Record<MarkInk, string>> = { red: '--tt-ink-red', amber: '--tt-ink-amber', plain: '--tt-text' }

/** The relative luminance of an `rgb()` colour, or null when it is not one. */
function luminance(colour: string): number | null {
  const parts = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(colour)
  if (!parts) return null
  const [r, g, b] = parts.slice(1, 4).map(part => { const value = Number(part) / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * Reads the inks from the theme where `host` sits: red and amber are the theme's error and warning colours at full
 * strength, and plain is its text. A note's words take whichever of the theme's canvas and text reads better on the ink.
 */
export function inkColours(host: Element): InkColours {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  host.appendChild(probe)
  const read = (role: string): string => { probe.style.color = `var(${role})`; return getComputedStyle(probe).color || 'currentcolor' }
  const stroke = { red: read(INK_ROLES.red), amber: read(INK_ROLES.amber), plain: read(INK_ROLES.plain) }
  const canvas = read('--tt-canvas'), text = stroke.plain
  probe.remove()
  const on = (ink: string): string => {
    const lum = luminance(ink), light = luminance(canvas), dark = luminance(text)
    if (lum === null || light === null || dark === null) return canvas
    return contrast(lum, light) >= contrast(lum, dark) ? canvas : text
  }
  return { stroke, noteText: { red: on(stroke.red), amber: on(stroke.amber), plain: on(stroke.plain) } }
}

/** Draws the marks on a canvas the picture's size. */
export function drawMarks(context: CanvasRenderingContext2D, marks: readonly Mark[], size: MarkupSize, colours: InkColours): void {
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
      context.font = noteFont(size)
      const box = noteBox(mark, size, context.measureText(mark.text).width)
      context.beginPath(); context.roundRect(box.x, box.y, box.width, box.height, box.radius); context.fill()
      context.fillStyle = colours.noteText[mark.ink]; context.fillText(mark.text, box.textX, box.textY)
    }
  }
}

/** The marked copy's name: the picture's own with "marked up" after it, as a PNG. */
export function markedName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/u, '').trim() || 'Picture'
  return `${stem} marked up.png`
}

/**
 * The picture with its marks drawn on it, at the picture's full size, as a PNG file named after it. Null when the
 * picture could not be read or drawn.
 */
export async function markedCopy(source: string, name: string, marks: readonly Mark[], colours: InkColours): Promise<File | null> {
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
  drawMarks(context, marks, size, colours)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  return blob ? new File([blob], markedName(name), { type: 'image/png' }) : null
}
