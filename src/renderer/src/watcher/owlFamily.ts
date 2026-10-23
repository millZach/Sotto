import { along, clamp, glide, makeRoute, smooth, type Point, type SceneLayout, type Spot } from './nightScene'
import type { WatcherRoomState } from '../../../shared/watcherRoom'

/**
 * The thread owls in Watcher's night scene (Zach's picks on October 22, 2026, `prototype/watcher-owl-family`): one small
 * owl for each thread Watcher watches. They fill the limb across from Watcher's own owl first, then the branches of
 * Watcher's tree, then the ground; when there are more threads than spots, the last spot shows "+N". A new watched
 * thread's owl comes out of a whirlpool in the moon and flies down to its spot; a thread settled or no longer watched
 * sends its owl back up into the moon. With motion reduced, or where the margin has no trees, owls appear and fade
 * instead. Nothing here touches the DOM or a canvas.
 */

/** How a thread owl looks: awake while its thread works, asleep while it rests, glowing while it waits on you. */
export type OwlMood = 'awake' | 'asleep' | 'waiting'

/** A watched thread, as its owl needs it. */
export interface WatchedOwl {
  /** The thread's address on its host, which stays the same while the thread is watched. */
  readonly key: string
  readonly title: string
  /** The thread in this window, to open on a press; null when this window does not list it. */
  readonly threadId: string | null
  readonly mood: OwlMood
}

type WatchedRow = WatcherRoomState['watchedThreads'][number]

/**
 * A watched row's owl: glowing while a question or permission waits on you, awake while the thread works, and asleep
 * otherwise: idle, settled but still watched, failed, out of reach, or paused while your own turn there runs.
 */
export function moodOf(row: Pick<WatchedRow, 'status' | 'settled' | 'paused' | 'waitsOn'>): OwlMood {
  if (row.waitsOn.length > 0) return 'waiting'
  return row.status === 'running' && !row.settled && row.paused !== true ? 'awake' : 'asleep'
}

/** A watched row's key: its thread's address on its host. */
export function owlKey(target: WatchedRow['target']): string {
  return `${target.hostId}\u0000${target.threadId}`
}

/** What an owl is doing between spots. */
export type OwlAnimation =
  /** Out of the moon's whirlpool, which opens at `t0`, and down to its spot from `emerge`. */
  | { readonly kind: 'arrive'; readonly t0: number; readonly emerge: number; readonly dur: number }
  /** From the "+N" pile to a spot that freed up. */
  | { readonly kind: 'hop'; readonly t0: number; readonly from: Point; readonly dur: number }
  /** Up from where it sat into the moon. */
  | { readonly kind: 'leave'; readonly t0: number; readonly from: Point; readonly dur: number }
  /** Reduced motion, or no trees: it appears where it sits. */
  | { readonly kind: 'appear'; readonly t0: number; readonly dur: number }
  /** Reduced motion, or no trees: it fades from where it sat. */
  | { readonly kind: 'fade'; readonly t0: number; readonly dur: number }

export interface FamilyOwl {
  readonly key: string
  title: string
  threadId: string | null
  mood: OwlMood
  /** Its spot's index, -1 in the "+N" pile, null before it has one. */
  spot: number | null
  animation: OwlAnimation | null
  /** When it joined, so the oldest in the pile takes a spot first. */
  readonly order: number
}

/** The moon's whirlpool, open from `t0` and closing from `t1`. */
export interface Whirl { readonly t0: number; readonly t1: number }

/**
 * How owls come and go: `fly` from and back to the moon; `fade` in place, with motion reduced or no trees to fly
 * between; `still` at once, for a capture's fixed clock.
 */
export type FamilyMotion = 'fly' | 'fade' | 'still'

