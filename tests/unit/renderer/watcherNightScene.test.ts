import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  addRipple, along, boxDistance, CELL, COLUMN_BLEND, COLUMN_GAP, COLUMN_QUIET, columnCeiling, columnFactor, frameDelay, frameDue, frameSleep, gridFor, IDLE_CHECK_MS, inMargin, isLightSurface, layoutScene, liveRipples, LIGHT_ACCENT_BOOST,
  LIGHT_INK_BOOST, MAX_RIPPLES, MOVING_MS, nextPlace, over, OWL_GAP, OWL_STAY, owlAt, owlRoom, placeStars, planFlight, quietAt, RIPPLE_LIFE, rippleAt, rippleReach, sceneInk, WORD_CONTRAST,
  starStrength, stayAt, STILL_RIPPLE_LIFE, TREES_MIN_MARGIN, twinkleStep, type SceneLayout, type SceneMeasure, type WatcherOwlState,
} from '../../../src/renderer/src/watcher/nightScene'
import { contrastRatio } from '../../../src/shared/themes/color'
import { RAIL_OWL, spriteCells } from '../../../src/renderer/src/watcher/owlFamily'
import { watchResolution } from '../../../src/renderer/src/watcher/watchResolution'

/**
 * Watcher's pane for a window `width` by `height`: the floating switch's band below it, the header at the top, and the
 * composer in the new thread's 760-pixel column near the bottom, the way the room lays it out.
 */
function room(width: number, height: number, patch: Partial<SceneMeasure> = {}): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2), pane = height - 54
  return { width, height: pane, header: 48, composer: { x: gutter, y: pane - 150, w: width - gutter * 2, h: 110 }, words: [], ...patch }
}

const near = (value: number, expected: number): void => expect(value).toBeCloseTo(expected, 6)
const home: WatcherOwlState = { at: 'home', side: 'left', flight: null, next: 0 }

/** Whether a whole owl of half-width `half` stands in a margin, clear of the column. */
function clearOfColumn(layout: SceneLayout, x: number, half: number): boolean {
  return x + half < layout.column.left - OWL_GAP || x - half > layout.column.right + OWL_GAP
}

