// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { TYPE_STEPS } from '../../../src/renderer/src/styles/typeSteps'
import { scaleSteps } from '../../fixtures/renderer/scaleSteps'

const root = join(process.cwd(), 'src/renderer/src')
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
const scaleOf = (path: string): ReadonlyMap<string, string> => scaleSteps(read(path))

const scale = scaleOf('styles/tokens.css')
const TYPE_NAMES = ['micro', 'caption', 'small', 'body', 'reading', 'lead', 'heading', 'figure', 'title'] as const
const RADIUS_NAMES = ['mark', 'tag', 'control', 'row', 'inset', 'card', 'overlay'] as const

/**
 * What may be written other than a step, and why. Each entry is one declaration in one stylesheet, as written; one no
 * stylesheet writes any more fails the test too, so the list only shrinks with the code.
 */
const EXCEPTIONS: readonly { readonly sheet: string; readonly declaration: string; readonly reason: string }[] = [
  { sheet: 'features/usage/usage.css', declaration: 'font-size: clamp(23px, 1.2cqi + 15px, 31px)', reason: 'Usage\'s index figures grow with the room between two sizes (ADR-0110, decision 4).' },
  { sheet: 'features/usage/usage.css', declaration: 'font-size: clamp(17px, .6cqi + 12px, 20px)', reason: 'An index figure written in words grows with the room the same way, from a smaller start.' },
  { sheet: 'features/usage/usage.css', declaration: 'border-radius: var(--usage-radius) var(--usage-radius) 0 0', reason: 'The chart works a bar\'s top corners out from the bar\'s width (UsageCharts.tsx), so a thin bar is never rounder than it is wide.' },
  { sheet: 'agents/skillPill.css', declaration: 'border-radius: .42em', reason: 'A skill sits in the composer\'s line of text and rounds with the text around it.' },
  { sheet: 'agents/quietComposer.css', declaration: 'border-radius: 24px', reason: 'Drake\'s composer is one pill (ADR-0161): on one line it is 46px tall (6 + 32 + 6 inside its 1px transparent border), so 24px rounds its ends whole; the overlay step would leave a flat stretch at each end.' },
  { sheet: 'agents/effortTrace.css', declaration: 'border-radius: 47px', reason: 'The effort trace\'s halo rounds concentrically with the composer\'s corner, out past it by the halo\'s reach (ADR-0019).' },
  { sheet: 'agents/effortTrace.css', declaration: 'border-radius: 25px', reason: 'The halo\'s glow, concentric with the halo inside it.' },
  // The floating widget keeps its look: its shape is Zach's to decide (ADR-0110), and these have no step at their size.
  { sheet: 'widget/widget.css', declaration: 'border-radius: 3px', reason: 'The resting sliver is 6px thick and its ends are round; the mark step would square them.' },
  { sheet: 'widget/widget.css', declaration: 'border-radius: 12px', reason: 'The upright sliver\'s open prompt; the inset step would round it 2px less.' },
  { sheet: 'widget/widget.css', declaration: 'font-size: 9px', reason: 'The capsule\'s Esc key; the micro step would grow it 2px inside the capsule\'s fixed width.' },
  { sheet: 'widget/widget.css', declaration: 'font-size: 10px', reason: 'The upright sliver\'s prompt, wrapped inside 76px; the micro step would grow it 1px.' },
  { sheet: 'widget/widget.css', declaration: 'font-size: 10.5px', reason: 'The capsule\'s timer, inside the capsule\'s fixed width.' },
  { sheet: 'widget/widget.css', declaration: 'font-size: 11.5px', reason: 'The capsule\'s status line, which the capsule\'s fixed width is measured to hold.' },
]

const SIZE_PROPERTY = /(?:^|[{;\s])(font-size|font|border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius)\s*:\s*([^;{}]+)/gu
const KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert'])

/** What in a declaration's value is not a step: an empty list when it is drawn from the scale. */
function offScale(property: string, value: string): string[] {
  if (KEYWORDS.has(value)) return []
  const isStep = (part: string): boolean => /^var\(--tt-type-[a-z]+\)$/u.test(part) && scale.has(part.slice(4, -1))
  if (property === 'font') {
    // The shorthand's size is its one length before the line height's slash: a step, with no other length beside it.
    const sizes = value.replace(/\/\s*\S+/u, '').split(/\s+/u).filter(part => /^(?:\d*\.?\d+[a-z%]+|var\(--tt-type-[a-z]+\))$/u.test(part))
    return sizes.length === 1 && isStep(sizes[0]!) ? [] : [value]
  }
  if (property === 'font-size') return isStep(value) ? [] : [value]
  // A corner: every length is 0, a circle's 50%, or a step, corner by corner.
  return value.split(/\s+|\//u).filter(Boolean).filter(part => {
    if (part === '0' || part === '50%') return false
    const step = /^var\((--tt-radius-[a-z]+)\)$/u.exec(part)?.[1]
    return step === undefined || !scale.has(step)
  })
}

