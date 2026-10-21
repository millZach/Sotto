import { describe, expect, it } from 'vitest'

import {
  addRipple, along, buildRoute, FLIGHT, FLIGHT_ENDS, frameDelay, gridFor, isLightSurface, layoutScene, liveRipples, LIGHT_ACCENT_BOOST, LIGHT_INK_BOOST,
  MAX_RIPPLES, owlAt, placeStars, quietAt, RIPPLE_LIFE, rippleAt, sceneInk, starStrength, STILL_RIPPLE_LIFE, type SceneMeasure,
} from '../../../src/renderer/src/watcher/nightScene'

/** Watcher's room at 1280 by 800, its pane above the floating switch: the composer near the bottom, the intro above it. */
function measure(patch: Partial<SceneMeasure> = {}): SceneMeasure {
  return {
    width: 1280, height: 746, header: 48,
    composer: { x: 260, y: 570, w: 760, h: 130 }, perchTop: 570,
    intro: { x: 405, y: 250, w: 470, h: 280 }, words: [{ x: 405, y: 290, w: 470, h: 30 }],
    ...patch,
  }
}

const near = (value: number, expected: number): void => expect(value).toBeCloseTo(expected, 6)

describe('the night scene’s layout and route', () => {
  it('ends the route on the composer’s top-right corner, 24 owl units in, at every size', () => {
    for (const [width, height, composer] of [[1600, 946, { x: 420, y: 760, w: 760, h: 130 }], [1280, 746, { x: 260, y: 570, w: 760, h: 130 }], [820, 506, { x: 24, y: 360, w: 772, h: 120 }]] as const) {
      const layout = layoutScene(measure({ width, height, composer, perchTop: composer.y }))
      const route = buildRoute(layout)
      for (const t of [FLIGHT_ENDS, FLIGHT_ENDS + 0.5, FLIGHT_ENDS + 60]) {
        const { pose, stage } = owlAt(t, layout, route, { still: false })
        expect(stage).toBe('perched')
        near(pose.x, composer.x + composer.w - 24 * layout.s)
        near(pose.y, composer.y + 1)
      }
      // The drop lands where the owl then perches, so it does not jump on landing.
      const landing = owlAt(FLIGHT_ENDS - 1e-6, layout, route, { still: false }).pose
      expect(Math.hypot(landing.x - layout.end.x, landing.y - layout.end.y)).toBeLessThan(0.01)
    }
  })

  it('flies from the left tree’s branch to the right tree’s, and lands on what stands on the composer', () => {
    const layout = layoutScene(measure())
    const route = buildRoute(layout)
    expect(along(route, 0)).toEqual(layout.left.perch)
    near(along(route, 1).x, layout.right.perch.x)
    near(along(route, 1).y, layout.right.perch.y)
    const stages = [0.5, FLIGHT.watch + 0.1, FLIGHT.watch + FLIGHT.takeoff + 1, FLIGHT.watch + FLIGHT.takeoff + FLIGHT.fly + 0.5, FLIGHT_ENDS - 0.5]
      .map(t => owlAt(t, layout, route, { still: false }).stage)
    expect(stages).toEqual(['watching', 'taking-off', 'flying', 'resting', 'dropping'])
    // The handover offer stands on the composer: the owl lands on its top edge instead, still at the composer's corner.
    const offered = layoutScene(measure({ perchTop: 480 }))
    expect(offered.end).toEqual({ x: 260 + 760 - 24 * offered.s, y: 481 })
  })

  it('draws the owl a quarter smaller than the prototype, held between its smallest and largest', () => {
    near(layoutScene(measure({ width: 1600, height: 1000 })).s, 2.025)
    near(layoutScene(measure({ width: 820, height: 506 })).s, 1.125)
    near(layoutScene(measure({ width: 2560, height: 1600 })).s, 2.1)
  })

  it('keeps words clear, the header band quiet and the intro in a soft oval of quiet', () => {
    const layout = layoutScene(measure())
    expect(quietAt(layout, 640, 300)).toBe(0)
    near(quietAt(layout, 1000, 10), 0.1)
    near(quietAt(layout, 640, 400), 0.12)
    expect(quietAt(layout, 1200, 400)).toBe(1)
  })
})

