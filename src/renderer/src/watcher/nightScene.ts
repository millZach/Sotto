/**
 * The maths of Watcher's night scene (Zach's pick on October 21, 2026, variant A of the prototype kept at the tag
 * `prototype/watcher-owl-scene`): where the landscape and the owl's route fall in the room, where the owl is at any
 * moment of its flight, what a ripple does to a cell, and what ink the scene draws with. Nothing here touches the DOM or
 * a canvas, so all of it can be tested on its own; `nightScenePainter.ts` draws it and `WatcherNightScene.tsx` runs it.
 *
 * Every length is in CSS pixels from the top-left of Watcher's pane, and every time in seconds from when the room
 * opened.
 */

import { relativeLuminance, type ThemeRgb } from '../../../shared/themes/color'

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Point { readonly x: number; readonly y: number }
export type Rgb = ThemeRgb

/** What the room measures of itself for the scene: its size, and where its header, intro and composer are. */
export interface SceneMeasure {
  readonly width: number
  readonly height: number
  /** The bottom of the header band: the header, and the needs-you line when it shows. */
  readonly header: number
  /** Watcher's composer. */
  readonly composer: Box
  /**
   * The top edge the owl lands on: the composer's own, or the top of what stands on it, such as the handover offer or
   * an error line, so the owl never covers their words or controls.
   */
  readonly perchTop: number
  /** The intro (the first-time words, or an empty conversation's line), which sits in a soft oval of quiet. */
  readonly intro: Box | null
  /**
   * Every block of words over the scene: the header's, the intro's, what stands on the composer and the line under it.
   * Nothing is drawn under them, so their text keeps its contrast with the surface whatever the scene does.
   */
  readonly words: readonly Box[]
}

/** The owl's size for the room's: its share of a 1600 by 1000 room, held between a smallest and a largest. */
export const OWL_SCALE = { factor: 2.025, min: 1.125, max: 2.1 } as const

/** How far around a block of words the scene stays clear. */
export const WORDS_CLEARANCE = 4

export interface Tree { readonly x: number; readonly y: number; readonly h: number; readonly perch: Point }
export interface Moon { readonly x: number; readonly y: number; readonly r: number }

/** Where everything in the scene falls for one size of the room. */
export interface SceneLayout {
  readonly width: number
  readonly height: number
  readonly composer: Box
  readonly intro: Box | null
  readonly words: readonly Box[]
  readonly header: number
  /** The owl's size: 1 is the prototype's drawing at its own units. */
  readonly s: number
  readonly groundY: number
  /** The sky's height, from the header to the ground. */
  readonly sky: number
  readonly horizon: number
  readonly left: Tree
  readonly right: Tree
  readonly moon: Moon
  /** Where the owl perches at the end: the composer's top-right corner, 24 owl units in from its right edge. */
  readonly end: Point
}

export const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** Hermite smoothstep of `x` between `a` and `b`. */
export const smooth = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }

