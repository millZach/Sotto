import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EFFORT_COLORS } from '../../../src/shared/settings'
import { DEFAULT_THEME_ID, THEME_COLOR_ROLES } from '../../../src/shared/themes/library'
import { themeColorVariable } from '../../../src/renderer/src/state/appearance'
import {
  MODES,
  THEME_IDS,
  contrast,
  over,
  parseTokenBlocks,
  resolveColor,
  rootDeclarations,
  type Mode,
  type PaintOptions,
  type Rgba,
} from './themeTokenResolver'

const combinations = MODES.flatMap(mode => THEME_IDS.map(id => [mode, id] as const))

function palette(mode: Mode, themeId: string, options: PaintOptions = {}): (name: string) => Rgba {
  const declarations = rootDeclarations(mode, themeId, options)
  const canvas = resolveColor('--tt-canvas', declarations)
  // Every token is judged as painted on the room: translucent fills sit on the canvas.
  return (name: string) => over(resolveColor(`--tt-${name}`, declarations), canvas)
}

describe('main-window theme tokens', () => {
  it.each(combinations)('%s mode of %s keeps text readable on the surfaces it sits on', (mode, id) => {
    const color = palette(mode, id)
    for (const surface of ['canvas', 'surface', 'surface-elevated', 'hover-strong', 'selected', 'field'] as const) {
      for (const ink of ['text', 'text-2'] as const) {
        expect(contrast(color(ink), color(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // Muted text lifts T3's muted foreground slightly toward the text colour so
    // metadata on raised panels and the sidebar still reads at 4.5:1.
    for (const surface of ['canvas', 'surface', 'field', 'surface-elevated', 'sidebar'] as const) {
      expect(contrast(color('text-muted'), color(surface)), `muted text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    // Faint text is still text: placeholders, ghost buttons and instrument labels read at 4.5:1 on the surfaces
    // they sit on. (The sidebar sets its own text roles.)
    for (const surface of ['canvas', 'surface', 'field', 'surface-elevated'] as const) {
      expect(contrast(color('text-faint'), color(surface)), `faint text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color('sidebar-text'), color('sidebar'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('sidebar-text-muted'), color('sidebar'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('bubble-text'), color('bubble'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('terminal-foreground'), color('terminal-background')), 'terminal text').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('effort-text'), color('surface-elevated')), 'gold effort word').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combinations)('%s mode of %s keeps the tinted effort word readable in every colourway', (mode, id) => {
    for (const effortColor of EFFORT_COLORS) {
      const color = palette(mode, id, { effortColor })
      // The word on its card and on the chip in the composer, where the colourway also paints it.
      expect(contrast(color('effort-text'), color('surface-elevated')), `${effortColor} word on the card`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('effort-text'), color('field')), `${effortColor} word on the chip`).toBeGreaterThanOrEqual(4.5)
      // The colourway's hues reach the fill and the outline through three tokens every colourway declares.
      for (const hue of ['effort-a', 'effort-b', 'effort-c', 'effort-border'] as const) expect(color(hue).a, `${effortColor} ${hue}`).toBeGreaterThan(0)
    }
  })

  it.each(combinations)('%s mode of %s keeps accent text, actions, focus, boundaries and status readable', (mode, id) => {
    const color = palette(mode, id)
    for (const surface of ['canvas', 'surface'] as const) {
      expect(contrast(color('accent-text'), color(surface)), `accent text on ${surface}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('link'), color(surface)), `link on ${surface}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('focus-ring'), color(surface)), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(color('activity'), color(surface)), `live activity on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(color('border'), color(surface)), `control boundary on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(color('attention'), color(surface)), `attention mark on ${surface}`).toBeGreaterThanOrEqual(3)
      for (const status of ['warning', 'error'] as const) {
        expect(contrast(color(status), color(surface)), `${status} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // The finished ring is drawn in the success colour on the sidebar as well
    // as in the transcript, so it has to read on both rooms.
    for (const surface of ['canvas', 'sidebar'] as const) {
      expect(contrast(color('success'), color(surface)), `finished mark on ${surface}`).toBeGreaterThanOrEqual(3)
    }
    for (const surface of ['field', 'selected'] as const) {
      expect(contrast(color('accent-text'), color(surface)), `question recommendation on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color('on-accent'), color('accent')), 'on-accent on accent').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('primary-contrast'), color('primary')), 'primary action').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('error-text'), color('error-surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('pill-ink'), color('pill'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('code-text'), color('code-bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('update-text'), color('update-surface'))).toBeGreaterThanOrEqual(4.5)
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      expect(contrast(color('provider-ink'), color(`provider-${provider}`)), `${provider} badge`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(MODES)('%s mode: the contrast slider strengthens and softens text and borders around 100', (mode) => {
    const at = (value: number) => palette(mode, 'nocturne', { contrast: value })
    const [soft, standard, strong] = [at(50), at(100), at(200)]
    const measure = (color: (name: string) => Rgba, ink: string) => contrast(color(ink), color('canvas'))
    for (const ink of ['text', 'text-muted', 'border']) {
      expect(measure(soft, ink), `${ink} at 50`).toBeLessThan(measure(standard, ink))
      expect(measure(strong, ink), `${ink} at 200`).toBeGreaterThan(measure(standard, ink))
    }
    // The canvas itself never moves: contrast changes ink, not the room.
    expect(soft('canvas')).toEqual(standard('canvas'))
  })

  it('paints glass as the overlay surface at the chosen opacity', () => {
    for (const glass of [40, 80, 100]) {
      const declarations = rootDeclarations('dark', 'nocturne', { glass })
      expect(resolveColor('--tt-glass', declarations).a).toBeCloseTo(glass / 100, 5)
    }
    // Text stays readable on the most transparent glass, painted over the room.
    for (const mode of MODES) {
      const declarations = rootDeclarations(mode, 'nocturne', { glass: 40 })
      const canvas = resolveColor('--tt-canvas', declarations)
      const text = over(resolveColor('--tt-text', declarations), canvas)
      for (const surface of ['--tt-glass', '--tt-glass-field']) {
        expect(contrast(text, over(resolveColor(surface, declarations), canvas)), `${mode} text on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    const dark = rootDeclarations('dark', 'nocturne')
    const light = rootDeclarations('light', 'nocturne')
    expect(dark.get('--tt-glass-filter')).toBe('blur(var(--tt-glass-blur)) saturate(var(--tt-glass-saturation))')
    expect([dark.get('--tt-glass-blur'), dark.get('--tt-glass-saturation')]).toEqual(['16px', '1.08'])
    expect([light.get('--tt-glass-blur'), light.get('--tt-glass-saturation')]).toEqual(['12px', '1.14'])
  })

  it('declares the default theme (Sotto) as the first-frame palette for both modes, with every role present', () => {
    const blocks = parseTokenBlocks()
    const base = blocks.find(block => block.selectors.length === 1 && block.selectors[0] === ':root' && block.declarations.has('--theme-canvas'))!
    const light = blocks.find(block => block.selectors.includes(":root[data-theme='light']") && block.declarations.has('--theme-canvas'))!
    for (const role of THEME_COLOR_ROLES) {
      expect(base.declarations.get(themeColorVariable(role)), `dark ${role}`).toBe(rootDeclarations('dark', DEFAULT_THEME_ID).get(themeColorVariable(role)))
      expect(light.declarations.get(themeColorVariable(role)), `light ${role}`).toBe(rootDeclarations('light', DEFAULT_THEME_ID).get(themeColorVariable(role)))
    }
  })

  it('derives every colour token from theme roles, never from an accent attribute', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(css).not.toMatch(/data-accent/u)
    const derived = parseTokenBlocks().find(block => block.selectors.length === 1 && block.selectors[0] === ':root' && block.declarations.has('--tt-canvas'))!
    const constants = new Set(['--tt-success', '--tt-provider-codex', '--tt-provider-claude', '--tt-provider-grok', '--tt-provider-devin', '--tt-provider-ink', '--tt-backdrop', '--tt-shadow-sm', '--tt-shadow-lg', '--tt-shadow-overlay', '--tt-shadow-color'])
    for (const [name, value] of derived.declarations) {
      if (constants.has(name) || !/^(#|rgb\(|oklch\()/u.test(value)) continue
      throw new Error(`${name} paints a literal colour (${value}) instead of a theme role`)
    }
  })

  it('declares the native control colour scheme for each mode', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/u)
    expect(css).toMatch(/:root\[data-theme='light'\] \{\s*color-scheme: light;/u)
  })

  it('keeps raw colours out of the main-window stylesheets', () => {
    const owned = [
      'src/renderer/src/features/settings/hosts.css',
      'src/renderer/src/features/settings/gitSettings.css',
      'src/renderer/src/agents/hostBadge.css',
      'src/renderer/src/agents/requests/requests.css',
      'src/renderer/src/styles/global.css',
      'src/renderer/src/styles/crossing-settings.css',
      'src/renderer/src/styles/glass.css',
      'src/renderer/src/agents/agents.css',
      'src/renderer/src/agents/modelPicker.css',
      'src/renderer/src/agents/effortPicker.css',
      'src/renderer/src/agents/threadMonitor.css',
      'src/renderer/src/agents/threadChips.css',
      'src/renderer/src/agents/workingCopy.css',
      'src/renderer/src/agents/branchToolbar.css',
      'src/renderer/src/agents/gitActionButton.css',
      'src/renderer/src/agents/newThread.css',
      'src/renderer/src/agents/providerRecovery.css',
      'src/renderer/src/agents/providers.css',
      'src/renderer/src/agents/clientUpdates.css',
      'src/renderer/src/agents/room.css',
      'src/renderer/src/agents/screenshots.css',
      'src/renderer/src/agents/reviewComments.css',
      'src/renderer/src/components/listeningBars.css',
      'src/renderer/src/features/history/history.css',
      'src/renderer/src/features/memory/memory.css',
      'src/renderer/src/tools/agentsSurface.css',
      'src/renderer/src/tools/browserPlayer.css',
      'src/renderer/src/tools/browserReview.css',
      'src/renderer/src/tools/changes.css',
      'src/renderer/src/tools/pullRequestSurface.css',
      'src/renderer/src/tools/tools.css',
      'src/renderer/src/tools/toolsRail.css',
    ]
    for (const path of owned) {
      const css = readFileSync(join(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/giu) ?? [], path).toEqual([])
      expect(css, `${path} must read tokens instead of branching on the theme`).not.toMatch(/data-theme|data-accent|prefers-color-scheme/u)
    }
  })
})
