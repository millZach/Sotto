import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A colourway may paint the level word as a gradient clipped to its glyphs (Rainbow, ADR-0019). Chromium drops
 * a transformed or positioned descendant out of that clip, so while the letters moved the word had no colour at
 * all: Rainbow went blank for the length of every arrival. The letters take the colour; the word is what moves.
 */
const GLOBAL = 'src/renderer/src/styles/global.css'
const SURFACES = ['src/renderer/src/agents/effortPicker.css', 'src/renderer/src/features/settings/themes/themes.css']
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const keyframes = (css: string, name: string): string => new RegExp(`@keyframes ${name} \\{(?:[^{}]|\\{[^{}]*\\})*\\}`, 'u').exec(css)?.[0] ?? ''

describe('the effort arrival', () => {
  it('colours the letters without moving them, and lifts the word instead', () => {
    const css = read(GLOBAL)
    const letters = keyframes(css, 'effort-letter')
    expect(letters).toMatch(/color: var\(--tt-effort-text-fill\)/u)
    expect(letters, 'a letter that moves takes the word out of its own gradient clip').not.toMatch(/transform|translate|position/u)
    expect(keyframes(css, 'effort-word')).toMatch(/translateY\(-1px\)/u)
  })

  it('keeps every surface that plays the arrival to the same rule', () => {
    for (const path of SURFACES) {
      const css = read(path)
      expect(css, `${path} must lift the word itself`).toMatch(/__word(\[data-top='true'\])? \{ animation: effort-word/u)
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const selector = rule[1] ?? '', body = rule[2] ?? ''
        if (!/__word > span/u.test(selector)) continue
        expect(body, `${selector.trim()} moves a letter`).not.toMatch(/transform|position/u)
      }
    }
  })
})
