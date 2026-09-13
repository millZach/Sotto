// What a Mermaid fence holds before anything draws it: its kind, whether Sotto draws that kind,
// and the source with every configuration override removed. No Mermaid code is loaded here.

export type DiagramKind = 'sequence' | 'flowchart' | 'state' | 'class' | 'er'

/** Longer sources are shown as text; a single answer cannot make the renderer lay out a huge graph. */
export const MAX_DIAGRAM_SOURCE_LENGTH = 12_000
/** Mermaid stops a flowchart with more edges than this. */
export const MAX_DIAGRAM_EDGES = 300
/** A render that has not settled by then is reported as too slow, and its source stays visible. */
export const DIAGRAM_RENDER_TIMEOUT_MS = 8_000

export interface DiagramSourceInspection {
  readonly kind: DiagramKind | null
  /** The kind in words, for the block label and the image's accessible name. */
  readonly label: string
  /** The source Mermaid receives: directives and front-matter configuration removed. */
  readonly code: string
  /** Front-matter title, when the source names one. */
  readonly title: string | null
  /** Why the source is shown instead of a drawing, or null when it can be drawn. */
  readonly problem: string | null
}

const KINDS: readonly { kind: DiagramKind; label: string; pattern: RegExp }[] = [
  { kind: 'sequence', label: 'Sequence diagram', pattern: /^sequenceDiagram\b/u },
  { kind: 'flowchart', label: 'Flowchart', pattern: /^(?:flowchart|graph)(?:\s|$)/u },
  { kind: 'state', label: 'State diagram', pattern: /^stateDiagram(?:-v2)?\b/u },
  { kind: 'class', label: 'Class diagram', pattern: /^classDiagram(?:-v2)?\b/u },
  { kind: 'er', label: 'Entity relationship diagram', pattern: /^erDiagram\b/u },
]

// `%%{init: …}%%` and `%%{config: …}%%` can appear anywhere and span lines.
const DIRECTIVE = /%%\{[\s\S]*?\}%%/gu
const FRONT_MATTER = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/u
const CONTROL_CHARACTERS = /[\p{Cc}\p{Bidi_Control}]/gu

function frontMatterTitle(block: string): string | null {
  const line = /^title:[ \t]*(.+)$/mu.exec(block)?.[1]?.trim()
  if (!line) return null
  const unquoted = /^(["'])(.*)\1$/u.exec(line)?.[2] ?? line
  const title = unquoted.replace(CONTROL_CHARACTERS, '').trim().slice(0, 120)
  return title || null
}

/**
 * Removes every way a diagram can reconfigure Mermaid. A front-matter title survives as a plain
 * quoted title so the drawing still names itself; theme, CSS, fonts, labels and limits come only
 * from Sotto.
 */
export function stripDiagramConfiguration(source: string): { code: string; title: string | null } {
  let code = source.replace(/^\uFEFF/u, '')
  let title: string | null = null
  const frontMatter = FRONT_MATTER.exec(code)
  if (frontMatter) {
    title = frontMatterTitle(frontMatter[1] ?? '')
    code = code.slice(frontMatter[0].length)
  }
  code = code.replace(DIRECTIVE, '')
  return { code: title ? `---\ntitle: ${JSON.stringify(title)}\n---\n${code}` : code, title }
}

function firstStatement(code: string): string {
  for (const raw of code.replace(FRONT_MATTER, '').split(/\r?\n/u)) {
    const line = raw.trim()
    if (line && !line.startsWith('%%')) return line
  }
  return ''
}

export function inspectDiagramSource(source: string): DiagramSourceInspection {
  if (source.length > MAX_DIAGRAM_SOURCE_LENGTH) {
    return { kind: null, label: 'Diagram', code: '', title: null, problem: `Too long to draw. Diagrams over ${MAX_DIAGRAM_SOURCE_LENGTH.toLocaleString('en-US')} characters are shown as source.` }
  }
  const { code, title } = stripDiagramConfiguration(source)
  const statement = firstStatement(code)
  if (!statement) return { kind: null, label: 'Diagram', code, title, problem: 'This diagram is empty.' }
  const match = KINDS.find(entry => entry.pattern.test(statement))
  if (!match) {
    const keyword = statement.split(/[\s:;{]/u)[0]!.replace(CONTROL_CHARACTERS, '').slice(0, 32)
    return { kind: null, label: 'Diagram', code, title, problem: `Sotto doesn't draw “${keyword}” diagrams. Sequence, flow, state, class and entity diagrams are drawn.` }
  }
  return { kind: match.kind, label: match.label, code, title, problem: null }
}

const CLOSING_FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})[ \t]*$/u
const OPENING_FENCE = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/u

/**
 * True when the Markdown that produced a fenced block ends with its closing fence. While a provider
 * streams, the block before the fence arrives is incomplete and is not handed to the renderer.
 */
export function isFenceClosed(markdown: string): boolean {
  const lines = markdown.replace(/\s+$/u, '').split(/\r?\n/u)
  if (lines.length < 2) return false
  const open = OPENING_FENCE.exec(lines[0]!)?.[1]
  const close = CLOSING_FENCE.exec(lines.at(-1)!)?.[1]
  return !!open && !!close && close[0] === open[0] && close.length >= open.length
}
