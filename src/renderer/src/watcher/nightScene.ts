/**
 * The maths of Watcher's night scene. Zach picked the look on October 21, 2026 (variant A of the prototype kept at the
 * tag `prototype/watcher-owl-scene`) and moved it into the room's side margins on October 22 (`prototype/watcher-owl-family`):
 * where the landscape, the trees, the moon and every owl's perch fall beside the column, how Watcher's own owl flies
 * between them, what a ripple does to a cell, and what ink the scene draws with. On October 23 the user let the sky and
 * the hills run on under the column at 85%, held still whatever the words do, with a soft glow of the canvas behind each
 * word (variant D of `docs/prototypes/watcher-floating-composer-prototype.html`, which replaced the gaps round each line
 * of variant A of `docs/prototypes/watcher-column-scene-prototype.html`); the ink there stops where a word would fall
 * under 4.5:1, its names and times in the secondary text colour so it can go stronger (ADR-0126). Nothing here touches the DOM or a
 * canvas, so all of it can be tested on its own; `owlFamily.ts` keeps the thread owls, `nightScenePainter.ts` draws the
 * scene and `WatcherNightScene.tsx` runs it.
 *
 * Every length is in CSS pixels from the top-left of Watcher's pane, and every time in seconds from when the scene
 * started.
 */

import { contrastRatio, relativeLuminance, type ThemeRgb } from '../../../shared/themes/color'

export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Point { readonly x: number; readonly y: number }
export type Rgb = ThemeRgb

