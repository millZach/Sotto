// Lights one step of a visual's walkthrough (ADR-0056, #793): the parts of a drawn diagram a step names stay as they
// are and the rest is dimmed. Mermaid draws once; each step's picture is the sanitized drawing with classes added,
// which the stylesheet Sotto puts in every drawing (`diagramStepCss`) turns into lit and dimmed. Nothing moves, so
// every step's picture has the same size and layout.

import type { DiagramPalette } from './diagramPalette'
import { svgDataUrl } from './diagramSvg'

/** On a part a step names, and on what lights with it. */
export const LIT_CLASS = 'sotto-step-lit'
/** On every other part while a step is shown. */
export const DIM_CLASS = 'sotto-step-dim'

/**
 * How a step looks, in the drawing's own stylesheet: the rest dimmed, the lit parts' outlines and lines in the accent.
 * Mermaid's own rules are scoped to the drawing's id, so these win with !important. The palette is read from the
 * theme's tokens, like the rest of the drawing.
 */
export function diagramStepCss(palette: DiagramPalette): string {
  const accent = palette.accent
  const stroke = `{stroke:${accent}!important;stroke-width:2px!important}`
  return [
    `.${DIM_CLASS}{opacity:.3}`,
    `.node.${LIT_CLASS} :is(.label-container,.label-container path,.outer-path path,circle.state-start)${stroke}`,
    `:is(.cluster,.statediagram-cluster).${LIT_CLASS} :is(rect:not(.background,.inner),rect.outer)${stroke}`,
    `path[data-edge].${LIT_CLASS}${stroke}`,
    `[data-et=participant].${LIT_CLASS} :is(rect.actor,line,circle)${stroke}`,
    `[data-et=message].${LIT_CLASS}{stroke:${accent}!important}`,
    `[data-et=life-line].${LIT_CLASS}{stroke:${accent}!important;stroke-width:1.5px!important}`,
  ].join('')
}

interface GraphKind { readonly node: RegExp; readonly edge: string }

/**
 * How each kind names its parts in Mermaid 11's output. A node's id is the drawing's id, a prefix, the name and a
 * counter (`<drawing>-flowchart-Login-3`); an edge's `data-id` joins the two ends' keys (`L_Login_Home_0`).
 */
function graphKind(role: string): GraphKind | null {
  if (/^flowchart/u.test(role) || role === 'graph') return { node: /^flowchart-(.+)-\d+$/u, edge: 'L_' }
  if (/^state/u.test(role)) return { node: /^state-(.+)-\d+$/u, edge: '' }
  if (/^class/u.test(role)) return { node: /^classId-(.+)-\d+$/u, edge: 'id_' }
  if (role === 'er') return { node: /^(entity-(.+)-\d+)$/u, edge: 'id_' }
  return null
}

/** What one step lights: the parts that stay as drawn, out of every part that could be dimmed. */
export interface StepTargets {
  readonly parts: readonly Element[]
  readonly lit: ReadonlySet<Element>
}

const EDGE_NAME = /^\s*(.+?)\s*-+>\s*(.+?)\s*$/u

