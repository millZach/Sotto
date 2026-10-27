import type { WatcherScene } from '../../../shared/watcherScene'
import { owlAt, type SceneInk, type SceneMeasure } from './nightScene'
import { context, makeCanvas, NightScenePainter } from './nightScenePainter'
import type { FamilyOwl, OwlMood, ThreadOwlPose } from './owlFamily'

/**
 * A place's picture for Settings → Appearance (ADR-0148), drawn by the night scene's own painter in a small room of its
 * own: the narrowest column that still leaves both margins their trees, no header and no words, Watcher's owl at home
 * and two thread owls on their spots, everything holding still. The picture is drawn once at this size and shown
 * smaller, so its glyphs are the scene's own, finer.
 */
export const THUMBNAIL_ROOM: SceneMeasure = { width: 380, height: 170, header: 0, composer: { x: 160, y: 118, w: 60, h: 28 }, words: [] }

const THUMBNAIL_OWLS: readonly OwlMood[] = ['waiting', 'asleep']

/** Draws `place` on `target` in the theme's inks; false when there is no canvas to draw with. */
export function paintSceneThumbnail(target: HTMLCanvasElement, place: WatcherScene, ink: SceneInk, fontFamily: string, dpr: number): boolean {
  const back = makeCanvas(), front = makeCanvas()
  const painter = new NightScenePainter(back, front)
  painter.setPlace(place)
  const layout = painter.resize(THUMBNAIL_ROOM, dpr)
  if (layout === null) return false
  painter.setInk(ink, fontFamily)
  const spots = layout.spots.filter(spot => spot.kind === 'limb' || spot.kind === 'tree')
  const owls: ThreadOwlPose[] = THUMBNAIL_OWLS.flatMap((mood, order) => {
    const spot = spots[order]
    if (spot === undefined) return []
    const owl: FamilyOwl = { key: `thumbnail-${order}`, title: '', threadId: null, mood, spot: order, animation: null, order }
    return [{ owl, x: spot.x, y: spot.y, flying: false, alpha: 1 }]
  })
  const watcher = owlAt(0, layout, { at: 'home', side: 'left', flight: null, next: 0 }, { still: true })
  painter.draw({ t: 0, still: true, ripples: [], watcher, owls, whirl: 0, pile: null })
  const ctx = context(target)
  if (ctx === null) return false
  target.width = back.width; target.height = back.height
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(back, 0, 0); ctx.drawImage(front, 0, 0)
  return true
}