/** What the room measures of itself for the scene: its size, the bottom of its header, its composer and its words. */
export interface SceneMeasure {
  readonly width: number
  readonly height: number
  /** The bottom of the header band: the header, and the needs-you line when it shows. */
  readonly header: number
  /**
   * Watcher's composer, at its full height even while it is slim (ADR-0125), so the scene holds still as it changes. Its
   * sides are the column's: the trees, the owls and the ripples live only beside it. The scene runs on under it, since the
   * card is glass.
   */
  readonly composer: Box
  /**
   * The words that stand still while the conversation scrolls: the header's, what stands on the composer and the line
   * under it. Nothing is drawn under them. The transcript's words move, and the scene never follows them.
   */
  readonly words: readonly Box[]
  /**
   * The message scrubber's lane beside the column's left edge, while a long conversation shows it (ADR-0109). The left
   * margin's trees, owls and rail are laid out from its outer edge and no owl is drawn in it; the sky and the hills run on
   * under it at the column's share, so its ticks float over the scene with no box round them (the user's ask on
   * October 24, 2026).
   */
  readonly lane?: Box | undefined
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

// ---------- The layout ----------

/**
 * Watcher's owl's size: its share of the margin and of the sky, held between a smallest and a largest. 1 is the
 * prototype's drawing at its own units.
 */
export const OWL_SCALE = { perMargin: 225, perSky: 330, min: 0.8, max: 1.9 } as const
/** A margin narrower than this has no room for trees, and shows a rail of owl eyes instead (Zach, October 22, 2026). */
export const TREES_MIN_MARGIN = 160
/**
 * A margin narrower than this shows nothing: the rail's eyes are two glyphs, 14 pixels, and keep OWL_GAP from the
 * column. The room's smallest window leaves 16-pixel margins, so the rail still shows there.
 */
export const RAIL_MIN_MARGIN = 16
/** How close to the column the scene draws: never nearer than this to its edge. */
export const COLUMN_GAP = 8
/** Pixels between two thread owls side by side. */
export const SPOT = 44
/** Pixels between two pairs of eyes on the rail. */
export const RAIL_STEP = 26

/** Trees above the margin's threshold, a rail of eyes below it, nothing when even the rail has no room. */
export type SceneMode = 'trees' | 'rail' | 'none'

/** A nearly level branch an owl can sit on, from `x0` (its root) to `x1`, sagging by `sag` at its middle. */
export interface Limb { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly sag: number }
export interface Tree { readonly x: number; readonly y: number; readonly h: number; readonly dir: 1 | -1; readonly limbs: readonly Limb[] }
export interface Moon { readonly x: number; readonly y: number; readonly r: number }
export type Side = 'left' | 'right'

/** Where a thread owl can sit, in the order they fill: the limb across from Watcher's owl, Watcher's tree, the ground. */
export type SpotKind = 'limb' | 'tree' | 'ground' | 'rail'
export interface Spot extends Point { readonly kind: SpotKind }

/** Where everything in the scene falls for one size of the room. */
export interface SceneLayout {
  readonly width: number
  readonly height: number
  readonly composer: Box
  readonly words: readonly Box[]
  readonly header: number
  /** The column's two edges: the composer's sides. Between them the scene shows quieter, and only the sky and the hills. */
  readonly column: { readonly left: number; readonly right: number }
  /** The message scrubber's lane, where the scene shows as in the column and no owl is drawn, or null while it does not show. */
  readonly lane: Box | null
  /** The narrower margin's width. */
  readonly margin: number
  readonly mode: SceneMode
  /** Watcher's owl's size: 1 is the prototype's drawing at its own units. */
  readonly s: number
  readonly groundY: number
  /** The sky's height, from the header to the ground. */
  readonly sky: number
  readonly horizon: number
  /** Watcher's tree, in the left margin. */
  readonly left: Tree
  /** The other tree, in the right margin, whose long limb faces Watcher's owl. */
  readonly right: Tree
  /** In the right margin, above the limb new owls fill first (Zach, October 22, 2026). */
  readonly moon: Moon
  /** Watcher's owl's own place, at the column end of its tree's long limb. */
  readonly home: Point
  /** Where Watcher's owl sits when it visits the other tree: near that tree's trunk, clear of the thread owls. */
  readonly visit: Point
  /** The composer's two branches, growing out of its sides into the margins (Zach, October 22, 2026). */
  readonly branches: { readonly left: Limb; readonly right: Limb }
  /** Where Watcher's owl perches on each branch, its whole body in the margin. */
  readonly composerPerch: { readonly left: Point; readonly right: Point }
  /** The thread owls' spots, in the order they fill. When there are more threads than spots, the last shows "+N". */
  readonly spots: readonly Spot[]
}

/** How high a limb is at `x`, along its curve. */
export function limbY(limb: Limb, x: number): number {
  const t = clamp((x - limb.x0) / (limb.x1 - limb.x0), 0, 1)
  return lerp(limb.y0, limb.y1, t) + 2 * t * (1 - t) * limb.sag
}

/** The ground's edge at `x`: a gentle wave along the composer's middle. */
export function groundAt(layout: Pick<SceneLayout, 'groundY'>, x: number): number {
  return layout.groundY + Math.sin(x * 0.013) * 3 + Math.sin(x * 0.051) * 1.5
}

const limb = (x0: number, y0: number, x1: number, y1: number, sag = 5): Limb => ({ x0, y0, x1, y1, sag })

/** The spots along a limb, from its tip toward its root, skipping any within `clear.w` of `clear.x`. */
function limbSpots(along: Limb, kind: SpotKind, clear: readonly { readonly x: number; readonly w: number }[]): Spot[] {
  const out: Spot[] = [], dir = Math.sign(along.x1 - along.x0)
  for (let x = along.x1 - dir * 20; dir * (x - along.x0) > 24; x -= dir * SPOT) {
    if (clear.some(c => Math.abs(x - c.x) < c.w)) continue
    out.push({ x, y: limbY(along, x), kind })
  }
  return out
}

/**
 * What the scene lays out by while the composer is slim (ADR-0125): the room as it was with the full card, while the
 * pane, its header and the scrubber's lane stand as they did, so the scene holds still as the composer slims and widens
 * and as the row under the card steps away and back. A room that changed while the composer was slim is taken as it is.
 */
export function heldRoom(slim: SceneMeasure | null, full: SceneMeasure | null): SceneMeasure | null {
  if (slim === null || full === null) return slim
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1
  const lane = slim.lane === undefined || full.lane === undefined ? slim.lane === full.lane
    : near(slim.lane.x, full.lane.x) && near(slim.lane.y, full.lane.y) && near(slim.lane.w, full.lane.w) && near(slim.lane.h, full.lane.h)
  return near(slim.width, full.width) && near(slim.height, full.height) && near(slim.header, full.header) && lane ? full : slim
}

/** Lays the scene out in the margins beside the composer's column: two trees, the moon on the right, the ground behind the composer. */
export function layoutScene(measure: SceneMeasure): SceneLayout {
  const { width: W, height: H, composer: comp, header } = measure
  const colL = comp.x, colR = comp.x + comp.w
  const lane = measure.lane ?? null
  // The left margin's room ends at the scrubber's lane while it shows (Zach's pick, October 22, 2026).
  const inL = lane === null ? colL : Math.max(0, Math.min(colL, lane.x))
  const leftRoom = Math.max(0, inL), rightRoom = Math.max(0, W - colR)
  const margin = Math.min(leftRoom, rightRoom)
  // Too narrow a left margin for its tree shows the rail of eyes on the right alone.
  const mode: SceneMode = margin >= TREES_MIN_MARGIN ? 'trees' : Math.max(leftRoom, rightRoom) >= RAIL_MIN_MARGIN ? 'rail' : 'none'
  const groundY = comp.y + comp.h * 0.55
  const sky = Math.max(1, groundY - header)
  const L = { x0: 6, x1: inL - 14 }, R = { x0: colR + 14, x1: W - 6 }
  const Mw = Math.max(1, Math.min(L.x1 - L.x0, R.x1 - R.x0))
  const s = clamp(Math.min(margin / OWL_SCALE.perMargin, sky / OWL_SCALE.perSky), OWL_SCALE.min, OWL_SCALE.max)
  const lh = sky * 0.8, rh = sky * 0.64
  const ltx = L.x0 + Mw * 0.3, rtx = R.x1 - Mw * 0.3
  const left: Tree = { x: ltx, y: groundY + 4, h: lh, dir: 1, limbs: [
    limb(ltx, groundY - lh * 0.42, L.x1 - 2, groundY - lh * 0.47),                           // Watcher's, toward the room
    limb(ltx, groundY - lh * 0.56, ltx + (L.x1 - ltx) * 0.62, groundY - lh * 0.63, 3),        // higher, toward the room
    limb(ltx, groundY - lh * 0.27, Math.max(L.x0 + 4, ltx - Mw * 0.29), groundY - lh * 0.32), // outward
  ] }
  const right: Tree = { x: rtx, y: groundY + 4, h: rh, dir: -1, limbs: [limb(rtx, groundY - rh * 0.48, R.x0 + 2, groundY - rh * 0.53)] }
  const homeX = L.x1 - 2 - 26 * s, visitX = rtx - 30 * s
  const home = { x: homeX, y: limbY(left.limbs[0]!, homeX) }
  const visit = { x: visitX, y: limbY(right.limbs[0]!, visitX) }
  // The composer's branches: one grows out of each side just under its top edge and rises a little into the margin.
  const by = comp.y + 12, reach = 64 * s + 44
  const branches = {
    left: limb(colL - COLUMN_GAP, by, Math.max(L.x0 + 8, colL - COLUMN_GAP - reach), by - 12 * s, -4),
    right: limb(colR + COLUMN_GAP, by, Math.min(R.x1 - 8, colR + COLUMN_GAP + reach), by - 12 * s, -4),
  }
  const perchOn = (b: Limb): Point => { const x = b.x0 + Math.sign(b.x1 - b.x0) * (22 * s + 10); return { x, y: limbY(b, x) } }
  const composerPerch = { left: perchOn(branches.left), right: perchOn(branches.right) }
  const moonR = clamp(Mw * 0.1, 15, 44)
  const moon: Moon = { x: R.x0 + Mw * 0.34, y: header + Math.max(moonR + 12, sky * 0.15 + moonR * 0.5), r: moonR }

  let spots: Spot[] = []
  if (mode === 'trees') {
    const owlWidth = 20 * s + 22
    const limbFirst = limbSpots(right.limbs[0]!, 'limb', [{ x: visit.x, w: owlWidth }])
    const tree = [
      ...limbSpots(left.limbs[0]!, 'tree', [{ x: home.x, w: owlWidth }]),
      ...limbSpots(left.limbs[1]!, 'tree', [{ x: home.x, w: owlWidth }]),
      ...limbSpots(left.limbs[2]!, 'tree', []),
    ]
    // On the ground, the right margin from the column outward, then the left; not at a trunk, and not under a branch's
    // root, where it leaves the composer too low for an owl under it.
    const open = (x: number, trunk: number): boolean => Math.abs(x - trunk) > 30 && Math.abs(x - branches.left.x0) >= 40 && Math.abs(x - branches.right.x0) >= 40
    const ground: Spot[] = []
    for (let x = R.x0 + 20; x < R.x1 - 16; x += SPOT) if (open(x, rtx)) ground.push({ x, y: groundAt({ groundY }, x), kind: 'ground' })
    for (let x = L.x1 - 20; x > L.x0 + 16; x -= SPOT) if (open(x, ltx)) ground.push({ x, y: groundAt({ groundY }, x), kind: 'ground' })
    spots = [...limbFirst, ...tree, ...ground]
  } else if (mode === 'rail') {
    // A column of eyes down the middle of each margin with room for it, the right one first.
    const rails = [...rightRoom >= RAIL_MIN_MARGIN ? [(colR + OWL_GAP + W) / 2] : [], ...leftRoom >= RAIL_MIN_MARGIN ? [(inL - OWL_GAP) / 2] : []]
    for (const x of rails) for (let y = header + RAIL_STEP; y < H - 14; y += RAIL_STEP) spots.push({ x, y, kind: 'rail' })
  }
  return { width: W, height: H, composer: comp, words: measure.words, header, column: { left: colL, right: colR }, lane, margin, mode, s,
    groundY, sky, horizon: groundY - sky * 0.3, left, right, moon, home, visit, branches, composerPerch, spots }
}

/** Whether a point is in a margin, clear of the column by COLUMN_GAP. */
export function inMargin(layout: SceneLayout, x: number): boolean {
  return x < layout.column.left - COLUMN_GAP || x > layout.column.right + COLUMN_GAP
}

/**
 * How much of the scene shows in the column, as a share of the margins': the user's pick on October 23, 2026 is 85%, by
 * day and by night (variant D). The words keep 4.5:1 by the column's ink ceiling (`SceneInk.column`), not by this share.
 */
export const COLUMN_QUIET = { dark: 0.85, light: 0.85 } as const
/** How far either side of the column's edge the scene blends from the column's share to the margins' whole. */
export const COLUMN_BLEND = 40
/** Around the words that stand still: nothing within this many pixels. */
const WORD_PAD = 4

/** How far a point is from a box, 0 inside it. */
export function boxDistance(box: Box, x: number, y: number): number {
  return Math.hypot(Math.max(box.x - x, 0, x - box.x - box.w), Math.max(box.y - y, 0, y - box.y - box.h))
}

/** The scene's share at `x`: `strength` in the column, the whole in the margins, blending across COLUMN_BLEND either side of each edge. */
export function columnFactor(layout: Pick<SceneLayout, 'column'>, x: number, strength: number): number {
  const { left, right } = layout.column
  const out = x < left ? left - x : x > right ? x - right : -Math.min(x - left, right - x)
  return lerp(strength, 1, smooth(-COLUMN_BLEND, COLUMN_BLEND, out))
}

/** Whether a point is in the message scrubber's lane, with a little room either side for its ticks' glow. */
export function inLane(layout: Pick<SceneLayout, 'lane'>, x: number, y: number): boolean {
  const lane = layout.lane
  return lane !== null && x >= lane.x - LANE_PAD && x <= lane.x + lane.w + LANE_PAD && y >= lane.y && y <= lane.y + lane.h
}
/**
 * Where an owl's glyph at a point is drawn: over everything in the margins (`over`), behind the words over the column
 * and the scrubber's lane (`behind`), where it takes the column's share and ink ceiling as the hills do (the user's pick
 * A on October 25, 2026), and nowhere in the header band or around still words.
 */
export function owlLayer(layout: Pick<SceneLayout, 'column' | 'lane' | 'header' | 'words'>, x: number, y: number): 'over' | 'behind' | null {
  if (y <= layout.header || layout.words.some(box => x >= box.x - 4 && x <= box.x + box.w + 4 && y >= box.y - 4 && y <= box.y + box.h + 4)) return null
  return owlRoom(layout, x) && !inLane(layout, x, y) ? 'over' : 'behind'
}
/** Room either side of the scrubber's lane that takes the lane's share. */
const LANE_PAD = 4

/**
 * How much of the scene shows at a point, 0 to 1: nothing under the words that stand still, nor in the column's part of
 * the header band, a band falling to a tenth under the header, and `strength` in the column, blending to the whole in
 * the margins, except along the composer's branches, which grow out of it. It runs on under the glass composer, and it
 * never depends on where the conversation's words are, so nothing in it moves as they scroll.
 */
export function quietAt(layout: SceneLayout, x: number, y: number, strength: number = COLUMN_QUIET.dark): number {
  const inside = !inMargin(layout, x)
  if (inside && y < layout.header) return 0
  for (const box of layout.words) if (boxDistance(box, x, y) <= WORD_PAD) return 0
  const toColumn = Math.min(Math.abs(x - layout.column.left), Math.abs(x - layout.column.right))
  const onBranch = !inside && Math.abs(y - layout.branches.left.y0) < 16 + 12 * layout.s && toColumn < 64 * layout.s + 52
  // Under the scrubber's lane the scene shows as in the column, so its ticks float over it.
  const share = inLane(layout, x, y) ? strength : onBranch ? 1 : columnFactor(layout, x, strength)
  return lerp(0.1, 1, smooth(layout.header - 2, layout.header + 14, y)) * share
}

// ---------- Flights ----------

interface RouteSample extends Point { readonly d: number }
export interface Route { readonly samples: readonly RouteSample[]; readonly length: number }

function catmull(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t, t3 = t2 * t
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}

/** A smooth path through `points`, sampled by distance so a flight along it keeps an even pace. */
export function makeRoute(points: readonly Point[]): Route {
  const ext = [points[0]!, ...points, points[points.length - 1]!]
  const samples: RouteSample[] = [{ ...points[0]!, d: 0 }]
  for (let k = 1; k < ext.length - 2; k++) for (let j = 1; j <= 16; j++) {
    const p = catmull(ext[k - 1]!, ext[k]!, ext[k + 1]!, ext[k + 2]!, j / 16)
    const last = samples[samples.length - 1]!
    samples.push({ ...p, d: last.d + Math.hypot(p.x - last.x, p.y - last.y) })
  }
  return { samples, length: samples[samples.length - 1]!.d }
}

/** The point a share `u` of the way along a route. */
export function along(route: Route, u: number): Point {
  const target = clamp(u, 0, 1) * route.length, S = route.samples
  let lo = 0, hi = S.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid]!.d < target) lo = mid; else hi = mid }
  const a = S[lo]!, b = S[hi]!, t = b.d === a.d ? 0 : (target - a.d) / (b.d - a.d)
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }
}

