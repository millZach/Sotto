// Draws one Mermaid source into an inert SVG image. Loaded on demand, so Mermaid stays out of the
// startup bundle. Renders run one at a time because Mermaid keeps global configuration.

import mermaid, { type MermaidConfig } from 'mermaid'
import { msg } from '@lingui/core/macro'
import type { DiagramPalette } from './diagramPalette'
import { FIGTREE_FONT_STACK } from '../../../../shared/figtreeFaces'
import { FIGTREE_FONT_FACES } from '../../../../shared/figtreeFonts'
import { DIAGRAM_RENDER_TIMEOUT_MS, MAX_DIAGRAM_EDGES, MAX_DIAGRAM_SOURCE_LENGTH, inspectDiagramSource } from '../../../../shared/diagramSource'
import { keepRecent, readRecent } from '../../../../shared/recentMap'
import { assertDiagramSafe, DiagramRefusal } from './diagramSafety'
import type { LaterWords } from '../interfaceWords'
import { diagramStepCss } from './diagramSteps'
import { svgDataUrl, toInertDiagramSvg, type DiagramBounds } from './diagramSvg'
import { shownCount } from '../interfaceWords'

export type DiagramRenderResult =
  | {
    readonly ok: true
    /** The sanitized drawing, which a visual's walkthrough reads back to light one step at a time (diagramSteps.ts). */
    readonly dataUrl: string
    readonly width: number
    readonly height: number
    readonly title: string | null
    readonly description: string | null
  }
  // Sotto's reason is a message read when shown, so a change of language rewords it; Mermaid's own words as written.
  | { readonly ok: false; readonly reason: LaterWords }

const FONT_FAMILY = FIGTREE_FONT_STACK
// The image document cannot see the window's fonts, so the label face travels with every drawing.
const LABEL_FONT_CSS = FIGTREE_FONT_FACES

/**
 * Corrections to Mermaid's own theme CSS: solid label backings and no fixed light fills in a dark room. Then how a
 * visual's step lights its parts, which does nothing until a step marks them.
 */
function finishingCss(palette: DiagramPalette): string {
  return [
    `.edgeLabel rect,.edgeLabel .label rect,.labelBkg{opacity:1!important;fill:${palette.block}!important}`,
    `.stateGroup .alt-composit{fill:${palette.group}!important}`,
    diagramStepCss(palette),
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

/** The Mermaid settings every drawing is made with. tests/fixtures/mermaidSteps/sources.mjs copies the layout ones. */
export function configFor(palette: DiagramPalette): MermaidConfig {
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
export function readableDiagramError(error: unknown): LaterWords {
  if (error instanceof DiagramRefusal) return error.reason
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const grammar = /^(?:Parse|Lexical) error on line (\d+)/u.exec(message.trim())
  if (grammar) {
    const line = shownCount(Number(grammar[1]))
    return msg`The source has a syntax error on line ${line}.`
  }
  const head = message.split(/\r?\n/u).map(line => line.trim()).find(line => line && !/^[-.^\s]+$/u.test(line))
  // Mermaid's own words for any other error are shown as it wrote them.
  if (!head) return msg`Mermaid could not read this diagram.`
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
    if (!image) return { ok: false, reason: msg`Mermaid did not produce a drawing.` }
    return { ok: true, dataUrl: svgDataUrl(image.svg), width: image.width, height: image.height, title: image.title, description: image.description }
  } catch (error) {
    return { ok: false, reason: readableDiagramError(error) }
  } finally {
    stage.remove()
  }
}

/** Read in the interface language each time it is shown; a result is told slow by this message. */
const TOO_SLOW = msg({ message: 'Took too long to draw.', comment: 'A diagram that took too long to draw.' })
const results = new Map<string, Promise<DiagramRenderResult>>()
const MAX_CACHED_RESULTS = 24

/**
 * Renders `code` (already inspected and stripped of configuration) with `palette`. Results are
 * cached per source and palette, so moving between threads or re-mounting a transcript does not
 * redraw; a failure's reason is a message, read in the language shown (ADR-0123). Parsed complexity limits are the synchronous layout admission boundary. The timer
 * only handles asynchronous stalls; it cannot interrupt synchronous work. Elapsed-time checking
 * prevents a late synchronous completion from reporting success. Neither check preempts layout.
 * The next render still waits for actual completion, so Mermaid never runs twice at once.
 */
export function renderDiagram(code: string, palette: DiagramPalette, timeoutMs = DIAGRAM_RENDER_TIMEOUT_MS): Promise<DiagramRenderResult> {
  const cacheKey = `${paletteKey(palette)}\n${code}`
  const tooSlow = (): DiagramRenderResult => ({ ok: false, reason: TOO_SLOW })
  const cached = readRecent(results, cacheKey)
  if (cached) return cached
  const previous = queue
  const run = previous.then(async () => {
    const started = performance.now()
    const result = await renderNow(code, palette)
    return performance.now() - started > timeoutMs ? tooSlow() : result
  })
  queue = run.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  // The clock starts when this render starts, not while it waits behind another.
  const settled = previous.then(() => Promise.race([
    run.catch((error: unknown) => ({ ok: false as const, reason: readableDiagramError(error) })),
    new Promise<DiagramRenderResult>(resolve => { timer = setTimeout(() => resolve(tooSlow()), timeoutMs) }),
  ])).finally(() => clearTimeout(timer))
  // A slow render is not cached, so a later view can try again once Mermaid is free.
  void settled.then(result => { if (!result.ok && result.reason === TOO_SLOW) results.delete(cacheKey) })
  return keepRecent(results, cacheKey, settled, MAX_CACHED_RESULTS)
}