describe('the night scene in the margins', () => {
  it('lays everything out beside the column and nothing in it', () => {
    for (const [width, height] of [[1600, 1000], [1280, 800], [1100, 720]] as const) {
      const layout = layoutScene(room(width, height))
      expect(layout.mode, `${width}x${height}`).toBe('trees')
      expect(layout.column).toEqual({ left: layout.composer.x, right: layout.composer.x + layout.composer.w })
      const half = 20 * layout.s
      for (const place of [layout.home, layout.visit, layout.composerPerch.left, layout.composerPerch.right]) expect(clearOfColumn(layout, place.x, half), `${width}x${height}`).toBe(true)
      expect(layout.left.x).toBeLessThan(layout.column.left)
      expect(layout.right.x).toBeGreaterThan(layout.column.right)
      expect(layout.moon.x - layout.moon.r).toBeGreaterThan(layout.column.right)
      for (const spot of layout.spots) expect(clearOfColumn(layout, spot.x, 18), `${spot.kind} at ${spot.x}`).toBe(true)
    }
  })

  it('fills the limb across from Watcher’s owl first, then Watcher’s tree, then the ground', () => {
    const layout = layoutScene(room(1600, 1000))
    const kinds = layout.spots.map(spot => spot.kind)
    const firstTree = kinds.indexOf('tree'), firstGround = kinds.indexOf('ground')
    expect(kinds[0]).toBe('limb')
    expect(firstTree).toBeGreaterThan(0)
    expect(firstGround).toBeGreaterThan(firstTree)
    expect(kinds.slice(0, firstTree).every(kind => kind === 'limb')).toBe(true)
    expect(kinds.slice(firstGround).every(kind => kind === 'ground')).toBe(true)
    // The limb's spots run from the column outward, so the first sits nearest Watcher's owl across the room.
    const limb = layout.spots.slice(0, firstTree)
    expect(limb.every(spot => spot.x > layout.column.right)).toBe(true)
    expect(limb.map(spot => spot.x)).toEqual([...limb.map(spot => spot.x)].sort((a, b) => a - b))
    expect(layout.spots.slice(firstTree, firstGround).every(spot => spot.x < layout.column.left)).toBe(true)
    expect(layout.spots.length).toBeGreaterThan(20)
    expect(layoutScene(room(1280, 800)).spots.length).toBeLessThan(layout.spots.length)
  })

  it('gives a margin under 160 pixels a rail of owl eyes, and a margin with no room for it nothing', () => {
    expect(layoutScene(room(760 + TREES_MIN_MARGIN * 2, 800)).mode).toBe('trees')
    const rail = layoutScene(room(760 + (TREES_MIN_MARGIN - 1) * 2, 800))
    expect(rail.mode).toBe('rail')
    // At the smallest window the room leaves 16-pixel margins: the eyes go down the right one first, then the left.
    const smallest = layoutScene(room(820, 560, { composer: { x: 16, y: 356, w: 788, h: 110 } }))
    expect(smallest.mode).toBe('rail')
    const right = smallest.spots.filter(spot => spot.x > smallest.column.right), left = smallest.spots.filter(spot => spot.x < smallest.column.left)
    expect(right.length).toBeGreaterThan(10)
    expect(left.length).toBe(right.length)
    expect(smallest.spots[0]!.x).toBeGreaterThan(smallest.column.right)
    // Every glyph of every pair of eyes falls in a margin.
    for (const spot of smallest.spots) {
      expect(spot.kind).toBe('rail')
      const cells = spriteCells([RAIL_OWL], spot.x, spot.y, CELL)
      for (let c = cells.c0; c < cells.c0 + cells.w; c++) expect(owlRoom(smallest, (c + 0.5) * CELL.w), `eyes at ${spot.x}`).toBe(true)
    }
    // Narrower than that, as a pane squeezed beside a thread can be, there is no margin to draw in.
    const none = layoutScene(room(560, 800, { composer: { x: 10, y: 600, w: 540, h: 110 } }))
    expect(none.mode).toBe('none')
    expect(none.spots).toEqual([])
  })

  it('shows the column at 85% under the glass composer too, nothing under still words, and quiets the header band', () => {
    const layout = layoutScene(room(1600, 1000, { words: [{ x: 20, y: 300, w: 200, h: 20 }, { x: 500, y: 600, w: 300, h: 20 }] }))
    const { left, right } = layout.column
    const middle = (left + right) / 2
    // The user's pick on October 23, 2026 (variant D): 85%, by day and by night.
    expect(COLUMN_QUIET).toEqual({ dark: 0.85, light: 0.85 })
    near(quietAt(layout, middle, 400), COLUMN_QUIET.dark)
    near(quietAt(layout, middle, 400, COLUMN_QUIET.light), COLUMN_QUIET.light)
    // The column's part of the header band stays empty; the margins' fades to a tenth.
    expect(quietAt(layout, middle, 20)).toBe(0)
    near(quietAt(layout, 200, 10), 0.1)
    // Under the still words, and their small pad, nothing.
    expect(quietAt(layout, 100, 310)).toBe(0)
    expect(quietAt(layout, 600, 610)).toBe(0)
    expect(quietAt(layout, 600, 600 - 4)).toBe(0)
    expect(quietAt(layout, 600, 600 - 6)).toBeGreaterThan(0)
    // The composer is glass: the scene runs on under it, right to its edge.
    near(quietAt(layout, middle, layout.composer.y + 5), COLUMN_QUIET.dark)
    near(quietAt(layout, middle, layout.composer.y - 2), COLUMN_QUIET.dark)
    // The margins keep only the still words' small pad, as before.
    expect(quietAt(layout, 100, 300 - 6)).toBeGreaterThan(0)
    expect(quietAt(layout, 200, 400)).toBe(1)
    // The column's edge is halfway between its share and the whole.
    near(quietAt(layout, left, 400), (COLUMN_QUIET.dark + 1) / 2)
    expect(inMargin(layout, left - COLUMN_GAP - 1)).toBe(true)
    expect(inMargin(layout, right + COLUMN_GAP - 1)).toBe(false)
  })

  it('blends the column’s share to the whole across its edges', () => {
    const layout = layoutScene(room(1600, 1000))
    const { left, right } = layout.column
    near(columnFactor(layout, (left + right) / 2, 0.35), 0.35)
    near(columnFactor(layout, left + COLUMN_BLEND, 0.35), 0.35)
    near(columnFactor(layout, right - COLUMN_BLEND, 0.35), 0.35)
    near(columnFactor(layout, left - COLUMN_BLEND, 0.35), 1)
    near(columnFactor(layout, right + COLUMN_BLEND, 0.35), 1)
    near(columnFactor(layout, right, 0.35), 0.675)
    expect(columnFactor(layout, left - 10, 0.35)).toBeGreaterThan(columnFactor(layout, left + 10, 0.35))
  })

  it('never follows the words: a point in the column shows the same share wherever the conversation has scrolled', () => {
    // The scene is laid out from the room alone; the conversation's words are not part of its measure.
    const layout = layoutScene(room(1280, 800))
    const middle = (layout.column.left + layout.column.right) / 2
    const before = [200, 300, 400, 500].map(y => quietAt(layout, middle, y))
    expect(Object.keys(room(1280, 800))).not.toContain('lines')
    expect([200, 300, 400, 500].map(y => quietAt(layoutScene(room(1280, 800)), middle, y))).toEqual(before)
    expect(boxDistance({ x: 100, y: 100, w: 200, h: 24 }, 90, 110)).toBe(10)
  })
})

