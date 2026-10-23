import { describe, expect, it } from 'vitest'

import type { Box } from '../../../src/renderer/src/watcher/nightScene'
import { GROVE, layoutGrove, overlaps, type GroveCluster, type GroveLayout } from '../../../src/renderer/src/watcher/pictureGrove'

/** Clusters of these sizes, on this computer unless a computer is named. */
const clustersOf = (sizes: readonly (number | readonly [number, string])[]): GroveCluster[] => sizes.map((size, index) => {
  const [count, computer] = typeof size === 'number' ? [size, 'This computer'] : size
  return { key: `c${index}`, project: `P${index}`, computer, nodes: Array.from({ length: count }, (_, at) => ({ key: `c${index}-${at}` })) }
})
const LABELS = { watcher: 132, you: 148 }

/** Every box of words and every owl, named, so a failure says which two met. */
function boxes(layout: GroveLayout): { readonly name: string; readonly box: Box }[] {
  return [
    { name: 'Watcher', box: layout.watcherName }, { name: 'You', box: layout.you },
    ...layout.signs.map(sign => ({ name: `sign ${sign.key}`, box: sign.box })),
    ...layout.trees.map(tree => ({ name: `tree ${tree.computer} at ${tree.x}`, box: tree.pill })),
    ...[...layout.at.values()].flatMap(owl => [{ name: `owl ${owl.key}`, box: owl.owl }, { name: `label ${owl.key}`, box: owl.label }]),
  ]
}
function meetings(layout: GroveLayout): string[] {
  const all = boxes(layout), met: string[] = []
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) if (overlaps(all[a]!.box, all[b]!.box)) met.push(`${all[a]!.name} meets ${all[b]!.name}`)
  return met
}
function outside(layout: GroveLayout): string[] {
  return boxes(layout).filter(({ box }) => box.x < 0 || box.y < 0 || box.x + box.w > layout.width || box.y + box.h > layout.height).map(({ name }) => name)
}

describe("Watcher's picture as a night of trees and owls", () => {
  it('sets Watcher on its perch in the middle with You at its foot, and nothing meets You or Watcher at any size', () => {
    // The October 23 report: You under Watcher ran into the projects on both sides.
    for (const [width, height] of [[1600, 700], [1280, 520], [960, 420]] as const) {
      const layout = layoutGrove(clustersOf([3, 1, [1, 'forge']]), width, height, LABELS)
      expect(layout.wide).toBe(true)
      expect(layout.perch?.x).toBe(width / 2)
      expect(layout.you.y).toBeGreaterThan(layout.watcherName.y)
      expect(meetings(layout)).toEqual([])
      expect(outside(layout)).toEqual([])
      // The trees keep to their sides, clear of Watcher's middle.
      for (const owl of layout.at.values()) {
        expect(owl.box.x + owl.box.w <= layout.you.x || owl.box.x >= layout.you.x + layout.you.w).toBe(true)
        expect(owl.box.x + owl.box.w <= layout.watcherName.x || owl.box.x >= layout.watcherName.x + layout.watcherName.w).toBe(true)
      }
    }
  })

  it('makes each computer a tree and each project a limb, with every owl on its own limb', () => {
    const layout = layoutGrove(clustersOf([3, 1, [1, 'forge']]), 1600, 700, LABELS)
    expect(layout.trees.map(tree => tree.computer).sort()).toEqual(['This computer', 'forge'])
    const here = layout.trees.find(tree => tree.computer === 'This computer')!
    expect(here.limbs).toHaveLength(2)
    expect(layout.signs.map(sign => sign.key).sort()).toEqual(['c0', 'c1', 'c2'])
    for (const owl of layout.at.values()) {
      const limb = layout.trees.flatMap(tree => tree.limbs).find(item => Math.min(item.x0, item.x1) <= owl.x && owl.x <= Math.max(item.x0, item.x1) && Math.abs(item.y0 - owl.y) < 12)
      expect(limb, `${owl.key} stands on a limb`).toBeDefined()
    }
    // A thread on the left of Watcher is on the left side, and the trees stand on the ground.
    for (const owl of layout.at.values()) expect(owl.side).toBe(owl.x < layout.width / 2 ? 'left' : 'right')
    expect(Math.max(...layout.trees.map(tree => tree.y))).toBe(layout.ground)
  })

  it('keeps one computer as one tree while it fits the view, and gives it a tree on each side only when it does not', () => {
    const fits = layoutGrove(clustersOf([2, 1]), 1280, 900, LABELS)
    expect(fits.trees).toHaveLength(1)
    expect(fits.trees[0]!.limbs).toHaveLength(2)
    const tall = layoutGrove(clustersOf([3, 3, 3, 3, 3]), 1280, 400, LABELS)
    expect(tall.trees.map(tree => tree.computer)).toEqual(['This computer', 'This computer'])
    expect(meetings(tall)).toEqual([])
  })

  it('puts Watcher and You on one line at the top when narrow, and both trees under it', () => {
    const layout = layoutGrove(clustersOf([3, 1, [1, 'forge']]), 820, 330, LABELS)
    expect(layout.wide).toBe(false)
    expect(layout.perch).toBeNull()
    expect(layout.you.y).toBe(layout.watcherName.y)
    const top = layout.watcherName.y + layout.watcherName.h
    for (const owl of layout.at.values()) expect(owl.box.y).toBeGreaterThan(top)
    for (const sign of layout.signs) expect(sign.box.y).toBeGreaterThan(top)
    expect(meetings(layout)).toEqual([])
    expect(outside(layout)).toEqual([])
  })

  it('gives You a line of its own when it and Watcher will not fit side by side', () => {
    const layout = layoutGrove(clustersOf([2]), 420, 400, { watcher: 220, you: 210 })
    expect(layout.you.y).toBeGreaterThan(layout.watcherName.y)
    expect(meetings(layout)).toEqual([])
    expect(outside(layout)).toEqual([])
  })

  it('grows another limb for a busy project, and scrolls rather than squeezing', () => {
    const layout = layoutGrove(clustersOf([20, 4, [6, 'forge'], [2, 'studio']]), 820, 330, LABELS)
    const busy = layout.trees.find(tree => tree.limbs.length > 2)
    expect(busy, 'twenty threads take several limbs').toBeDefined()
    expect(layout.height).toBeGreaterThan(330)
    expect(layout.at.size).toBe(32)
    expect(meetings(layout)).toEqual([])
    expect(outside(layout)).toEqual([])
    // Every label keeps the width it was laid out with.
    for (const owl of layout.at.values()) expect(owl.label.w).toBeGreaterThanOrEqual(GROVE.spacingMin - GROVE.labelAir)
  })

  it('stands every tree on one side when the pane is too narrow for two', () => {
    const layout = layoutGrove(clustersOf([3, [2, 'forge']]), GROVE.twoSidesMin - 1, 500, LABELS)
    expect(new Set([...layout.at.values()].map(owl => owl.side))).toEqual(new Set(['left']))
    expect(meetings(layout)).toEqual([])
    expect(outside(layout)).toEqual([])
  })
})
