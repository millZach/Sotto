import { describe, expect, it } from 'vitest'

import { groundAt, layoutScene, placeOf, type Point, type SceneMeasure, type WatcherOwlState } from '../../../src/renderer/src/watcher/nightScene'
import { OwlHunt, type HuntWood } from '../../../src/renderer/src/watcher/owlHunt'

function room(width: number, height: number): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2)
  return { width, height, header: 48, composer: { x: gutter, y: height - 150, w: width - gutter * 2, h: 110 }, words: [] }
}
const layout = layoutScene(room(1600, 1000))
const spot: Point = { x: 300, y: groundAt(layout, 300) }
const HOME: WatcherOwlState = { at: 'home', side: 'left', flight: null, next: 1e9 }
const IN_TREE: WatcherOwlState = { at: 'tree', side: 'left', flight: null, next: 1e9 }

/** A wood with a mouse to give, or none, that remembers when it was asked for one and when it was told to bolt. */
function woodWith(mouse: Point | null): HuntWood & { readonly asked: number[]; readonly bolts: number[] } {
  const asked: number[] = [], bolts: number[] = []
  return { asked, bolts, mouse: t => { asked.push(t); return mouse }, bolt: t => { bolts.push(t) } }
}
/** The owl as the scene lands it: a flight that has run its time ends where it was going. */
function landed(owl: WatcherOwlState, t: number): WatcherOwlState {
  return owl.flight !== null && t >= owl.flight.t0 + owl.flight.dur ? { at: owl.flight.to, side: owl.flight.side, flight: null, next: owl.next } : owl
}
/** Runs a hunt from `from` to `to` in tenths of a second, as the scene's frames do. Returns the owl at the end. */
function run(hunt: OwlHunt, wood: HuntWood, owl: WatcherOwlState, from: number, to: number, seen?: (t: number, owl: WatcherOwlState, look: unknown) => void): WatcherOwlState {
  for (let t = from; t <= to; t = Math.round((t + 0.1) * 10) / 10) {
    owl = landed(owl, t)
    const stepped = hunt.step(t, layout, owl, wood)
    owl = stepped.watcher
    seen?.(t, owl, stepped.look)
  }
  return owl
}