/** A small seeded random source (mulberry32), so the same room always draws the same scene. */
export function seeded(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = state + 0x6d2b79f5 | 0
    let t = Math.imul(state ^ state >>> 15, 1 | state)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

/** Lays the scene out around the room: the ground just behind the composer, the trees at either side, the moon on the right. */
export function layoutScene(measure: SceneMeasure): SceneLayout {
  const { width: W, height: H, composer: comp, header } = measure
  // A quarter smaller than the prototype's owl (Zach, October 21, 2026): its 2.7, 1.5 and 2.8 times three quarters.
  const s = clamp(Math.min(W / 1600, H / 1000) * OWL_SCALE.factor, OWL_SCALE.min, OWL_SCALE.max)
  const groundY = comp.y + comp.h * 0.55
  const sky = Math.max(1, groundY - header)
  const leftH = sky * 0.78
  const leftX = Math.max(52, W * 0.055)
  const left: Tree = { x: leftX, y: groundY + 4, h: leftH, perch: { x: leftX + Math.min(leftH * 0.42, W * 0.17), y: groundY - leftH * 0.5 } }
  const rightH = sky * 0.58
  const rightX = W - Math.max(70, W * 0.085)
  const right: Tree = { x: rightX, y: groundY + 4, h: rightH, perch: { x: rightX - rightH * 0.3, y: groundY - rightH * 0.5 } }
  const moonR = clamp(Math.min(W, H) * 0.058, 26, 62)
  const moon: Moon = { x: Math.min(W * 0.78, rightX - rightH * 0.42 - moonR), y: header + sky * 0.2 + moonR * 0.4, r: moonR }
  const end: Point = { x: comp.x + comp.w - 24 * s, y: measure.perchTop + 1 }
  return { width: W, height: H, composer: comp, intro: measure.intro, words: measure.words, header, s, groundY, sky, horizon: groundY - sky * 0.3, left, right, moon, end }
}

/**
 * How much of the scene shows at a point, 0 to 1: nothing under words, a band falling to a tenth under the header,
 * and a soft oval around the intro falling to about an eighth.
 */
export function quietAt(layout: SceneLayout, x: number, y: number): number {
  const pad = WORDS_CLEARANCE
  for (const box of layout.words) if (x >= box.x - pad && x <= box.x + box.w + pad && y >= box.y - pad && y <= box.y + box.h + pad) return 0
  let quiet = lerp(0.1, 1, smooth(layout.header - 14, layout.header + 10, y))
  const intro = layout.intro
  if (intro !== null) {
    const e = Math.hypot((x - (intro.x + intro.w / 2)) / (intro.w / 2 + 40), (y - (intro.y + intro.h / 2)) / (intro.h / 2 + 30))
    quiet = Math.min(quiet, lerp(0.12, 1, smooth(0.85, 1.35, e)))
  }
  return quiet
}

// ---------- The route ----------

/** How long each part of the flight takes, in seconds: watching, taking off, the flight, the right tree, the drop. */
export const FLIGHT = { watch: 2.6, takeoff: 0.45, fly: 5.6, rest: 1.9, drop: 1.4 } as const
/** When the owl has landed on the composer for good. */
export const FLIGHT_ENDS = FLIGHT.watch + FLIGHT.takeoff + FLIGHT.fly + FLIGHT.rest + FLIGHT.drop

interface RouteSample extends Point { readonly d: number }
export interface Route { readonly samples: readonly RouteSample[]; readonly length: number }

function catmull(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t, t3 = t2 * t
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}

/**
 * The long flight, by the owl's feet: from the left tree's branch, down to the left of the intro and low over the
 * composer, up across the moon, and into the right tree.
 */
export function buildRoute(layout: SceneLayout): Route {
  const { s, composer: c, moon: m, width: W } = layout
  const from = layout.left.perch, to = layout.right.perch
  const points: Point[] = [
    from,
    { x: lerp(from.x, c.x, 0.55), y: lerp(from.y, c.y + 20 * s, 0.6) },
    { x: c.x + 10 * s, y: c.y + 30 * s },
    { x: c.x + c.w * 0.4, y: c.y + 38 * s },
    { x: c.x + c.w * 0.7, y: c.y + 26 * s },
    { x: lerp(c.x + c.w * 0.7, m.x, 0.6), y: lerp(c.y, m.y + 30 * s, 0.6) },
    { x: m.x, y: m.y + 30 * s },
    { x: Math.min(W - 50 * s, m.x + m.r * 1.5 + 30), y: m.y + m.r + 40 * s },
    { x: to.x - 30, y: to.y - 46 },
    to,
  ]
  const ext = [points[0]!, ...points, points[points.length - 1]!]
  const samples: RouteSample[] = [{ ...points[0]!, d: 0 }]
  for (let k = 1; k < ext.length - 2; k++) for (let j = 1; j <= 30; j++) {
    const p = catmull(ext[k - 1]!, ext[k]!, ext[k + 1]!, ext[k + 2]!, j / 30)
    const last = samples[samples.length - 1]!
    samples.push({ ...p, d: last.d + Math.hypot(p.x - last.x, p.y - last.y) })
  }
  return { samples, length: samples[samples.length - 1]!.d }
}

/** The point a share `u` of the way along the route. */
export function along(route: Route, u: number): Point {
  const target = clamp(u, 0, 1) * route.length, S = route.samples
  let lo = 0, hi = S.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid]!.d < target) lo = mid; else hi = mid }
  const a = S[lo]!, b = S[hi]!, t = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d)
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
}

// ---------- The owl over time ----------

/** The owl's pose for one frame. `x`, `y` are its feet; the rest shape the drawing. */
export interface OwlPose {
  readonly x: number
  readonly y: number
  readonly s: number
  readonly bank: number
  readonly squash: number
  /** 0 with wings folded, 1 spread. */
  readonly spread: number
  readonly flap: number
  /** The head's turn, -1 (to the left) to 1. */
  readonly turn: number
  /** Where the pupils look, in owl units. */
  readonly gx: number
  readonly gy: number
  readonly blink: boolean
  /** How far the legs reach down for landing, 0 to 1. */
  readonly legs: number
}

