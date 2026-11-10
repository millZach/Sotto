import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CELL, layoutScene, owlAt, sceneInk, type SceneMeasure } from '../../../src/renderer/src/watcher/nightScene'
import { NightScenePainter } from '../../../src/renderer/src/watcher/nightScenePainter'
import {
  asksOf, failedOf, fidgetHop, fidgetOf, livingGlyphs, owlGlyphs, PERCHED_OWL, toldOf,
  type FamilyOwl, type OwlAct, type OwlLivesView, type OwlMood, type ThreadOwlPose, type WatchedOwl,
} from '../../../src/renderer/src/watcher/owlFamily'
import { headOf, MOST_PASSING, OwlLives, QUICK_STEPS, roundPerch, SPARKS, SPARKS_LIFE } from '../../../src/renderer/src/watcher/owlLife'
import type { AmbientGlyph } from '../../../src/renderer/src/watcher/scenePlace'

const owl = (mood: OwlMood, patch: Partial<FamilyOwl> = {}): FamilyOwl => ({ key: 'k', title: 't', threadId: 't', mood, failed: false, asks: null, spot: 0, animation: null, order: 0, ...patch })
const sitting = (mood: OwlMood, patch: Partial<FamilyOwl> = {}, at = { x: 210, y: 300 }): ThreadOwlPose => ({ owl: owl(mood, patch), ...at, flying: false, alpha: 1 })
/** Lives in which nothing special is happening, but for the one act given. */
const quiet = (act: OwlAct | null = null, watcherFlying = false): OwlLivesView => ({ watcherFlying, actOf: (_key, t) => act !== null && t >= act.t0 && t < act.t0 + act.dur ? act : null })
const watched = (key: string, mood: OwlMood, patch: Partial<WatchedOwl> = {}): WatchedOwl => ({ key, title: key, threadId: key, mood, ...patch })
type Emitted = { readonly x: number; readonly y: number; readonly glyph: string; readonly accent: boolean; readonly strength: number; readonly over: boolean }
function emitted(run: (emit: AmbientGlyph) => void): Emitted[] {
  const out: Emitted[] = []
  run((x, y, glyph, accent, strength, over) => { out.push({ x, y, glyph, accent, strength, over }) })
  return out
}

describe('what a watched row tells its owl (ADR-0199)', () => {
  it('knows a failed last turn, what the thread waits on the user for, and how many messages Watcher has sent it', () => {
    expect(failedOf({ status: 'error' })).toBe(true)
    for (const status of ['idle', 'running', 'unavailable'] as const) expect(failedOf({ status })).toBe(false)
    const target = { hostId: 'h', threadId: 't' }
    expect(asksOf({ waitsOn: [] })).toBeNull()
    expect(asksOf({ waitsOn: [{ id: 'a', kind: 'permission', openTarget: target }, { id: 'b', kind: 'question', openTarget: target }] })).toBe('permission')
    const part = (promptCount: number) => ({ requestId: '00000000-0000-4000-8000-000000000000', startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target, promptCount })
    expect(toldOf({ participation: [] })).toBe(0)
    expect(toldOf({ participation: [part(2), part(3)] })).toBe(5)
  })
})

