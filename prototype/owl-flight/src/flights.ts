/**
 * PROTOTYPE (prototype/owl-flight): Watcher's owl's flight, today's and the candidates. Each model answers one question:
 * where the owl is at `t`, and in what pose. Drawing stays the real painter's (`nightScenePainter.ts`): these only feed
 * it an `OwlPose`, as `owlAt` does in the app.
 */
import {
  along, clamp, lerp, makeRoute, owlAt, placeOf, planFlight, smooth,
  type OwlPlace, type OwlPose, type OwlStage, type Point, type Route, type SceneLayout, type Side,
} from '../../../src/renderer/src/watcher/nightScene'

/** One leg of the loop: from a place to a place, and the composer branch it leaves or lands on. */
export interface Trip { readonly from: OwlPlace; readonly fromSide: Side; readonly to: OwlPlace; readonly toSide: Side }
export interface Flown { readonly pose: OwlPose; readonly stage: OwlStage; readonly phase: string }
export interface Plan { readonly dur: number; at(t: number): Flown }
export type Lock = 'none' | 'half' | 'cell'
export interface Options { readonly reduced: boolean; readonly lock: Lock }
export interface Model {
  readonly id: string
  readonly name: string
  readonly idea: string
  /** Whether the painter's flight polish applies (today's model draws as today). */
  readonly polish: boolean
  plan(layout: SceneLayout, trip: Trip, t0: number, options: Options): Plan
}

/** The loop every panel flies, in the order the app's `nextPlace` can take it. */
export const TRIPS: readonly Trip[] = [
  { from: 'home', fromSide: 'left', to: 'tree', toSide: 'left' },
  { from: 'tree', fromSide: 'left', to: 'home', toSide: 'left' },
  { from: 'home', fromSide: 'left', to: 'composer', toSide: 'left' },
  { from: 'composer', fromSide: 'left', to: 'home', toSide: 'left' },
  { from: 'home', fromSide: 'left', to: 'tree', toSide: 'left' },
  { from: 'tree', fromSide: 'left', to: 'composer', toSide: 'right' },
  { from: 'composer', fromSide: 'right', to: 'home', toSide: 'left' },
]

const basePose = (layout: SceneLayout): { -readonly [K in keyof OwlPose]: OwlPose[K] } =>
  ({ x: 0, y: 0, s: layout.s, bank: 0, squash: 1, spread: 0, flap: 0, turn: 0, gx: 0, gy: 0, blink: false, legs: 0 })

function perched(layout: SceneLayout, place: OwlPlace, side: Side, t: number, turn = 0): Flown {
  const at = placeOf(layout, place, side)
  // The app's own perched pose, idle turns and blinks included, moved to where this owl sits.
  const { pose } = owlAt(t, layout, { at: 'home', side: 'left', flight: null, next: Infinity }, { still: false })
  return { pose: { ...pose, x: at.x, y: at.y, turn: turn === 0 ? pose.turn : turn }, stage: 'perched', phase: 'perched' }
}

// ---------- Today ----------

export const TODAY: Model = {
  id: 'today', name: 'Today', idea: 'One eased arc past the moon, a steady sine flap the whole way.', polish: false,
  plan(layout, trip, t0, options) {
    if (options.reduced) {
      // Today, with motion reduced, the owl never leaves home.
      return { dur: 3, at: t => ({ ...perched(layout, 'home', 'left', t), phase: 'stays home' }) }
    }
    const flight = planFlight(layout, { at: trip.from, side: trip.fromSide }, trip.to, t0)
    return {
      dur: flight.dur,
      at: t => {
        const landed = t >= flight.t0 + flight.dur
        const { pose, stage } = owlAt(t, layout, landed ? { at: trip.to, side: flight.side, flight: null, next: Infinity } : { at: trip.from, side: trip.fromSide, flight, next: Infinity }, { still: false })
        return { pose, stage, phase: 'flying' }
      },
    }
  },
}

// ---------- The candidates' shared body ----------

/** A wingbeat's key frames: flap angle (the painter's `flap`), how far the wing is spread, and how long it holds. */
interface Key { readonly flap: number; readonly spread: number; readonly hold: number }
/**
 * Seven frames: wings high, two quick downstroke frames, the bottom, and three slower upstroke frames with the wing
 * part-folded, as an owl's upstroke is. The downstroke takes about a third of the beat.
 */
