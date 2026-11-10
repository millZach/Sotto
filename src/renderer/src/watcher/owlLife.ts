import { CELL, clamp, type OwlPlace, type Point, type SceneLayout } from './nightScene'
import { fidgetHop, type OwlAct, type OwlActKind, type OwlLivesView, type OwlMood, type ThreadOwlPose, type WatchedOwl } from './owlFamily'
import type { AmbientGlyph } from './scenePlace'

/**
 * The thread owls' lives in Watcher's living night scene (ADR-0199, decisions 6 and 7; Zach's pick E on November 10,
 * 2026, of the prototype kept at the tag `prototype/watcher-scene-life`): what each owl is doing for a moment, the few
 * glyphs round the owls that say what their threads are doing, and what a change in the room's watched threads sets
 * off. `owlFamily.ts` draws the poses themselves. Nothing here touches the DOM or a canvas, and nothing grows with the
 * room's history: it holds one act an owl, a few passing things, and what each watched thread was when last looked at.
 */

/** Sparks round an owl whose turn finished, or a note called from one owl to another. */
export type Passing =
  | { readonly kind: 'sparks'; readonly t0: number; readonly dur: number; readonly at: Point; readonly spin: number }
  | { readonly kind: 'call'; readonly t0: number; readonly dur: number; readonly from: Point; readonly to: Point; readonly accent: boolean }

/** At most this many sparks and calls at once; the oldest goes first. */
export const MOST_PASSING = 8
/** Sparks in one burst, and how long it lasts, in seconds. */
export const SPARKS = 12
export const SPARKS_LIFE = 1.2
/** A call's pace in pixels a second, and the shortest and longest it takes to cross. */
const CALL_SPEED = 300, CALL_TIME = [0.7, 1.5] as const
/** How high over the straight line between the two owls a call arcs. */
const CALL_LIFT = 50
/** How often a spark or a call steps while it crosses, a second. */
export const QUICK_STEPS = 24
/** A sleeper's `z`s: how long one rise takes of each cycle, in seconds. */
const SLEEP_CYCLE = 5.6, SLEEP_RISE = 2.9

/** What each watched thread was when the scene last took the room's threads. */
interface Known { readonly mood: OwlMood; readonly failed: boolean; readonly told: number; readonly settled: boolean }

/**
 * What changed in the room's watched threads since they were last taken, by owl: the threads Watcher has sent a
 * message, those whose turn finished without failing, those whose turn failed, and those whose work settled.
 */
export interface RoomNews { readonly told: string[]; readonly finished: string[]; readonly failed: string[]; readonly settled: string[] }

export class OwlLives implements OwlLivesView {
  watcherFlying = false
  private readonly acts = new Map<string, OwlAct>()
  private passing: Passing[] = []
  private readonly known = new Map<string, Known>()

  /** An owl does something from `t0` for `dur` seconds, in place of whatever it was doing. */
  act(key: string, kind: OwlActKind, t0: number, dur: number): void {
    this.acts.set(key, { kind, t0, dur })
  }

  actOf(key: string, t: number): OwlAct | null {
    const act = this.acts.get(key)
    return act !== undefined && t >= act.t0 && t < act.t0 + act.dur ? act : null
  }

  /** A burst of sparks round the owl sitting at `at`. */
  sparks(at: Point, t: number): void {
    this.pass({ kind: 'sparks', t0: t, dur: SPARKS_LIFE, at, spin: (at.x * 0.37 + at.y * 0.11) % 6.28 })
  }

  /** A note called from one owl's head to another's, from `t`. Returns how long it takes to cross, in seconds. */
  call(from: Point, to: Point, t: number, accent: boolean): number {
    const dur = clamp(Math.hypot(to.x - from.x, to.y - from.y) / CALL_SPEED, CALL_TIME[0], CALL_TIME[1])
    this.pass({ kind: 'call', t0: t, dur, from, to, accent })
    return dur
  }

  private pass(passing: Passing): void {
    this.passing = [...this.passing, passing].slice(-MOST_PASSING)
  }

