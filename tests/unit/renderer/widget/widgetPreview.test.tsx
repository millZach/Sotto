import { describe, expect, it } from 'vitest'

import { isVisualPreviewEnabled, parseVisualPreview } from '../../../../src/renderer/src/widget/WidgetApp'
import { setupWidgetTests } from '../../../fixtures/renderer/widgetHarness'

setupWidgetTests()

describe('visual preview parser', () => {
  it.each([
    ['listening', 'listening'],
    ['processing', 'processing'],
    ['pasted', 'success'],
    ['copied', 'success'],
    ['error', 'error'],
  ] as const)('creates deterministic %s state only behind the injected gate', (preview, status) => {
    const query = new URLSearchParams(`preview=${preview}&theme=dark`)
    expect(parseVisualPreview(query, false)).toBeNull()
    const first = parseVisualPreview(query, true)
    const second = parseVisualPreview(query, true)
    expect(first).toEqual(second)
    expect(first).toEqual(expect.objectContaining({ status, theme: 'dark', reducedMotion: 'on' }))
    if (first?.status === 'listening') expect(first.speaking).toBe(true)
    if (first?.status === 'processing') expect(first.progress).toBe(0.58)
  })

  it('rejects unknown states, themes, duplicate parameters, and unrelated query data', () => {
    expect(parseVisualPreview(new URLSearchParams('preview=listening&theme=system'), true)).toBeNull()
    expect(parseVisualPreview(new URLSearchParams('preview=paused&theme=dark'), true)).toBeNull()
    expect(parseVisualPreview(new URLSearchParams('preview=listening&preview=error&theme=dark'), true)).toBeNull()
    expect(parseVisualPreview(new URLSearchParams('preview=listening&theme=dark&text=private'), true)).toBeNull()
  })

  it('requires both the exact environment gate and a truly immutable injected descriptor', () => {
    const immutable = {} as Window
    Object.defineProperty(immutable, '__SOTTO_VISUAL_PREVIEW__', {
      value: true, writable: false, configurable: false,
    })
    expect(isVisualPreviewEnabled(immutable, '1')).toBe(true)
    for (const disabled of [undefined, '', '0', 'true', '01', ' 1', '1 ']) {
      expect(isVisualPreviewEnabled(immutable, disabled)).toBe(false)
    }

    const writable = {} as Window
    Object.defineProperty(writable, '__SOTTO_VISUAL_PREVIEW__', {
      value: true, writable: true, configurable: false,
    })
    expect(isVisualPreviewEnabled(writable, '1')).toBe(false)

    const configurable = {} as Window
    Object.defineProperty(configurable, '__SOTTO_VISUAL_PREVIEW__', {
      value: true, writable: false, configurable: true,
    })
    expect(isVisualPreviewEnabled(configurable, '1')).toBe(false)
    expect(isVisualPreviewEnabled({} as Window, '1')).toBe(false)
  })
})
