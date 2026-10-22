import { describe, expect, it } from 'vitest'

import { layoutScene, type SceneMeasure } from '../../../src/renderer/src/watcher/nightScene'
import {
  ARRIVAL_STAGGER, assignSpots, blinking, EMERGE, FADE, glowStep, moodOf, owlGlyphs, owlKey, OwlFamily, spriteCells, type FamilyOwl, type OwlMood, type WatchedOwl,
} from '../../../src/renderer/src/watcher/owlFamily'

/** Watcher's pane for a window `width` by `height`, its composer in the 760-pixel column near the bottom. */
function room(width: number, height: number): SceneMeasure {
  const gutter = Math.max(24, (width - 760) / 2), pane = height - 54
  return { width, height: pane, header: 48, composer: { x: gutter, y: pane - 150, w: width - gutter * 2, h: 110 }, words: [] }
}

const watched = (count: number, mood: OwlMood = 'awake'): WatchedOwl[] =>
  Array.from({ length: count }, (_, k) => ({ key: `host\u0000thread-${k}`, title: `Thread ${k}`, threadId: `thread-${k}`, mood }))

const row = (patch: Partial<Parameters<typeof moodOf>[0]> = {}): Parameters<typeof moodOf>[0] => ({ status: 'idle', settled: false, waitsOn: [], ...patch })
const ask = { id: 'request-1', kind: 'permission' as const, openTarget: { hostId: 'host', threadId: 'thread-1' } }

describe('a thread owl’s mood', () => {
  it('glows while a question or permission waits, wakes while its thread works, and sleeps otherwise', () => {
    expect(moodOf(row({ status: 'running' }))).toBe('awake')
    expect(moodOf(row({ status: 'running', waitsOn: [ask] }))).toBe('waiting')
    expect(moodOf(row({ status: 'idle', waitsOn: [ask] }))).toBe('waiting')
    expect(moodOf(row({ status: 'idle' }))).toBe('asleep')
    expect(moodOf(row({ status: 'running', settled: true }))).toBe('asleep')
    expect(moodOf(row({ status: 'running', paused: true }))).toBe('asleep')
    expect(moodOf(row({ status: 'error' }))).toBe('asleep')
    expect(moodOf(row({ status: 'unavailable' }))).toBe('asleep')
  })

  it('keys an owl by its thread’s address on its host', () => {
    expect(owlKey({ hostId: 'a', threadId: 'b' })).not.toBe(owlKey({ hostId: 'ab', threadId: '' }))
    expect(owlKey({ hostId: 'a', threadId: 'b' })).toBe(owlKey({ hostId: 'a', threadId: 'b' }))
  })

  it('draws shut eyes asleep, round eyes awake and big ones waiting, and blinks a working owl now and then', () => {
    const owl = (mood: OwlMood): FamilyOwl => ({ key: 'k', title: 't', threadId: 't', mood, spot: 0, animation: null, order: 0 })
    const at = 1 // not mid-blink for order 0
    expect(owlGlyphs({ owl: owl('asleep'), flying: false }, at, { rail: false, still: false })).toEqual(['{-,-}', '/)__)', ' " " '])
    expect(owlGlyphs({ owl: owl('awake'), flying: false }, at, { rail: false, still: false })[0]).toBe('{o,o}')
    expect(owlGlyphs({ owl: owl('waiting'), flying: false }, at, { rail: false, still: false })[0]).toBe('{O,O}')
    expect(owlGlyphs({ owl: owl('awake'), flying: false }, at, { rail: true, still: false })).toEqual(['oo'])
    expect(owlGlyphs({ owl: owl('asleep'), flying: false }, at, { rail: true, still: false })).toEqual(['--'])
    expect(owlGlyphs({ owl: owl('waiting'), flying: false }, at, { rail: true, still: false })).toEqual(['OO'])
    expect(owlGlyphs({ owl: owl('awake'), flying: true }, at, { rail: false, still: false })).toHaveLength(2)
    expect(blinking(0, 0.05)).toBe(true)
    expect(owlGlyphs({ owl: owl('awake'), flying: false }, 0.05, { rail: false, still: false })[0]).toBe('{-,-}')
    expect(owlGlyphs({ owl: owl('awake'), flying: false }, 0.05, { rail: false, still: true })[0]).toBe('{o,o}')
    expect(glowStep(3, true)).toBe(0.5)
    expect(new Set([0, 0.45, 0.9, 1.35].map(t => glowStep(t, false))).size).toBeGreaterThan(1)
  })

  it('stands a sprite’s feet on its spot, centred', () => {
    expect(spriteCells(['{o,o}', '/)__)', ' " " '], 70, 121, { w: 7, h: 12 })).toEqual({ c0: 8, r0: 8, w: 5, n: 3 })
  })
})

