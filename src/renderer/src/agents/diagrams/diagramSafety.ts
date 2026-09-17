// Pre-layout admission for the pinned Mermaid 11.17.2 databases. These are parsed values, not
// estimates from source lines/regexes. Keep the real-parser/Electron tests green on upgrades.
import type { Diagram } from 'mermaid/dist/Diagram.js'
import type { FlowDB } from 'mermaid/dist/diagrams/flowchart/flowDb.js'
import type { SequenceDB } from 'mermaid/dist/diagrams/sequence/sequenceDb.js'
import type { ClassDB } from 'mermaid/dist/diagrams/class/classDb.js'
import type { ErDB } from 'mermaid/dist/diagrams/er/erDb.js'

const DIAGRAM_LAYOUT_LIMITS = Object.freeze({
  nodes: 40, edges: 60, depth: 3, graphWork: 1200,
  actors: 16, messages: 60, sequenceWork: 600,
  labelLength: 400, labelCharacters: 4000, rows: 120, edgeSpan: 4,
})
const COMPLEX = 'Too complex to draw safely. This diagram exceeds the node, connection, nesting or label limits; its source is available.'
const RESOURCES = 'Image and icon resources are not drawn because they can load files or network resources. The diagram source is available.'
const UNKNOWN = 'This diagram uses a structure that cannot be checked safely. The diagram source is available.'

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(UNKNOWN)
  return value as RecordValue
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(UNKNOWN)
  return value
}
function limited(condition: boolean): void {
  if (!condition) throw new Error(COMPLEX)
}

/** Cycles, missing parents and excessive ancestry all fail closed, with bounded traversal. */
function nesting(parents: Map<string, string | undefined>): number {
  let maximum = 0
  for (const id of parents.keys()) {
    let parent = parents.get(id)
    let depth = 0
    const seen = new Set([id])
    while (parent !== undefined) {
      limited(!seen.has(parent) && ++depth <= DIAGRAM_LAYOUT_LIMITS.depth)
      if (!parents.has(parent)) throw new Error(UNKNOWN)
      seen.add(parent)
      parent = parents.get(parent)
    }
    maximum = Math.max(maximum, depth)
  }
  return maximum
}

function groups(groups: { id: string; nodes: string[] }[]): number {
  limited(groups.length <= DIAGRAM_LAYOUT_LIMITS.nodes)
  const parents = new Map<string, string | undefined>(groups.map(group => [group.id, undefined]))
  for (const group of groups) for (const child of group.nodes) {
    if (parents.has(child)) parents.set(child, group.id)
  }
  // Count the group itself as a level, even if it has no visible children.
  return groups.length ? nesting(parents) + 1 : 0
}

/** Includes member/attribute rows, notes and multiline labels, not only graph vertices. */
function labels(values: unknown[]): void {
  let characters = 0
  let rows = 0
  let visited = 0
  const seen = new Set<object>()
  const pending = values.map(value => ({ value, label: false }))
  while (pending.length) {
    limited(++visited <= 4000)
    const { value, label } = pending.pop()!
    if (typeof value === 'string' && label) {
      limited(value.length <= DIAGRAM_LAYOUT_LIMITS.labelLength)
      characters += value.length
      rows += value.split(/\n|<br\s*\/?\s*>/iu).length
      limited(characters <= DIAGRAM_LAYOUT_LIMITS.labelCharacters && rows <= DIAGRAM_LAYOUT_LIMITS.rows)
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      const entries = Array.isArray(value) ? value.map(item => ['', item] as const) : Object.entries(value)
      for (const [key, item] of entries) {
        pending.push({ value: item, label: label || /^(?:label|alias|description|text|message|name|members|methods|annotations|attributes)$/u.test(key) })
      }
    }
  }
}

function resource(node: RecordValue): void {
  // FlowDB has already interpreted YAML, including escapes and aliases, and resolved the shape.
  // Check the raw vertices too: collapsed subgraphs can hide vertices from getData().
  if (node.img !== undefined || node.icon !== undefined ||
    /image|icon/iu.test(String(node.shape ?? node.type ?? ''))) throw new Error(RESOURCES)
}