function own(root: Element, element: Element): string {
  const id = element.getAttribute('id') ?? ''
  const prefix = `${root.getAttribute('id') ?? ''}-`
  return prefix.length > 1 && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

const translation = (element: Element): { x: number; y: number } | null => {
  const match = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/u.exec(element.getAttribute('transform') ?? '')
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null
}
const nearestRoot = (element: Element): Element | null => element.parentElement?.closest('g.root') ?? null

/** Flowchart, state, class and entity relationship drawings: nodes, subgraphs and composite states, and edges. */
function graphTargets(root: Element, kind: GraphKind, names: readonly string[]): StepTargets {
  interface Node { readonly element: Element; readonly name: string; readonly key: string }
  const nodes: Node[] = []
  for (const element of root.querySelectorAll('g.node')) {
    const match = kind.node.exec(own(root, element))
    if (!match) continue
    // An entity's edges name it by its whole id ("entity-THREAD-0"); every other kind by its name.
    nodes.push(match[2] === undefined ? { element, name: match[1]!, key: match[1]! } : { element, name: match[2], key: match[1]! })
  }
  const clusters = [...root.querySelectorAll('g.cluster, g.statediagram-cluster')]
  const edges = [...root.querySelectorAll('path[data-edge]')]
  const labels = [...root.querySelectorAll('g.edgeLabel, g.edgeTerminals')]
  const parts = [...nodes.map(node => node.element), ...clusters, ...edges, ...labels]

  const litNodes = new Set<Node>()
  const ends = new Set<Node>()
  const litEdges = new Set<Element>()
  const litClusters = new Set<Element>()
  const byName = (name: string): Node[] => nodes.filter(node => node.name === name)
  const edgeBetween = (edge: Element, from: Node, to: Node): boolean =>
    new RegExp(`^${escapeRegExp(`${kind.edge}${from.key}_${to.key}_`)}\\d+$`, 'u').test(edge.getAttribute('data-id') ?? '')

  for (const raw of names) {
    const name = raw.trim()
    const named = byName(name)
    for (const node of named) litNodes.add(node)
    for (const cluster of clusters) {
      if (cluster.getAttribute('data-id') !== name && own(root, cluster) !== name) continue
      litClusters.add(cluster)
      for (const node of clusterNodes(cluster, nodes.map(item => item.element))) litNodes.add(nodes.find(item => item.element === node)!)
    }
    const arrow = named.length ? null : EDGE_NAME.exec(name)
    if (!arrow) continue
    const from = byName(arrow[1]!)
    const to = byName(arrow[2]!)
    for (const edge of edges) {
      if (!from.some(start => to.some(end => edgeBetween(edge, start, end)))) continue
      litEdges.add(edge)
      for (const node of [...from, ...to]) ends.add(node)
    }
  }
  // An edge between two nodes the step names lights too, so a step that names both ends shows the way between them.
  // The ends of a named edge do not count: naming A->B does not light B->A.
  for (const edge of edges) {
    if (litEdges.has(edge)) continue
    if ([...litNodes].some(start => [...litNodes].some(end => edgeBetween(edge, start, end)))) litEdges.add(edge)
  }
  const litIds = new Set([...litEdges].map(edge => edge.getAttribute('data-id')))
  const lit = new Set<Element>([...[...litNodes, ...ends].map(node => node.element), ...litClusters, ...litEdges])
  for (const label of labels) {
    const id = label.querySelector('[data-id]')?.getAttribute('data-id')
    if (id && litIds.has(id)) lit.add(label)
  }
  return { parts, lit }
}

/**
 * The nodes inside a subgraph or composite state. One drawn as its own layout (a composite state) holds its nodes in
 * the nested root it sits in; one drawn in its parent's layout (a flowchart subgraph) holds the nodes whose centre is
 * inside its box.
 */
function clusterNodes(cluster: Element, nodes: readonly Element[]): Element[] {
  const home = nearestRoot(cluster)
  if (home && nearestRoot(home)) return nodes.filter(node => home.contains(node))
  const box = cluster.querySelector('rect')
  if (!box) return []
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(box.getAttribute(name)))
  if (![x, y, width, height].every(Number.isFinite)) return []
  return nodes.filter(node => {
    if (nearestRoot(node) !== home) return false
    const centre = translation(node)
    return !!centre && centre.x >= x! && centre.x <= x! + width! && centre.y >= y! && centre.y <= y! + height!
  })
}

const NOT_DRAWN = new Set(['style', 'defs', 'title', 'desc', 'marker', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'clippath', 'mask', 'pattern'])

/**
 * Sequence diagrams: participants by name, and arrows by their number counted from 1, top to bottom. Mermaid numbers
 * its `data-id`s across control rows (loops, notes) too, so the arrows are counted here in drawing order. An arrow lights
 * with its words, its autonumber badge and its two participants; a participant with its lifeline and activations.
 */
