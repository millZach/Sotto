import { describe, expect, it } from 'vitest'

import { CELL, groundAt, layoutScene, seeded, type SceneMeasure } from '../../../src/renderer/src/watcher/nightScene'
import type { AmbientGlyph } from '../../../src/renderer/src/watcher/scenePlace'
import {
  ANIMAL_EVERY, ANIMAL_RETRY, busyOf, FIREFLIES, GUST_EVERY, MOST_HAPPENINGS, QUICK_WOOD_STEPS, QUIET_AFTER, QUIET_ANIMALS, riverAt, WOOD_STEPS, WoodLife, type LandGlyphs,
} from '../../../src/renderer/src/watcher/woodLife'

function room(width: number, height: number): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2)
  return { width, height, header: 48, composer: { x: gutter, y: height - 150, w: width - gutter * 2, h: 110 }, words: [] }
}
const layout = layoutScene(room(1600, 1000))
type Emitted = { readonly x: number; readonly y: number; readonly glyph: string; readonly accent: boolean; readonly strength: number; readonly over: boolean }
function frame(wood: WoodLife, t: number, options: { readonly still?: boolean; readonly busy?: number; readonly pointer?: { x: number; y: number } | null } = {}): Emitted[] {
  const out: Emitted[] = []
  const emit: AmbientGlyph = (x, y, glyph, accent, strength, over) => { out.push({ x, y, glyph, accent, strength, over }) }
  wood.glyphs(t, options.still === true, options.busy ?? 0.5, options.pointer ?? null, emit)
  return out
}
/** A wood whose first gust is far off, so a test sees only what it starts. */
const calm = (land: LandGlyphs | null = null): WoodLife => new WoodLife(layout, 1e6, seeded(5), land)

describe('how busy the room is (ADR-0199)', () => {
  it('goes from 0 with nothing working to 1 with most of its threads working, and never past either', () => {
    expect(busyOf(0, 0)).toBe(0)
    expect(busyOf(0, 8)).toBe(0)
    expect(busyOf(2, 8)).toBeCloseTo(2 / 4.8, 6)
    expect(busyOf(8, 8)).toBe(1)
    // A room with one or two threads is not busy because both work.
    expect(busyOf(2, 2)).toBe(0.5)
  })
})

describe('the night wood’s river', () => {
  it('runs from the far hills to the pane’s foot, down all the way, in the left margin', () => {
    const start = riverAt(layout, 0), end = riverAt(layout, 1)
    expect(start.y).toBeCloseTo(layout.horizon + 6, 6)
    expect(end.y).toBeCloseTo(layout.height, 6)
    let last = start.y
    for (let share = 0.02; share <= 1; share += 0.02) {
      const at = riverAt(layout, share)
      expect(at.x).toBeLessThan(layout.column.left)
      expect(at.y).toBeGreaterThanOrEqual(last - 1e-6)
      last = at.y
    }
  })
})