describe('beside the message scrubber', () => {
  /** The scrubber's lane, as the transcript draws it: the 44 pixels left of the column, down the transcript's height. */
  const withLane = (width: number, height: number, lane = 44): SceneMeasure => {
    const base = room(width, height)
    return { ...base, lane: { x: base.composer.x - lane, y: base.header, w: lane, h: base.composer.y - 8 - base.header } }
  }

  it('lays the left margin out from the lane’s outer edge, so Watcher’s owl and its tree’s owls stand clear of it', () => {
    for (const [width, height] of [[1600, 1000], [1280, 800]] as const) {
      const measure = withLane(width, height)
      const layout = layoutScene(measure)
      const edge = measure.lane!.x
      expect(layout.mode, `${width}x${height}`).toBe('trees')
      expect(layout.home.x + 20 * layout.s, `${width}x${height}`).toBeLessThan(edge)
      for (const spot of layout.spots.filter(item => item.x < layout.column.left)) expect(spot.x + 18, `${spot.kind} at ${spot.x}`).toBeLessThan(edge)
      // The lane is kept like words: nothing of the landscape, a star or a ripple shows in it.
      expect(quietAt(layout, edge + 10, measure.lane!.y + 100)).toBe(0)
      expect(layout.words).toContainEqual(measure.lane)
    }
  })

  it('shows the rail of eyes on the right alone when the lane leaves the left margin too narrow', () => {
    const measure = { ...room(820, 560, { composer: { x: 16, y: 356, w: 788, h: 110 } }) }
    const layout = layoutScene({ ...measure, lane: { x: 0, y: 48, w: 18, h: 300 } })
    expect(layout.mode).toBe('rail')
    expect(layout.spots.length).toBeGreaterThan(10)
    expect(layout.spots.every(spot => spot.x > layout.column.right)).toBe(true)
  })

  it('keeps Watcher’s owl off the composer’s left branch, whose perch reaches into the lane', () => {
    expect(nextPlace('home', 0.9)).toBe('composer')
    expect(nextPlace('home', 0.9, false)).toBe('tree')
    expect(nextPlace('tree', 0.1, false)).toBe('composer')
  })
})

