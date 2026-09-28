// The edit: every shot, caption and key cap on the film's clock, in seconds. The tempo grid is 100 BPM,
// so a beat is 0.6 s and every cut lands on a beat or a half-beat (cue-sheet.md lists them).
// Source times come from each take's events (takes.json, written by `npm run capture -- sync`), so a
// retake moves its shots with it.
import takes from './takes.json'

export interface Rect { x: number; y: number; w: number; h: number }
/** A band of the 1080x1920 frame, full width: its top and its height. */
export interface Region { y: number; h: number }
export interface Shot {
  id: string
  /** A take in public/takes, or a still image in public/. */
  take?: string
  still?: string
  start: number
  end: number
  /** Source second at the shot's first frame. */
  from: number
  rate?: number
  /** `tight`: a crop filling the width; `window`: the whole window in the upper-middle third. */
  frame: 'tight' | 'window'
  y?: number
  h?: number
  /** Crops in source pixels (the 2560x1600 screen), eased between keyframes; t runs 0..1 over the shot. */
  camera: { t: number; rect: Rect; out?: Region }[]
}
export interface Caption { start: number; end: number; text: string; y?: number }
export interface KeyCap { at: number; keys: string[]; hold?: number; y?: number }

export const BEAT = 0.6
type TakeEvents = Record<string, { sync: number; events: { name: string; t: number; chord?: string; label?: string }[] }>
const recorded = takes as unknown as TakeEvents

/** A named moment in a take, in source seconds: the nth event called `name` (or labelled `label`). */
export function moment(take: string, name: string, index = 0): number {
  const events = recorded[take]?.events.filter(e => e.name === name || e.label === name) ?? []
  const event = events[index]
  if (!event) throw new Error(`Take ${take} has no event ${name} #${index}`)
  return event.t
}

export const WINDOW: Rect = { x: 0, y: 0, w: 2560, h: 1600 }
/** A square crop of side `size` centred on (cx, cy), kept inside the screen. */
export function square(cx: number, cy: number, size: number, aspect = 1): Rect {
  const w = size, h = size / aspect
  return { x: Math.max(0, Math.min(2560 - w, cx - w / 2)), y: Math.max(0, Math.min(1600 - h, cy - h / 2)), w, h }
}

