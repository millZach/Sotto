import { CELL, clamp, gridFor, groundAt, lerp, seeded, type Point, type SceneLayout } from './nightScene'
import type { AmbientGlyph } from './scenePlace'

/**
 * The night wood's life in Watcher's living night scene (ADR-0199, decisions 9 to 11; Zach's pick E, "the wood mirrors
 * the room", on November 10, 2026, of the prototype kept at the tag `prototype/watcher-scene-life`). Nothing in it runs
 * on a timer of its own: the busier the room, the more often a gust crosses and the faster the river runs; the quieter,
 * the more fireflies and the thicker the mist; a finished turn sends a shooting star, a failed one scatters bats, a
 * settled thread goes home under a meteor shower, and while nothing works the wood's animals come out, far apart.
 *
 * Every glyph goes through the painter's guard, as a place's moving glyphs do. What moves is bounded by the pane, never
 * by the room's history or its threads: a fixed few fireflies, glints and wisps, a cell a column of grass, the crowns'
 * own cells while a gust crosses them, and at most MOST_HAPPENINGS things happening at once. Nothing here touches the
 * DOM or a canvas, and every random draw comes from the roll it is given.
 */

/** A meteor: where it starts, the way it falls, how fast and for how long. */
interface Meteor { readonly x0: number; readonly y0: number; readonly dx: number; readonly dy: number; readonly speed: number; readonly life: number }

/** Something happening in the wood from `t0` for `dur` seconds. */
export type Happening =
  | { readonly kind: 'gust'; readonly t0: number; readonly dur: number; readonly strength: number; readonly leaves: readonly { readonly x: number; readonly y: number; readonly delay: number; readonly turn: number }[] }
  | ({ readonly kind: 'star'; readonly t0: number; readonly dur: number } & Meteor)
  | { readonly kind: 'meteors'; readonly t0: number; readonly dur: number; readonly list: readonly (Meteor & { readonly at: number })[] }
  | { readonly kind: 'bats'; readonly t0: number; readonly dur: number; readonly from: Point | null; readonly bats: readonly { readonly dx: number; readonly y: number; readonly turn: number; readonly vx: number; readonly vy: number }[] }
  | { readonly kind: 'fox'; readonly t0: number; readonly dur: number; readonly stopX: number }
  | { readonly kind: 'fish'; readonly t0: number; readonly dur: number; readonly at: Point }
  | { readonly kind: 'cloud'; readonly t0: number; readonly dur: number; readonly x0: number; readonly y: number; readonly rx: number; readonly ry: number }
  | { readonly kind: 'mouse'; readonly t0: number; readonly dur: number; readonly x0: number; readonly x1: number; readonly run: number; boltAt: number | null }

/** What the wood's animals do while nothing works, in turn. The hunt is Watcher's owl's, so the scene starts it. */
export const QUIET_ANIMALS = ['fox', 'fish', 'cloud', 'hunt'] as const
export type QuietAnimal = typeof QUIET_ANIMALS[number]

/** At most this many things happening at once; the oldest goes first. */
export const MOST_HAPPENINGS = 6
/** How often what moves in the wood steps, a second: eight at rest, more while something quick crosses. */
export const WOOD_STEPS = 8
export const QUICK_WOOD_STEPS = 24
/** Seconds between gusts in a room where nothing works and in one where everything does. */
export const GUST_EVERY = { quiet: 26, busy: 6 } as const
/** How long nothing must have worked before an animal comes out, and how long between one and the next, in seconds. */
export const QUIET_AFTER = 20
export const ANIMAL_EVERY = 90
/** Fireflies in a room where everything works and in one where nothing does. */
export const FIREFLIES = { busy: 5, quiet: 16 } as const
/** Glints on the river, wisps of mist, meteors in a shower and bats in a flock. */
const GLINTS = 18, WISPS = 4, SHOWER = 10, FLOCK = 7
/** A gust's pace across the pane in pixels a second, and how wide its front is. */
const GUST_SPEED = 320, GUST_WIDTH = 190, GUST_LEAD = 220
const FOX_SPEED = 95, FOX_PAUSE = 2

