// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chamberInk } from '../../../../../src/renderer/src/features/council/chamberInk'
import { inkAt, sceneInk } from '../../../../../src/renderer/src/watcher/nightScene'
import { MODES, THEME_IDS, contrast, over, parseTokenBlocks, resolveColor, rootDeclarations } from '../../../../fixtures/renderer/themeTokenResolver'

const blocks = parseTokenBlocks(readFileSync('src/renderer/src/styles/tokens.css', 'utf8'))

describe('the chamber’s contrast', () => {
  it.each(MODES.flatMap(mode => THEME_IDS.map(id => [mode, id] as const)))('%s %s keeps words at 4.5:1 and figures and focus at 3:1', (mode, id) => {
    const tokens = rootDeclarations(mode, id, {}, blocks)
    const surface = resolveColor('--tt-canvas', tokens)
    const text = resolveColor('--tt-text', tokens), accent = resolveColor('--tt-accent-text', tokens)
    const ink = chamberInk(surface, text, accent)
    for (const role of ['ink', 'accent'] as const) {
      for (const [kind, minimum] of [['figure', 3], ['words', 4.5]] as const) {
        // Check every stronger bucket too: these are the actual rounded rgba ramps the canvas uses.
        for (let step = Math.round(ink[kind][role] * 20); step <= 20; step++) {
          const [r, g, b, a] = inkAt(ink[role], step / 20).match(/[\d.]+/gu)!.map(Number) as [number, number, number, number]
          const painted = over({ r, g, b, a }, surface)
          expect(contrast(painted, surface), `${kind} ${role}, bucket ${step}`).toBeGreaterThanOrEqual(minimum)
        }
      }
    }
    expect(contrast(resolveColor('--tt-focus-ring', tokens), surface), 'focus ring on its solid canvas surround').toBeGreaterThanOrEqual(3)
    // The room's decorative ink keeps its faint steps; only the figures and words are lifted to their floors.
    expect(ink.ink).toEqual(sceneInk(surface, text, accent).ink)
    expect(ink.accent).toEqual(sceneInk(surface, text, accent).accent)
  })
})
