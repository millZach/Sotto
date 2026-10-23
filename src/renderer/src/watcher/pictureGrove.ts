import type { Box, Limb, Moon, Point } from './nightScene'
import { clamp, limbY } from './nightScene'

/**
 * Where everything in Watcher's picture goes (Zach's pick on October 22, 2026: B of `prototype/watcher-visualize-owls`,
 * "owls are the picture"). The picture is the night scene: each computer is a tree, each project a limb on it, and each
 * thread a thread owl on its project's limb with its name and where it stands under it. Watcher's owl sits on its own
 * perch in the middle with You at its foot, so nothing stands between the trees; narrower than GROVE.wideMin they share
 * one line at the top instead. Every word gets its own box and no two boxes meet, which is what the constellation's You
 * line did not have (it sat in a gap set without reading how wide it was). Pure, so it is tested without a window.
 */

/** The picture's measures, in CSS pixels. */
export const GROVE = {
  margin: 16,
  /** A trunk stands this far in from its side's outer edge. */
  trunkInset: 24,
  /** The first owl on a limb sits this far from the trunk, clear of the project's sign's start. */
  firstOwl: 64,
  /** Between two owls on a limb: their labels are this wide less `labelAir`. */
  spacingMax: 150,
  spacingMin: 112,
  labelAir: 10,
  /** An owl's box: its three rows of glyphs and a little air, its feet this far above its limb. */
  owlW: 40,
  owlH: 40,
  feet: 4,
  /** A thread's name and where it stands, under its limb. */
  labelTop: 8,
  labelH: 34,
  /** A project's sign, above its first limb's owls. */
  signH: 16,
  signGap: 6,
  blockGap: 14,
  treeGap: 18,
  /** A computer's name at its tree's foot. */
  pillH: 22,
  /** Under the ground line: the lowest trees' names. */
  groundBand: 44,
  top: 14,
  /** Narrow: Watcher and You share a line at the top, this tall. */
  captionH: 26,
  /** At least this wide, Watcher sits in the middle; narrower, it shares the top line with You. */
  wideMin: 960,
  /** At least this wide, the trees stand on two sides; narrower, one. */
  twoSidesMin: 480,
} as const

/** What the layout needs of a project: the picture's clusters carry more. */
export interface GroveCluster {
  readonly key: string
  readonly project: string
  readonly computer: string
  readonly nodes: readonly { readonly key: string }[]
}

export interface GroveOwl {
  readonly key: string
  /** The owl's middle and its feet. */
  readonly x: number
  readonly y: number
  /** Where a message reaches it: its face. */
  readonly head: Point
  /** The owl's glyphs. */
  readonly owl: Box
  /** Its name and where it stands, under the limb. */
  readonly label: Box
  /** The thread's button: the owl and its label together. */
  readonly box: Box
  /** Which side of Watcher it is on, so a still mark stands on Watcher's side of it. */
  readonly side: 'left' | 'right'
}
export interface GroveSign { readonly key: string; readonly box: Box; readonly align: 'left' | 'right' }
export interface GroveTree {
  readonly computer: string
  readonly x: number
  /** The trunk's foot. */
  readonly y: number
  readonly h: number
  readonly dir: 1 | -1
  readonly limbs: readonly Limb[]
  /** The computer's name at the trunk's foot. */
  readonly pill: Box
}
export interface GroveLayout {
  readonly width: number
  readonly height: number
  readonly wide: boolean
  readonly ground: number
  /** Where the sky ends and the stars stop. */
  readonly horizon: number
  readonly moon: Moon | null
  /** Watcher's owl on its perch, wide only: where its feet are, its size (1 is the night scene's drawing), and the post's foot. */
  readonly perch: { readonly x: number; readonly y: number; readonly s: number } | null
  /** Watcher's name: under its perch when wide, at the start of the top line when narrow. */
  readonly watcherName: Box
  readonly you: Box
  /** Where Watcher's messages leave from and arrive: its owl's face, or its name's mark when narrow. */
  readonly watcherAt: Point
  readonly youAt: Point
  readonly trees: readonly GroveTree[]
  readonly signs: readonly GroveSign[]
  readonly at: ReadonlyMap<string, GroveOwl>
  /** Every box of words, which the scene keeps clear. */
  readonly words: readonly Box[]
}