describe('Watcher’s owl', () => {
  const layout = layoutScene(room(1600, 1000))

  it('sits in its own tree and, with motion reduced, holds still there', () => {
    for (const t of [0, 1, 2.03, 30]) {
      const { pose, stage } = owlAt(t, layout, { ...home, at: 'tree', flight: planFlight(layout, home, 'tree', 0) }, { still: true, look: { x: 0, y: 0, t: Math.max(0, t - 0.5) } })
      expect(stage).toBe('perched')
      expect([pose.x, pose.y, pose.turn, pose.gx, pose.gy, pose.blink, pose.spread]).toEqual([layout.home.x, layout.home.y, 0, 0, 0, false, 0])
    }
  })

  it('flies now and then to the other tree or the composer’s branch and back, never anywhere else', () => {
    expect(['tree', 'composer']).toContain(nextPlace('home', 0.2))
    expect(nextPlace('home', 0.2)).toBe('tree')
    expect(nextPlace('home', 0.8)).toBe('composer')
    expect(nextPlace('tree', 0.1)).toBe('composer')
    expect(nextPlace('tree', 0.9)).toBe('home')
    expect(nextPlace('composer', 0.1)).toBe('home')
    expect(stayAt('home', 0)).toBe(OWL_STAY.home[0])
    expect(stayAt('home', 1)).toBe(OWL_STAY.home[1])
    expect(stayAt('composer', 0.5)).toBeLessThan(OWL_STAY.home[0])
  })

  it('crosses to the other tree past the moon, and lands where it then sits', () => {
    const flight = planFlight(layout, home, 'tree', 10)
    expect(along(flight.route, 0)).toEqual(layout.home)
    near(along(flight.route, 1).x, layout.visit.x)
    near(along(flight.route, 1).y, layout.visit.y)
    // It passes over the moon on its way across.
    const closest = Math.min(...flight.route.samples.map(p => Math.hypot(p.x - layout.moon.x, p.y - layout.moon.y)))
    expect(closest).toBeLessThan(layout.moon.r * 1.2)
    const mid = owlAt(10 + flight.dur / 2, layout, { ...home, flight }, { still: false })
    expect(mid.stage).toBe('flying')
    expect(mid.pose.spread).toBeGreaterThan(0.5)
    const landing = owlAt(10 + flight.dur - 1e-6, layout, { ...home, flight }, { still: false }).pose
    expect(Math.hypot(landing.x - layout.visit.x, landing.y - layout.visit.y)).toBeLessThan(0.5)
  })

  it('perches on the composer’s branch on the side of the tree it comes from', () => {
    const fromHome = planFlight(layout, home, 'composer', 0)
    expect(fromHome.side).toBe('left')
    near(along(fromHome.route, 1).x, layout.composerPerch.left.x)
    near(along(fromHome.route, 1).y, layout.composerPerch.left.y)
    const fromTree = planFlight(layout, { at: 'tree', side: 'left' }, 'composer', 0)
    expect(fromTree.side).toBe('right')
    near(along(fromTree.route, 1).x, layout.composerPerch.right.x)
    near(along(fromTree.route, 1).y, layout.composerPerch.right.y)
    const sitting = owlAt(5, layout, { at: 'composer', side: 'right', flight: null, next: 99 }, { still: false }).pose
    expect([sitting.x, sitting.y]).toEqual([layout.composerPerch.right.x, layout.composerPerch.right.y])
  })

  it('turns to watch a newcomer, and to look where the margin was pressed', () => {
    const watching = owlAt(10.5, layout, home, { still: false, watch: { at: layout.moon, since: 10 } }).pose
    expect(watching.turn).toBeCloseTo(1, 5)
    expect(watching.gx).toBeGreaterThan(1)
    expect(watching.blink).toBe(false)
    const looked = owlAt(10.5, layout, home, { still: false, look: { x: 0, y: layout.home.y, t: 10 } }).pose
    expect(looked.turn).toBeLessThan(-0.5)
    expect(owlAt(13, layout, home, { still: false, look: { x: 0, y: layout.home.y, t: 10 } }).pose.gx).toBe(0)
  })
})

