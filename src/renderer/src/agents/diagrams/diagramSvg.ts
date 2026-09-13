// Turns Mermaid's SVG text into an inert, self-contained image. The result is only ever shown
// through <img>, where SVG runs no script, loads no external resource and has no live links; this
// allowlist is the second wall, so the image document itself holds nothing that could act.

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'style', 'title', 'desc', 'marker', 'symbol', 'use', 'clippath', 'mask', 'pattern',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop',
  'filter', 'fedropshadow', 'fegaussianblur', 'feoffset', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'feblend', 'fecolormatrix', 'femorphology',
])
// Removed with everything inside: HTML islands, scripts, embedded documents, animation that can rewrite attributes.
const DROPPED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'feimage', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'handler', 'listener', 'audio', 'video', 'canvas', 'link', 'meta', 'base'])
// Unwrapped: the text stays, the element does not.
const UNWRAPPED_ELEMENTS = new Set(['a', 'switch', 'view'])
const FRAGMENT_REFERENCE = /^#[\w.:-]+$/u
const URL_FUNCTION = /url\(\s*(['"]?)(.*?)\1\s*\)/giu
const UNSAFE_CSS = /@import|@font-face|@namespace|expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set\s*\(|\bsrc\s*\(/iu

const CSS_COMMENT = /\/\*[\s\S]*?\*\//gu
// A CSS escape can spell url( or @import in a way the patterns here do not see, so any declaration
// (or selector) holding one is dropped rather than decoded.
const ESCAPED_SEGMENT = /[^;{}]*\\[^;{}]*/gu

function keepFragmentUrls(css: string): string {
  return css.replace(URL_FUNCTION, (match, _quote: string, target: string) => FRAGMENT_REFERENCE.test(target.trim()) ? match : 'none')
}

/** Keeps `url(#id)` references to markers and gradients; any other url() is removed. */
function cleanCss(value: string): string {
  const cleaned = keepFragmentUrls(value.replace(CSS_COMMENT, '').replace(ESCAPED_SEGMENT, '')).replace(/^[\s;]+|[\s;]+$/gu, '')
  return UNSAFE_CSS.test(cleaned) ? '' : cleaned
}

function cleanStyleSheet(css: string): string {
  // Drop whole at-rules we do not allow instead of trying to repair them.
  const withoutRules = css.replace(CSS_COMMENT, '').replace(ESCAPED_SEGMENT, '').replace(/@(?:import|font-face|namespace)[^;{]*(?:;|\{[^}]*\})/giu, '')
  const cleaned = keepFragmentUrls(withoutRules)
  return UNSAFE_CSS.test(cleaned) ? '' : cleaned
}

function cleanAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value
    const isReference = attribute.localName === 'href'
    if (name.startsWith('on') || name === 'src' || name === 'action' || name === 'formaction' || name === 'ping' || name === 'target' || name === 'download') {
      element.removeAttributeNode(attribute)
    } else if (isReference) {
      if (!FRAGMENT_REFERENCE.test(value.trim())) element.removeAttributeNode(attribute)
    } else if ((attribute.namespaceURI && attribute.namespaceURI !== XLINK_NS && !name.startsWith('xmlns') && !name.startsWith('xml:')) || (name.startsWith('xmlns:') && name !== 'xmlns:xlink')) {
      element.removeAttributeNode(attribute)
    } else if (name === 'style') {
      const cleaned = cleanCss(value)
      if (cleaned) attribute.value = cleaned
      else element.removeAttributeNode(attribute)
    } else if (/url\s*\(|\\/iu.test(value) || /^\s*(?:javascript|vbscript|data):/iu.test(value)) {
      const cleaned = cleanCss(value)
      if (cleaned && !/^\s*(?:javascript|vbscript|data):/iu.test(cleaned)) attribute.value = cleaned
      else element.removeAttributeNode(attribute)
    }
  }
}

function cleanTree(node: Element): void {
  for (const child of [...node.children]) {
    const name = child.localName.toLowerCase()
    if (child.namespaceURI !== SVG_NS || DROPPED_ELEMENTS.has(name)) {
      child.remove()
      continue
    }
    if (UNWRAPPED_ELEMENTS.has(name)) {
      cleanTree(child)
      child.replaceWith(...child.childNodes)
      continue
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      child.remove()
      continue
    }
    cleanAttributes(child)
    if (name === 'style') child.textContent = cleanStyleSheet(child.textContent ?? '')
    cleanTree(child)
  }
  // Comments, processing instructions and CDATA carry nothing the drawing needs.
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== 1 && child.nodeType !== 3) child.remove()
  }
}

export interface InertDiagramImage {
  /** Serialized, sanitized SVG document. */
  readonly svg: string
  readonly width: number
  readonly height: number
  readonly title: string | null
  readonly description: string | null
}

export interface DiagramBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface InertDiagramOptions {
  /** A stylesheet Sotto controls, e.g. the embedded label font. Inserted after sanitizing. */
  readonly trustedCss?: string
  /**
   * Lays out the sanitized drawing and returns its content bounds, or null when it cannot. Mermaid
   * can size its viewBox from a layout that later moved, which clips the drawing's edge.
   */
  readonly measure?: (root: SVGSVGElement) => DiagramBounds | null
}

/** Space kept around measured content, so strokes and arrowheads outside the geometry still show. */
export const DIAGRAM_BOUNDS_PADDING = 12

/** Parses Mermaid's SVG, removes anything active or external, and fixes its size. Null when it is not a drawable SVG. */
export function toInertDiagramSvg(markup: string, options: InertDiagramOptions = {}): InertDiagramImage | null {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg' || parsed.getElementsByTagName('parsererror').length) return null
  cleanAttributes(root)
  cleanTree(root)
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/u).map(Number)
  if (box.length !== 4 || !box.every(Number.isFinite) || !(box[2]! > 0) || !(box[3]! > 0)) return null
  const measured = options.measure?.(root as unknown as SVGSVGElement)
  let [boxX, boxY, boxWidth, boxHeight] = box as [number, number, number, number]
  if (measured && [measured.x, measured.y, measured.width, measured.height].every(Number.isFinite) && measured.width > 0 && measured.height > 0) {
    boxX = measured.x - DIAGRAM_BOUNDS_PADDING
    boxY = measured.y - DIAGRAM_BOUNDS_PADDING
    boxWidth = measured.width + DIAGRAM_BOUNDS_PADDING * 2
    boxHeight = measured.height + DIAGRAM_BOUNDS_PADDING * 2
  }
  const width = Math.ceil(boxWidth)
  const height = Math.ceil(boxHeight)
  root.setAttribute('viewBox', [boxX, boxY, width, height].join(' '))
  // Mermaid sizes its SVG to its container; an image needs intrinsic dimensions instead.
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  root.setAttribute('xmlns', SVG_NS)
  const title = root.querySelector(':scope > title')?.textContent?.trim() || null
  const description = root.querySelector(':scope > desc')?.textContent?.trim() || null
  if (options.trustedCss) {
    const style = parsed.createElementNS(SVG_NS, 'style')
    style.textContent = options.trustedCss
    root.insertBefore(style, root.firstChild)
  }
  return { svg: new XMLSerializer().serializeToString(root), width, height, title, description }
}

/** A base64 data URL for an <img>; UTF-8 labels survive intact. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