/** A flight's share of the way at a share `k` of its time: slow off the branch, quick across, slow to land. */
export const glide = (k: number): number => clamp(k - Math.sin(2 * Math.PI * k) / (2 * Math.PI) * 0.55, 0, 1)

/**
 * Where Watcher's owl can be: its own tree, the other tree, or the composer's branch on the side it came from. It flies
 * between them now and then, at random; nothing that happens in the room sends it anywhere.
 */
export type OwlPlace = 'home' | 'tree' | 'composer'

export interface OwlFlight {
  readonly from: OwlPlace
  readonly to: OwlPlace
  /** The composer's branch it lands on or leaves from. */
  readonly side: Side
  readonly t0: number
  /** From the crouch before take-off to the wings folded on the perch it lands on. */
  readonly dur: number
  readonly route: Route
  /** How long it is in the air, between the crouch and the fold. */
  readonly air: number
  /** With motion reduced (and not for a capture): a few calm steps along the route, wings still, no beat. */
  readonly calm: boolean
}

/** Watcher's owl between frames: where it sits or what flight it is on, and when it next sets off. */
export interface WatcherOwlState {
  readonly at: OwlPlace
  readonly side: Side
  readonly flight: OwlFlight | null
  readonly next: number
}

/** How long Watcher's owl stays before it flies again, in seconds: long at home, shorter away from it. */
export const OWL_STAY = { home: [45, 110], away: [10, 22] } as const
/** Its pace in the air, in pixels a second, and the shortest and longest it is in the air (Drake's pick E, October 27, 2026). */
export const OWL_FLIGHT_SPEED = 170
export const OWL_FLIGHT_TIME = [2.2, 7.5] as const
/** The crouch before take-off and the fold after landing, in seconds. */
export const OWL_CROUCH = 0.16
export const OWL_FOLD = 0.34
/** With motion reduced, how long each of the flight's calm steps holds, and where along the route the two in the air fall. */
export const CALM_STEP = 0.7
export const CALM_STEPS = [0.36, 0.7] as const

