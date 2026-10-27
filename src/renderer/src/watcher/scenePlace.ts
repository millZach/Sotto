import type { SceneLayout } from './nightScene'
import type { Field } from './sceneDraw'

/**
 * The places Watcher's night scene is set in (ADR-0148). Every place is laid out by the same `layoutScene`, so the moon,
 * Watcher's owl's home and every thread owl's spot stand where they do in the night wood: a place only draws its own
 * things at that geometry, a mast's yard or a cactus arm where the wood has a limb, a quay or a drift where it has the
 * ground. It draws into the same two fields (the ink's and the accent's) the painter reads into glyphs, so it keeps the
 * scene's ASCII look and the column's share and ink ceiling, and it brings no colour of its own.
 */
export interface ScenePlace {
  /** Draws the landscape's two fields: the ink's coverage on `fx`, and on `ax` where the accent shows, as light does. */
  readonly draw: (fx: Field, ax: Field, layout: SceneLayout) => void
  /** How many stars its sky has, as a share of the night wood's. */
  readonly stars: number
  /** What moves in it, beyond the stars: falling snow, drifting sand, a lighthouse's beam. Null when nothing does. */
  readonly ambience: ((layout: SceneLayout) => Ambience) | null
}

/**
 * One glyph of a place's ambience for a frame, at a point in the pane: drawn in the accent or the ink at `strength`,
 * over a landscape glyph (`over`) or only where the landscape leaves the cell empty. The painter holds it to the
 * cell's share and the column's ink ceiling, never under still words or an owl.
 */
export type AmbientGlyph = (x: number, y: number, glyph: string, accent: boolean, strength: number, over: boolean) => void

/**
 * What moves in a place: a fixed, small number of glyphs, so a frame's work never grows with the room's history or its
 * threads. It changes `steps` times a second while the scene moves and holds still at STILL_AMBIENCE_T when it holds
 * still, drawn once.
 */
export interface Ambience {
  readonly steps: number
  /** At most this many glyphs in a frame. */
  readonly most: number
  /** Emits the frame's glyphs for the time `ambienceTime` gives, at most `most` of them. */
  readonly cells: (t: number, emit: AmbientGlyph) => void
}

/** The time a still scene's ambience is drawn at: the beam reaching toward the room, snow and sand where they fell. */
export const STILL_AMBIENCE_T = 41.3

/** The step of a place's ambience at `t`: 0 when it holds still or nothing in it moves. */
export function ambienceStep(ambience: Ambience | null, t: number, still: boolean): number {
  return ambience === null || still ? 0 : Math.floor(t * ambience.steps)
}

/** The time an ambience is drawn at for `t`: its step's start, or the still time. */
export function ambienceTime(ambience: Ambience, t: number, still: boolean): number {
  return still ? STILL_AMBIENCE_T : Math.floor(t * ambience.steps) / ambience.steps
}

/** A remainder that is never negative. */
export const wrap = (value: number, size: number): number => ((value % size) + size) % size
