// Which parts of a drawn diagram one step of a visual's walkthrough names (ADR-0056, #793), read from what Mermaid 11
// draws for each kind. tests/fixtures/mermaidSteps holds captured drawings of each, and diagramSteps.ts turns what is
// found here into a step's picture.

/** What one step lights: the parts that stay as drawn, out of every part that could be dimmed. */
export interface StepTargets {
  readonly parts: readonly Element[]
  readonly lit: ReadonlySet<Element>
}

/** The parts of a drawn diagram a step names, and every part that could be dimmed. Unknown names light nothing. */
export function stepTargets(root: Element, names: readonly string[]): StepTargets {
  const role = root.getAttribute('aria-roledescription') ?? ''
  if (role === 'sequence') return sequenceTargets(root, names)
  const kind = graphKind(role)
  return kind ? graphTargets(root, kind, names) : { parts: [], lit: new Set() }
}

/**
 * How a flowchart, state, class or entity relationship drawing names its parts. A node's id is the drawing's id, a
 * prefix, the name and a counter (`<drawing>-flowchart-Login-3`); an edge's `data-id` is `edgePrefix`, the two ends'
 * keys and a counter (`L_Login_Home_0`). A state's edges carry no ends (`edge3`), so they never light.
 */
interface GraphKind { readonly node: RegExp; readonly edgePrefix: string }

function graphKind(role: string): GraphKind | null {
  if (/^flowchart/u.test(role) || role === 'graph') return { node: /^flowchart-(.+)-\d+$/u, edgePrefix: 'L_' }
  if (/^state/u.test(role)) return { node: /^state-(.+)-\d+$/u, edgePrefix: '' }
  if (/^class/u.test(role)) return { node: /^classId-(.+)-\d+$/u, edgePrefix: 'id_' }
  if (role === 'er') return { node: /^(entity-(.+)-\d+)$/u, edgePrefix: 'id_' }
  return null
}

/** A node's name, and the key its edges use for it: an entity's whole id ("entity-THREAD-0"), else its name. */
interface GraphNode { readonly element: Element; readonly name: string; readonly key: string }

/** "A->B" (any number of dashes): the edge from A to B. */
const EDGE_NAME = /^\s*(.+?)\s*-+>\s*(.+?)\s*$/u