export type OwlStage = 'watching' | 'taking-off' | 'flying' | 'resting' | 'dropping' | 'perched'

/** Where a press in the open background drew the owl's eye, and when. */
export interface Look { readonly x: number; readonly y: number; readonly t: number }

const IDLE_TURNS = [0, -0.7, 0, 0.55, 0.15, -0.35] as const
const IDLE_TURN_EVERY = 5.2
const BLINK_EVERY = 4.7

/**
 * Where the owl is at `t`, and in what pose. With `still` (reduced motion, or a capture's fixed clock) it is on the
 * composer from the start, and holds still there: no turning, no blinking.
 */
export function owlAt(t: number, layout: SceneLayout, route: Route, options: { readonly still: boolean; readonly look?: Look | null }): { readonly pose: OwlPose; readonly stage: OwlStage } {
  const { s } = layout
  const pose = { x: 0, y: 0, s, bank: 0, squash: 1, spread: 0, flap: 0, turn: 0, gx: 0, gy: 0, blink: false, legs: 0 }
  const T1 = FLIGHT.watch, T2 = T1 + FLIGHT.takeoff, T3 = T2 + FLIGHT.fly, T4 = T3 + FLIGHT.rest
  let stage: OwlStage
  if (options.still || t >= FLIGHT_ENDS) {
    stage = 'perched'
    pose.x = layout.end.x; pose.y = layout.end.y
    if (!options.still) {
      const k = t - FLIGHT_ENDS, seg = Math.floor(k / IDLE_TURN_EVERY)
      const prev = IDLE_TURNS[(seg + IDLE_TURNS.length - 1) % IDLE_TURNS.length]!, next = IDLE_TURNS[seg % IDLE_TURNS.length]!
      pose.turn = lerp(prev, next, smooth(0, 0.25, k - seg * IDLE_TURN_EVERY))
      pose.blink = (k + 1.3) % BLINK_EVERY < 0.14
    }
  } else if (t < T1) {
    stage = 'watching'
    pose.x = layout.left.perch.x; pose.y = layout.left.perch.y
    pose.turn = lerp(-0.85, 0.25, smooth(1.3, 1.6, t)) * smooth(0.2, 0.5, t)
    pose.blink = t > 2.0 && t < 2.13
  } else if (t < T2) {
    stage = 'taking-off'
    const k = (t - T1) / FLIGHT.takeoff
    pose.x = layout.left.perch.x; pose.y = layout.left.perch.y - 10 * k * s
    pose.squash = 1 - 0.1 * Math.sin(Math.min(1, k * 2) * Math.PI)
    pose.spread = smooth(0.25, 1, k); pose.flap = k * Math.PI * 3
  } else if (t < T3) {
    stage = 'flying'
    const k = (t - T2) / FLIGHT.fly
    const u = clamp(k - Math.sin(2 * Math.PI * k) / (2 * Math.PI) * 0.55, 0, 1)
    const p = along(route, u), q = along(route, Math.min(1, u + 0.01))
    const vx = q.x - p.x, vy = q.y - p.y
    pose.x = p.x; pose.y = p.y
    pose.bank = clamp(vx * 0.012, -0.3, 0.3)
    pose.spread = 1
    const rising = vy < -0.4 ? 1 : vy < 0.6 ? 0.55 : 0.12
    const landing = smooth(0.86, 1, k)
    pose.flap = 0.3 + Math.sin(t * 2 * Math.PI * (2.4 + landing * 1.6)) * lerp(rising, 1.1, landing)
    pose.legs = landing
    pose.gy = 0.6
  } else if (t < T4) {
    stage = 'resting'
    pose.x = layout.right.perch.x; pose.y = layout.right.perch.y
    const k = t - T3
    pose.turn = k < 0.9 ? lerp(0, -0.8, smooth(0.1, 0.35, k)) : lerp(-0.8, 0.4, smooth(0.9, 1.15, k))
    pose.blink = k > 1.4 && k < 1.53
  } else {
    stage = 'dropping'
    const k = (t - T4) / FLIGHT.drop
    const a = layout.right.perch, b = layout.end
    const cx = lerp(a.x, b.x, 0.5) - 20, cy = Math.min(a.y, b.y) - 36 * s
    const u = smooth(0, 1, k)
    pose.x = (1 - u) ** 2 * a.x + 2 * (1 - u) * u * cx + u * u * b.x
    pose.y = (1 - u) ** 2 * a.y + 2 * (1 - u) * u * cy + u * u * b.y
    pose.spread = Math.sin(Math.PI * clamp(k * 1.15, 0, 1)) ** 0.6
    pose.flap = t * 2 * Math.PI * 3.6
    pose.legs = smooth(0.6, 0.95, k)
  }
  // A press turns the head toward it while the owl sits, and the eyes follow, then it looks away again. With motion
  // reduced a press only brightens the spot, so the owl holds still.
  const look = options.look
  if (!options.still && look != null && t - look.t >= 0 && t - look.t < 1.8 && (stage === 'perched' || stage === 'watching' || stage === 'resting')) {
    const k = smooth(0, 0.2, t - look.t) * (1 - smooth(1.4, 1.8, t - look.t))
    pose.turn = lerp(pose.turn, clamp((look.x - pose.x) / 260, -1, 1), k)
    pose.gx = lerp(pose.gx, clamp((look.x - pose.x) / 200, -1.2, 1.2), k)
    pose.gy = lerp(pose.gy, clamp((look.y - (pose.y - 47 * s)) / 200, -1, 1.2), k)
    pose.blink = false
  }
  return { pose, stage }
}