describe('where thread owls sit', () => {
  const owl = (key: string, order: number, spot: number | null = null, leaving = false): Pick<FamilyOwl, 'key' | 'spot' | 'order' | 'animation'> =>
    ({ key, order, spot, animation: leaving ? { kind: 'leave', t0: 0, from: { x: 0, y: 0 }, dur: 1 } : null })

  it('gives each owl the lowest free spot, the oldest first', () => {
    const { spots, pile } = assignSpots([owl('b', 1), owl('a', 0), owl('c', 2)], 5)
    expect([spots.get('a'), spots.get('b'), spots.get('c')]).toEqual([0, 1, 2])
    expect(pile).toBe(false)
  })

  it('keeps an owl where it sits, and gives a newcomer the gap another left', () => {
    const { spots } = assignSpots([owl('a', 0, 0), owl('c', 2, 2), owl('d', 3)], 5)
    expect([spots.get('a'), spots.get('c'), spots.get('d')]).toEqual([0, 2, 1])
  })

  it('turns the last spot into the "+N" pile when the owls outnumber the spots', () => {
    const owls = Array.from({ length: 7 }, (_, k) => owl(`o${k}`, k))
    const { spots, pile } = assignSpots(owls, 5)
    expect(pile).toBe(true)
    expect(owls.map(item => spots.get(item.key))).toEqual([0, 1, 2, 3, -1, -1, -1])
    // Exactly as many owls as spots: no pile.
    expect(assignSpots(owls.slice(0, 5), 5).pile).toBe(false)
  })

  it('holds a leaving owl’s spot until it has gone', () => {
    const { spots } = assignSpots([owl('a', 0, 0, true), owl('b', 1)], 3)
    expect(spots.get('a')).toBe(0)
    expect(spots.get('b')).toBe(1)
  })
})

