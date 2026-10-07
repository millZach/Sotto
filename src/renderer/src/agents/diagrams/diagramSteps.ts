// Lights one step of a visual's walkthrough (ADR-0056, #793): the parts of a drawn diagram a step names stay as they
// are and the rest is dimmed. Mermaid draws once; each step's picture is the sanitized drawing with classes added,
// which the stylesheet Sotto puts in every drawing (`diagramStepCss`) turns into lit and dimmed. Nothing moves, so
// every step's picture has the same size and layout. Which parts a step names is diagramStepTargets.ts.

import type { DiagramPalette } from './diagramPalette'
import { stepTargets } from './diagramStepTargets'
import { svgDataUrl, svgFromDataUrl } from './diagramSvg'
import { keepRecent, readRecent } from '../../../../shared/recentMap'
import { VISUAL_KEPT_STEPS_MAX } from '../../../../shared/visuals'

/** On a part a step names, and on what lights with it. */
export const LIT_CLASS = 'sotto-step-lit'
/** On every other part while a step is shown. */
export const DIM_CLASS = 'sotto-step-dim'

/**
 * How a step looks, in the drawing's own stylesheet: the rest dimmed, the lit parts' outlines and lines in the accent.
 * Mermaid's own rules are scoped to the drawing's id, so these win with !important. The palette is read from the
 * theme's tokens, like the rest of the drawing. Dimmed words fall under 4.5:1 on purpose (ADR-0056).
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

/** How many step pictures one drawing keeps: one for every step a kept visual can have. */
export const MAX_STEP_IMAGES = VISUAL_KEPT_STEPS_MAX
const stepImages = new WeakMap<object, Map<string, string>>()

/**
 * The picture for one step of `drawn`, as a data URL for an `<img>`: its lit version, or the drawing as it is when the
 * step names nothing it can find. The SVG is read back from the drawing's own data URL, so only drawings that are
 * stepped through pay for it. Made once per step and kept with the drawing, so moving back and forth through a
 * walkthrough does not edit the drawing again.
 */
export function stepImage(drawn: { readonly dataUrl: string }, names: readonly string[] | undefined): string {
  if (!names?.length) return drawn.dataUrl
  let images = stepImages.get(drawn)
  if (!images) stepImages.set(drawn, images = new Map())
  const key = JSON.stringify(names)
  const kept = readRecent(images, key)
  if (kept !== undefined) return kept
  const base = svgFromDataUrl(drawn.dataUrl)
  const svg = base === null ? null : lightDiagramStep(base, names)
  return keepRecent(images, key, svg ? svgDataUrl(svg) : drawn.dataUrl, MAX_STEP_IMAGES)
}
