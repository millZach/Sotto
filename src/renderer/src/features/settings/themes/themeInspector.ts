/*
 * "Where is this colour used?" for the theme editor: pick an element to find
 * the theme role that paints it, and spotlight every element a role paints.
 *
 * Follows T3 Code's apps/web/src/components/settings/themeInspector.ts at
 * commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3 (MIT, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md). T3 reads Tailwind utility class
 * names first; Sotto's stylesheets name semantic tokens instead, so every
 * lookup here uses the exact probe: a role's custom property is swapped for a
 * sentinel colour, computed paint is compared, and the original value is put
 * back before the browser can render a frame.
 */

import { THEME_COLOR_ROLES, type ThemeColorRole } from '../../../../../shared/themes/library'
import { THEME_TOKEN_PROBE_ATTRIBUTE, themeColorVariable } from '../../../state/appearance'

export type ThemePaintKind = 'background' | 'border' | 'foreground'
export type ThemePaintSnapshot = Readonly<Record<ThemePaintKind, string>>
export interface ThemeElementInspection { readonly element: Element; readonly role: ThemeColorRole }

const PAINT_KINDS: readonly ThemePaintKind[] = ['background', 'border', 'foreground']
const MATCH_ATTRIBUTE = 'data-theme-inspector-match'
const PROBE_COLOR = '#01fea7'
const ALTERNATE_PROBE_COLOR = '#fe01a7'
const SPOTLIGHT_ID = 'theme-inspector-spotlight'
const SPOTLIGHT_MASK_ID = 'theme-inspector-spotlight-mask'
const SPOTLIGHT_GLOW_ID = 'theme-inspector-spotlight-glow'
const HOVER_ID = 'theme-inspector-hover'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
/** The editor and the inspector's own overlays are never inspected. */
const EXCLUDED = `[data-theme-editor-panel], #${SPOTLIGHT_ID}, #${HOVER_ID}`

export function clearThemeInspectorHighlights(): void {
  document.querySelectorAll(`[${MATCH_ATTRIBUTE}]`).forEach(element => element.removeAttribute(MATCH_ATTRIBUTE))
  document.getElementById(SPOTLIGHT_ID)?.remove()
}

export function clearThemeInspectorHover(): void {
  document.getElementById(HOVER_ID)?.remove()
}

function svg<Name extends keyof SVGElementTagNameMap>(name: Name): SVGElementTagNameMap[Name] {
  return document.createElementNS(SVG_NAMESPACE, name)
}

interface SpotlightRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number }

function spotlightRect(element: Element): SpotlightRect | null {
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0 || bounds.right < 0 || bounds.bottom < 0 || bounds.left > window.innerWidth || bounds.top > window.innerHeight) return null
  const padding = 5
  // A partly offscreen element keeps its true bounds; clamping would draw a false edge along the crop.
  const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
  return { x: bounds.left - padding, y: bounds.top - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2, radius: Math.min(18, Math.max(7, radius + padding)) }
}

/** Outlines the element under the pointer with the name of the colour that paints it. */
export function showThemeInspectorHover(inspection: ThemeElementInspection, label: string): void {
  const rectangle = spotlightRect(inspection.element)
  if (!rectangle) {
    clearThemeInspectorHover()
    return
  }
  let hover = document.getElementById(HOVER_ID)
  if (!hover) {
    hover = document.createElement('div')
    hover.id = HOVER_ID
    hover.setAttribute('aria-hidden', 'true')
    const tag = document.createElement('span')
    tag.className = 'theme-inspector-hover__label'
    hover.append(tag)
    document.body.append(hover)
  }
  Object.assign(hover.style, { left: `${rectangle.x}px`, top: `${rectangle.y}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px`, borderRadius: `${rectangle.radius}px` })
  hover.dataset.placement = rectangle.y < 32 ? 'below' : 'above'
  const tag = hover.querySelector<HTMLElement>('.theme-inspector-hover__label')
  if (tag) tag.textContent = label
}