describe('a thread owl acting out its thread (ADR-0199)', () => {
  const options = (lives: OwlLivesView | null, still = false) => ({ rail: false, still, lives })

  it('is drawn as it always was with no lives, on the rail, in flight and holding still', () => {
    const lives = quiet({ kind: 'happy', t0: 0, dur: 10 })
    for (const mood of ['awake', 'asleep', 'waiting'] as const) {
      const pose = sitting(mood, { failed: true }), plain = owlGlyphs(pose, 1, { rail: false, still: false })
      expect(owlGlyphs(pose, 1, options(null))).toEqual(plain)
      expect(owlGlyphs(pose, 1, options(lives, true))).toEqual(owlGlyphs(pose, 1, { rail: false, still: true }))
      expect(owlGlyphs(pose, 1, { rail: true, still: false, lives })).toEqual(owlGlyphs(pose, 1, { rail: true, still: false }))
      expect(owlGlyphs({ ...pose, flying: true }, 1, options(lives))).toEqual(owlGlyphs({ ...pose, flying: true }, 1, { rail: false, still: false }))
    }
  })

  it('winces, feathers ruffled, after a failed turn, whatever else it would do', () => {
    for (const mood of ['asleep', 'awake'] as const) expect(owlGlyphs(sitting(mood, { failed: true }), 3, options(quiet({ kind: 'happy', t0: 0, dur: 10 })))).toEqual(['{>,<}', '/)~~)', PERCHED_OWL[2]])
  })

  it('waves one wing, then the other, while it waits on the user, its face where it always is', () => {
    const faces = new Set<string>()
    for (let t = 0; t < 4; t += 0.1) {
      const rows = owlGlyphs(sitting('waiting'), t, options(quiet()))
      expect(rows.map(row => row.length)).toEqual([7, 7, 7])
      expect(rows[0]!.slice(1, 6)).toBe('{O,O}')
      expect(rows[1]!.slice(1, 6)).toBe(PERCHED_OWL[1])
      faces.add(rows[0]!)
    }
    expect([...faces].sort()).toEqual([' {O,O} ', ' {O,O}/', '\\{O,O} '].sort())
  })

  it('is happy for a moment, wakes with a stretch, hops and looks up, each for as long as its act lasts', () => {
    const face = (mood: OwlMood, kind: OwlAct['kind'], t: number): string => owlGlyphs(sitting(mood), t, options(quiet({ kind, t0: 10, dur: 2 })))[0]!
    expect(face('asleep', 'happy', 11)).toBe('{^,^}')
    expect(face('asleep', 'happy', 12.5)).toBe('{-,-}')
    expect([face('awake', 'wake', 10.2), face('awake', 'wake', 11), face('awake', 'wake', 11.8)]).toEqual(['{-,o}', '\\{o,o}/', '{o,o}'])
    expect(face('awake', 'lookup', 11)).toBe('{°,°}')
    expect(owlGlyphs(sitting('awake'), 11, options(quiet({ kind: 'hop', t0: 10, dur: 2 })))).toEqual(['{o,o}', PERCHED_OWL[1], " ' ' "])
    expect(owlGlyphs(sitting('asleep'), 11, options(quiet({ kind: 'hop', t0: 10, dur: 2 })))[0]).toBe('{-,-}')
  })

  it('watches Watcher’s owl fly over while it works, and sleeps through it otherwise', () => {
    expect(owlGlyphs(sitting('awake'), 1, options(quiet(null, true)))[0]).toBe('{°,°}')
    expect(owlGlyphs(sitting('asleep'), 1, options(quiet(null, true)))[0]).toBe('{-,-}')
  })

  it('fidgets while it works: looks down at its work, turns round, stretches, looks up and hops, each owl at its own moment', () => {
    const seen = new Set<string>()
    let hops = 0
    for (let order = 0; order < 6; order++) for (let t = 0; t < 400; t += 0.2) {
      const rows = livingGlyphs(owl('awake', { order }), t, quiet())
      if (rows !== null) seen.add(`${rows[0]}|${rows[1]}`)
      if (fidgetHop(order, t)) hops++
    }
    for (const pose of ['{.,.}|/)__)', '{o,o}|(__(\\', '\\{o,o}/| /)__) ', '{°,°}|/)__)']) expect(seen, pose).toContain(pose)
    expect(hops).toBeGreaterThan(0)
    // The same owl at the same moment always does the same, and two owls differ.
    expect(fidgetOf(2, 31.4)).toEqual(fidgetOf(2, 31.4))
    expect(Array.from({ length: 40 }, (_, k) => fidgetOf(0, k * 2.8).roll)).not.toEqual(Array.from({ length: 40 }, (_, k) => fidgetOf(1, k * 2.8).roll))
    // An owl asleep with nothing to do is left as it was.
    expect(livingGlyphs(owl('asleep'), 5, quiet())).toBeNull()
  })
})