describe('the type and corner scale (ADR-0169)', () => {
  it('declares the nine type steps and seven corners Zach picked, smallest first, and a full corner', () => {
    const px = (name: string): number => Number(/^(\d+)px$/u.exec(scale.get(name) ?? '')?.[1])
    const sizes = TYPE_NAMES.map(name => px(`--tt-type-${name}`))
    const corners = RADIUS_NAMES.map(name => px(`--tt-radius-${name}`))
    for (const steps of [sizes, corners]) {
      expect(steps.every(Number.isFinite), steps.join(', ')).toBe(true)
      expect(steps).toEqual([...steps].sort((a, b) => a - b))
      expect(new Set(steps).size).toBe(steps.length)
    }
    expect(scale.get('--tt-radius-full')).toBe('50%')
    // The names before the scale round the same as the steps they became.
    expect([scale.get('--tt-radius-sm'), scale.get('--tt-radius-md'), scale.get('--tt-radius-lg')]).toEqual(['var(--tt-radius-control)', 'var(--tt-radius-inset)', 'var(--tt-radius-card)'])
  })

  it('gives the widget the same scale, and what draws text outside the stylesheets the same steps', () => {
    expect(new Map(scaleOf('widget/widget-tokens.css'))).toEqual(new Map(scale))
    expect(Object.fromEntries(TYPE_NAMES.map(name => [name, scale.get(`--tt-type-${name}`)]))).toEqual(Object.fromEntries(Object.entries(TYPE_STEPS).map(([name, size]) => [name, `${size}px`])))
  })

  it('sizes every text and rounds every corner in every renderer stylesheet from a step', () => {
    const sheets = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.css')).map(name => name.replaceAll('\\', '/'))
    expect(sheets.length).toBeGreaterThan(60)
    const used = new Set<string>()
    const literals: Record<string, string[]> = {}
    for (const sheet of sheets) {
      for (const [, property = '', written = ''] of read(sheet).matchAll(SIZE_PROPERTY)) {
        const value = written.replace(/\s*!important\s*$/u, '').trim()
        const declaration = `${property}: ${value}`
        const exception = EXCEPTIONS.find(entry => entry.sheet === sheet && entry.declaration === declaration)
        if (exception !== undefined) { used.add(`${sheet}|${declaration}`); continue }
        const found = offScale(property, value)
        if (found.length > 0) (literals[relative(process.cwd(), join(root, sheet)).replaceAll('\\', '/')] ??= []).push(declaration)
      }
    }
    // A stylesheet writes `var(--tt-type-…)` for a size and `var(--tt-radius-…)` for a corner, or names its reason above.
    expect(literals).toEqual({})
    expect(EXCEPTIONS.filter(entry => !used.has(`${entry.sheet}|${entry.declaration}`)).map(entry => `${entry.sheet}: ${entry.declaration}`), 'exceptions no stylesheet writes any more').toEqual([])
  })

  it('holds a stylesheet that writes a size or corner off the scale', () => {
    expect(offScale('font-size', '12.5px')).toEqual(['12.5px'])
    expect(offScale('font-size', 'var(--tt-type-smaller)')).toEqual(['var(--tt-type-smaller)'])
    expect(offScale('font', '600 13px/1.4 var(--tt-font-ui)')).toEqual(['600 13px/1.4 var(--tt-font-ui)'])
    // A step in the line height's place does not make the size one.
    expect(offScale('font', '600 12.5px/var(--tt-type-heading) var(--tt-font-ui)')).toEqual(['600 12.5px/var(--tt-type-heading) var(--tt-font-ui)'])
    expect(offScale('border-radius', 'var(--tt-radius-card) 7px 0 0')).toEqual(['7px'])
    expect(offScale('font', '600 var(--tt-type-caption)/1.4 var(--tt-font-ui)')).toEqual([])
    expect(offScale('border-radius', '0 var(--tt-radius-sm) var(--tt-radius-sm) 0')).toEqual([])
  })
})
