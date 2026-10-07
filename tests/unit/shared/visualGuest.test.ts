// @vitest-environment node
/**
 * What passes between Sotto and an interactive visual's sealed page (ADR-0056): the height Sotto gives it, the step and
 * theme messages the guest preload passes on, the CSS it writes, and the window's request for a page.
 */
import { describe, expect, it } from 'vitest'
import {
  clampVisualPageHeight, readVisualStep, readVisualTheme, VISUAL_PAGE_HEIGHT_MAX, VISUAL_PAGE_HEIGHT_MIN, VISUAL_THEME_TOKENS, visualThemeCss, type VisualTheme,
} from '../../../src/shared/visualGuest'
import { visualPageRequestSchema, visualPageResultSchema } from '../../../src/shared/visualPages'

const theme: VisualTheme = { mode: 'light', reducedMotion: true, tokens: Object.fromEntries(VISUAL_THEME_TOKENS.map(name => [name, '#336699'])) as VisualTheme['tokens'] }

describe('the height Sotto gives a page', () => {
  it.each([[0, 160], [159.2, 160], [160, 160], [300.4, 301], [640, 640], [641, 640], [1e9, 640], [-5, 160], [Number.NaN, 160], [Infinity, 160], ['900', 160], [undefined, 160]])(
    'is %s measured, %s given', (measured, given) => {
      expect(clampVisualPageHeight(measured)).toBe(given)
    })
  it('stays between 160 and 640 pixels', () => {
    expect([VISUAL_PAGE_HEIGHT_MIN, VISUAL_PAGE_HEIGHT_MAX]).toEqual([160, 640])
  })
})

describe('the messages a page is sent', () => {
  it('passes a step on as the page reads it', () => {
    expect(readVisualStep({ step: 2, total: 4, highlight: ['queue', 'A->B'] })).toEqual({ type: 'sotto-visual-step', step: 2, total: 4, highlight: ['queue', 'A->B'] })
    expect(readVisualStep({ step: 0, total: 0, highlight: [] })).toEqual({ type: 'sotto-visual-step', step: 0, total: 0, highlight: [] })
  })

  it.each([null, 'step', { step: 5, total: 4, highlight: [] }, { step: 1.5, total: 4, highlight: [] }, { step: 1, total: 13, highlight: [] },
    { step: 1, total: 2, highlight: 'queue' }, { step: 1, total: 2, highlight: [1] }, { step: 1, total: 2, highlight: Array.from({ length: 13 }, () => 'a') },
    { step: 1, total: 2, highlight: ['x'.repeat(121)] }])('drops a step shaped %j', value => {
    expect(readVisualStep(value)).toBeNull()
  })

  it('passes a theme on only when every colour is a hex colour', () => {
    expect(readVisualTheme(theme)).toEqual(theme)
    expect(readVisualTheme({ ...theme, mode: 'dim' })).toBeNull()
    expect(readVisualTheme({ ...theme, reducedMotion: 'yes' })).toBeNull()
    expect(readVisualTheme({ ...theme, tokens: { ...theme.tokens, '--sotto-text': 'red' } })).toBeNull()
    expect(readVisualTheme({ ...theme, tokens: { ...theme.tokens, '--sotto-text': '#fff}</style><script>' } })).toBeNull()
    const partial: Record<string, string> = { ...theme.tokens }
    delete partial['--sotto-accent']
    expect(readVisualTheme({ ...theme, tokens: partial })).toBeNull()
  })

  it('writes the theme as variables, a matching colour scheme and, with reduced motion, no movement', () => {
    const css = visualThemeCss(theme)
    for (const name of VISUAL_THEME_TOKENS) expect(css).toContain(`${name}:#336699`)
    expect(css).toContain('--sotto-font:"Figtree"')
    expect(css).toContain('color-scheme:light')
    expect(css).toContain('animation-duration:0s!important')
    expect(visualThemeCss({ ...theme, mode: 'dark', reducedMotion: false })).not.toContain('animation-duration')
  })
})

describe('the window\'s request for a page', () => {
  it('names a visual and a theme, and nothing else: never a page', () => {
    const request = { threadId: 'thread-1', visualId: 'v1', theme }
    expect(visualPageRequestSchema.parse(request)).toEqual(request)
    expect(visualPageRequestSchema.safeParse({ ...request, source: '<h1>Hi</h1>' }).success).toBe(false)
    expect(visualPageRequestSchema.safeParse({ ...request, theme: { ...theme, tokens: { ...theme.tokens, '--sotto-text': 'url(x)' } } }).success).toBe(false)
    expect(visualPageRequestSchema.safeParse({ ...request, theme: { ...theme, tokens: { ...theme.tokens, '--other': '#000000' } } }).success).toBe(false)
  })

  it('is answered with a page address or a reason', () => {
    expect(visualPageResultSchema.safeParse({ ok: true, url: 'sotto-visual://page/abc' }).success).toBe(true)
    expect(visualPageResultSchema.safeParse({ ok: true, url: 'https://example.com/' }).success).toBe(false)
    expect(visualPageResultSchema.safeParse({ ok: false, reason: 'Sotto no longer has this visual.' }).success).toBe(true)
  })
})
