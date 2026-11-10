import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WATCHER_SCENES } from '../../../src/shared/watcherScene'
import { gridFor, layoutScene, moonHalo, owlAt, RAMP, sceneInk, type SceneLayout, type SceneMeasure } from '../../../src/renderer/src/watcher/nightScene'
import { NightScenePainter } from '../../../src/renderer/src/watcher/nightScenePainter'
import { WOOD_LAYERS, WOOD_TONE } from '../../../src/renderer/src/watcher/placeNightWood'
import { CELL_PX, LINE_PX, pickGlyph, RAISED, settleRaised, type GlyphPick } from '../../../src/renderer/src/watcher/sceneGlyph'
import { SCENE_PLACES } from '../../../src/renderer/src/watcher/scenePlaces'

/** Watcher's pane for a window `width` by `height`, as the night scene's own tests lay it out. */
function room(width: number, height: number): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2)
  return { width, height, header: 48, composer: { x: gutter, y: height - 150, w: width - gutter * 2, h: 110 }, words: [] }
}

/** One glyph cell of the finer field, each pixel as `ink(x, y)` gives it, 0 to 255. */
function cell(ink: (x: number, y: number) => number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(CELL_PX)
  for (let y = 0; y < LINE_PX.h; y++) for (let x = 0; x < LINE_PX.w; x++) px[y * LINE_PX.w + x] = ink(x, y)
  return px
}
const pick = (px: Uint8ClampedArray, lines = true, noise = 0.5): GlyphPick => pickGlyph(px, 0, lines, noise, { code: 0, strength: 0 })
const glyphOf = (px: Uint8ClampedArray, lines = true): string => { const code = pick(px, lines).code; return code === 0 ? '' : code === RAISED ? 'raised' : String.fromCharCode(code) }
const rows = (from: number, to: number, ink = 255) => (_x: number, y: number): number => y >= from && y <= to ? ink : 0

describe('the character a cell takes as line art (ADR-0199)', () => {
  it('draws nothing in an empty cell, and a covered one by the density ramp either way', () => {
    expect(glyphOf(cell(() => 0))).toBe('')
    const full = cell(() => 255)
    expect(glyphOf(full)).toBe(RAMP[RAMP.length - 1])
    expect(glyphOf(full, false)).toBe(RAMP[RAMP.length - 1])
  })

  it('draws a flat line by how high in its cell it lies', () => {
    expect(glyphOf(cell(rows(7, 8)))).toBe('_')
    expect(glyphOf(cell(rows(4, 5)))).toBe('-')
    // No character lies along the top of a cell, so the painter is told, and draws it under the cell above.
    expect(glyphOf(cell(rows(0, 1)))).toBe('raised')
  })

  it('takes a flat band about half its cell thick, or thicker, as a fill', () => {
    for (const band of [cell(rows(2, 7)), cell(rows(3, 9))]) {
      expect(RAMP).toContain(glyphOf(band))
      expect(glyphOf(band)).toBe(glyphOf(band, false))
    }
  })

  it('draws an upright line as |, and a slanted one as the slash that leans its way', () => {
    expect(glyphOf(cell(x => x === 2 || x === 3 ? 255 : 0))).toBe('|')
    const slant = (rising: boolean) => (x: number, y: number): number => {
      const across = (x + 0.5) / LINE_PX.w, down = (y + 0.5) / LINE_PX.h
      return Math.abs(across - (rising ? 1 - down : down)) < 0.15 ? 255 : 0
    }
    expect(glyphOf(cell(slant(true)))).toBe('/')
    expect(glyphOf(cell(slant(false)))).toBe('\\')
  })

  it('draws a short thin upright stub as a tick at the top of its cell or a comma at the foot', () => {
    expect(glyphOf(cell((x, y) => x === 2 && y <= 3 ? 255 : 0))).toBe('\'')
    expect(glyphOf(cell((x, y) => x === 2 && y >= 6 ? 255 : 0))).toBe(',')
    expect(glyphOf(cell((x, y) => x === 2 && y >= 1 && y <= 8 ? 255 : 0))).toBe('|')
  })

  it('is not made upright by the cell being taller than wide: a blob takes the ramp', () => {
    const blob = cell((x, y) => Math.hypot((x + 0.5) / LINE_PX.w - 0.5, (y + 0.5) / LINE_PX.h - 0.5) < 0.36 ? 255 : 0)
    expect(RAMP).toContain(glyphOf(blob))
    expect(glyphOf(blob)).toBe(glyphOf(blob, false))
  })

  it('draws a line in ink as strong as the line, not as faint as the cell’s average', () => {
    const strong = pick(cell(rows(4, 5))), faint = pick(cell(rows(4, 5, 128)))
    expect(strong.strength).toBeCloseTo(0.78, 2)
    expect(faint.strength).toBeCloseTo(0.16 + 0.62 * 128 / 255, 2)
    // By density the same cell is a ramp glyph at a fifth of full ink.
    const dense = pick(cell(rows(4, 5)), false)
    expect(RAMP).toContain(String.fromCharCode(dense.code))
    expect(dense.strength).toBeCloseTo(0.1 + 0.5 * 0.2, 2)
  })

  it('leaves a line too faint to be one, and every cell when lines are not asked for, to the ramp', () => {
    const faint = cell(rows(4, 5, 40))
    expect(glyphOf(faint)).toBe(glyphOf(faint, false))
    for (const ink of [rows(7, 8), rows(0, 1), (x: number) => x === 2 ? 255 : 0]) expect(RAMP + '\u0000').toContain(glyphOf(cell(ink), false) || '\u0000')
  })

  it('settles a line along the top of a cell as the underline of the free cell above, and drops it under a drawn one', () => {
    // Three cells across, two down: raised lines under a free cell, under a drawn one, and in the top row.
    const glyphs = Uint16Array.from([0, 35, RAISED, RAISED, RAISED, 0]), strengths = Float32Array.from([0, 0.5, 0.7, 0.6, 0.4, 0])
    settleRaised(glyphs, strengths, 3)
    expect([...glyphs]).toEqual([95, 35, 0, 0, 0, 0])
    expect(strengths[0]).toBeCloseTo(0.6, 5)
    expect(strengths[1]).toBeCloseTo(0.5, 5)
  })
})

