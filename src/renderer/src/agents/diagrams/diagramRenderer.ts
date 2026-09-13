// Draws one Mermaid source into an inert SVG image. Loaded on demand, so Mermaid stays out of the
// startup bundle. Renders run one at a time because Mermaid keeps global configuration.

import mermaid, { type MermaidConfig } from 'mermaid'
import bricolageLatin from '../../assets/fonts/bricolage-grotesque-latin.woff2?inline'
import bricolageLatinExt from '../../assets/fonts/bricolage-grotesque-latin-ext.woff2?inline'
import type { DiagramPalette } from './diagramPalette'
import { DIAGRAM_RENDER_TIMEOUT_MS, MAX_DIAGRAM_EDGES, MAX_DIAGRAM_SOURCE_LENGTH, inspectDiagramSource } from './diagramSource'
import { assertDiagramSafe } from './diagramSafety'
import { svgDataUrl, toInertDiagramSvg, type DiagramBounds } from './diagramSvg'

export type DiagramRenderResult =
  | { readonly ok: true; readonly dataUrl: string; readonly width: number; readonly height: number; readonly title: string | null; readonly description: string | null }
  | { readonly ok: false; readonly reason: string }

const FONT_FAMILY = '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif'
// The image document cannot see the window's fonts, so the label face travels with every drawing.
const LABEL_FONT_CSS = [
  `@font-face{font-family:"Bricolage Grotesque";font-style:normal;font-weight:200 800;src:url(${bricolageLatin}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`,
  `@font-face{font-family:"Bricolage Grotesque";font-style:normal;font-weight:200 800;src:url(${bricolageLatinExt}) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`,
].join('')

/** Corrections to Mermaid's own theme CSS: solid label backings and no fixed light fills in a dark room. */
function finishingCss(palette: DiagramPalette): string {
  return [
    `.edgeLabel rect,.edgeLabel .label rect,.labelBkg{opacity:1!important;fill:${palette.block}!important}`,
    `.stateGroup .alt-composit{fill:${palette.group}!important}`,
  ].join('')
}

// Keys a diagram's own directive may never change. Directives are already stripped from the
// source before it arrives here; this is Mermaid's own second check.
const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'dompurifyConfig',
  'theme', 'themeVariables', 'themeCSS', 'darkMode', 'fontFamily', 'altFontFamily', 'fontSize', 'htmlLabels', 'look',
  'layout', 'handDrawnSeed', 'arrowMarkerAbsolute', 'legacyMathML', 'forceLegacyMathML', 'deterministicIds', 'deterministicIDSeed',
  'flowchart', 'sequence', 'state', 'class', 'er', 'elk', 'markdownAutoWrap', 'logLevel',
]

function configFor(palette: DiagramPalette): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MAX_DIAGRAM_SOURCE_LENGTH,
    maxEdges: MAX_DIAGRAM_EDGES,
    secure: SECURE_KEYS,
    logLevel: 'fatal',
    deterministicIds: false,
    // SVG text instead of HTML islands: nothing in the drawing is an HTML document.
    htmlLabels: false,
    theme: 'base',
    darkMode: palette.dark,
    fontFamily: FONT_FAMILY,
    fontSize: 15,
    themeVariables: {
      darkMode: palette.dark,
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      background: palette.block,
      primaryColor: palette.node,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.nodeBorder,
      secondaryColor: palette.group,
      secondaryTextColor: palette.text,
      secondaryBorderColor: palette.nodeBorder,
      tertiaryColor: palette.group,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.nodeBorder,
      textColor: palette.text,
      lineColor: palette.line,
      mainBkg: palette.node,
      nodeBorder: palette.nodeBorder,
      nodeTextColor: palette.text,
      clusterBkg: palette.group,
      clusterBorder: palette.nodeBorder,
      titleColor: palette.text,
      edgeLabelBackground: palette.block,
      // Sequence
      actorBkg: palette.node,
      actorBorder: palette.nodeBorder,
      actorTextColor: palette.text,
      actorLineColor: palette.line,
      signalColor: palette.text,
      signalTextColor: palette.text,
      labelBoxBkgColor: palette.node,
      labelBoxBorderColor: palette.nodeBorder,
      labelTextColor: palette.text,
      loopTextColor: palette.text,
      noteBkgColor: palette.note,
      noteBorderColor: palette.accent,
      noteTextColor: palette.text,
      activationBkgColor: palette.group,
      activationBorderColor: palette.nodeBorder,
      sequenceNumberColor: palette.block,
      // State
      labelColor: palette.text,
      stateBkg: palette.node,
      stateBorder: palette.nodeBorder,
      altBackground: palette.group,
      compositeBackground: palette.block,
      compositeTitleBackground: palette.group,
      compositeBorder: palette.nodeBorder,
      transitionColor: palette.line,
      transitionLabelColor: palette.text,
      specialStateColor: palette.muted,
      innerEndBackground: palette.nodeBorder,
      // Class and entity relationship
      classText: palette.text,
      attributeBackgroundColorOdd: palette.node,
      attributeBackgroundColorEven: palette.group,
      relationColor: palette.line,
      relationLabelColor: palette.text,
      relationLabelBackground: palette.block,
    },
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false, wrap: true, mirrorActors: false },
    state: { useMaxWidth: false },
    class: { htmlLabels: false, useMaxWidth: false },
    er: { useMaxWidth: false },
  } as MermaidConfig
}

let queue: Promise<unknown> = Promise.resolve()
let configuredFor = ''
let sequence = 0