function renderSpotlight(elements: readonly Element[]): void {
  const rectangles = new Map<string, SpotlightRect>()
  for (const element of elements) {
    const rectangle = spotlightRect(element)
    if (rectangle) rectangles.set([rectangle.x, rectangle.y, rectangle.width, rectangle.height].map(Math.round).join(':'), rectangle)
  }
  if (rectangles.size === 0) {
    document.getElementById(SPOTLIGHT_ID)?.remove()
    return
  }
  let spotlight = document.getElementById(SPOTLIGHT_ID) as SVGSVGElement | null
  if (!spotlight) {
    spotlight = svg('svg')
    spotlight.id = SPOTLIGHT_ID
    spotlight.setAttribute('aria-hidden', 'true')
    spotlight.setAttribute('focusable', 'false')
    document.body.append(spotlight)
  }
  const { innerWidth: width, innerHeight: height } = window
  spotlight.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const definitions = svg('defs')
  const mask = svg('mask')
  mask.id = SPOTLIGHT_MASK_ID
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  const surface = svg('rect')
  surface.setAttribute('width', String(width))
  surface.setAttribute('height', String(height))
  surface.setAttribute('fill', 'white')
  mask.append(surface)
  const glowFilter = svg('filter')
  glowFilter.id = SPOTLIGHT_GLOW_ID
  for (const [name, value] of [['x', '-50%'], ['y', '-50%'], ['width', '200%'], ['height', '200%']] as const) glowFilter.setAttribute(name, value)
  const blur = svg('feGaussianBlur')
  blur.setAttribute('stdDeviation', '5')
  blur.setAttribute('result', 'blur')
  const merge = svg('feMerge')
  const blurred = svg('feMergeNode')
  blurred.setAttribute('in', 'blur')
  const crisp = svg('feMergeNode')
  crisp.setAttribute('in', 'SourceGraphic')
  merge.append(blurred, crisp)
  glowFilter.append(blur, merge)
  definitions.append(mask, glowFilter)

  const glows = svg('g')
  for (const rectangle of rectangles.values()) {
    const hole = svg('rect')
    hole.setAttribute('x', String(rectangle.x))
    hole.setAttribute('y', String(rectangle.y))
    hole.setAttribute('width', String(rectangle.width))
    hole.setAttribute('height', String(rectangle.height))
    hole.setAttribute('rx', String(rectangle.radius))
    hole.setAttribute('fill', 'black')
    mask.append(hole)
    const glow = hole.cloneNode(false) as SVGRectElement
    glow.removeAttribute('fill')
    glow.setAttribute('class', 'theme-inspector-spotlight__glow')
    glow.setAttribute('filter', `url(#${SPOTLIGHT_GLOW_ID})`)
    glows.append(glow)
  }
  const dimmer = svg('rect')
  dimmer.setAttribute('class', 'theme-inspector-spotlight__dimmer')
  dimmer.setAttribute('width', String(width))
  dimmer.setAttribute('height', String(height))
  dimmer.setAttribute('mask', `url(#${SPOTLIGHT_MASK_ID})`)
  spotlight.replaceChildren(definitions, dimmer, glows)
}

/** Redraws the spotlight around the current matches after a scroll or resize. */
export function refreshThemeInspectorSpotlight(): void {
  renderSpotlight([...document.querySelectorAll(`[${MATCH_ATTRIBUTE}]`)])
}

function hasVisibleText(element: Element): boolean {
  if (element.matches('input, textarea, select, option')) return true
  return Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
}

function paintSnapshot(element: Element, forHitTest = false): ThemePaintSnapshot | null {
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null
  const border: string[] = []
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    if (style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0) {
      border.push(style.getPropertyValue(`border-${side.toLowerCase()}-color`))
    }
  }
  if (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) border.push(style.outlineColor)
  if (style.boxShadow !== 'none') border.push(style.boxShadow)
  const foreground: string[] = []
  if (forHitTest || hasVisibleText(element)) foreground.push(style.color)
  if (element instanceof SVGElement) foreground.push(style.fill, style.stroke)
  if (element.matches('input, textarea')) foreground.push(style.caretColor)
  if (style.textDecorationLine !== 'none') foreground.push(style.textDecorationColor)
  return { background: [style.backgroundColor, style.backgroundImage].join('\n'), border: border.join('\n'), foreground: foreground.join('\n') }
}

export function changedPaintKinds(before: ThemePaintSnapshot, after: ThemePaintSnapshot): readonly ThemePaintKind[] {
  return PAINT_KINDS.filter(kind => before[kind] !== after[kind])
}