type Stroke = { readonly alpha: number; readonly points: ReadonlyArray<readonly [number, number]> }

/**
 * A 2D context that draws nothing and remembers the lines it strokes and the text it draws. Its image data is whatever
 * `ink` gives for each pixel, so a painter reading it sees that in every cell.
 */
function fake(ink: (x: number, y: number) => number = () => 0): { readonly ctx: CanvasRenderingContext2D; readonly strokes: Stroke[]; readonly texts: Array<{ readonly text: string; readonly x: number; readonly y: number }> } {
  const strokes: Stroke[] = [], texts: Array<{ text: string; x: number; y: number }> = []
  let path: Array<[number, number]> = []
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  const methods: Record<string, (...args: never[]) => unknown> = {
    beginPath: () => { path = [] },
    moveTo: (x: number, y: number) => { path.push([x, y]) },
    lineTo: (x: number, y: number) => { path.push([x, y]) },
    quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => { path.push([x, y]) },
    // A stroke along a Path2D, as the river is drawn, is remembered with no points: the fake path keeps none.
    stroke: (along?: unknown) => { strokes.push({ alpha: state.globalAlpha as number, points: along === undefined ? path.slice() : [] }) },
    fillText: (text: string, x: number, y: number) => { texts.push({ text, x, y }) },
    getImageData: (x0: number, y0: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(0, w * h * 4))
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 4 + 3] = ink(x0 + x, y0 + y)
      return { data }
    },
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
  }
  const ctx = new Proxy(state, {
    get: (target, key) => typeof key === 'string' && key in methods ? methods[key] : key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, strokes, texts }
}