  /** Drops what has finished at `t`. */
  step(t: number): void {
    for (const [key, act] of this.acts) if (t >= act.t0 + act.dur) this.acts.delete(key)
    if (this.passing.some(passing => t > passing.t0 + passing.dur)) this.passing = this.passing.filter(passing => t <= passing.t0 + passing.dur)
  }

  /** Whether a spark or a call is crossing at `t`, or about to: the scene draws more often while one does. */
  quick(t: number): boolean {
    return this.passing.some(passing => t <= passing.t0 + passing.dur)
  }

  /** Whether an owl is mid-act at `t`, or something is crossing. */
  moving(t: number): boolean {
    if (this.quick(t)) return true
    for (const act of this.acts.values()) if (t < act.t0 + act.dur) return true
    return false
  }

  /**
   * What the glyphs round the owls show at `t`, in a few characters: it changes only when the picture would, so a
   * resting scene is painted again when a `z` rises or a `?` bobs and not between. A spark or a call steps it
   * QUICK_STEPS times a second while it crosses. Holding still it never changes.
   */
  stepOf(poses: readonly ThreadOwlPose[], t: number, still: boolean): string {
    if (still) return ''
    let out = this.quick(t) ? `q${Math.floor(t * QUICK_STEPS)}` : ''
    for (const pose of poses) {
      if (pose.flying || pose.alpha < 0.9 || pose.owl.animation !== null) continue
      if (pose.owl.mood === 'waiting') out += Math.floor(t * 2) % 2 === 1 ? 'W' : 'w'
      else if (pose.owl.mood === 'asleep' && !pose.owl.failed) out += sleepStage(pose.owl.order, t)
    }
    return out
  }

  /** A sitting owl a row higher for a moment: a hop, of its own, in a happy moment, or while it waits on the user. */
  lifted(pose: ThreadOwlPose, t: number): ThreadOwlPose {
    if (pose.flying || pose.owl.animation !== null) return pose
    const act = this.actOf(pose.owl.key, t)
    const up = act !== null ? act.kind === 'hop' || (act.kind === 'happy' && Math.floor((t - act.t0) * 4) % 4 === 1)
      : pose.owl.failed ? false
      : pose.owl.mood === 'waiting' ? Math.floor(t * 3) % 12 === 6
      : pose.owl.mood === 'awake' && !this.watcherFlying && fidgetHop(pose.owl.order, t)
    return up ? { ...pose, y: pose.y - CELL.h } : pose
  }

  /**
   * Takes the room's watched threads as they are at `t` and starts what a change calls for: an owl whose thread starts
   * working again wakes with a stretch, one whose question was answered is happy for a moment, and one whose turn
   * finished, without failing, gets sparks and a happy moment before it sleeps. `perch` says where an owl sits now, or
   * null when it does not show. Returns what changed, for Watcher's owl to fly to the threads told and the wood to
   * answer the rest. A thread seen for the first time starts nothing: its owl is on its way out of the moon.
   */
  take(owls: readonly WatchedOwl[], t: number, perch: (key: string) => Point | null): RoomNews {
    const news: RoomNews = { told: [], finished: [], failed: [], settled: [] }, seen = new Set<string>()
    for (const owl of owls) {
      seen.add(owl.key)
      const before = this.known.get(owl.key), failed = owl.failed === true, messages = owl.told ?? 0, settled = owl.settled === true
      this.known.set(owl.key, { mood: owl.mood, failed, told: messages, settled })
      if (before === undefined) continue
      if (messages > before.told) news.told.push(owl.key)
      if (failed && !before.failed) news.failed.push(owl.key)
      if (settled && !before.settled) news.settled.push(owl.key)
      if (before.mood === owl.mood) continue
      if (owl.mood === 'awake' && before.mood === 'asleep') this.act(owl.key, 'wake', t, 1.5)
      else if (owl.mood === 'awake' && before.mood === 'waiting') this.act(owl.key, 'happy', t, 1.6)
      else if (owl.mood === 'asleep' && before.mood === 'awake' && !failed) {
        news.finished.push(owl.key)
        const at = perch(owl.key)
        if (at !== null) this.sparks(at, t)
        this.act(owl.key, 'happy', t, 2.6)
      }
    }
    for (const key of this.known.keys()) if (!seen.has(key)) { this.known.delete(key); this.acts.delete(key) }
    return news
  }