/**
 * The role credited with a paint that several roles move. Sotto's contrast
 * setting mixes every ink with the background, so the background also moves
 * text; the ink's own role is the answer whenever there is one.
 */
export function creditedRole(roles: readonly ThemeColorRole[]): ThemeColorRole | null {
  return roles.find(role => role !== 'canvas') ?? roles[0] ?? null
}

/** Runs probes with transitions off, so a sentinel colour never starts an animation. */
function withProbeSession<Result>(run: () => Result): Result {
  const root = document.documentElement
  const nested = root.hasAttribute(THEME_TOKEN_PROBE_ATTRIBUTE)
  if (!nested) root.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, '')
  try {
    return run()
  } finally {
    // Flush the restored values while transitions are still off; no frame paints in between.
    void getComputedStyle(root).color
    if (!nested) root.removeAttribute(THEME_TOKEN_PROBE_ATTRIBUTE)
  }
}

function applyProbe(role: ThemeColorRole): () => void {
  const style = document.documentElement.style
  const variable = themeColorVariable(role)
  const original = style.getPropertyValue(variable)
  const priority = style.getPropertyPriority(variable)
  style.setProperty(variable, original.trim().toLowerCase() === PROBE_COLOR ? ALTERNATE_PROBE_COLOR : PROBE_COLOR, 'important')
  return () => {
    if (original) style.setProperty(variable, original, priority)
    else style.removeProperty(variable)
  }
}

function applyProbes(roles: readonly ThemeColorRole[]): () => void {
  const restores = roles.map(applyProbe)
  return () => {
    for (const restore of restores.toReversed()) restore()
  }
}

/** Marks and spotlights every element whose paint depends on one of `roles`; returns how many. */
export function highlightThemeRoleUsage(roles: readonly ThemeColorRole[]): number {
  clearThemeInspectorHighlights()
  const candidates = [document.body, ...document.body.querySelectorAll('*')].filter(element => !element.closest(EXCLUDED))
  const matches = withProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>()
    for (const element of candidates) {
      const snapshot = paintSnapshot(element)
      if (snapshot) baseline.set(element, snapshot)
    }
    const restore = applyProbes(roles)
    const changed = new Set<Element>()
    try {
      for (const [element, before] of baseline) {
        const after = paintSnapshot(element)
        if (after && changedPaintKinds(before, after).length > 0) changed.add(element)
      }
    } finally {
      restore()
    }
    return changed
  })
  const highlighted = new Set<Element>()
  for (const element of matches) highlighted.add(element instanceof SVGElement ? element.closest('svg') ?? element : element)
  for (const element of highlighted) element.setAttribute(MATCH_ATTRIBUTE, '')
  renderSpotlight([...highlighted])
  return highlighted.size
}

/** The nearest element at or above `target` painted by a theme role, and that role. */
export function inspectThemeRoleAtElement(target: Element): ThemeElementInspection | null {
  if (target.closest(EXCLUDED)) return null
  const candidates: Element[] = []
  for (let element: Element | null = target; element && element !== document.documentElement; element = element.parentElement) candidates.push(element)

  const rolesByElement = withProbeSession(() => {
    const baseline = new Map<Element, ThemePaintSnapshot>()
    for (const candidate of candidates) {
      const snapshot = paintSnapshot(candidate, true)
      if (snapshot) baseline.set(candidate, snapshot)
    }
    const found = new Map<Element, Partial<Record<ThemePaintKind, ThemeColorRole[]>>>()
    for (const role of THEME_COLOR_ROLES) {
      const restore = applyProbe(role)
      try {
        for (const [candidate, before] of baseline) {
          const after = paintSnapshot(candidate, true)
          if (!after) continue
          const kinds = found.get(candidate) ?? {}
          for (const kind of changedPaintKinds(before, after)) (kinds[kind] ??= []).push(role)
          found.set(candidate, kinds)
        }
      } finally {
        restore()
      }
    }
    return found
  })

  for (const candidate of candidates) {
    const kinds = rolesByElement.get(candidate)
    if (!kinds) continue
    for (const kind of PAINT_KINDS) {
      const role = creditedRole(kinds[kind] ?? [])
      if (role) return { element: candidate, role }
    }
  }
  return null
}