describe('the thread owls’ lives (ADR-0199)', () => {
  const nowhere = (): null => null

  it('holds an act for as long as it lasts, and drops it after', () => {
    const lives = new OwlLives()
    lives.act('a', 'hop', 5, 0.3)
    expect(lives.actOf('a', 4.9)).toBeNull()
    expect(lives.actOf('a', 5.1)?.kind).toBe('hop')
    expect(lives.moving(5.1)).toBe(true)
    expect(lives.actOf('a', 5.3)).toBeNull()
    lives.step(6)
    expect(lives.moving(6)).toBe(false)
  })

  it('starts nothing for a thread seen for the first time, whose owl is on its way out of the moon', () => {
    const lives = new OwlLives()
    expect(lives.take([watched('a', 'awake', { told: 3 }), watched('b', 'asleep')], 1, nowhere)).toEqual([])
    expect(lives.moving(1)).toBe(false)
  })

  it('wakes an owl whose thread starts working again, and makes one happy whose question was answered', () => {
    const lives = new OwlLives()
    lives.take([watched('a', 'asleep'), watched('b', 'waiting')], 1, nowhere)
    lives.take([watched('a', 'awake'), watched('b', 'awake')], 2, nowhere)
    expect(lives.actOf('a', 2.5)?.kind).toBe('wake')
    expect(lives.actOf('b', 2.5)?.kind).toBe('happy')
  })

  it('gives an owl whose turn finished sparks and a happy moment, and one whose turn failed neither', () => {
    const lives = new OwlLives()
    lives.take([watched('a', 'awake'), watched('b', 'awake')], 1, nowhere)
    lives.take([watched('a', 'asleep'), watched('b', 'asleep', { failed: true })], 2, key => key === 'a' ? { x: 200, y: 300 } : null)
    expect(lives.actOf('a', 3)?.kind).toBe('happy')
    expect(lives.actOf('b', 3)).toBeNull()
    const sparks = emitted(emit => lives.glyphs([], 2.3, false, emit))
    expect(sparks).toHaveLength(SPARKS)
    expect(sparks.every(spark => spark.accent && '*+·'.includes(spark.glyph))).toBe(true)
    expect(emitted(emit => lives.glyphs([], 2 + SPARKS_LIFE + 0.1, false, emit))).toEqual([])
  })

  it('names the threads Watcher has sent a message since they were last taken, and forgets a thread that left', () => {
    const lives = new OwlLives()
    lives.take([watched('a', 'awake', { told: 1 }), watched('b', 'awake', { told: 1 })], 1, nowhere)
    expect(lives.take([watched('a', 'awake', { told: 2 }), watched('b', 'awake', { told: 1 })], 2, nowhere)).toEqual(['a'])
    expect(lives.take([watched('a', 'awake', { told: 2 })], 3, nowhere)).toEqual([])
    // Watched again, it is a newcomer: nothing is started for what it was told before.
    expect(lives.take([watched('a', 'awake', { told: 2 }), watched('b', 'awake', { told: 4 })], 4, nowhere)).toEqual([])
  })

  it('draws a hopping owl a row higher, and leaves one in flight where it is', () => {
    const lives = new OwlLives(), pose = sitting('awake')
    lives.act('k', 'hop', 1, 0.3)
    expect(lives.lifted(pose, 1.1).y).toBe(pose.y - CELL.h)
    expect(lives.lifted(pose, 2)).toBe(pose)
    expect(lives.lifted({ ...pose, flying: true }, 1.1).y).toBe(pose.y)
    expect(lives.lifted(sitting('awake', { failed: true }), 50)).toEqual(sitting('awake', { failed: true }))
  })

  it('shows a ? or a ! over an owl that waits on the user, clear of its glow, and zs rising from one asleep', () => {
    const lives = new OwlLives()
    const question = sitting('waiting', { asks: 'question' }), permission = sitting('waiting', { asks: 'permission' })
    const head = Math.floor((question.y - 1) / CELL.h) - 2
    for (const [pose, glyph] of [[question, '?'], [permission, '!']] as const) for (const t of [0.1, 0.6]) {
      const marks = emitted(emit => lives.glyphs([pose], t, false, emit))
      expect(marks.map(mark => mark.glyph)).toEqual([glyph])
      expect(marks[0]!.accent).toBe(true)
      // The painter lays the glow over the row above the owl's head, so the mark stands at least two rows above it.
      expect(Math.floor(marks[0]!.y / CELL.h)).toBeLessThanOrEqual(head - 2)
      expect(Math.abs(marks[0]!.x - question.x)).toBeLessThanOrEqual(CELL.w)
    }
    const counts = new Set<number>()
    for (let t = 0; t < 12; t += 0.2) {
      const zs = emitted(emit => lives.glyphs([sitting('asleep')], t, false, emit))
      expect(zs.every(z => !z.accent && !z.over && 'zZ'.includes(z.glyph))).toBe(true)
      counts.add(zs.length)
    }
    expect([...counts].sort()).toEqual([0, 1, 2, 3])
    expect(emitted(emit => lives.glyphs([sitting('asleep', { failed: true }), sitting('awake')], 0.5, false, emit))).toEqual([])
    expect(emitted(emit => lives.glyphs([{ ...sitting('asleep'), flying: true }, { ...sitting('waiting'), alpha: 0.4 }], 0.5, false, emit))).toEqual([])
  })

  it('calls a note from one owl to another along an arc, and never holds more than a few things crossing', () => {
    const lives = new OwlLives(), from = { x: 100, y: 400 }, to = { x: 700, y: 380 }
    const crossing = lives.call(from, to, 10, true)
    expect(crossing).toBeGreaterThanOrEqual(0.7)
    expect(crossing).toBeLessThanOrEqual(1.5)
    const noteAt = (t: number) => emitted(emit => lives.glyphs([], t, false, emit)).find(mark => mark.glyph === '♪')!
    const early = noteAt(10 + crossing * 0.1), middle = noteAt(10 + crossing * 0.5), late = noteAt(10 + crossing * 0.95)
    expect(early.x).toBeLessThan(middle.x)
    expect(middle.x).toBeLessThan(late.x)
    expect(middle.y).toBeLessThan(Math.min(from.y, to.y))
    expect(Math.hypot(late.x - to.x, late.y - to.y)).toBeLessThan(30)
    expect(emitted(emit => lives.glyphs([], 10 + crossing * 0.5, false, emit)).length).toBeLessThanOrEqual(3)
    expect(lives.quick(10.2)).toBe(true)
    for (let k = 0; k < 30; k++) lives.sparks({ x: k, y: 100 }, 20)
    expect(emitted(emit => lives.glyphs([], 20.5, false, emit)).length).toBeLessThanOrEqual(MOST_PASSING * SPARKS)
  })

  it('holds still with the scene: the marks stand where they rest, one z an owl, and nothing crosses', () => {
    const lives = new OwlLives(), poses = [sitting('waiting', { asks: 'permission' }), sitting('asleep', { key: 's', order: 3 }, { x: 400, y: 300 })]
    lives.sparks({ x: 300, y: 300 }, 1)
    lives.call({ x: 100, y: 300 }, { x: 500, y: 300 }, 1, true)
    const at = (t: number) => emitted(emit => lives.glyphs(poses, t, true, emit))
    expect(at(1.3).map(mark => mark.glyph).sort()).toEqual(['!', 'z'])
    expect(at(1.3)).toEqual(at(77))
    expect(lives.stepOf(poses, 1.3, true)).toBe(lives.stepOf(poses, 77, true))
  })

  it('asks for a new painting only when the picture would change, and faster only while something crosses', () => {
    const lives = new OwlLives(), poses = [sitting('waiting'), sitting('asleep', { key: 's', order: 1 }), sitting('awake', { key: 'w', order: 2 })]
    // Nothing to mark over a working owl alone.
    expect(lives.stepOf([sitting('awake')], 3, false)).toBe(lives.stepOf([sitting('awake')], 9.7, false))
    // Step and picture change together: over twelve seconds each new step shows something new, and never one without the other.
    let steps = 0, pictures = 0, lastStep = '', lastPicture = ''
    for (let t = 0; t < 12; t += 0.05) {
      const step = lives.stepOf(poses, t, false), picture = JSON.stringify(emitted(emit => lives.glyphs(poses, t, false, emit)))
      if (step !== lastStep) { steps++; lastStep = step }
      if (picture !== lastPicture) { pictures++; lastPicture = picture }
    }
    expect(steps).toBe(pictures)
    expect(steps).toBeLessThan(12 * 4)
    lives.sparks({ x: 0, y: 0 }, 20)
    expect(lives.stepOf([], 20.5, false)).toBe(`q${Math.floor(20.5 * QUICK_STEPS)}`)
    lives.step(20 + SPARKS_LIFE + 0.1)
    expect(lives.stepOf([], 22, false)).toBe('')
  })

  it('sends Watcher’s owl to its own tree for an owl in the left margin, and to the other tree for one in the right', () => {
    const layout = layoutScene({ width: 1600, height: 1000, header: 48, composer: { x: 420, y: 850, w: 760, h: 110 }, words: [] })
    expect(roundPerch(layout, 200)).toBe('home')
    expect(roundPerch(layout, 1300)).toBe('tree')
    expect(headOf({ x: 50, y: 300 })).toEqual({ x: 50, y: 266 })
  })
})