beforeEach(() => {
  vi.stubGlobal('Path2D', class { moveTo(): void {} lineTo(): void {} bezierCurveTo(): void {} quadraticCurveTo(): void {} })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the night wood in layers (ADR-0199)', () => {
  const layouts = [room(1600, 1000), room(1280, 800), room(1100, 640)].map(measure => layoutScene(measure))
  const wood = SCENE_PLACES['night-wood'].layers!

  /** The wood drawn apart, each layer's strokes on its own. */
  function apart(layout: SceneLayout): Map<string, Stroke[]> {
    return new Map(wood.order.map(name => { const field = fake(); wood.draw(name, field.ctx, layout); return [name, field.strokes] as const }))
  }

  it('is the only place with layers yet: the others are drawn by density as they were', () => {
    expect(wood.order).toEqual([...WOOD_LAYERS])
    expect(Object.keys(wood.tone).sort()).toEqual([...WOOD_LAYERS].sort())
    for (const place of WATCHER_SCENES) expect(SCENE_PLACES[place].layers === null, place).toBe(place !== 'night-wood')
  })

  it('draws the far hills faintest and the moon brightest', () => {
    expect(WOOD_TONE.far).toBeLessThan(WOOD_TONE.mid)
    expect(WOOD_TONE.mid).toBeLessThan(WOOD_TONE.near)
    expect(WOOD_TONE.near).toBeLessThan(WOOD_TONE.tree)
    expect(Math.max(...Object.values(WOOD_TONE))).toBe(WOOD_TONE.moon)
  })

  it('draws every stroke of the place, each on its own layer', () => {
    for (const layout of layouts) {
      const whole = fake()
      SCENE_PLACES['night-wood'].draw(whole.ctx, fake().ctx, layout)
      const layers = apart(layout)
      const count = [...layers.values()].reduce((sum, strokes) => sum + strokes.length, 0)
      // The river is cut out of each of the three hills apart, and of the one field by density: two strokes a cut.
      expect(count).toBe(whole.strokes.length + 4)
      for (const name of ['far', 'mid', 'near', 'river', 'ground', 'bare', 'tree', 'branch', 'moon']) expect(layers.get(name)!.length, name).toBeGreaterThan(0)
    }
  })

  it('strokes a hill along its ridge only, since the ground in front hides its foot, and draws the ground’s edge stronger', () => {
    for (const layout of layouts) {
      const foot = layout.groundY + 2, layers = apart(layout)
      for (const name of ['far', 'mid']) {
        const ridge = layers.get(name)!.filter(stroke => stroke.points.length > 50)
        expect(ridge.length, name).toBe(1)
        expect(ridge[0]!.points.some(([, y]) => y === foot), `${name} is stroked round its foot`).toBe(false)
      }
      const whole = fake()
      SCENE_PLACES['night-wood'].draw(whole.ctx, fake().ctx, layout)
      expect(whole.strokes.filter(stroke => stroke.points.length > 50).some(stroke => stroke.points.some(([, y]) => y === foot))).toBe(true)
      expect(Math.max(...layers.get('ground')!.map(stroke => stroke.alpha))).toBeCloseTo(0.95, 5)
    }
  })

  it('says where each layer draws, and every stroke in the pane falls inside it', () => {
    for (const layout of layouts) {
      for (const [name, strokes] of apart(layout)) {
        const box = wood.bounds(name, layout)
        for (const stroke of strokes) for (const [x, y] of stroke.points) {
          if (x < 0 || x > layout.width || y < 0 || y > layout.height) continue
          expect(x >= box.x - 0.5 && x <= box.x + box.w + 0.5 && y >= box.y - 0.5 && y <= box.y + box.h + 0.5, `${name} strokes ${Math.round(x)}, ${Math.round(y)} outside ${JSON.stringify(box)} in a ${layout.width} room`).toBe(true)
        }
      }
    }
  })
})