export function placeOf(layout: SceneLayout, place: OwlPlace, side: Side): Point {
  return place === 'home' ? layout.home : place === 'tree' ? layout.visit : layout.composerPerch[side]
}

/** How long the owl stays at `place` before it next flies, for a roll between 0 and 1. */
export function stayAt(place: OwlPlace, roll: number): number {
  const [low, high] = place === 'home' ? OWL_STAY.home : OWL_STAY.away
  return lerp(low, high, clamp(roll, 0, 1))
}

/**
 * Where the owl flies next from `at`, for a roll between 0 and 1: from home to the other tree or the composer's left
 * branch; from the other tree home, or now and then to the composer's right branch; from the composer home. While the
 * message scrubber shows, the left branch's perch would put the owl's head in its lane, so home flies to the other tree.
 */
export function nextPlace(at: OwlPlace, roll: number, leftBranch = true): OwlPlace {
  if (at === 'home') return roll < 0.5 || !leftBranch ? 'tree' : 'composer'
  if (at === 'tree') return roll < 0.35 ? 'composer' : 'home'
  return 'home'
}

/** Thread owls and Watcher's owl may come this close to the column, closer than the landscape, so the rail's eyes fit at the smallest window. */
export const OWL_GAP = 2

/** Whether an owl may be drawn at `x`: in a margin, clear of the column by OWL_GAP. */
export function owlRoom(layout: Pick<SceneLayout, 'column'>, x: number): boolean {
  return x < layout.column.left - OWL_GAP || x > layout.column.right + OWL_GAP
}

/**
 * A flight from where the owl sits to `to` (Drake's pick E on October 27, 2026, from the prototype kept at the tag
 * `prototype/owl-flight`): off the branch with a small drop, up in a high arc, and in from a little under the perch it
 * lands on. Between the trees it passes the moon; the column is crossed behind the room's words. To or from the
 * composer it drops onto or rises off the branch on the side of the tree it comes from or goes to. `calm` is for
 * reduced motion: the same route, walked in a few still steps.
 */