function paletteKey(palette: DiagramPalette): string {
  return JSON.stringify(palette)
}

/**
 * A short reason from a Mermaid error. Grammar errors name the line only: the parser's list of
 * expected token names means nothing to a reader, and the source is shown right below.
 */
export function readableDiagramError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const grammar = /^(?:Parse|Lexical) error on line (\d+)/u.exec(message.trim())
  if (grammar) return `The source has a syntax error on line ${grammar[1]}.`
  const head = message.split(/\r?\n/u).map(line => line.trim()).find(line => line && !/^[-.^\s]+$/u.test(line))
  if (!head) return 'Mermaid could not read this diagram.'
  const text = /[.!?]$/u.test(head) ? head : `${head.replace(/:$/u, '')}.`
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

// Mermaid measures labels in the live document, so the stage is laid out but never painted or reachable.
function createStage(): HTMLDivElement {
  const stage = document.createElement('div')
  stage.setAttribute('aria-hidden', 'true')
  stage.setAttribute('inert', '')
  stage.dataset.diagramStage = ''
  stage.style.cssText = 'position:fixed;left:-20000px;top:0;width:2400px;height:1px;overflow:hidden;visibility:hidden;pointer-events:none;contain:layout style paint'
  document.body.appendChild(stage)
  return stage
}

// Flow, state, class and entity drawings take their viewBox from a bounding box Mermaid reads
// mid-layout, which can miss nodes placed afterwards. The sanitized drawing (no scripts, handlers,
// links or external references; Mermaid's own scoped styles only) is laid out on the hidden stage
// just long enough to read its final bounds. Sequence diagrams size themselves from their layout
// model and draw lifelines past the box on purpose, so their viewBox is kept.
function measureOn(stage: HTMLElement): (root: SVGSVGElement) => DiagramBounds | null {
  return root => {
    if (root.getAttribute('aria-roledescription') === 'sequence') return null
    const probe = document.importNode(root, true)
    stage.appendChild(probe)
    try {
      const { x, y, width, height } = probe.getBBox()
      return { x, y, width, height }
    } catch {
      return null
    } finally {
      probe.remove()
    }
  }
}

async function renderNow(code: string, palette: DiagramPalette): Promise<DiagramRenderResult> {
  // Enforce at the renderer boundary too; callers cannot bypass kind/length/config inspection.
  const inspection = inspectDiagramSource(code)
  if (inspection.problem) return { ok: false, reason: inspection.problem }
  code = inspection.code
  const key = paletteKey(palette)
  if (configuredFor !== key) {
    mermaid.initialize(configFor(palette))
    configuredFor = key
  }
  try {
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(code)
    assertDiagramSafe(parsed)
  } catch (error) {
    return { ok: false, reason: readableDiagramError(error) }
  }
  try {
    await document.fonts?.load?.(`15px ${FONT_FAMILY}`)
  } catch { /* Measurement falls back to the system face; the drawing still renders. */ }
  const stage = createStage()
  try {
    sequence += 1
    const { svg } = await mermaid.render(`sotto-diagram-${sequence}`, code, stage)
    const image = toInertDiagramSvg(svg, { trustedCss: LABEL_FONT_CSS + finishingCss(palette), measure: measureOn(stage) })
    if (!image) return { ok: false, reason: 'Mermaid did not produce a drawing.' }
    return { ok: true, dataUrl: svgDataUrl(image.svg), width: image.width, height: image.height, title: image.title, description: image.description }
  } catch (error) {
    return { ok: false, reason: readableDiagramError(error) }
  } finally {
    stage.remove()
  }
}

const TOO_SLOW = 'Took too long to draw.'
const results = new Map<string, Promise<DiagramRenderResult>>()
const MAX_CACHED_RESULTS = 24

/**
 * Renders `code` (already inspected and stripped of configuration) with `palette`. Results are
 * cached per source and palette, so moving between threads or re-mounting a transcript does not
 * redraw. Parsed complexity limits are the synchronous layout admission boundary. The timer
 * only handles asynchronous stalls; it cannot interrupt synchronous work. Elapsed-time checking
 * prevents a late synchronous completion from reporting success. Neither check preempts layout.
 * The next render still waits for actual completion, so Mermaid never runs twice at once.
 */
export function renderDiagram(code: string, palette: DiagramPalette, timeoutMs = DIAGRAM_RENDER_TIMEOUT_MS): Promise<DiagramRenderResult> {
  const cacheKey = `${paletteKey(palette)}\n${code}`
  const cached = results.get(cacheKey)
  if (cached) {
    results.delete(cacheKey)
    results.set(cacheKey, cached)
    return cached
  }
  const previous = queue
  const run = previous.then(async () => {
    const started = performance.now()
    const result = await renderNow(code, palette)
    return performance.now() - started > timeoutMs ? { ok: false as const, reason: TOO_SLOW } : result
  })
  queue = run.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  // The clock starts when this render starts, not while it waits behind another.
  const settled = previous.then(() => Promise.race([
    run.catch((error: unknown) => ({ ok: false as const, reason: readableDiagramError(error) })),
    new Promise<DiagramRenderResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, reason: TOO_SLOW }), timeoutMs) }),
  ])).finally(() => clearTimeout(timer))
  // A slow render is not cached, so a later view can try again once Mermaid is free.
  void settled.then(result => { if (!result.ok && result.reason === TOO_SLOW) results.delete(cacheKey) })
  results.set(cacheKey, settled)
  if (results.size > MAX_CACHED_RESULTS) results.delete(results.keys().next().value!)
  return settled
}