  /**
   * The glyphs round the owls for a frame, through the painter's guard: a `?` or a `!` over an owl that waits on the
   * user, a row clear of its glow and bobbing a row higher; `z`s rising from one asleep, unless its last turn failed;
   * the sparks; and each call's note with two dots behind it. Holding still, the `?`, the `!` and one `z` stand where
   * they rest and nothing crosses. At most three glyphs an owl, twelve a burst and three a call.
   */
  glyphs(poses: readonly ThreadOwlPose[], t: number, still: boolean, emit: AmbientGlyph): void {
    const { w: cw, h: ch } = CELL
    for (const passing of still ? [] : this.passing) {
      const age = t - passing.t0
      if (age < 0 || age > passing.dur) continue
      const k = age / passing.dur
      if (passing.kind === 'sparks') {
        for (let j = 0; j < SPARKS; j++) {
          const angle = j / SPARKS * Math.PI * 2 + passing.spin, reach = 10 + 58 * (1 - (1 - k) ** 2) * (0.6 + 0.4 * ((j * 7) % SPARKS) / SPARKS)
          emit(passing.at.x + Math.cos(angle) * reach, passing.at.y - 20 + Math.sin(angle) * reach * 0.62, k < 0.35 ? '*' : k < 0.7 ? '+' : '·', true, 1 - k * 0.8, true)
        }
        continue
      }
      const eased = k * k * (3 - 2 * k)
      const along = (u: number): Point => {
        const v = 1 - u, mx = (passing.from.x + passing.to.x) / 2, my = Math.min(passing.from.y, passing.to.y) - CALL_LIFT
        return { x: v * v * passing.from.x + 2 * v * u * mx + u * u * passing.to.x, y: v * v * passing.from.y + 2 * v * u * my + u * u * passing.to.y }
      }
      const note = along(eased)
      emit(note.x, note.y, '♪', passing.accent, 1, true)
      for (const [back, strength] of [[0.05, 0.55], [0.1, 0.32]] as const) if (eased > back) { const dot = along(eased - back); emit(dot.x, dot.y, '·', passing.accent, strength, false) }
    }
    for (const pose of poses) {
      if (pose.flying || pose.alpha < 0.9 || pose.owl.animation !== null) continue
      // The owl's middle column, and the row above its head.
      const column = Math.round(pose.x / cw - 2.5) + 2, above = Math.floor((pose.y - 1) / ch) - 3
      if (pose.owl.mood === 'waiting') {
        const up = still ? 0 : Math.floor(t * 2) % 2
        emit((column + 0.5) * cw, (above - 1 - up + 0.5) * ch, pose.owl.asks === 'permission' ? '!' : '?', true, 1, true)
      } else if (pose.owl.mood === 'asleep' && !pose.owl.failed) {
        const last = still ? 0 : sleepStage(pose.owl.order, t)
        for (let stage = 0; stage <= last; stage++) {
          emit((column + 2 + stage + 0.5) * cw, (above - stage + 0.5) * ch, stage === 2 ? 'Z' : 'z', false, [0.62, 0.5, 0.4][stage]!, false)
        }
      }
    }
  }
}

/** How far a sleeper's `z`s have risen at `t`: none (-1), or the first, second or third. Each owl rises at its own moment. */
function sleepStage(order: number, t: number): number {
  const age = (t + order * 1.9) % SLEEP_CYCLE
  return age >= SLEEP_RISE ? -1 : Math.min(2, Math.floor(age / (SLEEP_RISE / 3)))
}

/**
 * Where Watcher's owl perches to call to a thread owl sitting at `x`: on its own tree for an owl in the left margin,
 * on the other tree for one in the right.
 */
export function roundPerch(layout: Pick<SceneLayout, 'column'>, x: number): OwlPlace {
  return x < layout.column.left ? 'home' : 'tree'
}

/** Where a call leaves or reaches a thread owl sitting at `at`: its head. */
export function headOf(at: Point): Point {
  return { x: at.x, y: at.y - 34 }
}