describe('the painter drawing line art', () => {
  /** A flat line along the foot of every cell of the finer field: ink in rows 7 and 8 of each ten. */
  const footLine = (_x: number, y: number): number => y % LINE_PX.h === 7 || y % LINE_PX.h === 8 ? 255 : 0
  const canvases = new Map<HTMLCanvasElement, ReturnType<typeof fake>>()
  beforeEach(() => {
    canvases.clear()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (!canvases.has(this)) canvases.set(this, fake(footLine))
      return canvases.get(this)!.ctx as never
    })
  })
  const ink = sceneInk({ r: 20, g: 20, b: 24 }, { r: 230, g: 230, b: 235 }, { r: 80, g: 200, b: 180 })

  function painted(lineArt: boolean, measure = room(1280, 800)): { readonly painter: NightScenePainter; readonly layout: SceneLayout; readonly texts: ReadonlyArray<{ readonly text: string; readonly x: number; readonly y: number }> } {
    const back = document.createElement('canvas'), front = document.createElement('canvas')
    const painter = new NightScenePainter(back, front)
    painter.setLineArt(lineArt)
    const layout = painter.resize(measure, 1)!
    painter.setInk(ink, 'monospace')
    painter.draw({ t: 0, still: true, ripples: [], watcher: owlAt(0, layout, { at: 'home', side: 'left', flight: null, next: 1e9 }, { still: true }), owls: [], whirl: 0, pile: null })
    // The landscape's glyphs are drawn once on the painter's own canvas and copied; the stars and the owl on the pane's two.
    return { painter, layout, texts: [...canvases.values()].flatMap(canvas => canvas.texts) }
  }

  it('draws a line as its own character in the margins, and by density under the conversation', () => {
    const { painter, layout, texts } = painted(true)
    expect(painter.linesShown).toBe(true)
    const lines = texts.filter(text => text.text === '_')
    expect(lines.length).toBeGreaterThan(100)
    // Under the conversation a solid line would read as an underline of the words above it.
    for (const text of lines) expect(text.x < layout.column.left || text.x > layout.column.right, `a line at ${text.x} under the column`).toBe(true)
    const under = texts.filter(text => text.x > layout.column.left + 8 && text.x < layout.column.right - 8)
    expect(under.length).toBeGreaterThan(0)
    for (const text of under) expect(RAMP + '*+·', `"${text.text}" under the column`).toContain(text.text)
  })

  it('draws every cell by density while line art is off, as it always has', () => {
    const { painter, texts } = painted(false)
    expect(painter.linesShown).toBe(false)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(text => '_|/\\'.includes(text.text))).toBe(false)
  })

  it('shows as line art only among trees, in a place that has layers', () => {
    expect(painted(true, room(820, 560)).painter.linesShown, 'the rail of eyes').toBe(false)
    const { painter } = painted(true)
    expect(painter.setPlace('desert')).toBe(true)
    expect(painter.linesShown, 'a place with no layers').toBe(false)
    expect(painter.setPlace('night-wood')).toBe(true)
    expect(painter.linesShown).toBe(true)
  })

  it('changes only when asked for something else, and draws the landscape again when it does', () => {
    const { painter, layout } = painted(true)
    expect(painter.setLineArt(true)).toBe(false)
    expect(painter.setLineArt(false)).toBe(true)
    expect(painter.linesShown).toBe(false)
    // The next frame paints, though nothing else about it changed.
    expect(painter.draw({ t: 0, still: true, ripples: [], watcher: owlAt(0, layout, { at: 'home', side: 'left', flight: null, next: 1e9 }, { still: true }), owls: [], whirl: 0, pile: null })).toBe(true)
  })

  it('keeps every glyph inside the grid', () => {
    const measure = room(1280, 800), grid = gridFor(measure.width, measure.height)
    for (const text of painted(true, measure).texts) {
      expect(text.x).toBeLessThan(grid.cols * grid.cw)
      expect(text.y).toBeLessThan(grid.rows * grid.ch)
    }
  })
})

describe('the moon’s halo (ADR-0199)', () => {
  it('lies in the moon’s own margin, below the header, with the moon inside it', () => {
    for (const measure of [room(1600, 1000), room(1280, 800), room(1100, 640)]) {
      const layout = layoutScene(measure), halo = moonHalo(layout)
      expect(halo.left).toBeGreaterThan(layout.column.right)
      expect(halo.left + halo.width).toBeCloseTo(layout.width, 6)
      expect(halo.top).toBe(layout.header)
      expect(halo.left + halo.x).toBeCloseTo(layout.moon.x, 6)
      expect(halo.top + halo.y).toBeCloseTo(layout.moon.y, 6)
      expect(halo.reach).toBeGreaterThan(layout.moon.r * 2)
      expect(halo.top + halo.height).toBeCloseTo(layout.moon.y + halo.reach, 6)
    }
  })
})