describe('the painter drawing the owls’ lives', () => {
  function room(width: number, height: number, patch: Partial<SceneMeasure> = {}): SceneMeasure {
    const gutter = Math.max(24, (width - 760) / 2)
    return { width, height, header: 48, composer: { x: gutter, y: height - 150, w: width - gutter * 2, h: 110 }, words: [], ...patch }
  }
  const texts: Array<{ readonly text: string; readonly x: number; readonly y: number }> = []
  beforeEach(() => {
    texts.length = 0
    vi.stubGlobal('Path2D', class { moveTo(): void {} lineTo(): void {} bezierCurveTo(): void {} quadraticCurveTo(): void {} })
    const methods: Record<string, (...args: never[]) => unknown> = {
      fillText: (text: string, x: number, y: number) => { texts.push({ text, x, y }) },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)) }),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      createRadialGradient: () => ({ addColorStop: () => undefined }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, key) => typeof key === 'string' && key in methods ? methods[key] : key in target ? target[key] : () => undefined,
      set: (target, key, value) => { target[key] = value; return true },
    }) as never)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends every glyph of the owls’ lives through its guard, and paints again only when their step changes', () => {
    const words = [{ x: 40, y: 300, w: 120, h: 60 }]
    const painter = new NightScenePainter(document.createElement('canvas'), document.createElement('canvas'))
    const layout = painter.resize(room(1280, 800, { words }), 1)!
    painter.setInk(sceneInk({ r: 20, g: 20, b: 24 }, { r: 230, g: 230, b: 235 }, { r: 80, g: 200, b: 180 }), 'monospace')
    const watcher = owlAt(0, layout, { at: 'home', side: 'left', flight: null, next: 1e9 }, { still: true })
    const frame = (step: number) => ({ t: 0, still: true, ripples: [], watcher, owls: [], whirl: 0, pile: null,
      life: { lives: quiet(), step, cells: (emit: AmbientGlyph) => { emit(100, 330, '?', true, 1, true); emit(200, 250, '!', true, 1, true) } } })
    expect(painter.draw(frame(1))).toBe(true)
    // The one under the still words is dropped; the one in the open margin is drawn.
    expect(texts.some(text => text.text === '?')).toBe(false)
    expect(texts.filter(text => text.text === '!')).toHaveLength(1)
    expect(painter.draw(frame(1))).toBe(false)
    expect(painter.draw(frame(2))).toBe(true)
  })

  it('draws a living owl’s pose, and repaints when only its body or its feet change', () => {
    const painter = new NightScenePainter(document.createElement('canvas'), document.createElement('canvas'))
    const layout = painter.resize(room(1280, 800), 1)!
    painter.setInk(sceneInk({ r: 20, g: 20, b: 24 }, { r: 230, g: 230, b: 235 }, { r: 80, g: 200, b: 180 }), 'monospace')
    const spot = layout.spots[0]!
    const frame = (failed: boolean) => ({ t: 0.1, still: false, ripples: [], watcher: null, whirl: 0, pile: null,
      owls: [{ owl: owl('asleep', { failed }), x: spot.x, y: spot.y, flying: false, alpha: 1 }], life: { lives: quiet(), step: 0, cells: () => undefined } })
    expect(painter.draw(frame(false))).toBe(true)
    texts.length = 0
    // Asleep and ruffled, its face changes and so does its body; the frame paints again.
    expect(painter.draw(frame(true))).toBe(true)
    expect(texts.map(text => text.text).join('')).toContain('~~')
    expect(texts.map(text => text.text).join('')).toContain('>')
  })
})