/** Arrivals together take turns out of the moon this far apart, in seconds; with motion reduced, closer. */
export const ARRIVAL_STAGGER = 0.45
export const FADE_STAGGER = 0.1
/** How long the whirlpool turns before a new owl comes out of it. */
export const EMERGE = 0.55
/** How long an owl takes to appear or fade with motion reduced. */
export const FADE = 0.6
/** How long a hop from the pile takes. */
export const HOP = 1.2
/** A thread owl's pace, in pixels a second, and the shortest and longest a flight takes. */
const OWL_SPEED = 190
const FLIGHT_TIME = [1.3, 3.4] as const

const flightTime = (a: Point, b: Point): number => clamp(Math.hypot(a.x - b.x, a.y - b.y) / OWL_SPEED, FLIGHT_TIME[0], FLIGHT_TIME[1])

/** When an animation ends. */
export function animationEnd(animation: OwlAnimation): number {
  return animation.kind === 'arrive' ? animation.emerge + animation.dur : animation.t0 + animation.dur
}

const leaving = (owl: Pick<FamilyOwl, 'animation'>): boolean => owl.animation?.kind === 'leave' || owl.animation?.kind === 'fade'

/**
 * Gives every staying owl the lowest free spot, the oldest first. A leaving owl keeps its spot until it has gone. When
 * the owls outnumber the free spots, the last spot holds the "+N" pile, and the owls with no spot wait in it. Returns
 * each owl's spot (-1 for the pile) and whether the pile shows.
 */
export function assignSpots(owls: readonly Pick<FamilyOwl, 'key' | 'spot' | 'order' | 'animation'>[], capacity: number): { readonly spots: ReadonlyMap<string, number>; readonly pile: boolean } {
  const held = new Set(owls.filter(owl => leaving(owl) && owl.spot !== null && owl.spot >= 0).map(owl => owl.spot!))
  const staying = owls.filter(owl => !leaving(owl))
  const free: number[] = []
  for (let k = 0; k < capacity; k++) if (!held.has(k)) free.push(k)
  const pile = staying.length > free.length && capacity > 0
  const usable = new Set(pile ? free.filter(k => k !== capacity - 1) : free)
  const spots = new Map<string, number>(), taken = new Set<number>(), waiting: typeof staying = []
  for (const owl of staying) {
    if (owl.spot !== null && owl.spot >= 0 && usable.has(owl.spot) && !taken.has(owl.spot)) { taken.add(owl.spot); spots.set(owl.key, owl.spot) }
    else waiting.push(owl)
  }
  const open = [...usable].filter(k => !taken.has(k)).sort((a, b) => a - b)
  for (const owl of [...waiting].sort((a, b) => a.order - b.order)) spots.set(owl.key, open.shift() ?? -1)
  for (const owl of owls) if (leaving(owl)) spots.set(owl.key, owl.spot ?? -1)
  return { spots, pile }
}

/** Where a thread owl is at one moment, and how it shows. */
export interface ThreadOwlPose {
  readonly owl: FamilyOwl
  readonly x: number
  readonly y: number
  readonly flying: boolean
  /** 0 to 1: coming out of the moon, fading with motion reduced, or going back in. */
  readonly alpha: number
}

/** The thread owls and the moon's whirlpool, across the room's updates. */
export class OwlFamily {
  owls: FamilyOwl[] = []
  whirls: Whirl[] = []
  private joined = 0
  private lastArrival = Number.NEGATIVE_INFINITY
  private placed = false
  /** How the last update said owls should move, for an owl that leaves the pile between updates. */
  private motion: FamilyMotion = 'fly'
  /** The pile's spot, worked out whenever the spots are, so a frame never works it out again for each owl. */
  private pileSpot: Spot | null = null

  constructor(private layout: SceneLayout) {}

  /** The last spot, while it holds the "+N" pile. */
  get marker(): Spot | null {
    return this.pileSpot
  }

  /** How many owls wait in the "+N" pile. */
  get pileCount(): number {
    return this.owls.filter(owl => !leaving(owl) && owl.spot === -1).length
  }

  /** Where an owl sits: its spot, or the pile's. */
  spotOf(owl: Pick<FamilyOwl, 'spot'>): Point | null {
    if (owl.spot !== null && owl.spot >= 0) return this.layout.spots[owl.spot] ?? null
    return this.marker
  }