const FOX_WALK = [['~-.__/\\°>', '   /|  |\\ '], ['~-.__/\\°>', '   |\\  /| ']] as const
const FOX_STOP = ['~-.__/\\°>', '   ||  || '] as const
const QUICK = new Set<Happening['kind']>(['star', 'meteors', 'bats', 'fish', 'mouse', 'fox'])

/** How busy the room is, 0 to 1, from how many of its watched threads are working. */
export function busyOf(working: number, watched: number): number {
  return watched <= 0 ? 0 : clamp(working / Math.max(4, watched * 0.6), 0, 1)
}

/** The night wood's river, as `placeNightWood.ts` draws it: a share 0 to 1 of the way from the far hills to the pane's foot. */
export function riverAt(g: Pick<SceneLayout, 'column' | 'horizon' | 'sky' | 'groundY' | 'height'>, share: number): Point {
  const edge = g.column.left - 14, sky = g.sky, u = clamp(share, 0, 1)
  // Two thirds of its way is the bend through the hills, the rest the run past Watcher's tree to the foot.
  if (u < 0.66) {
    const k = u / 0.66, v = 1 - k
    return {
      x: v * v * v * edge * 0.8 + 3 * v * v * k * edge * 0.55 + 3 * v * k * k * edge * 0.7 + k * k * k * edge * 0.35,
      y: v * v * v * (g.horizon + 6) + 3 * v * v * k * (g.horizon + sky * 0.14) + 3 * v * k * k * (g.groundY - sky * 0.03) + k * k * k * (g.groundY + 20),
    }
  }
  const k = (u - 0.66) / 0.34, v = 1 - k
  return { x: v * v * edge * 0.35 + 2 * v * k * edge * 0.12 + k * k * -10, y: v * v * (g.groundY + 20) + 2 * v * k * (g.groundY + 45) + k * k * g.height }
}

/** The landscape's characters as the painter drew them, for the crowns to sway in: a cell's code, 0 for none, and its ink. */
export interface LandGlyphs { readonly code: (cell: number) => number; readonly strength: (cell: number) => number }

export class WoodLife {
  private happenings: Happening[] = []
  private nextGust: number
  private quietSince: number | null = null
  private nextAnimal = Number.POSITIVE_INFINITY
  private animal = 0
  private readonly cols: number
  private readonly rows: number
  private readonly flies: readonly { readonly x: number; readonly y: number; readonly a: number; readonly b: number; readonly c: number; readonly pace: number }[]
  private readonly wisps: readonly { readonly y: number; readonly length: number; readonly speed: number; readonly x0: number }[]
  private readonly grass: readonly Point[]
  private crown: Array<{ readonly cell: number; readonly x: number; readonly y: number; readonly high: number }> | null = null

  /**
   * The wood's life from `now`, the scene's clock in seconds: the first gust comes a few seconds on, so a window being
   * dragged to a new size, which makes the wood's life again at each step, raises no wind. `roll` gives every random
   * draw, 0 to 1. `land` reads the landscape's own glyphs, or is null where the crowns cannot sway.
   */
  constructor(private readonly layout: SceneLayout, now: number, private readonly roll: () => number, private readonly land: LandGlyphs | null) {
    const g = layout, grid = gridFor(g.width, g.height), fixed = seeded(71)
    this.nextGust = now + 3 + 4 * roll()
    this.cols = grid.cols; this.rows = grid.rows
    this.flies = Array.from({ length: FIREFLIES.quiet }, (_, k) => ({
      x: k % 2 === 0 ? lerp(10, Math.max(12, g.column.left - 26), fixed()) : lerp(Math.min(g.width - 12, g.column.right + 26), g.width - 10, fixed()),
      y: lerp(g.horizon + g.sky * 0.16, Math.min(g.height - 16, g.groundY + 74), fixed()), a: fixed() * 6.28, b: fixed() * 6.28, c: fixed() * 6.28, pace: 0.2 + fixed() * 0.16,
    }))
    this.wisps = [g.horizon + g.sky * 0.03, g.horizon + g.sky * 0.1, g.groundY - g.sky * 0.09, g.groundY - g.sky * 0.035].slice(0, WISPS)
      .map((y, k) => ({ y, length: 26 + k * 7, speed: 5 + k * 1.6, x0: fixed() * (g.width + 400) }))
    this.grass = Array.from({ length: grid.cols }, (_, c) => { const x = (c + 0.5) * CELL.w; return { x, y: (Math.floor((groundAt(g, x) - 7) / CELL.h) + 0.5) * CELL.h } })
  }