describe('the night scene’s pace, stars and ripples', () => {
  it('draws at 30 frames a second while anything moves, checks 8 a second at rest, and stops when it holds still', () => {
    expect(frameDelay(true, 0, false)).toBe(MOVING_MS)
    expect(frameDelay(false, 2, false)).toBe(MOVING_MS)
    expect(frameDelay(false, 0, false)).toBe(IDLE_CHECK_MS)
    expect(frameDelay(false, 0, true)).toBeNull()
    expect(frameDelay(false, 1, true)).toBe(MOVING_MS)
  })

  it('twinkles the stars in half-second steps, and not at all when the scene holds still', () => {
    const star = { i: 0, base: 0.55, phase: 1, speed: 1.2, accent: false }
    expect(new Set([0, 0.7, 3.1].map(t => starStrength(star, twinkleStep(t, true), true)))).toEqual(new Set([0.55]))
    expect(starStrength(star, twinkleStep(1.05, false), false)).toBe(starStrength(star, twinkleStep(1.45, false), false))
    expect(new Set([0, 0.7, 3.1].map(t => starStrength(star, twinkleStep(t, false), false))).size).toBe(3)
  })

  it('scatters stars over the open sky, the column’s too, below the header and above the far hills', () => {
    const layout = layoutScene(room(1600, 1000))
    const grid = gridFor(layout.width, layout.height)
    const ink = new Float32Array(grid.cols * grid.rows)
    for (let c = 0; c < grid.cols; c++) ink[10 * grid.cols + c] = 1
    const stars = placeStars(layout, grid, ink)
    expect(stars.length).toBeGreaterThan(20)
    expect(stars.some(star => !inMargin(layout, (star.i % grid.cols + 0.5) * grid.cw)), 'a star in the column').toBe(true)
    for (const star of stars) {
      const row = Math.floor(star.i / grid.cols)
      expect(row).not.toBe(10)
      expect(row * grid.ch).toBeGreaterThanOrEqual(layout.header)
      expect(row * grid.ch).toBeLessThanOrEqual(layout.horizon - layout.sky * 0.08)
    }
  })

  it('turns a press into a spot that brightens in place and fades when motion is reduced, with nothing bent', () => {
    const out = { ring: 0, dx: 0, dy: 0 }
    const ripples = [{ x: 100, y: 100, t: 0 }]
    expect(rippleAt(100, 100, ripples, 0.1, true, out).ring).toBeGreaterThan(0.5)
    expect([out.dx, out.dy]).toEqual([0, 0])
    expect(rippleAt(300, 100, ripples, 0.1, true, out).ring).toBe(0)
    expect(rippleAt(100, 100, ripples, STILL_RIPPLE_LIFE, true, out).ring).toBe(0)
  })

  it('sends a ring out with its echo behind it, bending the landscape as it passes, and lets ripples expire', () => {
    const out = { ring: 0, dx: 0, dy: 0 }
    const ripples = [{ x: 0, y: 0, t: 0 }]
    // At 0.45 s the ring has reached about 193 pixels and its echo about 120; the middle is calm again.
    const ring = rippleAt(193, 0, ripples, 0.45, false, out).ring
    const echo = rippleAt(120, 0, ripples, 0.45, false, out).ring
    expect(ring).toBeGreaterThan(echo)
    expect(echo).toBeGreaterThan(0.2)
    expect(rippleAt(10, 0, ripples, 0.45, false, out).ring).toBe(0)
    expect(Math.abs(rippleAt(200, 0, ripples, 0.45, false, out).dx)).toBeGreaterThan(0)
    expect(liveRipples(ripples, RIPPLE_LIFE - 0.01, false)).toHaveLength(1)
    expect(liveRipples(ripples, RIPPLE_LIFE + 0.01, false)).toHaveLength(0)
    expect(liveRipples(ripples, STILL_RIPPLE_LIFE + 0.01, true)).toHaveLength(0)
  })

  it('keeps a ripple that starts later, as the moon’s does for a staggered newcomer, and leaves it out until it starts', () => {
    const out = { ring: 0, dx: 0, dy: 0 }
    const later = [{ x: 0, y: 0, t: 5 }]
    expect(liveRipples(later, 1, false)).toHaveLength(1)
    expect(rippleReach(later[0]!, 1, false)).toBe(0)
    expect(rippleAt(0, 0, later, 1, false, out).ring).toBe(0)
    expect(rippleAt(193, 0, later, 5.45, false, out).ring).toBeGreaterThan(0.2)
  })

  it('keeps no more than twelve ripples, dropping the oldest', () => {
    let ripples = [{ x: 0, y: 0, t: 0 }]
    for (let k = 1; k <= 14; k++) ripples = addRipple(ripples, { x: k, y: k, t: k / 100 })
    expect(ripples).toHaveLength(MAX_RIPPLES)
    expect(ripples[0]!.x).toBe(3)
  })

  /**
   * The scene's loop on a display that starts a frame every `period` milliseconds: after each drawn frame it sleeps for
   * frameSleep, then checks each display frame with frameDue, as WatcherNightScene does. The gaps between drawn frames.
   */
  function drawnGaps(period: number, delay: number, frames = 60): number[] {
    const drawn: number[] = []
    let last = Number.NEGATIVE_INFINITY, awake = 0
    for (let vsync = 0; drawn.length < frames; vsync += period) {
      if (vsync < awake || !frameDue(vsync, last, delay)) continue
      last = vsync
      drawn.push(vsync)
      // Drawing takes about a millisecond; the timer then sleeps until shortly before the next frame is due.
      awake = vsync + 1 + frameSleep(vsync + 1, last, delay)
    }
    return drawn.slice(1).map((at, index) => at - drawn[index]!)
  }
  const mean = (gaps: readonly number[]): number => gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length

  it('paces frames from when the last one started: about 30 a second moving and 8 checks at rest, on 60 and 144 hertz displays', () => {
    for (const period of [1000 / 60, 1000 / 144]) {
      const moving = mean(drawnGaps(period, MOVING_MS)), resting = mean(drawnGaps(period, IDLE_CHECK_MS))
      expect(1000 / moving, `moving at ${Math.round(1000 / period)} Hz`).toBeGreaterThan(27)
      expect(1000 / moving, `moving at ${Math.round(1000 / period)} Hz`).toBeLessThanOrEqual(31)
      expect(1000 / resting, `resting at ${Math.round(1000 / period)} Hz`).toBeGreaterThan(7)
      expect(1000 / resting, `resting at ${Math.round(1000 / period)} Hz`).toBeLessThanOrEqual(8.5)
    }
    expect(frameDue(33, 0, 33)).toBe(true)
    expect(frameSleep(1, 0, 100)).toBe(79)
    expect(frameSleep(1, 0, 33)).toBe(12)
  })
})