  /**
   * Takes the room's watched threads now. New ones come out of the moon one after another, gone ones go back into it,
   * and the rest take their new titles and moods where they sit. The first call places every owl at once: a room that
   * opens with threads already watched shows them sitting. Returns when the moon's whirlpool opens for each flight, so
   * the scene can send out a ripple from it then.
   */
  update(watched: readonly WatchedOwl[], t: number, motion: FamilyMotion): number[] {
    const incoming = new Map(watched.map(owl => [owl.key, owl] as const))
    const whirlpools: number[] = []
    const instant = motion === 'still' || !this.placed
    this.motion = motion
    for (const owl of this.owls) {
      const next = incoming.get(owl.key)
      if (next !== undefined) {
        owl.title = next.title; owl.threadId = next.threadId; owl.mood = next.mood
        // Watched again on its way out: it turns back to the spot it still holds, or reappears there.
        if (leaving(owl)) {
          const at = this.poseOf(owl, t)
          owl.animation = motion === 'fly' && at !== null ? { kind: 'hop', t0: t, from: { x: at.x, y: at.y }, dur: HOP } : instant ? null : { kind: 'appear', t0: t, dur: FADE }
        }
        continue
      }
      if (leaving(owl)) continue
      if (instant || this.spotOf(owl) === null) { owl.animation = { kind: 'fade', t0: t, dur: 0 }; continue }
      if (motion === 'fade') { owl.animation = { kind: 'fade', t0: t, dur: FADE }; continue }
      const from = this.spotOf(owl)!, dur = flightTime(from, this.layout.moon)
      owl.animation = { kind: 'leave', t0: t, from, dur }
      this.whirls.push({ t0: t + dur - EMERGE, t1: t + dur + 0.15 })
      whirlpools.push(t + dur - EMERGE)
    }
    const known = new Set(this.owls.map(owl => owl.key))
    const arrivals: FamilyOwl[] = []
    for (const owl of watched) {
      if (known.has(owl.key)) continue
      const added: FamilyOwl = { key: owl.key, title: owl.title, threadId: owl.threadId, mood: owl.mood, spot: null, animation: null, order: this.joined++ }
      this.owls.push(added)
      arrivals.push(added)
    }
    this.reconcile(t, !instant)
    if (!instant) for (const owl of arrivals) {
      const target = this.spotOf(owl)
      if (target === null) continue
      const start = Math.max(t, this.lastArrival + (motion === 'fly' ? ARRIVAL_STAGGER : FADE_STAGGER))
      this.lastArrival = start
      if (motion === 'fade') { owl.animation = { kind: 'appear', t0: start, dur: FADE }; continue }
      owl.animation = { kind: 'arrive', t0: start, emerge: start + EMERGE, dur: flightTime(this.layout.moon, target) }
      this.whirls.push({ t0: start, t1: start + EMERGE + 0.5 })
      whirlpools.push(start)
    }
    this.placed = true
    this.step(t)
    return whirlpools
  }

  /** A new size for the room: every flight ends where it was going, and every owl keeps its spot while the spot exists. */
  relayout(layout: SceneLayout, t: number): void {
    this.layout = layout
    this.owls = this.owls.filter(owl => !leaving(owl))
    for (const owl of this.owls) owl.animation = null
    this.whirls = []
    this.lastArrival = Number.NEGATIVE_INFINITY
    this.reconcile(t, false)
  }

  /** Ends what has finished at `t`: an owl gone into the moon leaves the family, and its spot goes to the pile's oldest. */
  step(t: number): void {
    let gone = false
    for (const owl of this.owls) if (owl.animation !== null && t >= animationEnd(owl.animation)) {
      if (leaving(owl)) { gone = true; continue }
      owl.animation = null
    }
    if (gone) { this.owls = this.owls.filter(owl => !(leaving(owl) && t >= animationEnd(owl.animation!))); this.reconcile(t, true) }
    this.whirls = this.whirls.filter(whirl => t <= whirl.t1 + 0.6)
  }