  private add(happening: Happening): void {
    this.happenings = [...this.happenings, happening].slice(-MOST_HAPPENINGS)
  }

  private meteor(rightward: boolean): Meteor {
    const g = this.layout, speed = 560 + 160 * this.roll(), life = 0.55 + 0.3 * this.roll(), run = speed * life * 0.9
    // Three in four fall over a margin, where they show at full strength; the rest cross behind the conversation's words.
    const pick = this.roll(), from = pick < 0.375 ? 0 : pick < 0.75 ? g.column.right : g.column.left, to = pick < 0.375 ? g.column.left : pick < 0.75 ? g.width : g.column.right
    const start = from + this.roll() * Math.max(0, to - from - run)
    return { x0: rightward ? start : start + run, y0: g.header + 12 + g.sky * 0.16 * this.roll(), dx: rightward ? 0.95 : -0.95, dy: 0.3, speed, life }
  }

  /** A gust sets off across the wood from the left, taking a few leaves off Watcher's tree. */
  gust(t: number): void {
    const g = this.layout, tree = g.left
    const leaves = Array.from({ length: 9 }, () => { const x = tree.x + (this.roll() - 0.3) * tree.h * 0.3; return { x, y: tree.y - tree.h * (0.62 + this.roll() * 0.3), delay: (x + GUST_LEAD) / GUST_SPEED + this.roll() * 0.5, turn: this.roll() * 6 } })
    this.add({ kind: 'gust', t0: t, dur: (g.width + 700) / GUST_SPEED + 3, strength: 0.75 + 0.25 * this.roll(), leaves })
  }

  /** A watched thread's turn finished: a shooting star. */
  finished(t: number): void {
    this.add({ kind: 'star', t0: t + 0.4, dur: 1.3, ...this.meteor(this.roll() < 0.5) })
  }

  /** A watched thread's turn failed: bats scatter from the bare tree. */
  failed(t: number): void {
    const tree = this.layout.right
    this.bats(t, { x: tree.x - tree.h * 0.1, y: tree.y - tree.h * 0.7 })
  }

  /** A watched thread's work is settled: a meteor shower, as its owl goes home. */
  settled(t: number): void {
    const rightward = this.roll() < 0.5
    this.add({ kind: 'meteors', t0: t + 0.7, dur: 4.6, list: Array.from({ length: SHOWER }, (_, k) => ({ at: k * 0.3 + this.roll() * 0.2, ...this.meteor(rightward) })) })
  }

  private bats(t: number, from: Point | null): void {
    const g = this.layout
    const bats = Array.from({ length: FLOCK }, (_, k) => ({ dx: k * 30 + this.roll() * 18, y: g.moon.y - 34 + this.roll() * 78, turn: this.roll() * 6, vx: -(70 + this.roll() * 150), vy: -(40 + this.roll() * 70) }))
    this.add({ kind: 'bats', t0: t, dur: from === null ? (g.width + 320) / 150 : 5, from, bats })
  }