const BEAT: readonly Key[] = [
  { flap: 1.2, spread: 0.86, hold: 1.0 },
  { flap: 0.5, spread: 1.0, hold: 0.55 },
  { flap: -0.3, spread: 1.06, hold: 0.55 },
  { flap: -0.95, spread: 0.98, hold: 0.85 },
  { flap: -0.5, spread: 0.74, hold: 1.1 },
  { flap: 0.2, spread: 0.66, hold: 1.1 },
  { flap: 0.8, spread: 0.74, hold: 1.0 },
]
const BEAT_HOLD = BEAT.reduce((sum, key) => sum + key.hold, 0)
/** Wings spread and still: a slight lift at the tips, and wider than in a beat. */
const GLIDE_KEY = { flap: 0.22, spread: 1.16 }
/** Wings up and forward to brake. */
const FLARE_KEY = { flap: 1.15, spread: 1.0 }

function beatKey(phase: number): Key {
  let at = (phase - Math.floor(phase)) * BEAT_HOLD
  for (const key of BEAT) { if (at < key.hold) return key; at -= key.hold }
  return BEAT[0]!
}

/** A piece of a flight's wingwork, in seconds from the flight's start. */
interface Wingwork { readonly beats: number; readonly hz: number; readonly depth: number }

interface Shape {
  /** The path's points, owl's feet, from the perch it leaves to the perch it lands on. */
  points(layout: SceneLayout, a: Point, b: Point, dir: number, trip: Trip): Point[]
  /** Pixels a second, on average, and the shortest and longest a flight may take. */
  readonly pace: number
  readonly time: readonly [number, number]
  /** Beats off the perch, beats on the approach, and how they are made. Between them it glides. */
  readonly climb: Wingwork
  readonly approach: Wingwork
  /** Beats through the glide too: the slow majestic flight never quite stops beating. */
  readonly cruise?: Wingwork
  /** How far the glide's slow wobble lifts and drops the owl, in owl units. */
  readonly wobble: number
}

const CROUCH = 0.16
const FOLD = 0.34
/** Where the flare starts, as a share of the flight's time. */
const FLARE_AT = 0.84

/** Relative speed over the flight's time: a push off the perch, a cruise, a long braking approach that reaches nearly nothing. */
const speed = (k: number): number => lerp(0.3, 1, smooth(0, 0.2, k)) * (1 - 0.8 * smooth(0.66, 1, k))

/** The share of the way at each share of the time, from the speed above, in 200 steps. */
const PROGRESS = (() => {
  const n = 200, out = new Float32Array(n + 1)
  let sum = 0
  for (let j = 1; j <= n; j++) { sum += speed((j - 0.5) / n); out[j] = sum }
  for (let j = 0; j <= n; j++) out[j] = out[j]! / sum
  return out
})()
const progress = (k: number): number => {
  const x = clamp(k, 0, 1) * 200, j = Math.min(199, Math.floor(x))
  return lerp(PROGRESS[j]!, PROGRESS[j + 1]!, x - j)
}

/** Holds a value to a few steps between `a` and `b`, so a change shows as distinct frames rather than a smear. */
const stepped = (a: number, b: number, k: number, steps: number): number => lerp(a, b, Math.round(clamp(k, 0, 1) * steps) / steps)

function heading(route: Route, u: number): number {
  const p = along(route, Math.max(0, u - 0.012)), q = along(route, Math.min(1, u + 0.012))
  return Math.atan2(q.y - p.y, q.x - p.x)
}

/** How hard the path turns at `u`, in radians per share of the way, averaged over a short stretch. */
function turning(route: Route, u: number): number {
  let sum = 0
  for (const du of [-0.03, 0, 0.03]) {
    const at = clamp(u + du, 0.02, 0.98)
    let d = heading(route, at + 0.015) - heading(route, at - 0.015)
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    sum += d / 0.03
  }
  return sum / 3
}

function lockTo(lock: Lock, layout: SceneLayout, anchor: Point, p: Point): Point {
  if (lock === 'none') return p
  const cw = lock === 'half' ? 3.5 : 7, ch = lock === 'half' ? 6 : 12
  void layout
  return { x: anchor.x + Math.round((p.x - anchor.x) / cw) * cw, y: anchor.y + Math.round((p.y - anchor.y) / ch) * ch }
}