function graph(data: unknown, rawDepth = 0): void {
  const parsed = record(data)
  const nodes = array(parsed.nodes).map(record)
  const edges = array(parsed.edges).map(record)
  limited(nodes.length <= DIAGRAM_LAYOUT_LIMITS.nodes && edges.length <= DIAGRAM_LAYOUT_LIMITS.edges)
  const parents = new Map<string, string | undefined>()
  for (const node of nodes) {
    resource(node)
    if (typeof node.id !== 'string' || (node.parentId !== undefined && typeof node.parentId !== 'string')) throw new Error(UNKNOWN)
    parents.set(node.id, node.parentId as string | undefined)
  }
  const depth = Math.max(rawDepth, nesting(parents))
  limited(depth <= DIAGRAM_LAYOUT_LIMITS.depth)
  // Rank spans introduce dummy layout nodes even in a graph with only two source vertices.
  let spans = 0
  for (const edge of edges) {
    const span = edge.minlen ?? 1
    limited(typeof span === 'number' && Number.isFinite(span) && span >= 0 && span <= DIAGRAM_LAYOUT_LIMITS.edgeSpan)
    spans += span as number
  }
  limited(nodes.length * Math.max(edges.length, spans, 1) * (depth + 1) <= DIAGRAM_LAYOUT_LIMITS.graphWork)
  labels([...nodes, ...edges])
}

/** No render, measurement, stage creation or image decoding may occur before this succeeds. */
export function assertDiagramSafe(diagram: Pick<Diagram, 'type' | 'db'>): void {
  switch (diagram.type) {
    case 'flowchart-v2': {
      const db = diagram.db as FlowDB
      const vertices = db.getVertices()
      for (const vertex of vertices.values()) resource(record(vertex))
      limited(vertices.size <= DIAGRAM_LAYOUT_LIMITS.nodes && db.getEdges().length <= DIAGRAM_LAYOUT_LIMITS.edges)
      const depth = groups(db.getSubGraphs())
      limited(depth <= DIAGRAM_LAYOUT_LIMITS.depth)
      graph(db.getData(), depth)
      break
    }
    case 'state':
    case 'stateDiagram': {
      // StateDB.getData includes nested states, notes, synthetic groups and ALL transitions.
      const db = diagram.db as { getData(): unknown }
      graph(db.getData())
      break
    }
    case 'class':
    case 'classDiagram': {
      const db = diagram.db as ClassDB
      limited(db.getClasses().size + db.getNamespaces().size <= DIAGRAM_LAYOUT_LIMITS.nodes)
      const depth = nesting(new Map([...db.getNamespaces()].map(([id, ns]) => [id, ns.parent])))
      graph(db.getData(), db.getNamespaces().size ? depth + 1 : 0)
      break
    }
    case 'er': {
      const db = diagram.db as ErDB
      limited(db.getEntities().size <= DIAGRAM_LAYOUT_LIMITS.nodes)
      graph(db.getData(), groups(db.getSubGraphs()))
      break
    }
    case 'sequence': {
      const db = diagram.db as SequenceDB
      const actors = db.getActors()
      const messages = db.getMessages()
      limited(actors.size <= DIAGRAM_LAYOUT_LIMITS.actors && messages.length <= DIAGRAM_LAYOUT_LIMITS.messages)
      const kind = db.LINETYPE
      const starts = new Set<number>([kind.LOOP_START, kind.ALT_START, kind.OPT_START, kind.ACTIVE_START,
        kind.PAR_START, kind.RECT_START, kind.CRITICAL_START, kind.BREAK_START, kind.PAR_OVER_START])
      const ends = new Set<number>([kind.LOOP_END, kind.ALT_END, kind.OPT_END, kind.ACTIVE_END,
        kind.PAR_END, kind.RECT_END, kind.CRITICAL_END, kind.BREAK_END])
      let depth = 0
      let maximum = 0
      for (const message of messages) {
        if (starts.has(message.type!)) maximum = Math.max(maximum, ++depth)
        if (ends.has(message.type!)) depth--
        limited(depth >= 0 && maximum <= DIAGRAM_LAYOUT_LIMITS.depth)
      }
      // Mermaid permits an activation to remain open at the end of a sequence.
      limited(actors.size * Math.max(messages.length, 1) * (maximum + 1) <= DIAGRAM_LAYOUT_LIMITS.sequenceWork)
      labels([...actors.values(), ...messages, ...db.getBoxes()])
      break
    }
    default: throw new Error(UNKNOWN)
  }
}