  /** One of the wood's animals comes out. The hunt is Watcher's owl's own: `mouse` starts it, and the scene sends the owl. */
  animalOut(kind: Exclude<QuietAnimal, 'hunt'>, t: number): void {
    const g = this.layout
    if (kind === 'fox') this.add({ kind: 'fox', t0: t, dur: (g.width + 170) / FOX_SPEED + FOX_PAUSE + 0.2, stopX: g.column.left * 0.62 })
    // Where the river runs open between the far hills and the near field; lower down Watcher's tree stands in front of it.
    else if (kind === 'fish') this.add({ kind: 'fish', t0: t, dur: 2.1, at: riverAt(g, 0.27) })
    else this.add({ kind: 'cloud', t0: t, dur: (g.moon.r * 6.4 + 160) / 22, x0: g.moon.x + g.moon.r * 3.2 + 80, y: g.moon.y - g.moon.r * 0.1, rx: g.moon.r * 2.3, ry: g.moon.r * 0.85 })
  }

  /**
   * A mouse comes out under Watcher's tree and runs toward the room, for the owl to dive at. Returns where it stops, or
   * null where the margin has no room for it.
   */
  mouse(t: number): Point | null {
    const g = this.layout, x0 = g.left.x + 46 * g.s, x1 = Math.min(g.column.left - 70, x0 + 110)
    if (x1 - x0 < 40) return null
    this.add({ kind: 'mouse', t0: t, dur: 40, x0, x1, run: 2.4, boltAt: null })
    return { x: x1 - 6, y: groundAt(g, x1 - 6) }
  }

  /** The mouse bolts for the room, a moment before the owl lands on where it was, and is gone a second later. */
  bolt(t: number): void {
    this.happenings = this.happenings.map(h => h.kind === 'mouse' && h.boltAt === null ? { ...h, boltAt: t, dur: t - h.t0 + 1.3 } : h)
  }

  /**
   * Starts what is due at `t` in a room this `busy` (0 to 1) with this many threads `working`, and drops what has
   * finished. Returns the animal to send out now, while nothing has worked for a while, or null: the scene sends the
   * fox, the fish and the cloud straight back through `animalOut`, and starts the hunt itself when its owl is home.
   */
  step(t: number, busy: number, working: number): QuietAnimal | null {
    if (this.happenings.some(h => t > h.t0 + h.dur)) this.happenings = this.happenings.filter(h => t <= h.t0 + h.dur)
    if (t >= this.nextGust) { this.gust(t); this.nextGust = t + lerp(GUST_EVERY.quiet, GUST_EVERY.busy, busy) * (0.7 + 0.6 * this.roll()) }
    if (working > 0) { this.quietSince = null; this.nextAnimal = Number.POSITIVE_INFINITY; return null }
    if (this.quietSince === null) { this.quietSince = t; this.nextAnimal = t + QUIET_AFTER }
    if (t < this.nextAnimal) return null
    this.nextAnimal = t + ANIMAL_EVERY * (0.7 + 0.6 * this.roll())
    return QUIET_ANIMALS[this.animal++ % QUIET_ANIMALS.length]!
  }

  /** Whether something quick is crossing at `t`, or about to: the scene draws more often while one does. */
  quick(t: number): boolean {
    return this.happenings.some(h => QUICK.has(h.kind) && t <= h.t0 + h.dur)
  }

  /** The step of what moves in the wood at `t`: 0 while the scene holds still. */
  stepOf(t: number, still: boolean): number {
    return still ? 0 : Math.floor(t * (this.quick(t) ? QUICK_WOOD_STEPS : WOOD_STEPS))
  }

  /** How hard the wind blows at `x`: a faint breeze, and each gust's front as it crosses. */
  windAt(x: number, t: number): number {
    let wind = 0.08
    for (const h of this.happenings) if (h.kind === 'gust') { const d = (x - (-GUST_LEAD + (t - h.t0) * GUST_SPEED)) / GUST_WIDTH; wind += h.strength * Math.exp(-d * d) }
    return Math.min(1, wind)
  }