export function planFlight(layout: SceneLayout, owl: Pick<WatcherOwlState, 'at' | 'side'>, to: OwlPlace, t0: number, calm = false): OwlFlight {
  const { s, moon } = layout
  const side: Side = to === 'composer' ? (owl.at === 'tree' ? 'right' : 'left') : owl.side
  const a = placeOf(layout, owl.at, owl.side), b = placeOf(layout, to, side)
  const dir = Math.sign(b.x - a.x) || 1, d = Math.abs(b.x - a.x)
  const high = Math.max(layout.header + 34, Math.min(a.y, b.y) - clamp(d * 0.3, 26 * s, 150 * s))
  const points: Point[] = [a, { x: a.x + dir * 16 * s, y: a.y + 3 * s }, { x: a.x + dir * d * 0.14, y: lerp(a.y, high, 0.55) }]
  if (d > layout.width * 0.4) {
    // A crossing passes just under the moon, on the side it comes from; the moon is on the right, so a flight there
    // reaches its high point first and the moon second.
    const past = { x: moon.x - dir * moon.r * 0.6, y: moon.y + moon.r * 0.9 }, top = Math.min(high, past.y)
    if (dir > 0) points.push({ x: (points[2]!.x + past.x) / 2, y: top }, past)
    else points.push(past, { x: (past.x + b.x - dir * d * 0.2) / 2, y: top })
  } else points.push({ x: a.x + dir * d * 0.5, y: high })
  points.push({ x: b.x - dir * d * 0.2, y: lerp(high, b.y, 0.82) + 10 * s }, { x: b.x - dir * 22 * s, y: b.y + 7 * s }, b)
  const route = makeRoute(points)
  const air = clamp(route.length / OWL_FLIGHT_SPEED, OWL_FLIGHT_TIME[0], OWL_FLIGHT_TIME[1])
  const dur = calm ? CALM_STEP * (CALM_STEPS.length + 1) : OWL_CROUCH + air + OWL_FOLD
  return { from: owl.at, to, side, t0, dur, route, air, calm }
}

/**
 * A wingbeat's seven frames: wings high, two quick frames down, the bottom, and three slower frames up with the wing
 * part-folded, as an owl's upstroke is. `flap` and `spread` are the pose's; `hold` is each frame's share of the beat,
 * so the downstroke takes about a third of it.
 */
export const WINGBEAT: readonly { readonly flap: number; readonly spread: number; readonly hold: number }[] = [
  { flap: 1.2, spread: 0.86, hold: 1 },
  { flap: 0.5, spread: 1, hold: 0.55 },
  { flap: -0.3, spread: 1.06, hold: 0.55 },
  { flap: -0.95, spread: 0.98, hold: 0.85 },
  { flap: -0.5, spread: 0.74, hold: 1.1 },
  { flap: 0.2, spread: 0.66, hold: 1.1 },
  { flap: 0.8, spread: 0.74, hold: 1 },
]
const BEAT_HOLD = WINGBEAT.reduce((sum, key) => sum + key.hold, 0)

/** The wingbeat's frame `beats` beats in: whole frames, never a blend of two. */
export function wingFrame(beats: number): (typeof WINGBEAT)[number] {
  let at = (beats - Math.floor(beats)) * BEAT_HOLD
  for (const key of WINGBEAT) { if (at < key.hold) return key; at -= key.hold }
  return WINGBEAT[0]!
}

/** Slow, deep beats: two off the branch, a slower cruise beat across, two short ones on the approach, then the flare. */
const CLIMB = { beats: 2, hz: 1.7, depth: 1.1 }
const CRUISE = { hz: 1.45, depth: 0.85 }
const APPROACH = { beats: 2, hz: 2.2, depth: 0.6 }
/** Where the flare starts, as a share of the time in the air. */
const FLARE_AT = 0.84
/** Wings up and forward to brake. */
const FLARE = { flap: 1.15, spread: 1 }

/** Relative speed over the time in the air: a push off the branch, a cruise, and a long braking approach. */
const airSpeed = (k: number): number => lerp(0.3, 1, smooth(0, 0.2, k)) * (1 - 0.8 * smooth(0.66, 1, k))
/** The share of the way at each share of the time in the air, from that speed, in 200 steps. */
const PROGRESS = ((): Float32Array => {
  const n = 200, out = new Float32Array(n + 1)
  let sum = 0
  for (let j = 1; j <= n; j++) { sum += airSpeed((j - 0.5) / n); out[j] = sum }
  for (let j = 0; j <= n; j++) out[j] = out[j]! / sum
  return out
})()
export function airProgress(k: number): number {
  const x = clamp(k, 0, 1) * 200, j = Math.min(199, Math.floor(x))
  return lerp(PROGRESS[j]!, PROGRESS[j + 1]!, x - j)
}

/** Holds a change to a few frames between `a` and `b`, so it shows as distinct drawings rather than a smear. */
const stepped = (a: number, b: number, k: number, steps: number): number => lerp(a, b, Math.round(clamp(k, 0, 1) * steps) / steps)

function heading(route: Route, u: number): number {
  const p = along(route, Math.max(0, u - 0.012)), q = along(route, Math.min(1, u + 0.012))
  return Math.atan2(q.y - p.y, q.x - p.x)
}

/** How hard the route turns at `u`, in radians per share of the way, averaged over a short stretch. */
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

/**
 * How long until a calm flight's next step is due, in milliseconds, or null when no calm flight is under way. With
 * motion reduced the scene otherwise draws nothing, so it wakes only for these.
 */
export function calmStepDelay(flight: OwlFlight | null, t: number): number | null {
  if (flight === null || !flight.calm) return null
  const next = Math.floor((t - flight.t0) / CALM_STEP + 1e-6) + 1
  return Math.max(0, (flight.t0 + Math.min(next * CALM_STEP, flight.dur) - t) * 1000)
}

// ---------- Watcher's owl over time ----------

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

export type OwlStage = 'perched' | 'flying'

/** Where a press in the open margin drew the owl's eye, and when. */
export interface Look { readonly x: number; readonly y: number; readonly t: number }
/** What the owl watches, from when: the moon while its whirlpool opens, then the new thread owl coming down. */
export interface Watch { readonly at: Point; readonly since: number }

const IDLE_TURNS = [0, -0.7, 0, 0.55, 0.15, -0.35] as const
const IDLE_TURN_EVERY = 5.2
const BLINK_EVERY = 4.7