// ---------- Ripples ----------

export interface Ripple { readonly x: number; readonly y: number; readonly t: number }

/** How long a ripple runs: an expanding ring and its echo, or with motion reduced, a spot that brightens and fades. */
export const RIPPLE_LIFE = 2.4
export const STILL_RIPPLE_LIFE = 0.7
/** At most this many at once; the oldest goes first. */
export const MAX_RIPPLES = 8
/** How fast the ring spreads, in pixels a second, and its echo's share of that. */
const RIPPLE_SPEED = 430
const ECHO_SHARE = 0.62
const RINGS = [[1, 20, 1], [ECHO_SHARE, 14, 0.45]] as const
/** How far beyond its radius a ring still reaches a cell: three widths of the wider ring. */
export const RIPPLE_REACH = 62
const STILL_REACH = 70

/** The ripples still running at `t`. */
export function liveRipples(ripples: readonly Ripple[], t: number, still: boolean): Ripple[] {
  const life = still ? STILL_RIPPLE_LIFE : RIPPLE_LIFE
  return ripples.filter(ripple => t - ripple.t >= 0 && t - ripple.t <= life)
}

/** A new press's ripple, keeping no more than MAX_RIPPLES. */
export function addRipple(ripples: readonly Ripple[], ripple: Ripple): Ripple[] {
  return [...ripples, ripple].slice(-MAX_RIPPLES)
}

/** How far out from its centre a ripple can touch a cell at `t`. */
export function rippleReach(ripple: Ripple, t: number, still: boolean): number {
  return still ? STILL_REACH : (t - ripple.t) * RIPPLE_SPEED + RIPPLE_REACH
}

/** What the running ripples do to one cell: how bright their ring is there, and how far they bend the landscape. */
export interface RippleEffect { ring: number; dx: number; dy: number }

/** Writes the ripples' effect at a cell's centre into `out` (reused, since it runs for many cells a frame) and returns it. */
export function rippleAt(x: number, y: number, ripples: readonly Ripple[], t: number, still: boolean, out: RippleEffect): RippleEffect {
  out.ring = 0; out.dx = 0; out.dy = 0
  for (const ripple of ripples) {
    const age = t - ripple.t, ddx = x - ripple.x, ddy = y - ripple.y, dist = Math.hypot(ddx, ddy) || 1
    if (still) {
      // Reduced motion: no ring travels and nothing bends; the spot brightens where it was pressed and fades.
      const f = (1 - age / STILL_RIPPLE_LIFE) * (1 - smooth(0, STILL_REACH, dist))
      if (f > 0) out.ring += f * 0.8
      continue
    }
    const amp = Math.max(0, 1 - age / RIPPLE_LIFE) ** 1.6
    for (const [share, width, strength] of RINGS) {
      const off = dist - age * RIPPLE_SPEED * share, band = Math.exp(-(off * off) / (2 * width * width)) * amp * strength
      if (band < 0.01) continue
      const wave = band * Math.cos(off / width * 1.7)
      out.ring += band
      out.dx += ddx / dist * wave * 1.8; out.dy += ddy / dist * wave * 1.8
    }
  }
  return out
}

