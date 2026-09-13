import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ACCENTS,
  MODES,
  contrast,
  over,
  parseTokenBlocks,
  resolveColor,
  rootDeclarations,
  type Mode,
  type Rgba,
} from './themeTokenResolver'
import type { Accent } from '../../../src/shared/settings'

const combinations = MODES.flatMap(mode => ACCENTS.map(accent => [mode, accent] as const))

function palette(mode: Mode, accent: Accent): (name: string) => Rgba {
  const declarations = rootDeclarations(mode, accent)
  const canvas = resolveColor('--tt-canvas', declarations)
  // Every token is judged as painted on the room: translucent fills sit on the canvas.
  return (name: string) => over(resolveColor(`--tt-${name}`, declarations), canvas)
}

const READING_SURFACES = ['canvas', 'surface', 'surface-elevated', 'surface-sunken', 'panel', 'field', 'sidebar', 'bubble', 'hover-strong', 'selected'] as const

describe('main-window theme tokens', () => {
  it.each(combinations)('%s mode with the %s accent keeps every text tier readable on every reading surface', (mode, accent) => {
    const color = palette(mode, accent)
    for (const surface of READING_SURFACES) {
      for (const ink of ['text', 'text-2', 'text-muted', 'text-faint'] as const) {
        expect(contrast(color(ink), color(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each(combinations)('%s mode with the %s accent keeps accent text, fills and focus distinguishable', (mode, accent) => {
    const color = palette(mode, accent)
    for (const surface of ['canvas', 'surface', 'surface-elevated', 'panel', 'field', 'sidebar', 'selected'] as const) {
      expect(contrast(color('accent-text'), color(surface)), `accent text on ${surface}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('link'), color(surface)), `link on ${surface}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('focus-ring'), color(surface)), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3)
      expect(contrast(color('activity'), color(surface)), `accent graphic on ${surface}`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(color('on-accent'), color('accent')), 'on-accent on accent').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('primary-contrast'), color('primary')), 'primary contrast').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('on-accent'), color('accent-hover')), 'on-accent on hovered accent').toBeGreaterThanOrEqual(4.5)
  })

  it.each(MODES)('%s mode keeps controls, status text, the pill, code and provider badges readable', (mode) => {
    const color = palette(mode, 'teal')
    for (const surface of ['canvas', 'surface', 'panel', 'field'] as const) {
      expect(contrast(color('border'), color(surface)), `control boundary on ${surface}`).toBeGreaterThanOrEqual(3)
      for (const status of ['success', 'warning', 'error', 'error-text'] as const) {
        expect(contrast(color(status), color(surface)), `${status} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(contrast(color('error-text'), color('error-surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('error-contrast'), color('error'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('pill-ink'), color('pill'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('pill'), color('canvas')), 'pill against the room').toBeGreaterThanOrEqual(3)
    expect(contrast(color('code-text'), color('code-bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('attention'), color('canvas')), 'attention dot').toBeGreaterThanOrEqual(3)
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      expect(contrast(color('provider-ink'), color(`provider-${provider}`)), `${provider} badge`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(combinations)('%s mode paints the %s swatch exactly as that accent and distinguishable from the room', (mode, accent) => {
    const chosen = palette(mode, accent)
    for (const swatch of ACCENTS) {
      expect(contrast(chosen(`swatch-${swatch}`), chosen('canvas')), `${swatch} swatch`).toBeGreaterThanOrEqual(3)
      expect(contrast(chosen('on-accent'), chosen(`swatch-${swatch}`)), `check mark on ${swatch}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(chosen(`swatch-${accent}`)).toEqual(chosen('accent'))
  })

  it('keeps the dark teal room byte-for-byte the Crossing palette existing installs already see', () => {
    const dark = rootDeclarations('dark', 'teal')
    expect(Object.fromEntries(['--tt-canvas', '--tt-surface', '--tt-surface-elevated', '--tt-text', '--tt-text-2', '--tt-text-muted', '--tt-border', '--tt-border-faint', '--tt-hairline', '--tt-pill', '--tt-pill-ink', '--tt-focus-ring', '--tt-success', '--tt-warning', '--tt-error'].map(name => [name, dark.get(name)]))).toEqual({
      '--tt-canvas': '#000000', '--tt-surface': '#0c0e0d', '--tt-surface-elevated': '#121514', '--tt-text': '#f3f4f3',
      '--tt-text-2': '#c3c9c6', '--tt-text-muted': '#858c88', '--tt-border': '#6b7370', '--tt-border-faint': '#2a2e2c',
      '--tt-hairline': '#1a1d1b', '--tt-pill': '#f3f4f3', '--tt-pill-ink': '#000000', '--tt-focus-ring': '#9fe3d9',
      '--tt-success': '#7fd6ca', '--tt-warning': '#f0b45c', '--tt-error': '#f0a89c',
    })
    expect(resolveColor('--tt-activity', dark)).toEqual({ r: 0x47, g: 0xb8, b: 0xa9, a: 1 })
    expect(dark.get('--tt-font-ui')).toMatch(/^'Bricolage Grotesque'/u)
  })

  it('overrides the same accent properties in every accent block and every colour token in the light block', () => {
    const blocks = parseTokenBlocks()
    const base = blocks.find(block => block.selectors.includes(':root'))!
    const light = blocks.find(block => block.selectors.includes(":root[data-theme='light']"))!
    const accentNames = ['--tt-accent', '--tt-accent-hover', '--tt-accent-text', '--tt-on-accent', '--tt-focus-ring']
    for (const accent of ACCENTS.filter(candidate => candidate !== 'teal')) {
      for (const selector of [`:root[data-accent='${accent}']`, `:root[data-theme='light'][data-accent='${accent}']`]) {
        const block = blocks.find(candidate => candidate.selectors.includes(selector))
        expect(block, selector).toBeDefined()
        expect([...block!.declarations.keys()].sort(), selector).toEqual([...accentNames].sort())
      }
    }
    // A light room must never inherit a dark literal: every literal colour the
    // base declares is either redeclared for light or derived from other tokens.
    for (const [name, value] of base.declarations) {
      const literal = /^(#|rgb\()/u.test(value) || /^(0 |-?\d+px )/u.test(value) || value === 'none'
      if (literal) expect(light.declarations.has(name), `${name} has a light value`).toBe(true)
    }
  })

  it('declares the native control colour scheme for each mode', () => {
    const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(css).toMatch(/:root \{\s*color-scheme: dark;/u)
    expect(css).toMatch(/:root\[data-theme='light'\] \{\s*color-scheme: light;/u)
  })

  it('keeps raw colours out of the main-window stylesheets this slice owns', () => {
    const owned = [
      'src/renderer/src/styles/global.css',
      'src/renderer/src/styles/crossing-settings.css',
      'src/renderer/src/agents/agents.css',
      'src/renderer/src/agents/modelPicker.css',
      'src/renderer/src/agents/newThread.css',
      'src/renderer/src/agents/providerRecovery.css',
      'src/renderer/src/agents/providers.css',
      'src/renderer/src/agents/room.css',
      'src/renderer/src/agents/screenshots.css',
      'src/renderer/src/components/listeningBars.css',
      'src/renderer/src/features/history/history.css',
      'src/renderer/src/features/memory/memory.css',
    ]
    for (const path of owned) {
      const css = readFileSync(join(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/giu) ?? [], path).toEqual([])
      expect(css, `${path} must read tokens instead of branching on the theme`).not.toMatch(/data-theme|prefers-color-scheme/u)
    }
  })
})