/** An element's id without the drawing's own id in front, which every id Mermaid writes starts with. */
function idInDrawing(root: Element, element: Element): string {
  const id = element.getAttribute('id') ?? ''
  const prefix = `${root.getAttribute('id') ?? ''}-`
  return prefix.length > 1 && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

/** Flowchart, state, class and entity relationship drawings: nodes, subgraphs and composite states, and edges. */
function graphTargets(root: Element, kind: GraphKind, names: readonly string[]): StepTargets {
  const nodes: GraphNode[] = []
  for (const element of root.querySelectorAll('g.node')) {
    const match = kind.node.exec(idInDrawing(root, element))
    if (!match) continue
    nodes.push(match[2] === undefined ? { element, name: match[1]!, key: match[1]! } : { element, name: match[2], key: match[1]! })
  }
  const clusters = [...root.querySelectorAll('g.cluster, g.statediagram-cluster')]
  const edges = [...root.querySelectorAll('path[data-edge]')]
  const labels = [...root.querySelectorAll('g.edgeLabel, g.edgeTerminals')]
  const parts = [...nodes.map(node => node.element), ...clusters, ...edges, ...labels]

  // Every edge under the ends it joins, read once: `L_A_B_0` and `L_A_B_1` are both under `L_A_B`.
  const edgesByEnds = new Map<string, Element[]>()
  for (const edge of edges) {
    const ends = (edge.getAttribute('data-id') ?? '').replace(/_\d+$/u, '')
    edgesByEnds.set(ends, [...edgesByEnds.get(ends) ?? [], edge])
  }
  const edgesBetween = (from: GraphNode, to: GraphNode): readonly Element[] => edgesByEnds.get(`${kind.edgePrefix}${from.key}_${to.key}`) ?? []
  const byName = (name: string): GraphNode[] => nodes.filter(node => node.name === name)

  const namedNodes = new Set<GraphNode>()
  const namedEdgeEnds = new Set<GraphNode>()
  const litEdges = new Set<Element>()
  const litClusters = new Set<Element>()
  for (const raw of names) {
    const name = raw.trim()
    const named = byName(name)
    for (const node of named) namedNodes.add(node)
    for (const cluster of clusters) {
      if (cluster.getAttribute('data-id') !== name && idInDrawing(root, cluster) !== name) continue
      litClusters.add(cluster)
      const inside = clusterContents(cluster, [...nodes.map(node => node.element), ...clusters])
      for (const node of nodes) if (inside.includes(node.element)) namedNodes.add(node)
      for (const nested of clusters) if (inside.includes(nested)) litClusters.add(nested)
    }
    const arrow = named.length ? null : EDGE_NAME.exec(name)
    if (!arrow) continue
    for (const from of byName(arrow[1]!)) for (const to of byName(arrow[2]!)) {
      const between = edgesBetween(from, to)
      if (!between.length) continue
      for (const edge of between) litEdges.add(edge)
      namedEdgeEnds.add(from)
      namedEdgeEnds.add(to)
    }
  }
  // An edge between two nodes the step names lights too, so a step that names both ends shows the way between them.
  // The ends of a named edge do not count: naming A->B does not light B->A.
  for (const from of namedNodes) for (const to of namedNodes) for (const edge of edgesBetween(from, to)) litEdges.add(edge)

  const litEdgeIds = new Set([...litEdges].map(edge => edge.getAttribute('data-id')))
  const lit = new Set<Element>([...[...namedNodes, ...namedEdgeEnds].map(node => node.element), ...litClusters, ...litEdges])
  for (const label of labels) {
    const id = label.querySelector('[data-id]')?.getAttribute('data-id')
    if (id && litEdgeIds.has(id)) lit.add(label)
  }
  return { parts, lit }
}

const nearestRoot = (element: Element): Element | null => element.parentElement?.closest('g.root') ?? null

/**
 * The nodes and nested subgraphs inside a subgraph or composite state. One drawn as its own layout (a composite state)
 * holds them in the nested root it sits in; one drawn in its parent's layout (a flowchart subgraph) holds those whose
 * centre is inside its box.
 */
function clusterContents(cluster: Element, candidates: readonly Element[]): Element[] {
  const home = nearestRoot(cluster)
  if (home && nearestRoot(home)) return candidates.filter(item => item !== cluster && home.contains(item))
  const box = boxOf(cluster)
  if (!box) return []
  return candidates.filter(item => {
    if (item === cluster || nearestRoot(item) !== home) return false
    const centre = centreOf(item)
    return !!centre && centre.x >= box.x && centre.x <= box.x + box.width && centre.y >= box.y && centre.y <= box.y + box.height
  })
}

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A subgraph's box: its first rect, in the layout's coordinates. */
function boxOf(cluster: Element): Box | null {
  const rect = cluster.querySelector('rect')
  if (!rect) return null
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(name => Number(rect.getAttribute(name))) as [number, number, number, number]
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null
}

/** Where a node or subgraph sits: a node's translation, or the middle of a subgraph's box. */
function centreOf(element: Element): { x: number; y: number } | null {
  if (element.matches('g.node')) {
    const match = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/u.exec(element.getAttribute('transform') ?? '')
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null
  }
  const box = boxOf(element)
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null
}

/** Elements that draw nothing themselves, which a sequence diagram's parts are never among. */
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
    const role = part.getAttribute('data-et')
    const name = part.getAttribute('data-id')
    if ((role !== 'participant' && role !== 'life-line') || !name) continue
    participants.set(name, [...participants.get(name) ?? [], part])
    if (role === 'life-line') lifelines.push({ name, x: Number(part.getAttribute('x1')) })
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
  // A participant declared `participant U as User` is drawn as "User" and named U: a step may use either.
  const shownAs = new Map<string, string>()
  for (const part of parts) {
    if (part.getAttribute('data-et') !== 'participant') continue
    const id = part.getAttribute('data-id')
    const text = part.querySelector('text')
    const lines = text ? [...text.querySelectorAll('tspan')].map(line => line.textContent ?? '') : []
    const shown = tidy(lines.length ? lines.join(' ') : text?.textContent ?? '')
    if (id && shown && !participants.has(shown) && !shownAs.has(shown)) shownAs.set(shown, id)
  }

  const lit = new Set<Element>()
  const light = (name: string): void => { for (const element of participants.get(name) ?? []) lit.add(element) }
  for (const raw of names) {
    const name = raw.trim()
    if (participants.has(name)) { light(name); continue }
    const declared = shownAs.get(tidy(name))
    if (declared) { light(declared); continue }
    if (!/^\d+$/u.test(name)) continue
    const arrow = arrows[Number(name) - 1]
    if (!arrow) continue
    for (const element of arrow.elements) lit.add(element)
    light(arrow.from)
    light(arrow.to)
  }
  return { parts, lit }
}

/** Words with their runs of spaces made one, and none at the ends. */
const tidy = (words: string): string => words.replace(/\s+/gu, ' ').trim()