  /** The cells of the two crowns that hold a glyph, or stand beside one, read from the landscape once a gust first needs them. */
  private crowns(): NonNullable<WoodLife['crown']> {
    if (this.crown !== null) return this.crown
    const g = this.layout, land = this.land, out: NonNullable<WoodLife['crown']> = []
    if (land !== null) for (const tree of [g.left, g.right]) {
      const top = tree.y - tree.h * 1.02, bottom = tree.y - tree.h * 0.66
      const c0 = clamp(Math.floor((tree.x - tree.h * 0.42) / CELL.w), 1, this.cols - 1), c1 = clamp(Math.ceil((tree.x + tree.h * 0.42) / CELL.w), 1, this.cols - 1)
      for (let r = clamp(Math.floor(top / CELL.h), 0, this.rows - 1); r <= clamp(Math.floor(bottom / CELL.h), 0, this.rows - 1); r++) for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c, x = (c + 0.5) * CELL.w, y = (r + 0.5) * CELL.h
        if (Math.hypot(x - g.moon.x, y - g.moon.y) < g.moon.r * 2.9) continue
        if (land.code(cell) !== 0 || land.code(cell - 1) !== 0) out.push({ cell, x, y, high: clamp((bottom - y) / Math.max(1, bottom - top), 0, 1) })
      }
    }
    this.crown = out
    return out
  }

  /**
   * The frame's glyphs at `t`, nearest first, since the painter gives a cell to the first that asks: what is happening,
   * the fireflies, the leaves, the river, the wind in the grass and the crowns, a cloud, and the mist. `busy` is the
   * room's, 0 to 1. `pointer` is where the pointer rests in the pane, which the fireflies keep clear of. Holding still,
   * the fireflies, the river's glints and the mist stand where they rest, and nothing happens.
   */
  glyphs(t: number, still: boolean, busy: number, pointer: Point | null, emit: AmbientGlyph): void {
    const g = this.layout, { w: cw, h: ch } = CELL, W = g.width
    const sprite = (lines: readonly string[], x: number, y: number, strength: number, accents: string): void => {
      const width = Math.max(...lines.map(line => line.length)), c0 = Math.round(x / cw - width / 2), r0 = Math.floor((y - 1) / ch) - lines.length + 1
      lines.forEach((line, k) => { for (let j = 0; j < line.length; j++) if (line[j] !== ' ') emit((c0 + j + 0.5) * cw, (r0 + k + 0.5) * ch, line[j]!, accents.includes(line[j]!), strength, true) })
    }
    const meteor = (m: Meteor, age: number): void => {
      if (age < 0 || age > m.life + 0.3) return
      const head = Math.min(age, m.life), fade = age > m.life ? clamp(1 - (age - m.life) / 0.3, 0, 1) : 1
      for (let j = 0; j < 13; j++) {
        const s = head - j * 0.011
        if (s < 0) break
        const x = m.x0 + m.dx * m.speed * s, y = m.y0 + m.dy * m.speed * s
        if (j === 0) { if (age <= m.life) emit(x, y, '*', true, 1, true); continue }
        emit(x, y, j < 4 ? '=' : j < 8 ? '-' : '·', j < 5, (0.9 - j * 0.06) * fade, true)
      }
    }
    if (!still) for (const h of this.happenings) {
      const age = t - h.t0
      if (age < 0 || age > h.dur) continue
      if (h.kind === 'star') meteor(h, age)
      else if (h.kind === 'meteors') for (const m of h.list) meteor(m, age - m.at)
      else if (h.kind === 'bats') {
        for (const bat of h.bats) {
          const x = h.from === null ? W + 30 + bat.dx - 150 * age : h.from.x + bat.vx * age, y = h.from === null ? bat.y + 9 * Math.sin(age * 2.3 + bat.turn) : h.from.y + bat.vy * age + 7 * Math.sin(age * 3 + bat.turn)
          const wings = Math.floor(age * 7 + bat.turn) % 2 === 0 ? '^v^' : '-v-'
          for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, wings[j]!, false, 0.85, true)
        }
      } else if (h.kind === 'fox') {
        const toStop = (h.stopX + 70) / FOX_SPEED, stopped = age >= toStop && age < toStop + FOX_PAUSE
        const x = age < toStop ? -70 + FOX_SPEED * age : stopped ? h.stopX : h.stopX + FOX_SPEED * (age - toStop - FOX_PAUSE)
        // Its feet are in the row above the ground's edge, so it walks on the ground rather than in it.
        const y = Math.floor(groundAt(g, x) / ch) * ch
        sprite(stopped ? FOX_STOP : FOX_WALK[Math.floor(age * 6) % 2]!, x, y, 0.9, '°')
        if (stopped && age - toStop > 0.35 && age - toStop < 1.7) emit(x + 40, y - 30, '?', true, 0.9, true)
      } else if (h.kind === 'mouse') {
        const x = h.boltAt !== null ? h.x1 + (t - h.boltAt) * 420 : age < h.run ? lerp(h.x0, h.x1, age / h.run) : h.x1, y = groundAt(g, x) - 3
        for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, '~o>'[j]!, j === 1, 0.9, true)
      } else if (h.kind === 'fish') {
        if (age < 0.9) {
          const k = age / 0.9, x = h.at.x - 14 + 28 * k, y = h.at.y - 42 * Math.sin(Math.PI * k)
          for (let j = 0; j < 3; j++) emit(x + (j - 1) * cw, y, '><>'[j]!, true, 1, true)
          if (age < 0.45) for (const side of [-1, 1]) emit(h.at.x - 14 + side * (6 + age * 30), h.at.y - 8 - age * 26, "'", true, 0.7 - age, true)
        } else {
          const k = (age - 0.9) / (h.dur - 0.9), reach = 6 + 36 * k, x = h.at.x + 14
          emit(x - reach, h.at.y, '(', true, 0.9 * (1 - k), true); emit(x + reach, h.at.y, ')', true, 0.9 * (1 - k), true)
          if (reach > 16) { emit(x - reach / 2, h.at.y, '~', true, 0.5 * (1 - k), true); emit(x + reach / 2, h.at.y, '~', true, 0.5 * (1 - k), true) }
          if (k < 0.45) for (const side of [-1, 0, 1]) emit(x + side * (8 + k * 22), h.at.y - 10 - 34 * k + 60 * k * k, side === 0 ? '.' : "'", true, 0.8 - k, true)
        }
      }
    }

    // Fireflies: fewer the busier the room. Each drifts round its own place and glows now and then.
    const count = Math.round(lerp(FIREFLIES.quiet, FIREFLIES.busy, busy))
    for (let k = 0; k < count; k++) {
      const fly = this.flies[k]!
      let x = fly.x + 26 * Math.sin(t * 0.31 + fly.a) + 9 * Math.sin(t * 1.3 + fly.b), y = fly.y + 12 * Math.sin(t * 0.43 + fly.c) + 5 * Math.sin(t * 1.7 + fly.a)
      if (pointer !== null) {
        // Pushed straight away from the pointer, or up when the pointer is right on it.
        const dx = x - pointer.x, dy = y - pointer.y, d = Math.hypot(dx, dy)
        if (d < 90) { x += (d < 0.01 ? 0 : dx / d) * (90 - d) * 0.8; y += (d < 0.01 ? -1 : dy / d) * (90 - d) * 0.8 }
      }
      const phase = (t * fly.pace + fly.b) % 1, glow = still ? (k % 3 === 0 ? 0.9 : 0) : phase < 0.4 ? Math.sin(phase / 0.4 * Math.PI) : 0
      if (glow >= 0.12) emit(x, y, glow > 0.7 ? '*' : glow > 0.35 ? '°' : '·', true, 0.45 + 0.55 * glow, false)
    }

    // Leaves off Watcher's tree on each gust.
    if (!still) for (const h of this.happenings) if (h.kind === 'gust') for (const leaf of h.leaves) {
      const s = t - h.t0 - leaf.delay
      if (s >= 0 && s <= 2.8) emit(leaf.x + 250 * s + 6 * s * s, leaf.y + 26 * s + 14 * Math.sin(s * 5 + leaf.turn) + 9 * s * s, ",'`."[Math.floor(s * 7 + leaf.turn) % 4]!, false, 0.75 - s * 0.2, false)
    }

    // The river runs toward the room, faster the busier it is.
    const flow = lerp(0.025, 0.085, busy)
    for (let k = 0; k < GLINTS; k++) {
      const offset = ((k * 37) % GLINTS) / GLINTS, share = (k / GLINTS + t * flow * (0.8 + 0.4 * offset)) % 1
      if (!still && (Math.floor(t * 2) + k * 5) % 7 === 0) continue
      const at = riverAt(g, share)
      emit(at.x + (offset - 0.5) * (4 + 14 * share), at.y, share > 0.6 ? '~' : share > 0.3 ? '-' : '·', true, 0.45 + 0.4 * offset, true)
    }

    // The wind: each blade of grass leans once the wind passes its own threshold, and the crowns sway a cell.
    if (!still && this.happenings.some(h => h.kind === 'gust')) {
      for (let c = 0; c < this.grass.length; c++) {
        const blade = this.grass[c]!
        if (this.windAt(blade.x, t) >= 0.3 + 0.6 * (((c * 53) % 97) / 97)) emit(blade.x, blade.y, '/', false, 0.5, true)
      }
      const land = this.land
      if (land !== null) for (const cell of this.crowns()) {
        if (this.windAt(cell.x, t) < 0.52 - 0.14 * cell.high) continue
        // The cell shows what stands to its left: the crown leans a cell with the wind.
        const code = land.code(cell.cell - 1)
        emit(cell.x, cell.y, code === 0 ? ' ' : String.fromCharCode(code), false, code === 0 ? 0.1 : land.strength(cell.cell - 1), true)
      }
    }

    // A cloud over the moon.
    if (!still) for (const h of this.happenings) {
      const age = t - h.t0
      if (h.kind !== 'cloud' || age < 0 || age > h.dur) continue
      const cx = h.x0 - 22 * age, shift = Math.floor(cx / cw), fade = Math.min(1, age / 1.5, (h.dur - age) / 1.5)
      for (let r = Math.floor((h.y - h.ry) / ch); r <= Math.ceil((h.y + h.ry) / ch); r++) for (let c = Math.floor((cx - h.rx) / cw); c <= Math.ceil((cx + h.rx) / cw); c++) {
        const x = (c + 0.5) * cw, y = (r + 0.5) * ch, dx = (x - cx) / h.rx, dy = (y - h.y) / h.ry
        // The cloud's own texture, which moves with it: the same cells of the cloud are thick or thin as it drifts.
        const grain = (((c - shift) * 73 + r * 151) % 101 + 101) % 101 / 101
        const thick = 1 - dx * dx - dy * dy - grain * 0.45 + 0.18 * Math.sin((c - shift) * 0.9 + r * 1.7)
        if (thick > 0.05) emit(x, y, thick > 0.55 ? '=' : thick > 0.3 ? '~' : thick > 0.15 ? '-' : '·', false, (0.24 + 0.3 * Math.min(1, thick)) * fade, true)
      }
    }

    // Mist between the hills, thicker the quieter the room.
    const thick = lerp(1.25, 0.35, busy)
    this.wisps.forEach((wisp, k) => {
      const span = W + 400, start = Math.floor(((((wisp.x0 - t * wisp.speed) % span) + span) % span - 200) / cw), row = Math.floor(wisp.y / ch)
      for (let j = 0; j < wisp.length; j++) {
        const taper = Math.sin(Math.PI * j / wisp.length)
        for (const [line, share] of [[0, 1], [1, 0.55]] as const) {
          const grain = ((j * 29 + (k * 2 + line) * 61) % 89) / 89
          if (grain > (0.25 + 0.5 * taper) * share * thick) continue
          const pick = ((j * 47 + (k * 2 + line) * 13) % 83) / 83
          emit((start + j + 0.5) * cw, (row + line + 0.5) * ch, pick < 0.4 ? '~' : pick < 0.75 ? '-' : '·', false, 0.2 + 0.14 * taper, false)
        }
      }
    })
  }
}