describe('the night scene in reduced motion', () => {
  it('starts settled on the composer, with no flight, no turn and no blink', () => {
    const layout = layoutScene(measure())
    const route = buildRoute(layout)
    for (const t of [0, 1, FLIGHT.watch + 1, 2.03, FLIGHT_ENDS + 1.3 + 4.7 * 3 + 0.05]) {
      const { pose, stage } = owlAt(t, layout, route, { still: true, look: { x: 0, y: 0, t: Math.max(0, t - 0.5) } })
      expect(stage).toBe('perched')
      expect([pose.x, pose.y, pose.turn, pose.gx, pose.gy, pose.blink, pose.spread]).toEqual([layout.end.x, layout.end.y, 0, 0, 0, false, 0])
    }
  })

  it('stops drawing once nothing moves, and keeps the stars still', () => {
    expect(frameDelay('perched', 0, true)).toBeNull()
    expect(frameDelay('perched', 1, true)).toBe(33)
    const star = { i: 0, base: 0.55, phase: 1, speed: 1.2, accent: false }
    expect(new Set([0, 0.7, 3.1].map(t => starStrength(star, t, true)))).toEqual(new Set([0.55]))
    expect(new Set([0, 0.7, 3.1].map(t => starStrength(star, t, false))).size).toBe(3)
  })

  it('turns a press into a spot that brightens in place and fades, with nothing bent', () => {
    const out = { ring: 0, dx: 0, dy: 0 }
    const ripples = [{ x: 100, y: 100, t: 0 }]
    expect(rippleAt(100, 100, ripples, 0.1, true, out).ring).toBeGreaterThan(0.5)
    expect([out.dx, out.dy]).toEqual([0, 0])
    expect(rippleAt(300, 100, ripples, 0.1, true, out).ring).toBe(0)
    expect(rippleAt(100, 100, ripples, STILL_RIPPLE_LIFE, true, out).ring).toBe(0)
  })
})

describe('the night scene’s pace and ripples', () => {
  it('draws at 30 frames a second while the owl flies or a ripple runs, 10 while it sits, and none when nothing moves', () => {
    expect(frameDelay('flying', 0, false)).toBe(33)
    expect(frameDelay('watching', 0, false)).toBe(33)
    expect(frameDelay('perched', 2, false)).toBe(33)
    expect(frameDelay('perched', 0, false)).toBe(100)
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

  it('keeps no more than eight ripples, dropping the oldest', () => {
    let ripples = [{ x: 0, y: 0, t: 0 }]
    for (let k = 1; k <= 10; k++) ripples = addRipple(ripples, { x: k, y: k, t: k / 100 })
    expect(ripples).toHaveLength(MAX_RIPPLES)
    expect(ripples[0]!.x).toBe(3)
  })

  it('scatters stars only in the open sky, below the header and above the far hills', () => {
    const layout = layoutScene(measure())
    const grid = gridFor(layout.width, layout.height)
    const ink = new Float32Array(grid.cols * grid.rows)
    for (let c = 0; c < grid.cols; c++) ink[10 * grid.cols + c] = 1
    const stars = placeStars(layout, grid, ink)
    expect(stars.length).toBeGreaterThan(20)
    for (const star of stars) {
      const row = Math.floor(star.i / grid.cols)
      expect(row).not.toBe(10)
      expect(row * grid.ch).toBeGreaterThanOrEqual(layout.header * 0.4)
      expect(row * grid.ch).toBeLessThanOrEqual(layout.horizon - layout.sky * 0.08)
    }
  })
})

describe('the night scene’s ink', () => {
  const ink = { r: 20, g: 22, b: 30 }, paper = { r: 250, g: 249, b: 246 }, accent = { r: 20, g: 120, b: 110 }

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