describe('Watcher’s owl’s dive for a mouse (ADR-0199)', () => {
  it('dives from home to where the mouse stops, sits there looking after it, and flies home', () => {
    const hunt = new OwlHunt(), wood = woodWith(spot)
    const began = hunt.start(10, layout, HOME, wood, true)
    expect(began.outcome).toBe('started')
    expect(began.watcher).toBe(HOME)
    expect(wood.asked).toEqual([10])
    expect(hunt.under).toBe(true)
    // While the hunt runs, the place on the ground stands in for the owl's perch in the other tree.
    expect(hunt.layoutFor(layout).visit).toEqual(spot)
    let dived = false, sat = false, looked = false
    const owl = run(hunt, wood, HOME, 10, 40, (_t, now, look) => {
      if (now.flight?.to === 'tree') { dived = true; expect(placeOf(hunt.layoutFor(layout), 'tree', now.side)).toEqual(spot) }
      if (now.at === 'tree' && now.flight === null) sat = true
      if (look !== null) looked = true
    })
    expect([dived, sat, looked]).toEqual([true, true, true])
    // The mouse bolts a moment before the owl lands, and only then.
    expect(wood.bolts.length).toBeGreaterThan(0)
    expect(owl).toEqual({ ...HOME })
    expect(hunt.under).toBe(false)
    expect(hunt.layoutFor(layout)).toBe(layout)
  })

  it('flies an owl home first when its last call left it in the other tree, and then hunts', () => {
    // W3: after a message round ends in the right tree, the hunt's turn was dropped, since the owl was not home.
    const hunt = new OwlHunt(), wood = woodWith(spot)
    const began = hunt.start(10, layout, IN_TREE, wood, true)
    expect(began.outcome).toBe('started')
    expect(began.watcher.flight?.to).toBe('home')
    expect(wood.asked, 'no mouse until the owl is home').toEqual([])
    // Its flight home is an ordinary one: its perch in the other tree is the tree's own.
    expect(hunt.layoutFor(layout)).toBe(layout)
    let dived = false
    const owl = run(hunt, wood, began.watcher, 10, 60, (_t, now) => { if (now.flight?.to === 'tree') dived = true })
    expect(wood.asked).toHaveLength(1)
    expect(wood.asked[0]).toBeGreaterThan(10)
    expect(dived).toBe(true)
    expect(owl.at).toBe('home')
    expect(hunt.under).toBe(false)
  })

  it('hunts later, keeping its turn, while the owl is in the air or a call is under way or waiting', () => {
    // An owl in the air: the flight home another hunt planned for it.
    const inAir: WatcherOwlState = { ...IN_TREE, flight: new OwlHunt().start(10, layout, IN_TREE, woodWith(spot), true).watcher.flight }
    expect(inAir.flight).not.toBeNull()
    for (const [owl, free] of [[inAir, true], [HOME, false], [IN_TREE, false]] as const) {
      const hunt = new OwlHunt(), began = hunt.start(10, layout, owl, woodWith(spot), free)
      expect(began.outcome).toBe('later')
      expect(began.watcher).toBe(owl)
      expect(hunt.under).toBe(false)
    }
  })

  it('never hunts where the margin has no room for a mouse', () => {
    const hunt = new OwlHunt(), began = hunt.start(10, layout, HOME, woodWith(null), true)
    expect(began.outcome).toBe('never')
    expect(hunt.under).toBe(false)
    expect(hunt.layoutFor(layout)).toBe(layout)
  })

  it('puts an owl on the ground, or flying there or back, home at once when the hunt ends early', () => {
    // W2: a change of place or the feature going mid-hunt left the owl sitting "in the other tree", which had meant the
    // ground, so it jumped to the tree's real perch and stayed there.
    const stages: Array<{ readonly name: string; readonly until: (owl: WatcherOwlState) => boolean }> = [
      { name: 'the mouse is out and the owl still home', until: () => true },
      { name: 'diving', until: owl => owl.flight?.to === 'tree' },
      { name: 'sitting on the ground', until: owl => owl.at === 'tree' && owl.flight === null },
      { name: 'flying back', until: owl => owl.flight?.to === 'home' },
    ]
    for (const stage of stages) {
      const hunt = new OwlHunt(), wood = woodWith(spot)
      let owl = hunt.start(10, layout, HOME, wood, true).watcher
      for (let t = 10; t <= 40 && !stage.until(owl); t = Math.round((t + 0.1) * 10) / 10) owl = hunt.step(t, layout, landed(owl, t), wood).watcher
      expect(stage.until(owl), stage.name).toBe(true)
      const ended = hunt.end(owl)
      expect(ended, stage.name).toEqual({ at: 'home', side: 'left', flight: null, next: owl.next })
      expect(hunt.under, stage.name).toBe(false)
      // With the hunt gone, the other tree's perch is the tree's own again, and the owl is not on it.
      expect(hunt.layoutFor(layout), stage.name).toBe(layout)
      expect(placeOf(hunt.layoutFor(layout), ended.at, ended.side), stage.name).toEqual(layout.home)
    }
  })

  it('leaves an owl as it is when no hunt is under way, and lets one only flying home keep its flight', () => {
    const idle = new OwlHunt()
    expect(idle.end(IN_TREE)).toBe(IN_TREE)
    expect(idle.end(HOME)).toBe(HOME)
    const hunt = new OwlHunt(), homing = hunt.start(10, layout, IN_TREE, woodWith(spot), true).watcher
    expect(hunt.under).toBe(true)
    expect(hunt.end(homing)).toBe(homing)
    expect(hunt.under).toBe(false)
  })
})