  /** Whether anything moves at `t`: an owl flying, appearing or fading, or the whirlpool turning. */
  moving(t: number): boolean {
    return this.owls.some(owl => owl.animation !== null && t < animationEnd(owl.animation)) || this.whirl(t) > 0.01
      || this.owls.some(owl => owl.animation?.kind === 'arrive' && t < owl.animation.t0)
  }

  /** How open the moon's whirlpool is at `t`, 0 to 1. */
  whirl(t: number): number {
    let open = 0
    for (const whirl of this.whirls) open = Math.max(open, smooth(whirl.t0, whirl.t0 + 0.45, t) * (1 - smooth(whirl.t1, whirl.t1 + 0.6, t)))
    return open
  }

  /** The newest owl coming out of the moon at `t`, with when it started: Watcher's owl watches it. */
  newcomer(t: number): { readonly at: Point; readonly since: number } | null {
    let newest: FamilyOwl | null = null
    for (const owl of this.owls) if (owl.animation?.kind === 'arrive' && t >= owl.animation.t0 && t < animationEnd(owl.animation)
      && (newest === null || owl.animation.t0 > (newest.animation as { t0: number }).t0)) newest = owl
    if (newest === null || newest.animation?.kind !== 'arrive') return null
    const pose = t < newest.animation.emerge ? null : this.poseOf(newest, t)
    return { at: pose ?? this.layout.moon, since: newest.animation.t0 }
  }

  /** Every owl that shows at `t`, where it is. */
  poses(t: number): ThreadOwlPose[] {
    const out: ThreadOwlPose[] = []
    for (const owl of this.owls) { const pose = this.poseOf(owl, t); if (pose !== null && pose.alpha > 0.02) out.push(pose) }
    return out
  }

  private poseOf(owl: FamilyOwl, t: number): ThreadOwlPose | null {
    const a = owl.animation, target = this.spotOf(owl), moon = this.layout.moon
    const sits = (alpha: number): ThreadOwlPose | null => target !== null && owl.spot !== null && owl.spot >= 0 ? { owl, x: target.x, y: target.y, flying: false, alpha } : null
    if (a === null) return sits(1)
    const k = clamp((t - a.t0) / Math.max(0.001, a.dur), 0, 1)
    if (a.kind === 'appear') return t < a.t0 ? null : sits(smooth(0, 1, k))
    if (a.kind === 'fade') return sits(1 - smooth(0, 1, k))
    if (a.kind === 'arrive') {
      if (t < a.emerge || target === null) return null
      const u = clamp((t - a.emerge) / a.dur, 0, 1)
      const p = along(makeRoute([{ x: moon.x, y: moon.y }, { x: moon.x + (target.x - moon.x) * 0.25, y: moon.y + 34 }, { x: target.x, y: target.y - 46 }, target]), glide(u))
      const toPile = owl.spot === -1
      return { owl, x: p.x, y: p.y, flying: u < 0.97, alpha: smooth(0, 0.2, u) * (toPile ? 1 - smooth(0.85, 1, u) : 1) }
    }
    if (a.kind === 'hop') {
      if (target === null) return null
      const p = along(makeRoute([a.from, { x: (a.from.x + target.x) / 2, y: Math.min(a.from.y, target.y) - 50 }, target]), glide(k))
      return { owl, x: p.x, y: p.y, flying: k < 0.97, alpha: 1 }
    }
    const p = along(makeRoute([a.from, { x: a.from.x, y: a.from.y - 46 }, { x: a.from.x + (moon.x - a.from.x) * 0.75, y: moon.y + 36 }, { x: moon.x, y: moon.y }]), glide(k))
    return { owl, x: p.x, y: p.y, flying: k > 0.03, alpha: 1 - smooth(0.82, 1, k) }
  }

