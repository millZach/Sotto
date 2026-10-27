import type { WatcherScene } from '../../../shared/watcherScene'
import { owlAt, type SceneInk, type SceneLayout, type SceneMeasure } from './nightScene'
import { context, makeCanvas, NightScenePainter } from './nightScenePainter'
import type { FamilyOwl, OwlMood, ThreadOwlPose } from './owlFamily'

/**
 * A place's picture for Settings → Appearance (ADR-0149), drawn by the night scene's own painter in a small room of its
 * own, about the size of a small window's margins and column, with no header and no words, Watcher's owl at home and
 * two thread owls on their spots, moving as the room does unless motion is reduced. A smaller room would thin its trees
 * and limbs below a glyph's density; this one keeps them, and is shown smaller, so its glyphs are the scene's own, finer.
 */
export const THUMBNAIL_ROOM: SceneMeasure = { width: 520, height: 231, header: 0, composer: { x: 165, y: 170, w: 190, h: 36 }, words: [] }

/**
 * How much stronger the picture's glyphs are drawn than the room's: shown at about two fifths of its size, each glyph
 * is averaged with the canvas round it and would read fainter than the scene does. The inks are still the theme's.
 */
export const THUMBNAIL_INK_BOOST = 1.8

/** The theme's inks, each step taking a stronger one, so the shrunken picture reads as strong as the room. */
export function thumbnailInk(ink: SceneInk): SceneInk {
  const stronger = (steps: readonly string[]): string[] => steps.map((_, k) => steps[Math.min(steps.length - 1, Math.round(k * THUMBNAIL_INK_BOOST))]!)
  return { ...ink, ink: stronger(ink.ink), accent: stronger(ink.accent) }
}

const THUMBNAIL_OWLS: readonly OwlMood[] = ['awake', 'asleep']

/**
 * A place's picture, laid out once for a theme and place: the painter, Watcher's owl at home and two thread owls on
 * their spots. `paint` draws it at a moment of the scene's clock, moving as the room does, or holding still.
 */
export class SceneThumbnail {
  private readonly back = makeCanvas()
  private readonly front = makeCanvas()
  private readonly painter = new NightScenePainter(this.back, this.front)
  private readonly layout: SceneLayout | null
  private readonly owls: readonly ThreadOwlPose[]

  constructor(place: WatcherScene, ink: SceneInk, fontFamily: string, dpr: number) {
    this.painter.setPlace(place)
    this.layout = this.painter.resize(THUMBNAIL_ROOM, dpr)
    this.painter.setInk(thumbnailInk(ink), fontFamily)
    const spots = this.layout?.spots.filter(spot => spot.kind === 'limb' || spot.kind === 'tree') ?? []
    this.owls = THUMBNAIL_OWLS.flatMap((mood, order) => {
      const spot = spots[order]
      if (spot === undefined) return []
      const owl: FamilyOwl = { key: `thumbnail-${order}`, title: '', threadId: null, mood, spot: order, animation: null, order }
      return [{ owl, x: spot.x, y: spot.y, flying: false, alpha: 1 }]
    })
  }

  /** Draws the picture at `t` seconds on `target`; false when there is nothing to draw with. */
  paint(target: HTMLCanvasElement, t: number, still: boolean): boolean {
    const layout = this.layout
    if (layout === null) return false
    const watcher = owlAt(t, layout, { at: 'home', side: 'left', flight: null, next: Number.POSITIVE_INFINITY }, { still })
    this.painter.draw({ t, still, ripples: [], watcher, owls: this.owls, whirl: 0, pile: null })
    const ctx = context(target)
    if (ctx === null) return false
    if (target.width !== this.back.width || target.height !== this.back.height) { target.width = this.back.width; target.height = this.back.height }
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.drawImage(this.back, 0, 0); ctx.drawImage(this.front, 0, 0)
    return true
  }
}
