// PROTOTYPE, throwaway. What the prototype's layers share: which ideas are switched on, the pretend room's threads,
// what each thread owl is doing, and what is happening in the wood right now. The real scene's painter never sees this;
// the prototype's ambience (ambience.ts) and its owl glyphs (owlFamilyLife.ts) read it.
import type { OwlPose, Point } from '@w/nightScene'
import type { ThreadOwlPose } from '@w/owlFamily'

export type FlagId =
  | 'wind' | 'river' | 'fireflies' | 'mist' | 'shooting'
  | 'sleepZ' | 'fidget' | 'wave' | 'sparkle' | 'rounds' | 'gaze'
  | 'meteors' | 'bats' | 'fox' | 'fish' | 'hunt' | 'cloud'
  | 'mirror'

export interface FlagInfo { readonly id: FlagId; readonly group: 'wood' | 'owls' | 'events' | 'room'; readonly name: string; readonly line: string }

export const FLAGS: readonly FlagInfo[] = [
  { id: 'wind', group: 'wood', name: 'Wind', line: 'Gusts cross the wood: grass leans, crowns sway, leaves fly.' },
  { id: 'river', group: 'wood', name: 'River flows', line: 'Glints run down the river toward you.' },
  { id: 'fireflies', group: 'wood', name: 'Fireflies', line: 'A dozen lights drift and pulse in the margins.' },
  { id: 'mist', group: 'wood', name: 'Mist', line: 'Thin wisps drift between the hills.' },
  { id: 'shooting', group: 'wood', name: 'Shooting stars', line: 'Now and then one crosses the sky.' },
  { id: 'sleepZ', group: 'owls', name: 'Sleepers', line: 'A resting thread’s owl sleeps under rising z’s.' },
  { id: 'fidget', group: 'owls', name: 'Workers fidget', line: 'A working thread’s owl looks down at its work, turns, stretches and hops. A failed one winces.' },
  { id: 'wave', group: 'owls', name: 'Waiting owl waves', line: 'An owl that waits on you waves its wings under a ? or a !.' },
  { id: 'sparkle', group: 'owls', name: 'Finish sparkle', line: 'A thread that finishes gets a burst of sparks and a happy owl.' },
  { id: 'rounds', group: 'owls', name: 'Watcher’s rounds', line: 'Watcher’s owl flies to the tree of the thread it checks and calls to its owl, which answers.' },
  { id: 'gaze', group: 'owls', name: 'Follows your pointer', line: 'Watcher’s owl watches your pointer in the margins; an owl you point at hops.' },
  { id: 'meteors', group: 'events', name: 'Meteor shower', line: 'Eight meteors in three seconds.' },
  { id: 'bats', group: 'events', name: 'Bats', line: 'A flock crosses in front of the moon.' },
  { id: 'fox', group: 'events', name: 'Fox', line: 'A fox trots the length of the ground and stops to look up.' },
  { id: 'fish', group: 'events', name: 'Fish', line: 'A fish jumps in the river.' },
  { id: 'hunt', group: 'events', name: 'Owl hunts', line: 'Watcher’s owl dives for a mouse in the grass.' },
  { id: 'cloud', group: 'events', name: 'Cloud', line: 'A cloud drifts across the moon.' },
  { id: 'mirror', group: 'room', name: 'Tied to the room', line: 'Nothing runs on a timer: the wood answers what your threads do.' },
]

export const WOOD: FlagId[] = ['wind', 'river', 'fireflies', 'mist', 'shooting']
export const OWLS: FlagId[] = ['sleepZ', 'fidget', 'wave', 'sparkle', 'rounds', 'gaze']
export const EVENTS: FlagId[] = ['meteors', 'bats', 'fox', 'fish', 'hunt', 'cloud']

export interface Preset { readonly id: string; readonly name: string; readonly line: string; readonly flags: readonly FlagId[] }
export const PRESETS: readonly Preset[] = [
  { id: 'A', name: 'Today', line: 'The night wood as it ships. Stars twinkle, owls blink, Watcher’s owl flies now and then.', flags: [] },
  { id: 'B', name: 'The wood breathes', line: 'Always something small moving: wind, the river, fireflies, mist, a shooting star. Decoration only.', flags: WOOD },
  { id: 'C', name: 'The owls have lives', line: 'Each owl acts out its thread: sleeping, working, waving for you, celebrating. Watcher’s owl does its rounds.', flags: OWLS },
  { id: 'D', name: 'Things happen at night', line: 'The scene as today, but every so often a set piece: meteors, bats, a fox, a fish, a hunt, a cloud.', flags: EVENTS },
  { id: 'E', name: 'The wood mirrors the room', line: 'All of it, and nothing on a timer: wind follows how busy the room is, and events fire when threads finish, fail, ask or merge.', flags: [...WOOD, ...OWLS, ...EVENTS, 'mirror'] },
]

/** A thread in the pretend room. */
export interface Thread {
  readonly key: string
  readonly title: string
  state: 'working' | 'resting' | 'waiting' | 'failed'
  ask: 'question' | 'permission' | null
}

/** Something a thread owl does for a moment. */
export interface Act { readonly kind: 'hop' | 'happy' | 'wake' | 'lookup'; readonly t0: number; readonly dur: number }

/** Something happening in the wood, from `t0` for `dur` seconds. The rest is the kind's own. */
export interface Happening { kind: string; t0: number; dur: number; [more: string]: any }

/** How the scene is drawn: characters picked by shape, the wood in layers with depth, a halo round the moon. */
export const LOOK = { shape: false, depth: false, halo: false }

export const LIFE = {
  flags: new Set<FlagId>(),
  pace: 'demo' as 'demo' | 'real',
  autoRoom: true,
  /** Reduced motion: nothing moves, and the extras are drawn once where they rest. */
  still: false,
  /** The scene's clock at the last frame, in seconds. */
  now: 0,
  threads: [] as Thread[],
  acts: new Map<string, Act>(),
  happenings: [] as Happening[],
  /** The thread owls as the last frame drew them. */
  poses: [] as ThreadOwlPose[],
  watcher: null as OwlPose | null,
  watcherFlying: false,
  pointer: null as (Point & { readonly t: number }) | null,
  say: (_words: string): void => undefined,
}

export const has = (id: FlagId): boolean => LIFE.flags.has(id)
export const threadOf = (key: string): Thread | undefined => LIFE.threads.find(thread => thread.key === key)
export const working = (): number => LIFE.threads.filter(thread => thread.state === 'working').length
/** How busy the room is, 0 to 1: the share of its threads that are working. */
export const activity = (): number => LIFE.threads.length === 0 ? 0 : Math.min(1, working() / Math.max(4, LIFE.threads.length * 0.6))

/** The kinds that move fast enough to want more frames while they run. */
const FAST = new Set(['star', 'meteors', 'note', 'sparkle', 'fish', 'bats', 'mouse', 'fox'])
export function fast(t: number): boolean {
  return LIFE.happenings.some(h => FAST.has(h.kind) && t >= h.t0 && t <= h.t0 + h.dur)
}

/** A number from 0 to 1 that is always the same for the same three integers. */
export function hash(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

/** When a working owl fidgets: each owl rolls again every few seconds, at its own moment. */
export function fidgetOf(order: number, t: number): { readonly roll: number; readonly into: number } {
  const at = t + order * 1.7, slot = Math.floor(at / 2.8)
  return { roll: Math.floor(hash(order + 1, slot) * 12), into: at - slot * 2.8 }
}