  private reconcile(t: number, animate: boolean): void {
    const was = new Map(this.owls.map(owl => [owl.key, owl.spot] as const))
    const capacity = this.layout.spots.length
    const { spots, pile } = assignSpots(this.owls, capacity)
    const from = this.pileSpot
    this.pileSpot = pile ? this.layout.spots[capacity - 1]! : null
    for (const owl of this.owls) {
      owl.spot = spots.get(owl.key) ?? -1
      // An owl that waited in the pile hops from it to the spot that freed up, or with motion reduced appears there.
      if (animate && was.get(owl.key) === -1 && owl.spot >= 0 && owl.animation === null) {
        owl.animation = from === null || this.motion !== 'fly' ? { kind: 'appear', t0: t, dur: FADE } : { kind: 'hop', t0: t, from, dur: HOP }
      }
    }
  }
}

// ---------- How a thread owl is drawn ----------

/** A thread owl sitting: face, body and feet, five glyphs wide. */
export const PERCHED_OWL = ['{o,o}', '/)__)', ' " " '] as const
/** Flying: the wings take the face's row, in three beats. */
export const FLYING_OWL = [['\\{o,o}/', ' (__) '], ['-{o,o}-', ' (__) '], ['/{o,o}\\', ' (__) ']] as const
/** On the rail, a thread owl is its eyes: two glyphs, so they fit the smallest window's 16-pixel margins. */
export const RAIL_OWL = 'oo'

/**
 * The "+N" pile's label. On the rail, which has room for two glyphs, more than nine reads "9+", so it never shows a
 * cut-off number.
 */
export function pileLabel(count: number, rail: boolean): string {
  return rail && count > 9 ? '9+' : `+${count}`
}

/** Whether a working owl is mid-blink at `t`: about once every six seconds, each at its own moment. */
export function blinking(order: number, t: number): boolean {
  return (t + order * 1.37) % 6.1 < 0.15
}

/** The glow's step at `t` for an owl waiting on you: four steps of a slow pulse, or the middle one held still. */
export function glowStep(t: number, still: boolean): number {
  return still ? 0.5 : Math.round((0.5 + 0.5 * Math.sin(t * Math.PI * 2 / 1.8)) * 3) / 3
}

/** A thread owl's eyes at `t`: shut while asleep or mid-blink, round and wide while it waits on the user. */
export function owlEyes(owl: { readonly mood: OwlMood; readonly order: number }, t: number, canBlink: boolean): string {
  const shut = owl.mood === 'asleep' || (owl.mood === 'awake' && canBlink && blinking(owl.order, t))
  return shut ? '-' : owl.mood === 'waiting' ? 'O' : 'o'
}

/** A perched thread owl's glyphs with these eyes, rows top to bottom. */
export function perchedGlyphs(eyes: string): string[] {
  return [PERCHED_OWL[0].replace(/o/g, eyes), PERCHED_OWL[1], PERCHED_OWL[2]]
}

/** The glyphs for a thread owl at `t`, rows top to bottom. */
export function owlGlyphs(pose: Pick<ThreadOwlPose, 'flying' | 'owl'>, t: number, options: { readonly rail: boolean; readonly still: boolean }): string[] {
  const { owl } = pose
  const eyes = owlEyes(owl, t, !options.still && !pose.flying)
  if (options.rail) return [RAIL_OWL.replace(/o/g, eyes)]
  if (pose.flying) { const beat = FLYING_OWL[Math.floor(t * 8 + owl.order) % 3]!; return [beat[0].replace(/o/g, eyes), beat[1]] }
  return perchedGlyphs(eyes)
}

/** The cells a sprite covers, its feet at `x`, `y`: its first column and row, and its size in cells. */
export function spriteCells(lines: readonly string[], x: number, y: number, cell: { readonly w: number; readonly h: number }): { readonly c0: number; readonly r0: number; readonly w: number; readonly n: number } {
  const w = Math.max(...lines.map(line => line.length)), n = lines.length
  return { c0: Math.round(x / cell.w - w / 2), r0: Math.floor((y - 1) / cell.h) - n + 1, w, n }
}