interface Placed { readonly cluster: GroveCluster; readonly rows: number; readonly height: number }

/** How far a limb rises along its length (Limb.y1), which its owls rise with. */
const RISE = 4
/** From a limb's line up to the top of its owls, and on a project's first limb, of its sign. */
const ABOVE = RISE + GROVE.feet + GROVE.owlH
const ABOVE_FIRST = ABOVE + GROVE.signGap + GROVE.signH
/** From a limb's line down to the bottom of its labels. */
const BELOW = GROVE.labelTop + GROVE.labelH
/** Between two trees on one side: the upper tree's name at its foot, and air. */
const BETWEEN_TREES = 8 + GROVE.pillH + 8 + GROVE.treeGap
/** How tall a project's limbs are: its first carries the sign, the rest only owls and labels. */
const blockHeight = (rows: number): number => ABOVE_FIRST + BELOW + (rows - 1) * (GROVE.blockGap + ABOVE + BELOW)

/** Owls that fit on one limb of a side this wide, at this spacing. */
function perLimb(sideWidth: number, spacing: number): number {
  return Math.max(1, Math.floor((sideWidth - GROVE.trunkInset - GROVE.firstOwl - spacing / 2) / spacing) + 1)
}

/**
 * Lays the picture out for `clusters` in a space `width` by `viewHeight`, with Watcher's name and You `labels` wide.
 * It is as tall as the view, or taller when the trees need more height, and then the picture scrolls.
 */
