// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EFFORT_COLORS } from '../../../src/shared/settings'
import { rgbToOklch } from '../../../src/shared/themes/color'
import { DEFAULT_THEME_ID, T3_CODE_THEME, THEME_COLOR_ROLES } from '../../../src/shared/themes/library'
import { themeColorVariable } from '../../../src/renderer/src/state/appearance'
import {
  MODES,
  THEME_IDS,
  contrast,
  over,
  parseColorValue,
  parseTokenBlocks,
  relativeLuminance,
  resolveColor,
  rootDeclarations,
  type Mode,
  type PaintOptions,
  type Rgba,
} from '../../fixtures/renderer/themeTokenResolver'
import { PAINTED_TEXT_PAIRS, paintedContrast, withPaintedLayers } from '../../fixtures/renderer/paintedTextPairs'
import { visionDistance } from '../../fixtures/renderer/colourVision'

const tokensCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8')
const tokenBlocks = parseTokenBlocks(tokensCss)

const combinations = MODES.flatMap(mode => THEME_IDS.map(id => [mode, id] as const))
/** Usage's chart series: six hues, then Other's grey. */
const CHART_SERIES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'] as const

function palette(mode: Mode, themeId: string, options: PaintOptions = {}): (name: string) => Rgba {
  const declarations = rootDeclarations(mode, themeId, options, tokenBlocks)
  const canvas = resolveColor('--tt-canvas', declarations)
  // Every token is judged as painted on the room: translucent fills sit on the canvas.
  return (name: string) => over(resolveColor(`--tt-${name}`, declarations), canvas)
}

