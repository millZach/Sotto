/**
 * The captured Mermaid drawings the step tests read (tests/fixtures/mermaidSteps) are drawn with a copy of the app's
 * settings, because capture.mjs runs under plain Node and cannot load the renderer. This keeps the copy honest: every
 * setting that changes what Mermaid draws is the renderer's own, so the fixtures cannot drift from what the app draws.
 */
import { describe, expect, it, vi } from 'vitest'
import { CONFIG } from '../../fixtures/mermaidSteps/sources.mjs'
import { configFor } from '../../../src/renderer/src/agents/diagrams/diagramRenderer'
import { readDiagramPalette } from '../../../src/renderer/src/agents/diagrams/diagramPalette'

vi.mock('mermaid', () => ({ default: {} }))

describe('the captured drawings\' settings', () => {
  it('are the renderer\'s, but for the font, which a plain browser page does not have', () => {
    const app = configFor(readDiagramPalette()) as Record<string, unknown>
    const { fontFamily, ...layout } = CONFIG as Record<string, unknown>
    expect(fontFamily).toBe('sans-serif')
    for (const [key, value] of Object.entries(layout)) {
      if (typeof value === 'object' && value !== null) expect(app[key], key).toMatchObject(value)
      else expect(app[key], key).toBe(value)
    }
    // Every per-kind block the renderer sets is copied.
    for (const kind of ['flowchart', 'sequence', 'state', 'class', 'er']) expect(layout[kind], kind).toEqual(app[kind])
  })
})