function sequenceTargets(root: Element, names: readonly string[]): StepTargets {
  const parts: Element[] = []
  const collect = (parent: Element): void => {
    for (const child of parent.children) {
      if (NOT_DRAWN.has(child.localName.toLowerCase())) continue
      // Mermaid wraps each lifeline and its participant in a bare group; the parts are inside.
      if (child.localName === 'g' && !child.hasAttribute('data-et') && !child.hasAttribute('class') && !child.hasAttribute('id')) collect(child)
      else parts.push(child)
    }
  }
  collect(root)

  interface Arrow { readonly elements: Element[]; readonly from: string; readonly to: string }
  const arrows: Arrow[] = []
  let words: Element[] = []
  for (const part of parts) {
    const classes = part.getAttribute('class') ?? ''
    if (part.getAttribute('data-et') === 'message') {
      arrows.push({ elements: [...words, part], from: part.getAttribute('data-from') ?? '', to: part.getAttribute('data-to') ?? '' })
      words = []
    } else if (/\bmessageText\b/u.test(classes)) words.push(part)
    else if (arrows.length && (/\bsequenceNumber\b/u.test(classes) || /sequencenumber/iu.test(part.getAttribute('marker-start') ?? ''))) arrows.at(-1)!.elements.push(part)
  }

  const participants = new Map<string, Element[]>()
  const lifelines: { name: string; x: number }[] = []
  for (const part of parts) {
    const et = part.getAttribute('data-et')
    const name = part.getAttribute('data-id')
    if ((et !== 'participant' && et !== 'life-line') || !name) continue
    participants.set(name, [...participants.get(name) ?? [], part])
    if (et === 'life-line') lifelines.push({ name, x: Number(part.getAttribute('x1')) })
  }
  // An activation bar sits on its participant's lifeline.
  for (const part of parts) {
    const bar = part.localName === 'rect' ? part : part.querySelector(':scope > rect')
    if (!bar || !/\bactivation\d*\b/u.test(bar.getAttribute('class') ?? '')) continue
    const left = Number(bar.getAttribute('x'))
    const right = left + Number(bar.getAttribute('width'))
    const owner = lifelines.find(line => line.x >= left && line.x <= right)
    if (owner) participants.get(owner.name)!.push(part)
  }

  const lit = new Set<Element>()
  const light = (name: string): void => { for (const element of participants.get(name) ?? []) lit.add(element) }
  for (const raw of names) {
    const name = raw.trim()
    if (participants.has(name)) { light(name); continue }
    if (!/^\d+$/u.test(name)) continue
    const arrow = arrows[Number(name) - 1]
    if (!arrow) continue
    for (const element of arrow.elements) lit.add(element)
    light(arrow.from)
    light(arrow.to)
  }
  return { parts, lit }
}

/** The parts of a drawn diagram a step names, and every part that could be dimmed. Unknown names light nothing. */
export function stepTargets(root: Element, names: readonly string[]): StepTargets {
  const role = root.getAttribute('aria-roledescription') ?? ''
  if (role === 'sequence') return sequenceTargets(root, names)
  const kind = graphKind(role)
  return kind ? graphTargets(root, kind, names) : { parts: [], lit: new Set() }
}

/**
 * One step's picture: the sanitized drawing `svg` with the parts `names` names lit and the rest dimmed, as SVG text.
 * Null when the step names nothing (or nothing that matches), so the whole drawing stays lit.
 */
export function lightDiagramStep(svg: string, names: readonly string[] | undefined): string | null {
  if (!names?.length) return null
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length) return null
  const { parts, lit } = stepTargets(root, names)
  if (!lit.size) return null
  // Appended rather than through classList, which would also tidy Mermaid's own class lists.
  for (const part of parts) part.setAttribute('class', `${part.getAttribute('class') ?? ''} ${lit.has(part) ? LIT_CLASS : DIM_CLASS}`.trimStart())
  return new XMLSerializer().serializeToString(root)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** How many step pictures one drawing keeps; a visual has at most 12 steps. */
export const MAX_STEP_IMAGES = 12
const stepImages = new WeakMap<object, Map<string, string>>()

/**
 * The picture for one step of `drawn`, as a data URL for an `<img>`: its lit version, or the drawing as it is when the
 * step names nothing it can find. Made once per step and kept with the drawing, the most recent 12 of them, so moving
 * back and forth through a walkthrough does not edit the drawing again.
 */
export function stepImage(drawn: { readonly svg: string; readonly dataUrl: string }, names: readonly string[] | undefined): string {
  if (!names?.length) return drawn.dataUrl
  let images = stepImages.get(drawn)
  if (!images) stepImages.set(drawn, images = new Map())
  const key = JSON.stringify(names)
  let image = images.get(key)
  if (image === undefined) {
    const svg = lightDiagramStep(drawn.svg, names)
    image = svg ? svgDataUrl(svg) : drawn.dataUrl
  } else images.delete(key)
  images.set(key, image)
  if (images.size > MAX_STEP_IMAGES) images.delete(images.keys().next().value!)
  return image
}