// ---------- Pace ----------

/** How long to wait before the next frame, in milliseconds, or null when nothing moves and drawing stops. */
export function frameDelay(stage: OwlStage, ripples: number, still: boolean): number | null {
  if (ripples > 0 || stage !== 'perched') return 33
  return still ? null : 100
}

// ---------- Ink ----------

/** Whether a surface is light: black text reads better on it than white. Every theme is judged by its colour, not its name. */
export function isLightSurface(surface: Rgb): boolean {
  return relativeLuminance(surface) > 0.179
}

/** The scene's two inks in 21 steps of strength, from nothing to full. */
export interface SceneInk { readonly light: boolean; readonly ink: readonly string[]; readonly accent: readonly string[] }

/** Dark ink on a light surface needs more of it to be seen as well as light ink on dark does. */
export const LIGHT_INK_BOOST = 1.9
export const LIGHT_ACCENT_BOOST = 1.5

/** The scene's inks for a theme: its text and accent colours, made stronger when the surface under them is light. */
export function sceneInk(surface: Rgb, text: Rgb, accent: Rgb): SceneInk {
  const light = isLightSurface(surface)
  const ramp = ({ r, g, b }: Rgb, boost: number): string[] => Array.from({ length: 21 }, (_, k) => `rgba(${r}, ${g}, ${b}, ${Math.min(1, k / 20 * boost).toFixed(2)})`)
  return { light, ink: ramp(text, light ? LIGHT_INK_BOOST : 1), accent: ramp(accent, light ? LIGHT_ACCENT_BOOST : 1) }
}

/** One of an ink's steps for a strength between 0 and 1. */
export function inkAt(steps: readonly string[], strength: number): string {
  return steps[Math.round(clamp(strength, 0, 1) * 20)]!
}

// ---------- Stars ----------

export interface Star {
  /** The cell's index in the grid. */
  readonly i: number
  /** 0.3, 0.55 or 0.9. */
  readonly base: number
  readonly phase: number
  readonly speed: number
  readonly accent: boolean
}

/** The grid the scene is drawn on: a cell per glyph. */
export interface Grid { readonly cols: number; readonly rows: number; readonly cw: number; readonly ch: number }

/** Glyph cells: 7 by 12 pixels, which the 10.5-pixel mono face fills without gaps. */
export const CELL = { w: 7, h: 12 } as const

export function gridFor(width: number, height: number): Grid {
  return { cols: Math.ceil(width / CELL.w), rows: Math.ceil(height / CELL.h), cw: CELL.w, ch: CELL.h }
}

/** Stars scattered over the open sky, where the landscape leaves a cell empty. */
export function placeStars(layout: SceneLayout, grid: Grid, ink: Float32Array): Star[] {
  const S = seeded(5), count = Math.round(layout.width * layout.height / 7500), stars: Star[] = []
  for (let k = 0; k < count; k++) {
    const c = Math.floor(S() * grid.cols), r = Math.floor(S() * grid.rows), y = r * grid.ch
    if (y < layout.header * 0.4 || y > layout.horizon - layout.sky * 0.08) continue
    const i = r * grid.cols + c
    if ((ink[i] ?? 1) > 0.05) continue
    const tier = S()
    stars.push({ i, base: tier > 0.93 ? 0.9 : tier > 0.7 ? 0.55 : 0.3, phase: S() * 6.28, speed: 0.5 + S() * 1.2, accent: S() > 0.86 })
  }
  return stars
}

/** A star's strength at `t`: it twinkles unless the scene holds still. */
export function starStrength(star: Star, t: number, still: boolean): number {
  return star.base * (still ? 1 : 0.65 + 0.35 * Math.sin(t * star.speed + star.phase))
}

/** The density ramp the landscape and the owl are drawn in, faintest first. */
export const RAMP = ' .·:-=+*#%@'
/** A ripple's ring, faintest first. */
export const RIPPLE_GLYPHS = '·∘oO'

/** The glyph for a density between 0 and 1: never the blank, since a cell drawn at all shows something. */
export function rampGlyph(density: number): string {
  return RAMP[Math.max(1, Math.round(clamp(density, 0, 1) * (RAMP.length - 1)))]!
}