describe('the night scene’s ink', () => {
  const ink = { r: 20, g: 22, b: 30 }, paper = { r: 250, g: 249, b: 246 }, accent = { r: 20, g: 120, b: 110 }

  it('stops the column’s ink where the weakest word over it would fall under 4.5:1, by day and by night', () => {
    const night = { r: 12, g: 13, b: 16 }, text = { r: 247, g: 247, b: 250 }, muted = { r: 168, g: 170, b: 176 }, yellow = { r: 242, g: 208, b: 36 }
    for (const [surface, word, quiet, glow, boost] of [
      [night, text, muted, yellow, 1], [paper, ink, { r: 92, g: 90, b: 82 }, accent, LIGHT_INK_BOOST],
    ] as const) {
      const cap = columnCeiling(surface, word, boost, [word, quiet])
      expect(cap).toBeGreaterThan(0)
      // At the ceiling a glyph's core leaves both words at WORD_CONTRAST or more; a step stronger, one falls under it.
      const at = over(surface, word, Math.min(1, cap * boost))
      expect(contrastRatio(word, at)).toBeGreaterThanOrEqual(WORD_CONTRAST)
      expect(contrastRatio(quiet, at)).toBeGreaterThanOrEqual(WORD_CONTRAST)
      if (cap < 1) {
        const past = over(surface, word, Math.min(1, (cap + 0.05) * boost))
        expect(Math.min(contrastRatio(word, past), contrastRatio(quiet, past))).toBeLessThan(WORD_CONTRAST)
      }
      expect(WORD_CONTRAST).toBeGreaterThanOrEqual(4.5)
      // The accent has its own ceiling, by the same words.
      const scene = sceneInk(surface, word, glow, [word, quiet])
      expect(scene.column.ink).toBe(cap)
      expect(scene.column.accent).toBe(columnCeiling(surface, glow, boost === 1 ? 1 : LIGHT_ACCENT_BOOST, [word, quiet]))
    }
    // The weaker word brings the ceiling down from where the text alone would put it. The muted tier would bring it far
    // lower than the secondary one, which is why Watcher's names and times take the secondary tier (pick D2).
    const secondary = { r: 214, g: 212, b: 204 }
    expect(columnCeiling(night, text, 1, [text, secondary])).toBeLessThan(columnCeiling(night, text, 1, [text]))
    expect(columnCeiling(night, text, 1, [text, muted])).toBeLessThan(columnCeiling(night, text, 1, [text, secondary]))
    // A word that already falls under 4.5:1 on the bare surface leaves no ink at all.
    expect(columnCeiling(night, text, 1, [{ r: 40, g: 40, b: 44 }])).toBe(0)
  })

  it('judges light and dark by the surface’s luminance, not a theme’s name', () => {
    expect(isLightSurface(paper)).toBe(true)
    expect(isLightSurface({ r: 12, g: 14, b: 20 })).toBe(false)
    // A mid-tone surface goes whichever way black or white text would read better on it.
    expect(isLightSurface({ r: 140, g: 140, b: 140 })).toBe(true)
    expect(isLightSurface({ r: 100, g: 100, b: 100 })).toBe(false)
  })

  it('draws dark ink on a light surface with much more of it, and light ink on dark as it is', () => {
    const light = sceneInk(paper, ink, accent)
    const dark = sceneInk({ r: 12, g: 14, b: 20 }, { r: 240, g: 240, b: 248 }, accent)
    expect(light.light).toBe(true)
    expect(dark.light).toBe(false)
    expect(light.ink[10]).toBe(`rgba(20, 22, 30, ${(0.5 * LIGHT_INK_BOOST).toFixed(2)})`)
    expect(light.accent[10]).toBe(`rgba(20, 120, 110, ${(0.5 * LIGHT_ACCENT_BOOST).toFixed(2)})`)
    expect(dark.ink[10]).toBe('rgba(240, 240, 248, 0.50)')
    expect(light.ink[20]).toBe('rgba(20, 22, 30, 1.00)')
    expect(light.ink[0]).toBe('rgba(20, 22, 30, 0.00)')
  })
})

describe('the night scene and the display’s scaling', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('lays the scene out again whenever the pixel ratio changes, watching for the new ratio each time', () => {
    const queries: Array<{ media: string; listeners: Set<() => void> }> = []
    vi.stubGlobal('devicePixelRatio', 1)
    vi.stubGlobal('matchMedia', (media: string) => {
      const listeners = new Set<() => void>()
      queries.push({ media, listeners })
      return { media, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
    })
    const changed = vi.fn()
    const stop = watchResolution(changed)
    expect(queries.map(query => query.media)).toEqual(['(resolution: 1dppx)'])
    vi.stubGlobal('devicePixelRatio', 1.5)
    for (const listener of [...queries[0]!.listeners]) listener()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(queries.map(query => query.media)).toEqual(['(resolution: 1dppx)', '(resolution: 1.5dppx)'])
    expect(queries[0]!.listeners.size).toBe(0)
    expect(queries[1]!.listeners.size).toBe(1)
    stop()
    expect(queries[1]!.listeners.size).toBe(0)
  })
})