/** One hop from perch to perch along a shape: crouch, push off, beat, glide, beat, flare, land and fold. */
function hop(layout: SceneLayout, shape: Shape, trip: Trip, t0: number, options: Options): Plan {
  const a = placeOf(layout, trip.from, trip.fromSide), b = placeOf(layout, trip.to, trip.toSide), s = layout.s
  const dir = Math.sign(b.x - a.x) || 1
  const route = makeRoute(shape.points(layout, a, b, dir, trip))
  const D = clamp(route.length / shape.pace, shape.time[0], shape.time[1])
  const dur = CROUCH + D + FOLD
  const climbEnd = shape.climb.beats / shape.climb.hz
  const flareAt = FLARE_AT * D, approachStart = flareAt - shape.approach.beats / shape.approach.hz
  const wobblePhase = (a.x * 0.013) % (2 * Math.PI)

  if (options.reduced) {
    // Reduced motion: a few calm steps along the same path, wings spread and still, no beat, no bank, no wobble.
    const steps = [0.36, 0.7], hold = 0.7
    return {
      dur: hold * (steps.length + 1),
      at: t => {
        const j = Math.floor((t - t0) / hold)
        if (j <= 0) return { ...perched(layout, trip.from, trip.fromSide, t, dir * 0.6), phase: 'step 0' }
        if (j > steps.length) return { ...perched(layout, trip.to, trip.toSide, t), phase: 'landed' }
        const p = along(route, steps[j - 1]!)
        const pose = basePose(layout)
        pose.x = p.x; pose.y = p.y; pose.flap = GLIDE_KEY.flap; pose.spread = 1; pose.gy = 0.6; pose.gx = dir * 0.5; pose.turn = dir * 0.25
        return { pose, stage: 'flying', phase: `step ${j}` }
      },
    }
  }

  return {
    dur,
    at: t => {
      const local = t - t0
      if (local < CROUCH) {
        // Crouch: the body dips and the head turns to where it is going.
        const f = perched(layout, trip.from, trip.fromSide, t, dir * 0.5)
        return { pose: { ...f.pose, squash: 1 - 0.1 * Math.sin(local / CROUCH * Math.PI * 0.5), blink: false }, stage: 'perched', phase: 'crouch' }
      }
      const pose = basePose(layout)
      if (local >= CROUCH + D) {
        // Landed: wings fold in three frames, the legs take the weight, the body settles with one small bob.
        const k = (local - CROUCH - D) / FOLD
        if (k >= 1) return { ...perched(layout, trip.to, trip.toSide, t), phase: 'landed' }
        pose.x = b.x; pose.y = b.y
        pose.spread = stepped(0.95, 0.06, k, 3)
        pose.flap = stepped(FLARE_KEY.flap, 0.5, k, 3)
        pose.legs = 1 - smooth(0.5, 1, k)
        pose.squash = 1 - 0.08 * Math.sin(k * Math.PI)
        pose.gy = 0.3
        return { pose, stage: 'flying', phase: 'fold' }
      }
      const ft = local - CROUCH, k = ft / D
      const u = progress(k)
      const p = along(route, u)
      // Wingwork: beats off the perch, a glide (or a slow cruise beat), beats on approach, then the flare.
      let key: { flap: number; spread: number }, phase: string, gliding = 0
      if (ft < climbEnd) {
        const beat = beatKey(ft * shape.climb.hz)
        key = { flap: beat.flap * shape.climb.depth, spread: beat.spread }; phase = 'climb'
      } else if (ft >= flareAt) {
        const f = (ft - flareAt) / (D - flareAt)
        key = { flap: stepped(GLIDE_KEY.flap, FLARE_KEY.flap, f * 1.6, 3), spread: FLARE_KEY.spread }; phase = 'flare'
      } else if (ft >= approachStart) {
        const beat = beatKey((ft - approachStart) * shape.approach.hz)
        key = { flap: beat.flap * shape.approach.depth + 0.15, spread: beat.spread }; phase = 'approach'
      } else if (shape.cruise !== undefined) {
        const beat = beatKey((ft - climbEnd) * shape.cruise.hz)
        key = { flap: beat.flap * shape.cruise.depth, spread: beat.spread * 1.08 }; phase = 'cruise'; gliding = 0.4
      } else {
        // Into the glide in two frames from the last beat's top, so the wings settle rather than snap.
        const into = ft - climbEnd
        key = into < 0.1 ? { flap: lerp(BEAT[0]!.flap, GLIDE_KEY.flap, into < 0.05 ? 0.35 : 0.7), spread: 1.05 } : GLIDE_KEY
        phase = 'glide'; gliding = 1
      }
      // A slow wobble while gliding, and a bank into every turn, held off near the perches.
      const away = smooth(0, 0.15, k) * (1 - smooth(0.78, 0.95, k))
      const wob = Math.sin(local * 2 * Math.PI * 0.55 + wobblePhase)
      const y = p.y + wob * shape.wobble * s * gliding * away
      const v = speed(k)
      // Held to steps of about three degrees, so a straight stretch keeps one drawing and a turn leans in a few frames.
      pose.bank = Math.round(clamp(-turning(route, u) * 0.06 * v * away, -0.32, 0.32) / 0.05) * 0.05
      const at = lockTo(options.lock, layout, b, { x: p.x, y })
      pose.x = at.x; pose.y = at.y
      pose.flap = key.flap; pose.spread = key.spread
      pose.legs = smooth(0.8, 1, k)
      pose.squash = stepped(1, 0.93, smooth(FLARE_AT, 1, k), 2)
      pose.turn = dir * 0.25 * (1 - smooth(0.9, 1, k)); pose.gx = dir * 0.6; pose.gy = 0.6
      return { pose, stage: 'flying', phase }
    },
  }
}