/**
 * Where Watcher's owl is at `t`, and in what pose. With `still` (reduced motion, or a capture's fixed clock) it sits at
 * home and holds still there: no flight, no turning, no blinking.
 */
export function owlAt(t: number, layout: SceneLayout, owl: WatcherOwlState, options: { readonly still: boolean; readonly calm?: boolean; readonly look?: Look | null; readonly watch?: Watch | null }): { readonly pose: OwlPose; readonly stage: OwlStage } {
  const { s } = layout
  const pose = { x: 0, y: 0, s, bank: 0, squash: 1, spread: 0, flap: 0, turn: 0, gx: 0, gy: 0, blink: false, legs: 0 }
  const flight = options.still ? null : owl.flight
  const calm = options.calm === true
  if (flight !== null && t >= flight.t0 && t < flight.t0 + flight.dur) {
    const a = placeOf(layout, flight.from, owl.side), b = placeOf(layout, flight.to, flight.side)
    const dir = Math.sign(b.x - a.x) || 1, local = t - flight.t0
    if (flight.calm) {
      // Reduced motion: the owl sits, then shows at two points along the way with its wings spread and still, then sits
      // where it lands. No beat, no bank, no wobble; each step holds CALM_STEP.
      const j = Math.floor(local / CALM_STEP + 1e-6)
      if (j <= 0) { pose.x = a.x; pose.y = a.y; return { pose, stage: 'perched' } }
      if (j > CALM_STEPS.length) { pose.x = b.x; pose.y = b.y; return { pose, stage: 'perched' } }
      const p = along(flight.route, CALM_STEPS[j - 1]!)
      pose.x = p.x; pose.y = p.y; pose.flap = 0.22; pose.spread = 1; pose.turn = dir * 0.25; pose.gx = dir * 0.5; pose.gy = 0.6
      return { pose, stage: 'flying' }
    }
    if (local < OWL_CROUCH) {
      // The crouch: the body dips and the head turns to where it is going.
      pose.x = a.x; pose.y = a.y; pose.turn = dir * 0.5
      pose.squash = 1 - 0.1 * Math.sin(local / OWL_CROUCH * Math.PI * 0.5)
      return { pose, stage: 'flying' }
    }
    const air = local - OWL_CROUCH
    if (air >= flight.air) {
      // Landed: the wings fold in three frames, the legs take the weight, the body settles with one small bob.
      const k = (air - flight.air) / OWL_FOLD
      pose.x = b.x; pose.y = b.y
      pose.spread = stepped(0.95, 0.06, k, 3); pose.flap = stepped(FLARE.flap, 0.5, k, 3)
      pose.legs = 1 - smooth(0.5, 1, k); pose.squash = 1 - 0.08 * Math.sin(k * Math.PI); pose.gy = 0.3
      return { pose, stage: 'flying' }
    }
    const k = air / flight.air, u = airProgress(k), p = along(flight.route, u)
    const flareAt = FLARE_AT * flight.air, approach = flareAt - APPROACH.beats / APPROACH.hz, climbEnd = CLIMB.beats / CLIMB.hz
    let flap: number, spread: number
    if (air < climbEnd) { const key = wingFrame(air * CLIMB.hz); flap = key.flap * CLIMB.depth; spread = key.spread }
    else if (air >= flareAt) { flap = stepped(0.22, FLARE.flap, (air - flareAt) / (flight.air - flareAt) * 1.6, 3); spread = FLARE.spread }
    else if (air >= approach) { const key = wingFrame((air - approach) * APPROACH.hz); flap = key.flap * APPROACH.depth + 0.15; spread = key.spread }
    else { const key = wingFrame((air - climbEnd) * CRUISE.hz); flap = key.flap * CRUISE.depth; spread = key.spread * 1.08 }
    // A slow wobble across, and a bank into every turn held to steps of about three degrees, both kept off near the
    // perches. The owl moves in whole cells from the perch it lands on, so its drawing changes only where it beats or
    // turns, never because it slid part of a cell.
    const away = smooth(0, 0.15, k) * (1 - smooth(0.78, 0.95, k))
    const y = p.y + Math.sin(t * 2 * Math.PI * 0.55 + a.x * 0.013) * 0.8 * s * away
    pose.bank = Math.round(clamp(-turning(flight.route, u) * 0.06 * airSpeed(k) * away, -0.32, 0.32) / 0.05) * 0.05
    pose.x = b.x + Math.round((p.x - b.x) / CELL.w) * CELL.w
    pose.y = b.y + Math.round((y - b.y) / CELL.h) * CELL.h
    pose.flap = flap; pose.spread = spread
    pose.legs = smooth(0.8, 1, k)
    pose.squash = stepped(1, 0.93, smooth(FLARE_AT, 1, k), 2)
    pose.turn = dir * 0.25 * (1 - smooth(0.9, 1, k)); pose.gx = dir * 0.6; pose.gy = 0.6
    return { pose, stage: 'flying' }
  }
  const at = placeOf(layout, options.still ? 'home' : flight !== null && t >= flight.t0 + flight.dur ? flight.to : owl.at, flight !== null && t >= flight.t0 + flight.dur ? flight.side : owl.side)
  pose.x = at.x; pose.y = at.y
  // Held for a capture, or with motion reduced, it sits still: no turning, no blinking.
  if (options.still || calm) return { pose, stage: 'perched' }
  const seg = Math.floor(t / IDLE_TURN_EVERY)
  pose.turn = lerp(IDLE_TURNS[(seg + IDLE_TURNS.length - 1) % IDLE_TURNS.length]!, IDLE_TURNS[seg % IDLE_TURNS.length]!, smooth(0, 0.25, t - seg * IDLE_TURN_EVERY))
  pose.blink = (t + 1.3) % BLINK_EVERY < 0.14
  // A newcomer: the head turns to the moon as its whirlpool opens and follows the new owl down. A press in the margin
  // turns it the same way for a moment.
  const look = options.look
  const target = options.watch != null ? { x: options.watch.at.x, y: options.watch.at.y, k: smooth(options.watch.since, options.watch.since + 0.25, t) }
    : look != null && t - look.t >= 0 && t - look.t < 1.8 ? { x: look.x, y: look.y, k: smooth(0, 0.2, t - look.t) * (1 - smooth(1.4, 1.8, t - look.t)) } : null
  if (target !== null && target.k > 0) {
    pose.turn = lerp(pose.turn, clamp((target.x - pose.x) / 240, -1, 1), target.k)
    pose.gx = lerp(0, clamp((target.x - pose.x) / 200, -1.2, 1.2), target.k)
    pose.gy = lerp(0, clamp((target.y - (pose.y - 47 * s)) / 200, -1, 1.2), target.k)
    pose.blink = false
  }
  return { pose, stage: 'perched' }
}