describe('the wood’s life (ADR-0199)', () => {
  it('raises no wind when it is made, so a window dragged to a new size is not a storm', () => {
    const wood = new WoodLife(layout, 500, seeded(5), null)
    expect(wood.step(500, 1, 4)).toBeNull()
    expect(wood.windAt(300, 500.5)).toBeCloseTo(0.08, 6)
    expect(frame(wood, 500.5).some(mark => mark.glyph === '/')).toBe(false)
    // A few seconds on, the first gust crosses from the left: the grass leans where its front is.
    for (let t = 500; t < 508; t += 0.5) wood.step(t, 1, 4)
    let leaned = 0
    for (let t = 503; t < 512; t += 0.25) leaned += frame(wood, t).filter(mark => mark.glyph === '/' && !mark.accent).length
    expect(leaned).toBeGreaterThan(20)
  })

  it('sends a gust more often the busier the room is', () => {
    const gusts = (busy: number): number => {
      const wood = new WoodLife(layout, 0, seeded(9), null)
      let count = 0, blowing = false
      for (let t = 0; t < 600; t += 0.5) {
        wood.step(t, busy, busy > 0 ? 4 : 0)
        // A gust's front passes x = 0 a little after it sets off.
        const now = wood.windAt(0, t) > 0.5
        if (now && !blowing) count++
        blowing = now
      }
      return count
    }
    const quiet = gusts(0), busy = gusts(1)
    expect(busy).toBeGreaterThan(quiet * 2)
    expect(quiet).toBeGreaterThan(600 / (GUST_EVERY.quiet * 1.3) - 2)
    expect(busy).toBeLessThan(600 / (GUST_EVERY.busy * 0.7) + 2)
  })

  it('sends its animals out only while nothing has worked for a while, one at a time, far apart and in turn', () => {
    const wood = calm(), out: Array<{ readonly animal: string; readonly t: number }> = []
    for (let t = 0; t < 10; t += 0.5) expect(wood.step(t, 0.5, 2), 'while threads work').toBeNull()
    for (let t = 10; t < 10 + ANIMAL_EVERY * 6; t += 0.5) { const animal = wood.step(t, 0, 0); if (animal !== null) out.push({ animal, t }) }
    expect(out.slice(0, 4).map(item => item.animal)).toEqual([...QUIET_ANIMALS])
    expect(out[0]!.t).toBeCloseTo(10 + QUIET_AFTER, 0)
    for (let k = 1; k < out.length; k++) expect(out[k]!.t - out[k - 1]!.t).toBeGreaterThanOrEqual(ANIMAL_EVERY * 0.7 - 0.5)
    // Work starting again sends them home: the wait begins over.
    const again = calm()
    for (let t = 0; t < QUIET_AFTER - 2; t += 0.5) again.step(t, 0, 0)
    again.step(QUIET_AFTER - 1, 0.3, 1)
    for (let t = QUIET_AFTER; t < QUIET_AFTER * 2 - 2; t += 0.5) expect(again.step(t, 0, 0)).toBeNull()
  })

  it('lets an animal that could not come out keep its turn, and sends it again a few seconds on', () => {
    // W3: the hunt's turn was used up when Watcher's owl could not start it, and the next animal took its place.
    const wood = calm()
    const next = (from: number, to: number): { readonly animal: string; readonly t: number } | null => {
      for (let t = from; t < to; t += 0.5) { const animal = wood.step(t, 0, 0); if (animal !== null) return { animal, t } }
      return null
    }
    const out: string[] = []
    let t = 0
    while (out.length < 3) { const sent = next(t, t + ANIMAL_EVERY * 2)!; out.push(sent.animal); t = sent.t + 0.5 }
    const hunt = next(t, t + ANIMAL_EVERY * 2)!
    expect([...out, hunt.animal]).toEqual([...QUIET_ANIMALS])
    // It could not start: it is sent again soon, and is still the hunt, twice over.
    for (let tries = 0, at = hunt.t; tries < 2; tries++) {
      wood.again(at)
      const again = next(at + 0.5, at + ANIMAL_EVERY)!
      expect(again.animal).toBe('hunt')
      expect(again.t - at).toBeLessThanOrEqual(ANIMAL_RETRY + 0.5)
      at = again.t
    }
    // Once it has come out, the turn passes on to the first again.
    expect(next(hunt.t + ANIMAL_RETRY * 3, hunt.t + ANIMAL_EVERY * 3)!.animal).toBe('fox')
  })

  it('answers a finished turn with a shooting star, a failed one with bats from the bare tree, and settled work with a meteor shower', () => {
    const star = calm()
    star.finished(10)
    expect(star.quick(10.2)).toBe(true)
    const heads = (wood: WoodLife, from: number, to: number): number => { let most = 0; for (let t = from; t < to; t += 0.05) most = Math.max(most, frame(wood, t).filter(mark => mark.glyph === '*' && mark.accent && mark.over).length); return most }
    expect(heads(star, 10.4, 11.4)).toBe(1)
    const shower = calm()
    shower.settled(10)
    expect(heads(shower, 10.7, 15)).toBeGreaterThan(1)
    const bats = calm()
    bats.failed(10)
    const flock = frame(bats, 10.5).filter(mark => '^v-'.includes(mark.glyph) && !mark.accent && mark.over)
    expect(flock.length).toBe(21)
    // They leave the bare tree, in the right margin, going up and to the left.
    const later = frame(bats, 12).filter(mark => '^v-'.includes(mark.glyph) && !mark.accent && mark.over)
    expect(Math.max(...flock.map(mark => mark.x))).toBeGreaterThan(layout.column.right)
    expect(Math.min(...later.map(mark => mark.y))).toBeLessThan(Math.min(...flock.map(mark => mark.y)))
    // Once each has passed, nothing of it is left.
    for (const wood of [star, shower, bats]) { wood.step(40, 0.5, 2); expect(wood.quick(40)).toBe(false) }
  })

  it('never holds more than a few things happening at once', () => {
    const wood = calm()
    for (let k = 0; k < 40; k++) wood.finished(10)
    const stars = frame(wood, 10.9).filter(mark => mark.glyph === '*' && mark.accent && mark.over)
    expect(stars.length).toBeLessThanOrEqual(MOST_HAPPENINGS)
  })

  it('walks its fox along the ground from one side of the pane to the other, stopping once to look up', () => {
    const wood = calm()
    wood.animalOut('fox', 10)
    const fox = (t: number): Emitted[] => frame(wood, t).filter(mark => mark.over && !'/'.includes(mark.glyph) && '~-._\\°>|'.includes(mark.glyph) && mark.strength === 0.9)
    const early = fox(12), late = fox(24)
    expect(early.length).toBeGreaterThan(8)
    expect(Math.max(...late.map(mark => mark.x))).toBeGreaterThan(Math.max(...early.map(mark => mark.x)) + 300)
    for (const mark of early) {
      const ground = groundAt(layout, mark.x)
      expect(mark.y).toBeLessThan(ground + CELL.h)
      expect(mark.y).toBeGreaterThan(ground - CELL.h * 3)
    }
    expect(early.some(mark => mark.glyph === '°' && mark.accent)).toBe(true)
    const stopped = (layout.column.left * 0.62 + 70) / 95 + 10
    expect(frame(wood, stopped + 1).some(mark => mark.glyph === '?' && mark.accent)).toBe(true)
  })

  it('jumps a fish in the open river, and brings a mouse out under Watcher’s tree that bolts for the room', () => {
    const wood = calm()
    wood.animalOut('fish', 10)
    const fish = frame(wood, 10.45).filter(mark => '><'.includes(mark.glyph) && mark.accent)
    expect(fish).toHaveLength(3)
    expect(Math.max(...fish.map(mark => mark.x))).toBeLessThan(layout.column.left)
    expect(fish[0]!.y).toBeLessThan(riverAt(layout, 0.27).y - 20)
    const at = wood.mouse(20)!
    expect(at.y).toBeCloseTo(groundAt(layout, at.x), 6)
    expect(at.x).toBeGreaterThan(layout.left.x)
    expect(at.x).toBeLessThan(layout.column.left)
    const mouse = (t: number): number => { const marks = frame(wood, t).filter(mark => mark.glyph === 'o' && mark.accent && mark.over); return marks.length === 0 ? Number.NaN : marks[0]!.x }
    expect(mouse(21)).toBeLessThan(mouse(23))
    wood.bolt(25)
    expect(mouse(25.5)).toBeGreaterThan(at.x + 150)
    wood.step(27, 0.5, 2)
    expect(Number.isNaN(mouse(27))).toBe(true)
  })

  it('drifts a cloud across the moon', () => {
    const wood = calm()
    wood.animalOut('cloud', 10)
    const over = (t: number): number => frame(wood, t).filter(mark => mark.over && !mark.accent && '=~-·'.includes(mark.glyph) && Math.hypot(mark.x - layout.moon.x, mark.y - layout.moon.y) < layout.moon.r).length
    expect(over(11)).toBe(0)
    let most = 0
    for (let t = 12; t < 30; t += 0.5) most = Math.max(most, over(t))
    expect(most).toBeGreaterThan(8)
  })

  it('shows more fireflies and thicker mist the quieter the room, keeps the fireflies off the pointer, and runs the river faster the busier', () => {
    const wood = calm()
    const flies = (busy: number): number => { let most = 0; for (let t = 0; t < 30; t += 0.3) most = Math.max(most, frame(wood, t, { busy }).filter(mark => mark.accent && !mark.over).length); return most }
    expect(flies(0)).toBeGreaterThan(flies(1))
    expect(flies(0)).toBeLessThanOrEqual(FIREFLIES.quiet)
    expect(flies(1)).toBeLessThanOrEqual(FIREFLIES.busy)
    const mist = (busy: number): number => frame(wood, 3, { busy }).filter(mark => !mark.accent && !mark.over && '~-·'.includes(mark.glyph)).length
    expect(mist(0)).toBeGreaterThan(mist(1))
    // A firefly that would glow where the pointer rests is pushed clear of it.
    const lit = frame(wood, 4, { busy: 0 }).filter(mark => mark.accent && !mark.over)[0]!
    for (const mark of frame(wood, 4, { busy: 0, pointer: { x: lit.x, y: lit.y } }).filter(item => item.accent && !item.over)) expect(Math.hypot(mark.x - lit.x, mark.y - lit.y)).toBeGreaterThan(40)
    const glints = (t: number, busy: number): number[] => frame(wood, t, { busy, still: true }).filter(mark => mark.accent && mark.over).map(mark => mark.y)
    expect(glints(0, 0)).toHaveLength(18)
    expect(glints(5, 1)).not.toEqual(glints(5, 0))
  })

  it('sways the crowns a cell with the wind, in the landscape’s own characters, where it is given them', () => {
    const land: LandGlyphs = { code: cell => cell % 3 === 0 ? 35 : 0, strength: () => 0.6 }
    const swaying = (wood: WoodLife): number => {
      wood.gust(10)
      let most = 0
      for (let t = 10; t < 18; t += 0.25) most = Math.max(most, frame(wood, t).filter(mark => mark.over && !mark.accent && (mark.glyph === '#' || mark.glyph === ' ')).length)
      return most
    }
    expect(swaying(calm(land))).toBeGreaterThan(50)
    expect(swaying(calm())).toBe(0)
  })

  it('holds still with the scene: fireflies, glints and mist stand where they rest, and nothing happens', () => {
    const wood = calm()
    wood.gust(1); wood.finished(1); wood.failed(1); wood.settled(1); wood.animalOut('fox', 1); wood.animalOut('cloud', 1)
    const still = frame(wood, 41.3, { still: true })
    // W1: whenever it is painted again, for an owl's calm step or a new size, they are where they were. They were
    // drawn at the scene's live clock, so each such painting moved every one of them.
    for (const t of [0, 3, 44, 41.3, 5000.7]) expect(frame(wood, t, { still: true }), `painted again at ${t}`).toEqual(still)
    expect(still.length).toBeGreaterThan(40)
    // Moving, the same wood does change from one moment to another.
    expect(frame(wood, 60)).not.toEqual(frame(wood, 64))
    expect(still.some(mark => '/^v>?*='.includes(mark.glyph) && mark.over && !mark.accent)).toBe(false)
    expect(still.filter(mark => mark.accent && !mark.over).length).toBeGreaterThan(0)
    expect(wood.stepOf(3, true)).toBe(0)
    expect(wood.stepOf(99, true)).toBe(0)
  })

  it('steps eight times a second, faster only while something quick crosses, and draws a bounded picture', () => {
    const wood = calm()
    expect(wood.stepOf(2, false)).toBe(2 * WOOD_STEPS)
    wood.finished(2)
    expect(wood.stepOf(2.5, false)).toBe(Math.floor(2.5 * QUICK_WOOD_STEPS))
    wood.step(10, 0.5, 2)
    expect(wood.stepOf(10, false)).toBe(10 * WOOD_STEPS)
    // Everything at once, over a minute: what a frame draws stays within the pane's own bound, however long it runs.
    const busy = new WoodLife(layout, 0, seeded(3), { code: () => 35, strength: () => 0.5 })
    let most = 0
    for (let t = 0; t < 60; t += 0.25) {
      busy.step(t, 1, 6)
      if (Math.floor(t) % 5 === 0 && t % 1 === 0) { busy.finished(t); busy.failed(t); busy.settled(t); busy.animalOut('cloud', t); busy.animalOut('fox', t) }
      most = Math.max(most, frame(busy, t, { busy: 1 }).length)
    }
    expect(most).toBeLessThan(3000)
  })
})