/** Two hops with a rest between, on the composer branch nearest the perch it leaves. */
function twoHops(layout: SceneLayout, shape: Shape, trip: Trip, t0: number, options: Options): Plan {
  const crossing = (trip.from === 'home' && trip.to === 'tree') || (trip.from === 'tree' && trip.to === 'home')
  if (!crossing) return hop(layout, shape, trip, t0, options)
  const side: Side = trip.from === 'home' ? 'left' : 'right'
  const first = hop(layout, shape, { from: trip.from, fromSide: trip.fromSide, to: 'composer', toSide: side }, t0, options)
  const rest = 0.9
  const second = hop(layout, shape, { from: 'composer', fromSide: side, to: trip.to, toSide: trip.toSide }, t0 + first.dur + rest, options)
  const dir = trip.to === 'tree' ? 1 : -1
  return {
    dur: first.dur + rest + second.dur,
    at: t => {
      const local = t - t0
      if (local < first.dur) return first.at(t)
      if (local < first.dur + rest) return { ...perched(layout, 'composer', side, t, dir * 0.7), phase: 'rest' }
      return second.at(t)
    },
  }
}

const span = (a: Point, b: Point): number => Math.abs(b.x - a.x)

/** A high arc, its top a quarter of its span over the higher perch, coming in from just under the perch it lands on. */
function arcPoints(lift: number, top: number, at: number): Shape['points'] {
  return (layout, a, b, dir) => {
    const d = span(a, b), s = layout.s, h = clamp(d * top, 26 * s, 150 * s)
    const high = Math.max(layout.header + 34, Math.min(a.y, b.y) - h)
    return [
      a,
      { x: a.x + dir * 16 * s, y: a.y + 3 * s },
      { x: a.x + dir * d * 0.14, y: lerp(a.y, high, lift) },
      { x: a.x + dir * d * at, y: high },
      { x: b.x - dir * d * 0.2, y: lerp(high, b.y, 0.82) + 10 * s },
      { x: b.x - dir * 22 * s, y: b.y + 7 * s },
      b,
    ]
  }
}

export const GLIDE_ARC: Model = {
  id: 'glide', name: 'A · Glide arc', idea: 'Three beats off the branch, then one long silent glide with a slow wobble; two short beats and a flare to land.', polish: true,
  plan: (layout, trip, t0, options) => hop(layout, {
    points: arcPoints(0.55, 0.24, 0.5), pace: 225, time: [1.7, 6],
    climb: { beats: 3, hz: 2.3, depth: 1 }, approach: { beats: 2, hz: 2.8, depth: 0.55 }, wobble: 3,
  }, trip, t0, options),
}