// ---------- Ripples ----------

/** A ripple from a press in the open margin, or from the moon as its whirlpool opens. It may start later than now. */
export interface Ripple { readonly x: number; readonly y: number; readonly t: number }

/** How long a ripple runs: an expanding ring and its echo, or with motion reduced, a spot that brightens and fades. */
export const RIPPLE_LIFE = 2.4
export const STILL_RIPPLE_LIFE = 0.7
/** At most this many at once, waiting ones included; the oldest goes first. */
export const MAX_RIPPLES = 12
/** How fast the ring spreads, in pixels a second, and its echo's share of that. */
const RIPPLE_SPEED = 430
const ECHO_SHARE = 0.62
const RINGS = [[1, 20, 1], [ECHO_SHARE, 14, 0.45]] as const
/** How far beyond its radius a ring still reaches a cell: three widths of the wider ring. */
export const RIPPLE_REACH = 62
const STILL_REACH = 70

/** The ripples still running or still to start at `t`. */
export function liveRipples(ripples: readonly Ripple[], t: number, still: boolean): Ripple[] {
  const life = still ? STILL_RIPPLE_LIFE : RIPPLE_LIFE
  return ripples.filter(ripple => t - ripple.t <= life)
}

/** How many ripples are running at `t`, leaving out those still to start. */
export function runningRipples(ripples: readonly Ripple[], t: number): number {
  return ripples.reduce((count, ripple) => count + (t >= ripple.t ? 1 : 0), 0)
}

/** A new ripple, keeping no more than MAX_RIPPLES. */
export function addRipple(ripples: readonly Ripple[], ripple: Ripple): Ripple[] {
  return [...ripples, ripple].slice(-MAX_RIPPLES)
}

/** How far out from its centre a ripple can touch a cell at `t`; nothing before it starts. */
export function rippleReach(ripple: Ripple, t: number, still: boolean): number {
  if (t < ripple.t) return 0
  return still ? STILL_REACH : (t - ripple.t) * RIPPLE_SPEED + RIPPLE_REACH
}

/** What the running ripples do to one cell: how bright their ring is there, and how far they bend the landscape. */
export interface RippleEffect { ring: number; dx: number; dy: number }