describe('main-window theme tokens', () => {
  it.each(combinations)('%s mode of %s keeps text readable on the surfaces it sits on', (mode, id) => {
    const color = palette(mode, id)
    for (const surface of ['canvas', 'surface', 'surface-elevated', 'hover-strong', 'selected', 'field', 'card', 'card-selected'] as const) {
      for (const ink of ['text', 'text-2'] as const) {
        expect(contrast(color(ink), color(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    // Muted text lifts T3's muted foreground slightly toward the text colour so
    // metadata on raised panels and the sidebar still reads at 4.5:1.
    for (const surface of ['canvas', 'surface', 'field', 'surface-elevated', 'sidebar', 'card', 'card-selected'] as const) {
      expect(contrast(color('text-muted'), color(surface)), `muted text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    // Faint text is still text: placeholders, ghost buttons and instrument labels read at 4.5:1 on the surfaces
    // they sit on. (The sidebar sets its own text roles.)
    for (const surface of ['canvas', 'surface', 'field', 'surface-elevated', 'card'] as const) {
      expect(contrast(color('text-faint'), color(surface)), `faint text on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color('sidebar-text'), color('sidebar'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('sidebar-text-muted'), color('sidebar'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('bubble-text'), color('bubble'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('terminal-foreground'), color('terminal-background')), 'terminal text').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('effort-text'), color('surface-elevated')), 'gold effort word').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combinations)('%s mode of %s keeps every text pair the window paints at 4.5:1', (mode, id) => {
    const declarations = withPaintedLayers(rootDeclarations(mode, id, {}, tokenBlocks))
    for (const pair of PAINTED_TEXT_PAIRS) {
      expect(paintedContrast(declarations, pair), `${pair.ink} on ${pair.surface.join(' + ')} (${pair.where})`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(combinations)('%s mode of %s keeps the tinted effort word readable in every colourway', (mode, id) => {
    for (const effortColor of EFFORT_COLORS) {
      const color = palette(mode, id, { effortColor })
      // The word on its card, on a chip in a field, and on the composer's card, where the reasoning text button sits
      // with no fill of its own (ADR-0113) and the colourway also paints it.
      expect(contrast(color('effort-text'), color('surface-elevated')), `${effortColor} word on the card`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('effort-text'), color('field')), `${effortColor} word on the chip`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('effort-text'), color('card')), `${effortColor} word on the composer`).toBeGreaterThanOrEqual(4.5)
      // The colourway's hues reach the fill and the outline through three tokens every colourway declares.
      for (const hue of ['effort-a', 'effort-b', 'effort-c', 'effort-border'] as const) expect(color(hue).a, `${effortColor} ${hue}`).toBeGreaterThan(0)
    }
  })

  it.each(combinations)('%s mode of %s keeps accent text, actions, focus, boundaries and status readable', (mode, id) => {
    const color = palette(mode, id)
    for (const surface of ['canvas', 'surface', 'card'] as const) {
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
    // A provider's Connected line on its card, the selected card included.
    expect(contrast(color('accent-text'), color('card-selected')), 'Connected on the selected card').toBeGreaterThanOrEqual(4.5)
    // A card is a step off the room: a fill the eye finds, never one that reads as a different room.
    expect(contrast(color('card'), color('canvas')), 'card against the room').toBeGreaterThan(1.05)
    expect(contrast(color('on-accent'), color('accent')), 'on-accent on accent').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('primary-contrast'), color('primary')), 'primary action').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('error-text'), color('error-surface'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('pill-ink'), color('pill'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('code-text'), color('code-bg'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('update-text'), color('update-surface'))).toBeGreaterThanOrEqual(4.5)
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      expect(contrast(color('provider-ink'), color(`provider-${provider}`)), `${provider} badge`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast(color('provider-ink'), color('provider-cursor-badge')), 'cursor badge').toBeGreaterThanOrEqual(4.5)
    expect(contrast(color('provider-ink'), color('provider-deepseek-badge')), 'deepseek badge').toBeGreaterThanOrEqual(4.5)
  })

  it.each(combinations)('%s mode of %s draws Cursor’s mark at 3:1 wherever it sits', (mode, id) => {
    const color = palette(mode, id)
    // Cursor's token is drawn straight in both modes, as OpenCode's is: the model menu's rail and chip, the sidebar and a host tile.
    for (const surface of ['canvas', 'surface', 'surface-elevated', 'sidebar', 'card', 'card-selected', 'selected'] as const) {
      expect(contrast(color('provider-cursor'), color(surface)), `Cursor's mark on ${surface}`).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(combinations)('%s mode of %s draws every chart series and Other at 3:1 on the room and the surface', (mode, id) => {
    const color = palette(mode, id)
    // Usage draws its charts on a card; the room and the surface are checked too, for a chart drawn on either.
    for (const series of [...CHART_SERIES, 'chart-other'] as const) {
      for (const surface of ['canvas', 'surface', 'card'] as const) {
        expect(contrast(color(series), color(surface)), `${series} on ${surface}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it.each(MODES)('%s mode keeps every two chart series apart, with full colour vision and with protanopia and deuteranopia', (mode) => {
    const color = palette(mode, DEFAULT_THEME_ID)
    const other = color('chart-other')
    for (const [index, first] of CHART_SERIES.entries()) {
      for (const second of CHART_SERIES.slice(index + 1)) {
        // Lines cross and models keep their colour wherever they are drawn, so every pair can meet, not only neighbours.
        expect(visionDistance(color(first), color(second), 'normal'), `${first} and ${second}`).toBeGreaterThanOrEqual(15)
        for (const vision of ['protan', 'deutan'] as const) expect(visionDistance(color(first), color(second), vision), `${first} and ${second}, ${vision}`).toBeGreaterThanOrEqual(8)
      }
      // Other is the one grey: told apart by having no hue, and still apart from each series for red-green readers.
      expect(visionDistance(color(first), other, 'normal'), `${first} and Other`).toBeGreaterThanOrEqual(12)
      for (const vision of ['protan', 'deutan'] as const) expect(visionDistance(color(first), other, vision), `${first} and Other, ${vision}`).toBeGreaterThanOrEqual(8)
    }
  })

  it.each(combinations)('%s mode of %s keeps the Sotto Owl header as readable on its night as on the sidebar', (mode, id) => {
    const color = palette(mode, id)
    // What sits on the header, and the surface under it on stable and under the night sky on Owl.
    const onHeader = [
      ['text-faint', 'sidebar', 'owl-night', 'Add project and New thread'],
      ['text-muted', 'sidebar', 'owl-night', 'Collapse sidebar'],
      ['text-faint', 'field', 'owl-night-field', 'the search placeholder'],
      ['text-muted', 'field', 'owl-night-field', 'the search icon'],
    ] as const
    for (const [ink, stable, owl, what] of onHeader) {
      const before = contrast(color(ink), color(stable))
      const after = contrast(color(ink), color(owl))
      expect(after, `${what} on the night`).toBeGreaterThanOrEqual(4.5)
      // Sotto's own dark search field gives up the most, about 5%, for the night Zach picked; nothing gives up more.
      expect(after / before, `${what}: ${before.toFixed(2)} on stable, ${after.toFixed(2)} on Owl`).toBeGreaterThanOrEqual(0.94)
    }
    // There is no night by day: the wash of the accent is never darker than the sidebar it replaces.
    if (mode === 'light') expect(contrast(color('owl-night'), color('sidebar')), 'the wash beside the sidebar').toBeLessThan(1.05)
    if (mode === 'light') expect(relativeLuminance(color('owl-night'))).toBeGreaterThanOrEqual(relativeLuminance(color('sidebar')))
    // Every star and the glow come from the theme.
    for (const token of ['owl-star', 'owl-star-accent', 'owl-glow']) expect(color(token).a, token).toBeGreaterThan(0)
  })

  it('keeps the Sotto Owl wash by day no darker than the sidebar on a theme of the user\'s own with a deep accent', () => {
    const colors = { ...T3_CODE_THEME.colors, sidebar: 'oklch(0.97 0.01 85)', accent: 'oklch(0.4 0.1 30)' }
    const declarations = rootDeclarations('light', 't3-code', { colors }, tokenBlocks)
    expect(relativeLuminance(resolveColor('--tt-owl-night', declarations))).toBeGreaterThanOrEqual(relativeLuminance(resolveColor('--tt-sidebar', declarations)))
  })

  it('evaluates relative colours as Chromium does, and refuses a channel expression it cannot read', () => {
    // Chromium 150 paints Sotto's dark night as oklch(0.224 0.028 265).
    const night = rgbToOklch(resolveColor('--tt-owl-night', rootDeclarations('dark', 't3-code', {}, tokenBlocks)))
    expect(night.L).toBeCloseTo(0.224, 2)
    expect(night.C).toBeCloseTo(0.028, 2)
    expect(() => parseColorValue('oklch(from oklch(0.5 0.1 200) calc(l - 5%) c h)', new Map())).toThrow(/Unsupported channel expression/u)
    expect(() => parseColorValue('oklch(from oklch(0.5 0.1 200) l c hue)', new Map())).toThrow(/Unknown channel keyword/u)
  })

  it('takes the Sotto Owl night from the theme\'s own hue, and lends Sotto\'s night blue to a theme with none', () => {
    const hue = (id: string): number => {
      const declarations = rootDeclarations('dark', id, {}, tokenBlocks)
      const { h, C } = rgbToOklch(resolveColor('--tt-owl-night', declarations))
      expect(C, `${id} night chroma`).toBeGreaterThan(0.02)
      return (h + 360) % 360
    }
    expect(hue('t3-code')).toBeCloseTo(265, -1)
    expect(hue('citrine')).toBeCloseTo(265, -1)
    expect(hue('graphite')).toBeCloseTo(265, -1)
    // Fern's night is green, Clay's the colour of fired earth.
    expect(hue('fern')).toBeCloseTo(160, -1)
    expect(hue('clay')).toBeCloseTo(40, -1)
  })

  it.each(MODES)('%s mode: the contrast slider strengthens and softens text and borders around 100', (mode) => {
    const at = (value: number) => palette(mode, 'graphite', { contrast: value })
    const [soft, standard, strong] = [at(50), at(100), at(200)]
    const measure = (color: (name: string) => Rgba, ink: string) => contrast(color(ink), color('canvas'))
    for (const ink of ['text', 'text-muted', 'border']) {
      expect(measure(soft, ink), `${ink} at 50`).toBeLessThan(measure(standard, ink))
      expect(measure(strong, ink), `${ink} at 200`).toBeGreaterThan(measure(standard, ink))
    }
    // The canvas itself never moves: contrast changes ink, not the room.
    expect(soft('canvas')).toEqual(standard('canvas'))
  })

  it('paints glass solid: the overlay surface, and the field under the composer (ADR-0084)', () => {
    for (const mode of MODES) {
      const declarations = rootDeclarations(mode, 'graphite', {}, tokenBlocks)
      expect(resolveColor('--tt-glass', declarations), `${mode} glass`).toEqual(resolveColor('--tt-surface-overlay', declarations))
      expect(resolveColor('--tt-glass-field', declarations), `${mode} glass field`).toEqual(resolveColor('--tt-field', declarations))
      for (const surface of ['--tt-glass', '--tt-glass-field']) {
        const painted = resolveColor(surface, declarations)
        expect(painted.a, `${mode} ${surface} is opaque`).toBe(1)
        expect(contrast(resolveColor('--tt-text', declarations), painted), `${mode} text on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    const dark = rootDeclarations('dark', 'graphite', {}, tokenBlocks)
    const light = rootDeclarations('light', 'graphite', {}, tokenBlocks)
    expect(dark.get('--tt-glass-filter')).toBe('blur(var(--tt-glass-blur)) saturate(var(--tt-glass-saturation))')
    expect([dark.get('--tt-glass-blur'), dark.get('--tt-glass-saturation')]).toEqual(['16px', '1.08'])
    expect([light.get('--tt-glass-blur'), light.get('--tt-glass-saturation')]).toEqual(['12px', '1.14'])
  })

  it('declares the default theme (Sotto) as the first-frame palette for both modes, with every role present', () => {
    const blocks = tokenBlocks
    const base = blocks.find(block => block.selectors.length === 1 && block.selectors[0] === ':root' && block.declarations.has('--theme-canvas'))!
    const light = blocks.find(block => block.selectors.includes(":root[data-theme='light']") && block.declarations.has('--theme-canvas'))!
    for (const role of THEME_COLOR_ROLES) {
      expect(base.declarations.get(themeColorVariable(role)), `dark ${role}`).toBe(rootDeclarations('dark', DEFAULT_THEME_ID, {}, tokenBlocks).get(themeColorVariable(role)))
      expect(light.declarations.get(themeColorVariable(role)), `light ${role}`).toBe(rootDeclarations('light', DEFAULT_THEME_ID, {}, tokenBlocks).get(themeColorVariable(role)))
    }
  })

  it('derives every colour token from theme roles, never from an accent attribute', () => {
    const css = tokensCss.replace(/\/\*[\s\S]*?\*\//gu, '')
    expect(css).not.toMatch(/data-accent/u)
    const derived = tokenBlocks.find(block => block.selectors.length === 1 && block.selectors[0] === ':root' && block.declarations.has('--tt-canvas'))!
    const constants = new Set(['--tt-success', '--tt-provider-codex', '--tt-provider-claude', '--tt-provider-grok', '--tt-provider-devin', '--tt-provider-opencode', '--tt-provider-cursor', '--tt-provider-muse', '--tt-provider-opencode-badge', '--tt-provider-cursor-badge', '--tt-provider-deepseek-badge', '--tt-provider-ink', ...CHART_SERIES.map(name => `--tt-${name}`), '--tt-chart-other', '--tt-backdrop', '--tt-shadow-sm', '--tt-shadow-lg', '--tt-shadow-overlay', '--tt-shadow-color'])
    for (const [name, value] of derived.declarations) {
      // A relative colour from a theme role (`oklch(from var(…) …)`) is derived, not a literal.
      if (constants.has(name) || !/^(#|rgb\(|oklch\((?!from (var|color-mix)\())/u.test(value)) continue
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
      'src/renderer/src/features/omarchy/omarchySetup.css',
      'src/renderer/src/features/onboarding/onboarding.css',
      'src/renderer/src/features/onboarding/threadsTour.css',
      'src/renderer/src/features/starting/startingScreen.css',
      'src/renderer/src/agents/threadsChrome.css',
      'src/renderer/src/agents/workingThreadsLine.css',
      'src/renderer/src/agents/restartStopped.css',
      'src/renderer/src/features/settings/hosts.css',
      'src/renderer/src/features/settings/hostDevices.css',
      'src/renderer/src/features/settings/gitSettings.css',
      'src/renderer/src/features/settings/notificationSettings.css',
      'src/renderer/src/features/settings/phones.css',
      'src/renderer/src/features/settings/cloudIphone.css',
      'src/renderer/src/features/settings/hostSetup.css',
      'src/renderer/src/features/settings/hostBoot.css',
      'src/renderer/src/features/settings/hostProviders.css',
      'src/renderer/src/features/settings/workerRoles.css',
      'src/renderer/src/features/settings/workerMachine.css',
      'src/renderer/src/features/settings/watcherCompaction.css',
      'src/renderer/src/features/settings/dictationShortcuts.css',
      'src/renderer/src/features/settings/threadShortcuts.css',
      'src/renderer/src/features/settings/menuBarOwl.css',
      'src/renderer/src/features/settings/languagePicker.css',
      'src/renderer/src/agents/hostBadge.css',
      'src/renderer/src/agents/activityBodies.css',
      'src/renderer/src/agents/requests/requests.css',
      'src/renderer/src/styles/global.css',
      'src/renderer/src/styles/crossing-settings.css',
      'src/renderer/src/styles/glass.css',
      'src/renderer/src/agents/agents.css',
      'src/renderer/src/agents/modelPicker.css',
      'src/renderer/src/agents/effortPicker.css',
      'src/renderer/src/agents/skillPill.css',
      'src/renderer/src/agents/threadMonitor.css',
      'src/renderer/src/agents/threadChips.css',
      'src/renderer/src/agents/nextPrompt.css',
      'src/renderer/src/agents/owlSky.css',
      'src/renderer/src/watcher/watcher.css',
      'src/renderer/src/watcher/watcherPicture.css',
      'src/renderer/src/watcher/nightScene.css',
      'src/renderer/src/agents/workingCopy.css',
      'src/renderer/src/agents/threadClear.css',
      'src/renderer/src/agents/branchToolbar.css',
      'src/renderer/src/agents/gitActionButton.css',
      'src/renderer/src/agents/bringChangesBack.css',
      'src/renderer/src/agents/newThread.css',
      'src/renderer/src/agents/folderBrowser.css',
      'src/renderer/src/agents/providerRecovery.css',
      'src/renderer/src/agents/providers.css',
      'src/renderer/src/agents/opencodeSources.css',
      'src/renderer/src/agents/ownServers.css',
      'src/renderer/src/agents/clientUpdates.css',
      'src/renderer/src/agents/hostUpdates.css',
      'src/renderer/src/features/updates/updateAll.css',
      'src/renderer/src/agents/screenshots.css',
      'src/renderer/src/agents/reviewComments.css',
      'src/renderer/src/agents/replyQuotes.css',
      'src/renderer/src/agents/runCommand.css',
      'src/renderer/src/agents/visualCard.css',
      'src/renderer/src/agents/delegation.css',
      'src/renderer/src/agents/messageScrubber.css',
      'src/renderer/src/agents/continueThread.css',
      'src/renderer/src/agents/threadStart.css',
      'src/renderer/src/agents/interactiveVisual.css',
      'src/renderer/src/agents/visualStepper.css',
      'src/renderer/src/components/listeningBars.css',
      'src/renderer/src/features/dictate/dictate.css',
      'src/renderer/src/features/usage/usage.css',
      'src/renderer/src/features/performance/mainActivity.css',
      'src/renderer/src/features/memory/memory.css',
      'src/renderer/src/tools/agentsSurface.css',
      'src/renderer/src/tools/browserPlayer.css',
      'src/renderer/src/tools/browserReview.css',
      'src/renderer/src/tools/changes.css',
      'src/renderer/src/tools/iphoneSurface.css',
      'src/renderer/src/tools/phonePlayer.css',
      'src/renderer/src/tools/pullRequestSurface.css',
      'src/renderer/src/tools/tools.css',
      'src/renderer/src/tools/toolsRail.css',
      'src/renderer/src/tools/paneTerminal.css',
    ]
    for (const path of owned) {
      const css = readFileSync(join(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/giu) ?? [], path).toEqual([])
      expect(css, `${path} must read tokens instead of branching on the theme`).not.toMatch(/data-theme|data-accent|prefers-color-scheme/u)
    }
  })

  it('draws no pill: every renderer stylesheet rounds its corners by a few pixels, and only dots are circles (ADR-0110)', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const sheets = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.css')).map(name => join(root, name))
    expect(sheets.length).toBeGreaterThan(60)
    // The floating widget keeps its capsule until Zach decides its shape; it is the one sheet this rule leaves alone.
    const undecided = new Set([join(root, 'widget', 'widget.css')])
    const capsules: string[] = []
    for (const path of sheets) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(css.match(/\b9{3,}px|--tt-radius-pill/gu) ?? [], relative(process.cwd(), path)).toEqual([])
      if (undecided.has(path)) continue
      // A corner of 50 pixels or more, or a corner at least half a rule's own height on anything but a square, rounds
      // the whole end: a pill. Thin bars may keep 2px corners, as the ADR allows.
      for (const [, selector = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const radius = /(?:^|[;\s])border-radius:\s*([^;]+)/u.exec(body)?.[1]
        if (!radius) continue
        const corners = [...radius.matchAll(/(\d+(?:\.\d+)?)px/gu)].map(match => Number(match[1]))
        if (!corners.length) continue
        const height = /(?:^|[;\s])height:\s*(\d+(?:\.\d+)?)px/u.exec(body)?.[1]
        const width = /(?:^|[;\s])width:\s*(\d+(?:\.\d+)?)px/u.exec(body)?.[1]
        const largest = Math.max(...corners)
        const capsule = height !== undefined && width !== height && largest * 2 >= Number(height) && largest > 2
        if (largest >= 50 || capsule) capsules.push(`${relative(process.cwd(), path)}: ${selector.trim()}`)
      }
    }
    expect(capsules).toEqual([])
  })
})