export const CLIMB_GLIDE: Model = {
  id: 'climb', name: 'B · Climb, then glide', idea: 'Beats hard up to a high point early, then glides the long way down and swoops up onto the perch.', polish: true,
  plan: (layout, trip, t0, options) => hop(layout, {
    points: (layout, a, b, dir) => {
      const d = span(a, b), s = layout.s, h = clamp(d * 0.32, 30 * s, 170 * s)
      const high = Math.max(layout.header + 30, Math.min(a.y, b.y) - h)
      return [a, { x: a.x + dir * 14 * s, y: a.y + 2 * s }, { x: a.x + dir * d * 0.16, y: lerp(a.y, high, 0.75) }, { x: a.x + dir * d * 0.33, y: high },
        { x: a.x + dir * d * 0.7, y: lerp(high, b.y, 0.85) + 18 * s }, { x: b.x - dir * 24 * s, y: b.y + 10 * s }, b]
    },
    pace: 235, time: [1.7, 6],
    climb: { beats: 5, hz: 2.4, depth: 1.05 }, approach: { beats: 2, hz: 2.8, depth: 0.5 }, wobble: 2.5,
  }, trip, t0, options),
}

export const LOW_SWOOP: Model = {
  id: 'swoop', name: 'C · Low swoop', idea: 'Drops off the branch, swoops low under the moon banking through the dip, and rises onto the perch, the climb doing the braking.', polish: true,
  plan: (layout, trip, t0, options) => hop(layout, {
    points: (layout, a, b, dir) => {
      const d = span(a, b), s = layout.s
      const floor = layout.composer.y - 30 * s
      const low = Math.min(floor, Math.max(a.y, b.y) + clamp(d * 0.16, 14 * s, 90 * s))
      return [a, { x: a.x + dir * 18 * s, y: a.y + 10 * s }, { x: a.x + dir * d * 0.22, y: lerp(a.y, low, 0.75) }, { x: a.x + dir * d * 0.5, y: low },
        { x: a.x + dir * d * 0.78, y: lerp(low, b.y, 0.7) }, { x: b.x - dir * 20 * s, y: b.y + 6 * s }, b]
    },
    pace: 240, time: [1.6, 5.5],
    climb: { beats: 2, hz: 2.4, depth: 0.9 }, approach: { beats: 2, hz: 2.6, depth: 0.6 }, wobble: 1.5,
  }, trip, t0, options),
}

export const TWO_HOPS: Model = {
  id: 'hops', name: 'D · Two hops', idea: 'Crosses the room in two short hops, resting a moment on the composer\'s branch and looking ahead before going on.', polish: true,
  plan: (layout, trip, t0, options) => twoHops(layout, {
    points: arcPoints(0.6, 0.3, 0.5), pace: 215, time: [1.4, 4.2],
    climb: { beats: 3, hz: 2.4, depth: 1 }, approach: { beats: 1, hz: 2.8, depth: 0.55 }, wobble: 2,
  }, trip, t0, options),
}

export const MAJESTIC: Model = {
  id: 'majestic', name: 'E · Slow, deep beats', idea: 'A slower crossing high past the moon on deep, unhurried beats the whole way, wings at their widest.', polish: true,
  plan: (layout, trip, t0, options) => hop(layout, {
    points: (layout, a, b, dir, trip) => {
      const base = arcPoints(0.55, 0.3, 0.5)(layout, a, b, dir, trip)
      const crossing = span(a, b) > layout.width * 0.4
      if (!crossing) return base
      // Past the moon, as today's flight is.
      const m = layout.moon, top = base[3]!
      const past = { x: m.x - dir * m.r * 0.6, y: m.y + m.r * 0.9 }
      return dir > 0 ? [...base.slice(0, 3), { x: (base[2]!.x + past.x) / 2, y: Math.min(top.y, past.y) }, past, ...base.slice(4)] : [...base.slice(0, 3), past, { x: (past.x + base[4]!.x) / 2, y: Math.min(top.y, past.y) }, ...base.slice(4)]
    },
    pace: 170, time: [2.2, 7.5],
    climb: { beats: 2, hz: 1.7, depth: 1.1 }, cruise: { beats: 0, hz: 1.45, depth: 0.85 }, approach: { beats: 2, hz: 2.2, depth: 0.6 }, wobble: 2,
  }, trip, t0, options),
}

export const MODELS: readonly Model[] = [TODAY, GLIDE_ARC, CLIMB_GLIDE, LOW_SWOOP, TWO_HOPS, MAJESTIC]