/** Writes the ripples' effect at a cell's centre into `out` (reused, since it runs for many cells a frame) and returns it. */
export function rippleAt(x: number, y: number, ripples: readonly Ripple[], t: number, still: boolean, out: RippleEffect): RippleEffect {
  out.ring = 0; out.dx = 0; out.dy = 0
  for (const ripple of ripples) {
    const age = t - ripple.t, ddx = x - ripple.x, ddy = y - ripple.y, dist = Math.hypot(ddx, ddy) || 1
    if (age < 0) continue
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

/** How often a resting scene checks whether anything changed: a blink, a star's step, a glow's step. */
export const IDLE_CHECK_MS = 125
/** How often a moving scene draws. */
export const MOVING_MS = 33

/**
 * How long to wait before the next frame, in milliseconds, or null when nothing moves and drawing stops: about 30 a
 * second while an owl flies, a fade runs or a ripple spreads, a check 8 times a second while the scene only blinks and
 * twinkles, and nothing at all when it holds still.
 */
export function frameDelay(moving: boolean, ripples: number, still: boolean): number | null {
  if (moving || ripples > 0) return MOVING_MS
  return still ? null : IDLE_CHECK_MS
}

/**
 * How early a frame may come and still count as due: a little under one display frame, so a 60-hertz display draws
 * every second frame for the 33 milliseconds a moving scene wants, rather than every third.
 */
export const FRAME_SLACK_MS = 4
/** How long before a frame is due a waiting scene starts counting display frames for it, instead of sleeping on a timer. */
export const FRAME_WAKE_MS = 20

/** Whether a display frame starting at `now` is due, `delay` after the last drawn frame started at `last`. */
export function frameDue(now: number, last: number, delay: number): boolean {
  return now - last >= delay - FRAME_SLACK_MS
}

/** How long to sleep before counting display frames again, or 0 to count them from the next one. */
export function frameSleep(now: number, last: number, delay: number): number {
  return Math.max(0, last + delay - now - FRAME_WAKE_MS)
}

// ---------- Ink ----------

/** Whether a surface is light: black text reads better on it than white. Every theme is judged by its colour, not its name. */
export function isLightSurface(surface: Rgb): boolean {
  return relativeLuminance(surface) > 0.179
}

/** The scene's two inks in 21 steps of strength, from nothing to full. */
export interface SceneInk {
  readonly light: boolean
  readonly ink: readonly string[]
  readonly accent: readonly string[]
  /**
   * The highest step of each ink a cell in the column may take (0 to 1, as `inkAt` reads it): where every word colour
   * given still reads at WORD_CONTRAST against the ink laid over the surface at its full strength, the core of a glyph.
   */
  readonly column: { readonly ink: number; readonly accent: number }
}

/** What a word over the scene keeps against any pixel the scene draws under it, the glow left out: 4.5:1, and a little over for rounding. */
export const WORD_CONTRAST = 4.6

/** Dark ink on a light surface needs more of it to be seen as well as light ink on dark does. */
export const LIGHT_INK_BOOST = 1.9
export const LIGHT_ACCENT_BOOST = 1.5

/** A colour laid over a surface at `alpha`, as the canvas and then the page composite it. */
export function over(surface: Rgb, ink: Rgb, alpha: number): Rgb {
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * alpha)
  return { r: mix(surface.r, ink.r), g: mix(surface.g, ink.g), b: mix(surface.b, ink.b) }
}

/** A colour words are written in, with its opacity where a theme makes it translucent (1 when left out). */
export type Word = Rgb & { readonly a?: number }

/** A word's contrast against the pixel under it, the word laid over that pixel as the screen shows it when translucent. */
export function wordContrast(word: Word, pixel: Rgb): number {
  const alpha = word.a ?? 1
  return contrastRatio(alpha >= 1 ? word : over(pixel, word, alpha), pixel)
}

/**
 * The highest of an ink's 21 steps, as a share from 0 to 1, at which every one of `words` keeps WORD_CONTRAST against the
 * ink laid over `surface`. Steps are tried from the faintest; the first that fails ends it.
 */
export function columnCeiling(surface: Rgb, ink: Rgb, boost: number, words: readonly Word[]): number {
  let best = 0
  for (let k = 1; k <= 20; k++) {
    const pixel = over(surface, ink, Math.min(1, k / 20 * boost))
    if (words.some(word => wordContrast(word, pixel) < WORD_CONTRAST)) break
    best = k / 20
  }
  return best
}

/** The glass card's least opacity, the user's pick of 72%, below which nothing is thinned. */
export const GLASS_FLOOR = 0.72

/**
 * How opaque Watcher's glass composer must be, from GLASS_FLOOR up in hundredths, for every one of `words` written on it
 * to keep WORD_CONTRAST whatever passes under it: the card's colour laid over pure white and over pure black, the two
 * worst a picture in the conversation can put there. Solid when nothing thinner holds.
 */
export function glassOpacity(card: Rgb, words: readonly Word[], floor: number = GLASS_FLOOR): number {
  const extremes: readonly Rgb[] = [{ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }]
  for (let k = Math.ceil(floor * 100); k < 100; k++) {
    if (extremes.every(behind => { const surface = over(behind, card, k / 100); return words.every(word => wordContrast(word, surface) >= WORD_CONTRAST) })) return k / 100
  }
  return 1
}

/**
 * The scene's inks for a theme: its text and accent colours, made stronger when the surface under them is light, and
 * how far each may go in the column, where the conversation's words fall over it: `words` are the colours words there
 * are written in (the text, its secondary tier, which the names and times take there, and links), and none of them may
 * fall under 4.5:1 against a glyph's core.
 */
export function sceneInk(surface: Rgb, text: Rgb, accent: Rgb, words: readonly Word[] = [text]): SceneInk {
  const light = isLightSurface(surface)
  const inkBoost = light ? LIGHT_INK_BOOST : 1, accentBoost = light ? LIGHT_ACCENT_BOOST : 1
  const ramp = ({ r, g, b }: Rgb, boost: number): string[] => Array.from({ length: 21 }, (_, k) => `rgba(${r}, ${g}, ${b}, ${Math.min(1, k / 20 * boost).toFixed(2)})`)
  return { light, ink: ramp(text, inkBoost), accent: ramp(accent, accentBoost),
    column: { ink: columnCeiling(surface, text, inkBoost, words), accent: columnCeiling(surface, accent, accentBoost, words) } }
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

/**
 * Stars scattered over the open sky, where the landscape leaves a cell empty: the margins' and the column's, where the
 * quiet and the gaps around words decide how much of each shows. `density` is the place's share of the night wood's
 * (ADR-0149).
 */
export function placeStars(layout: SceneLayout, grid: Grid, ink: Float32Array, density = 1): Star[] {
  const S = seeded(5), count = Math.round(layout.width * layout.height / 6000 * density), stars: Star[] = [], taken = new Set<number>()
  for (let k = 0; k < count; k++) {
    const c = Math.floor(S() * grid.cols), r = Math.floor(S() * grid.rows), y = r * grid.ch
    if (y < layout.header + 6 || y > layout.horizon - layout.sky * 0.08) continue
    const i = r * grid.cols + c
    if ((ink[i] ?? 1) > 0.05) continue
    const tier = S()
    const star: Star = { i, base: tier > 0.93 ? 0.9 : tier > 0.7 ? 0.55 : 0.3, phase: S() * 6.28, speed: 0.5 + S() * 1.2, accent: S() > 0.86 }
    // One star to a cell: two would paint the cell twice, past the column's ceiling. The draws are made either way, so
    // every other star stays where it was.
    if (taken.has(i)) continue
    taken.add(i)
    stars.push(star)
  }
  return stars
}

/** How often a star's twinkle steps, so a resting scene changes a few times a second rather than every frame. */
export const TWINKLE_STEPS_PER_SECOND = 2

/** The twinkle's step at `t`: 0 when the scene holds still. */
export function twinkleStep(t: number, still: boolean): number {
  return still ? 0 : Math.floor(t * TWINKLE_STEPS_PER_SECOND)
}

/** A star's strength at a twinkle step: it twinkles unless the scene holds still. */
export function starStrength(star: Star, step: number, still: boolean): number {
  return star.base * (still ? 1 : 0.65 + 0.35 * Math.sin(step / TWINKLE_STEPS_PER_SECOND * star.speed + star.phase))
}

/** The density ramp the landscape and the owl are drawn in, faintest first. */
export const RAMP = ' .·:-=+*#%@'
/** A ripple's ring, faintest first. */
export const RIPPLE_GLYPHS = '·∘oO'
/** The moon's whirlpool, faintest first. */
export const WHIRL_GLYPHS = '·:+*%@'

/** The glyph for a density between 0 and 1: never the blank, since a cell drawn at all shows something. */
export function rampGlyph(density: number): string {
  return RAMP[Math.max(1, Math.round(clamp(density, 0, 1) * (RAMP.length - 1)))]!
}