describe('the thread owls coming and going', () => {
  const layout = layoutScene(room(1600, 1000))

  it('shows the threads already watched sitting when the room opens, with no flight', () => {
    const family = new OwlFamily(layout)
    expect(family.update(watched(3), 0, 'fly')).toEqual([])
    expect(family.owls.map(item => item.spot)).toEqual([0, 1, 2])
    expect(family.moving(0)).toBe(false)
    const poses = family.poses(0)
    expect(poses.map(pose => [pose.x, pose.y])).toEqual([0, 1, 2].map(k => [layout.spots[k]!.x, layout.spots[k]!.y]))
  })

  it('brings a newly watched thread’s owl out of the moon’s whirlpool, down to the next free spot', () => {
    const family = new OwlFamily(layout)
    family.update(watched(2), 0, 'fly')
    const whirlpools = family.update(watched(3), 10, 'fly')
    expect(whirlpools).toEqual([10])
    const newcomer = family.owls[2]!
    expect(newcomer.spot).toBe(2)
    expect(newcomer.animation?.kind).toBe('arrive')
    expect(family.moving(10)).toBe(true)
    // While the whirlpool turns, nothing has come out yet, and Watcher's owl watches the moon.
    expect(family.poses(10.2).map(pose => pose.owl.key)).not.toContain(newcomer.key)
    expect(family.whirl(10.5)).toBeGreaterThan(0.5)
    expect(family.newcomer(10.2)?.at).toEqual(layout.moon)
    // It comes out of the moon faint, and fills in as it leaves it.
    const out = family.poses(10 + EMERGE + 0.1).find(pose => pose.owl.key === newcomer.key)!
    expect(Math.hypot(out.x - layout.moon.x, out.y - layout.moon.y)).toBeLessThan(20)
    expect(out.alpha).toBeLessThan(0.5)
    expect(out.flying).toBe(true)
    const end = 10 + EMERGE + (newcomer.animation as { dur: number }).dur
    family.step(end + 0.01)
    expect(newcomer.animation).toBeNull()
    const sitting = family.poses(end + 1).find(pose => pose.owl.key === newcomer.key)!
    expect([sitting.x, sitting.y, sitting.flying]).toEqual([layout.spots[2]!.x, layout.spots[2]!.y, false])
    expect(family.moving(end + 2)).toBe(false)
  })

  it('lets several newcomers out of the moon one after another', () => {
    const family = new OwlFamily(layout)
    family.update([], 0, 'fly')
    expect(family.update(watched(3), 5, 'fly')).toEqual([5, 5 + ARRIVAL_STAGGER, 5 + ARRIVAL_STAGGER * 2])
  })

  it('sends a settled or unwatched thread’s owl back up into the moon, then gives its spot to the pile’s oldest', () => {
    const capacity = layout.spots.length
    const family = new OwlFamily(layout)
    family.update(watched(capacity + 2), 0, 'fly')
    expect(family.marker).toEqual(layout.spots[capacity - 1])
    expect(family.pileCount).toBe(3)
    const gone = family.owls[0]!
    const whirlpools = family.update(watched(capacity + 2).slice(1), 20, 'fly')
    expect(gone.animation?.kind).toBe('leave')
    expect(whirlpools).toHaveLength(1)
    const dur = (gone.animation as { dur: number }).dur
    expect(whirlpools[0]).toBeCloseTo(20 + dur - EMERGE, 6)
    const near = family.poses(20 + dur - 0.01).find(pose => pose.owl.key === gone.key)
    expect(near === undefined || Math.hypot(near.x - layout.moon.x, near.y - layout.moon.y) < 5).toBe(true)
    family.step(20 + dur + 0.01)
    expect(family.owls.map(item => item.key)).not.toContain(gone.key)
    // Spot 0 went to the oldest owl in the pile, which hops there from it.
    const promoted = family.owls.find(item => item.spot === 0)!
    expect(promoted.animation?.kind).toBe('hop')
    expect(family.pileCount).toBe(2)
  })

  it('makes owls appear and fade in place with motion reduced, and places them at once for a capture', () => {
    const family = new OwlFamily(layout)
    family.update(watched(1), 0, 'fade')
    expect(family.update(watched(2), 3, 'fade')).toEqual([])
    const added = family.owls[1]!
    expect(added.animation?.kind).toBe('appear')
    expect(family.whirl(3.5)).toBe(0)
    expect(family.poses(3 + FADE / 2).find(pose => pose.owl.key === added.key)!.alpha).toBeCloseTo(0.5, 5)
    family.update(watched(1), 10, 'fade')
    expect(added.animation?.kind).toBe('fade')
    family.step(10 + FADE + 0.01)
    expect(family.owls).toHaveLength(1)
    const held = new OwlFamily(layout)
    held.update(watched(1), 0, 'still')
    held.update(watched(3), 1, 'still')
    expect(held.owls.every(item => item.animation === null)).toBe(true)
  })

  it('takes a thread’s new mood and title where its owl sits', () => {
    const family = new OwlFamily(layout)
    family.update(watched(2), 0, 'fly')
    family.update(watched(2).map((item, k) => k === 1 ? { ...item, mood: 'waiting' as const, title: 'Renamed' } : item), 4, 'fly')
    expect(family.owls[1]!.mood).toBe('waiting')
    expect(family.owls[1]!.title).toBe('Renamed')
    expect(family.owls[1]!.animation).toBeNull()
  })

  it('ends every flight where it was going on a new size, and keeps each owl’s spot', () => {
    const family = new OwlFamily(layout)
    family.update(watched(2), 0, 'fly')
    family.update(watched(3), 1, 'fly')
    family.relayout(layoutScene(room(1280, 800)), 1.2)
    expect(family.owls.map(item => [item.spot, item.animation])).toEqual([[0, null], [1, null], [2, null]])
    expect(family.whirl(1.3)).toBe(0)
  })

  it('shows no owl where the margin has no room, and none waits in a pile there', () => {
    const family = new OwlFamily(layoutScene({ ...room(560, 800), composer: { x: 10, y: 600, w: 540, h: 110 } }))
    family.update(watched(4), 0, 'fade')
    expect(family.poses(1)).toEqual([])
    expect(family.marker).toBeNull()
  })
})