export function layoutGrove(clusters: readonly GroveCluster[], width: number, viewHeight: number, labels: { readonly watcher: number; readonly you: number }): GroveLayout {
  const wide = width >= GROVE.wideMin
  const watcherW = Math.ceil(labels.watcher), youW = Math.ceil(labels.you)
  // Narrow, Watcher and You share the top line, or take a line each when both will not fit.
  const captionRows = wide ? 0 : watcherW + youW + 24 > width - GROVE.margin * 2 ? 2 : 1
  const contentTop = GROVE.top + (wide ? 0 : captionRows * (GROVE.captionH + 4) + 8)
  // Wide, the middle is as wide as the wider of Watcher's name and You, with air either side.
  const centre = wide ? Math.max(watcherW, youW, 96) + 64 : 0
  const two = width >= GROVE.twoSidesMin
  const sides = !two ? [{ left: GROVE.margin, right: width - GROVE.margin, dir: 1 as const }]
    : wide ? [{ left: GROVE.margin, right: width / 2 - centre / 2, dir: 1 as const }, { left: width / 2 + centre / 2, right: width - GROVE.margin, dir: -1 as const }]
      : [{ left: GROVE.margin, right: width / 2 - 8, dir: 1 as const }, { left: width / 2 + 8, right: width - GROVE.margin, dir: -1 as const }]
  const sideWidth = sides[0]!.right - sides[0]!.left
  const spacing = clamp((sideWidth - GROVE.trunkInset - GROVE.firstOwl) / 3, GROVE.spacingMin, GROVE.spacingMax)
  const fit = perLimb(sideWidth, spacing)

  // Whole computers to the side that is shorter so far, the tallest first, so a computer is one tree. Only while a side
  // is taller than the view, and moving a project across makes the taller side shorter, does its last project go across:
  // then one computer with many projects stands as a tree on each side. Each side keeps the clusters' own order, a tree
  // for each computer in the order the computers first come.
  const placed: Placed[] = clusters.map(cluster => { const rows = Math.ceil(cluster.nodes.length / fit); return { cluster, rows, height: blockHeight(rows) } })
  const computers = [...new Set(clusters.map(cluster => cluster.computer))]
  const treesOf = (items: readonly Placed[]): Placed[][] => computers
    .map(computer => items.filter(item => item.cluster.computer === computer).sort((a, b) => clusters.indexOf(a.cluster) - clusters.indexOf(b.cluster)))
    .filter(group => group.length > 0)
  // A side's height: its trees' limbs, and between two trees the upper one's name at its foot.
  const sideHeight = (trees: readonly Placed[][]): number => trees.reduce((sum, tree, index) =>
    sum + tree.reduce((inner, item, at) => inner + (at ? GROVE.blockGap : 0) + item.height, 0) + (index ? BETWEEN_TREES : 0), 0)
  const shares: Placed[][] = sides.map(() => [])
  const heightOf = (items: readonly Placed[]): number => sideHeight(treesOf(items))
  for (const group of treesOf(placed).sort((a, b) => sideHeight([b]) - sideHeight([a]))) {
    const side = shares.reduce((low, next) => heightOf(next) < heightOf(low) ? next : low)
    side.push(...group)
  }
  const viewRoom = viewHeight - GROVE.groundBand - 24 - contentTop
  for (;;) {
    if (shares.length < 2) break
    const [tall, short] = heightOf(shares[0]!) >= heightOf(shares[1]!) ? [shares[0]!, shares[1]!] : [shares[1]!, shares[0]!]
    if (tall.length < 2 || heightOf(tall) <= viewRoom) break
    const last = [...tall].sort((a, b) => clusters.indexOf(b.cluster) - clusters.indexOf(a.cluster))[0]!
    const after = { tall: tall.filter(item => item !== last), short: [...short, last] }
    if (Math.max(heightOf(after.tall), heightOf(after.short)) >= heightOf(tall)) break
    tall.splice(tall.indexOf(last), 1)
    short.push(last)
  }
  const grouped = shares.map(treesOf)
  const tallest = Math.max(0, ...grouped.map(sideHeight))
  const height = Math.max(viewHeight, contentTop + tallest + 24 + GROVE.groundBand)
  const ground = height - GROVE.groundBand
  const room = ground - 24 - contentTop

  const at = new Map<string, GroveOwl>()
  const trees: GroveTree[] = []
  const signs: GroveSign[] = []
  const words: Box[] = []
  const labelW = spacing - GROVE.labelAir
  grouped.forEach((side, sideIndex) => {
    const { left, right, dir } = sides[sideIndex]!
    const trunk = dir > 0 ? left + GROVE.trunkInset : right - GROVE.trunkInset
    // Spare height goes between the limbs, a little each, and the rest above them, so the trees stand on the ground.
    const gaps = side.reduce((count, tree) => count + tree.reduce((inner, item) => inner + item.rows, 0), 0) - 1
    const spare = Math.max(0, room - sideHeight(side))
    const extra = gaps > 0 ? Math.min(28, spare / (gaps + 2)) : 0
    let y = contentTop + Math.max(0, spare - extra * gaps)
    side.forEach((tree, treeIndex) => {
      const limbs: Limb[] = []
      let firstLimb = Infinity
      for (const [itemIndex, item] of tree.entries()) {
        if (itemIndex > 0) y += GROVE.blockGap + extra
        const nodes = item.cluster.nodes
        let lastX = trunk
        for (let row = 0; row < item.rows; row++) {
          if (row > 0) y += GROVE.blockGap + extra
          const line = y + (row === 0 ? ABOVE_FIRST : ABOVE)
          firstLimb = Math.min(firstLimb, line)
          const onLimb = nodes.slice(row * fit, (row + 1) * fit)
          const end = trunk + dir * (GROVE.firstOwl + (onLimb.length - 1) * spacing + spacing * 0.42)
          const limb: Limb = { x0: trunk + dir * 4, y0: line, x1: end, y1: line - RISE, sag: 5 }
          limbs.push(limb)
          onLimb.forEach((node, index) => {
            const x = trunk + dir * (GROVE.firstOwl + index * spacing)
            const feet = Math.round(limbY(limb, x)) - GROVE.feet
            const owl = { x: x - GROVE.owlW / 2, y: feet - GROVE.owlH, w: GROVE.owlW, h: GROVE.owlH }
            const label = { x: x - labelW / 2, y: line + GROVE.labelTop, w: labelW, h: GROVE.labelH }
            const box = { x: label.x, y: owl.y, w: labelW, h: label.y + label.h - owl.y }
            at.set(node.key, { key: node.key, x, y: feet, head: { x, y: feet - 26 }, owl, label, box, side: dir > 0 ? 'left' : 'right' })
            words.push(label)
            lastX = x
          })
          y = line + BELOW
        }
        // The sign runs from the trunk along the limb, as far as the limb's last label reaches.
        const reach = Math.abs(lastX - trunk) + labelW / 2
        const signBox = { x: dir > 0 ? trunk + 10 : trunk - 10 - reach, y: (firstLimb === Infinity ? y : limbs[limbs.length - item.rows]!.y0) - ABOVE_FIRST, w: reach, h: GROVE.signH }
        signs.push({ key: item.cluster.key, box: signBox, align: dir > 0 ? 'left' : 'right' })
        words.push(signBox)
      }
      const lowest = treeIndex === side.length - 1
      const foot = lowest ? ground : y + 8
      const pill = { x: trunk - 70, y: lowest ? ground + 8 : foot, w: 140, h: GROVE.pillH }
      trees.push({ computer: tree[0]!.cluster.computer, x: trunk, y: foot, h: foot - firstLimb + 40, dir, limbs, pill: clampBox(pill, width) })
      words.push(clampBox(pill, width))
      if (!lowest) y += BETWEEN_TREES
    })
  })

  let perch: GroveLayout['perch'] = null
  let moon: Moon | null = null
  let watcherName: Box, you: Box, watcherAt: Point
  if (wide) {
    const s = clamp((ground - contentTop) / 380, 0.85, 1.35)
    const y = Math.round(Math.max(contentTop + 70 * s, Math.min(contentTop + (ground - contentTop) * 0.42, ground - 96)))
    perch = { x: width / 2, y, s }
    watcherName = { x: width / 2 - watcherW / 2, y: y + 10, w: watcherW, h: 20 }
    you = { x: width / 2 - youW / 2, y: Math.max(y + 40, ground - 34), w: youW, h: 24 }
    watcherAt = { x: width / 2, y: y - 46 * s }
    const r = Math.round(14 + 8 * s)
    moon = { x: width / 2 + 40 + 40 * s, y: contentTop + r + 12, r }
  } else {
    watcherName = { x: GROVE.margin, y: GROVE.top, w: watcherW, h: GROVE.captionH }
    you = captionRows === 1 ? { x: width - GROVE.margin - youW, y: GROVE.top, w: youW, h: GROVE.captionH }
      : { x: GROVE.margin, y: GROVE.top + GROVE.captionH + 4, w: youW, h: GROVE.captionH }
    watcherAt = { x: GROVE.margin + 12, y: GROVE.top + GROVE.captionH / 2 }
  }
  words.push(watcherName, you)
  return {
    width, height, wide, ground, horizon: contentTop + (ground - contentTop) * 0.55, moon, perch, watcherName, you, watcherAt,
    youAt: { x: you.x + you.w / 2, y: you.y + you.h / 2 }, trees, signs, at, words,
  }
}

/** A box held inside the picture's width. */
function clampBox(box: Box, width: number): Box {
  return { ...box, x: clamp(box.x, 4, Math.max(4, width - box.w - 4)) }
}

/** Whether two boxes share any area. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
