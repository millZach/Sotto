import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WATCHER_SCENES, type WatcherScene } from '../../../src/shared/watcherScene'
import { boxDistance, gridFor, groundAt, layoutScene, owlAt, sceneInk, type Box, type SceneLayout, type SceneMeasure } from '../../../src/renderer/src/watcher/nightScene'
import { NightScenePainter } from '../../../src/renderer/src/watcher/nightScenePainter'
import { ambienceTime, STILL_AMBIENCE_T, type AmbientGlyph } from '../../../src/renderer/src/watcher/scenePlace'
import { SCENE_PLACES } from '../../../src/renderer/src/watcher/scenePlaces'

/** Watcher's pane for a window `width` by `height`, as the night scene's own tests lay it out. */
function room(width: number, height: number, patch: Partial<SceneMeasure> = {}): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2)
  return { width, height, header: 48, composer: { x: gutter, y: height - 150, w: width - gutter * 2, h: 110 }, words: [], ...patch }
}

type Polyline = { readonly alpha: number; readonly points: ReadonlyArray<readonly [number, number]> }

/**
 * A 2D context that draws nothing and remembers every line it strokes, with the alpha it was stroked at. Its image data
 * is empty, so a painter reading it sees no landscape, and its text is remembered with where it went.
 */
function recorder(): { readonly ctx: CanvasRenderingContext2D; readonly strokes: Polyline[]; readonly texts: Array<{ readonly text: string; readonly x: number; readonly y: number; readonly t: DOMMatrix2DInit }> } {
  const strokes: Polyline[] = [], texts: Array<{ text: string; x: number; y: number; t: DOMMatrix2DInit }> = []
  let path: Array<[number, number]> = [], transform: DOMMatrix2DInit = { a: 1, d: 1, e: 0, f: 0 }
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 }
  const methods: Record<string, (...args: never[]) => unknown> = {
    beginPath: () => { path = [] },
    moveTo: (x: number, y: number) => { path.push([x, y]) },
    lineTo: (x: number, y: number) => { path.push([x, y]) },
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
      const [sx, sy] = path.at(-1) ?? [x, y]
      for (let k = 1; k <= 16; k++) { const u = k / 16; path.push([(1 - u) ** 2 * sx + 2 * u * (1 - u) * cx + u * u * x, (1 - u) ** 2 * sy + 2 * u * (1 - u) * cy + u * u * y]) }
    },
    stroke: () => { strokes.push({ alpha: state.globalAlpha as number, points: path.slice() }) },
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => { transform = { a, d, e, f } },
    fillText: (text: string, x: number, y: number) => { texts.push({ text, x, y, t: transform }) },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
  }
  const ctx = new Proxy(state, {
    get: (target, key) => typeof key === 'string' && key in methods ? methods[key] : key in target ? target[key] : () => undefined,
    set: (target, key, value) => { target[key] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, strokes, texts }
}

/** How near a stroke at `alpha` or stronger passes to a point. */
function nearestStroke(strokes: readonly Polyline[], x: number, y: number, alpha = 0.5): number {
  let best = Number.POSITIVE_INFINITY
  for (const stroke of strokes) {
    if (stroke.alpha < alpha) continue
    for (let k = 1; k < stroke.points.length; k++) {
      const [ax, ay] = stroke.points[k - 1]!, [bx, by] = stroke.points[k]!
      const dx = bx - ax, dy = by - ay, u = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
      best = Math.min(best, Math.hypot(ax + u * dx - x, ay + u * dy - y))
    }
  }
  return best
}

function drawPlace(place: WatcherScene, layout: SceneLayout): Polyline[] {
  const fx = recorder(), ax = recorder()
  SCENE_PLACES[place].draw(fx.ctx, ax.ctx, layout)
  return fx.strokes
}

beforeEach(() => {
  vi.stubGlobal('Path2D', class { moveTo(): void {} lineTo(): void {} bezierCurveTo(): void {} quadraticCurveTo(): void {} })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('every place Watcher’s scene can be set in (ADR-0148)', () => {
  const layouts = [room(1600, 1000), room(1280, 800), room(1100, 640)].map(measure => layoutScene(measure))

  it('is laid out alike, so every owl sits where it does in the night wood', () => {
    // The layout takes no place: a place only draws at it.
    expect(layoutScene.length).toBe(1)
    for (const layout of layouts) expect(layout.mode).toBe('trees')
  })

  it.each(WATCHER_SCENES)('%s draws a perch under every spot an owl sits on a limb, and Watcher’s owl’s home and visit', place => {
    for (const layout of layouts) {
      const strokes = drawPlace(place, layout)
      const perched = [...layout.spots.filter(spot => spot.kind === 'limb' || spot.kind === 'tree'), layout.home, layout.visit, layout.composerPerch.left, layout.composerPerch.right]
      for (const spot of perched) expect(nearestStroke(strokes, spot.x, spot.y), `${place} at ${Math.round(spot.x)}, ${Math.round(spot.y)} in a ${layout.width} room`).toBeLessThan(9)
    }
  })

  it.each(WATCHER_SCENES)('%s draws ground under every owl that sits on the ground', place => {
    for (const layout of layouts) {
      const strokes = drawPlace(place, layout)
      for (const spot of layout.spots.filter(item => item.kind === 'ground')) {
        expect(spot.y).toBeCloseTo(groundAt(layout, spot.x), 6)
        expect(nearestStroke(strokes, spot.x, spot.y), `${place} ground at ${Math.round(spot.x)}`).toBeLessThan(4)
      }
    }
  })

  it('keeps the night wood as it was: no ambience, and its stars as many as ever', () => {
    expect(SCENE_PLACES['night-wood'].ambience).toBeNull()
    expect(SCENE_PLACES['night-wood'].stars).toBe(1)
  })

  it.each(WATCHER_SCENES.filter(place => SCENE_PLACES[place].ambience !== null))('%s moves only a fixed few glyphs a frame, and holds them still when the scene does', place => {
    for (const layout of layouts) {
      const ambience = SCENE_PLACES[place].ambience!(layout)
      expect(ambience.most).toBeLessThanOrEqual(200)
      const frame = (t: number): string[] => { const out: string[] = []; ambience.cells(t, (x, y, glyph) => out.push(`${Math.round(x)},${Math.round(y)},${glyph}`)); return out }
      for (let t = 0; t < 30; t += 0.37) expect(frame(ambienceTime(ambience, t, false)).length).toBeLessThanOrEqual(ambience.most)
      // Still, every frame draws the same glyphs in the same cells.
      expect(frame(ambienceTime(ambience, 3, true))).toEqual(frame(ambienceTime(ambience, 90, true)))
      expect(ambienceTime(ambience, 12.34, true)).toBe(STILL_AMBIENCE_T)
      // Moving, it changes from one step to a later one.
      expect(frame(ambienceTime(ambience, 1, false))).not.toEqual(frame(ambienceTime(ambience, 4, false)))
    }
  })
})

describe('the painter in each place', () => {
  const canvases = new Map<HTMLCanvasElement, ReturnType<typeof recorder>>()
  beforeEach(() => {
    canvases.clear()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      if (!canvases.has(this)) canvases.set(this, recorder())
      return canvases.get(this)!.ctx as never
    })
  })

  it.each(WATCHER_SCENES)('%s draws nothing under the words that stand still, its moving glyphs included', place => {
    const words: Box[] = [{ x: 300, y: 60, w: 680, h: 40 }, { x: 260, y: 620, w: 400, h: 24 }, { x: 40, y: 300, w: 120, h: 60 }]
    const measure = room(1280, 800, { words })
    const back = document.createElement('canvas'), front = document.createElement('canvas')
    const painter = new NightScenePainter(back, front)
    painter.setPlace(place)
    const layout = painter.resize(measure, 1)!
    painter.setInk(sceneInk({ r: 20, g: 20, b: 24 }, { r: 230, g: 230, b: 235 }, { r: 80, g: 200, b: 180 }), 'monospace')
    const grid = gridFor(measure.width, measure.height)
    back.getContext('2d')
    const texts = canvases.get(back)!.texts
    let drawn = 0
    for (let t = 0; t < 20; t += 0.6) {
      texts.length = 0
      painter.draw({ t, still: false, ripples: [], watcher: owlAt(t, layout, { at: 'home', side: 'left', flight: null, next: 1e9 }, { still: false }), owls: [], whirl: 0, pile: null })
      for (const text of texts) {
        // The back canvas draws in CSS pixels under the pixel ratio's transform, at each cell's centre.
        expect(words.some(box => boxDistance(box, text.x, text.y) <= 4), `${place} drew "${text.text}" at ${text.x}, ${text.y}`).toBe(false)
        expect(text.x).toBeLessThan(grid.cols * grid.cw)
      }
      drawn += texts.length
    }
    expect(drawn, 'the scene drew glyphs to judge').toBeGreaterThan(0)
  })

  it('changes place only when it is another, and holds the layout', () => {
    const back = document.createElement('canvas'), front = document.createElement('canvas')
    const painter = new NightScenePainter(back, front)
    expect(painter.place).toBe('night-wood')
    expect(painter.setPlace('night-wood')).toBe(false)
    const before = painter.resize(room(1280, 800), 1)
    expect(painter.setPlace('desert')).toBe(true)
    expect(painter.place).toBe('desert')
    expect(painter.resize(room(1280, 800), 1)).toEqual(before)
  })

  it('sends every moving glyph through the guard, which drops the ones it may not draw', () => {
    // The guard is the painter's; a place only says where.
    const emitted: Parameters<AmbientGlyph>[] = []
    SCENE_PLACES.snowfield.ambience!(layoutScene(room(1280, 800))).cells(5, (...args) => emitted.push(args))
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.every(([, , glyph, accent]) => glyph.length === 1 && accent === false)).toBe(true)
  })
})
