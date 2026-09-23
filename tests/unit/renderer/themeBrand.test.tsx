import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentAppearance } from '../../../src/renderer/src/agents/AgentRoom'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentOrb } from '../../../src/renderer/src/agents/orb/AgentOrb'
import { ORB_INK_FILTER, colorBeneathInkFilter, createOrb, inkableColor, orbColorsBeneath, type OrbHandle } from '../../../src/renderer/src/agents/orb/orb'
import { SottoMark } from '../../../src/renderer/src/components/SottoMark'
import { applyAppearance, type AppearanceChoice } from '../../../src/renderer/src/state/appearance'
import { defaultAgentConfiguration } from '../../../src/shared/agents'
import { APP_ICON_BRAND, themeBrand } from '../../../src/shared/themeBranding'
import { parseThemeRgb, rgbToOklch } from '../../../src/shared/themes/color'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, getThemeColorsForMode, parseThemeFile, type ThemeDefinition } from '../../../src/shared/themes/library'
import type { ThemeAppearance } from '../../../src/shared/themes/palettes'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/orb/orb', async (original) => ({
  ...await original<typeof import('../../../src/renderer/src/agents/orb/orb')>(),
  createOrb: vi.fn(),
}))

const choice = (patch: Partial<AppearanceChoice> = {}): AppearanceChoice => ({
  appearance: 'dark', lightTheme: 'nocturne', darkTheme: 'nocturne', appearanceContrast: 100, glassOpacity: 80, effortColor: 'ember', customThemes: [], ...patch,
})

function builtIn(id: string, mode: ThemeAppearance) {
  return getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === id)!, mode)!
}

function custom(): ThemeDefinition {
  return parseThemeFile({ version: 1, id: 'saffron', name: 'Saffron', appearance: 'light', colors: createVividThemeColors('light', '#fbf7ee', '#c0392b') })
}

const oklch = (hex: string) => rgbToOklch(parseThemeRgb(hex, { r: 0, g: 0, b: 0 }))
const hueDistance = (a: number, b: number): number => {
  const distance = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(distance, 360 - distance)
}

function handle(): OrbHandle & { setColors: ReturnType<typeof vi.fn>; setState: ReturnType<typeof vi.fn>; setStill: ReturnType<typeof vi.fn> } {
  return {
    setState: vi.fn(), setColors: vi.fn(), setStill: vi.fn(), pause: vi.fn(), resume: vi.fn(), redraw: vi.fn(), dispose: vi.fn(),
    colors: () => ['#000000', '#000000'], settings: () => ({}) as never,
  }
}

function paint(next: AppearanceChoice, draft: Parameters<typeof applyAppearance>[3] = null): void {
  act(() => { applyAppearance(next, document.documentElement, true, draft) })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})

afterEach(() => {
  cleanup()
  const root = document.documentElement
  root.removeAttribute('style')
  delete root.dataset.theme
  delete root.dataset.themeId
  delete root.dataset.brand
  vi.mocked(createOrb).mockReset()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('SottoMark in the main window', () => {
  it('wears the painted theme and follows selection, mode, custom themes and editor drafts live', async () => {
    paint(choice())
    const { container } = render(<SottoMark />)
    const svg = container.querySelector('svg')!
    const expectBrand = async (colors: Parameters<typeof themeBrand>[0], mode: ThemeAppearance) => {
      const brand = themeBrand(colors, mode)
      await waitFor(() => expect(svg).toHaveAttribute('data-tile', brand.tile))
      expect([...svg.querySelectorAll('stop')].map(stop => stop.getAttribute('stop-color'))).toEqual([brand.tile, brand.tile])
      expect(svg.querySelector('rect[x="26"]')).toHaveAttribute('fill', brand.glyph)
      expect(svg.querySelector('path')).toHaveAttribute('stroke', brand.glyph)
    }
    await expectBrand(builtIn('nocturne', 'dark'), 'dark')

    paint(choice({ darkTheme: 'tropic' }))
    await expectBrand(builtIn('tropic', 'dark'), 'dark')

    paint(choice({ appearance: 'light', lightTheme: 'citrine' }))
    await expectBrand(builtIn('citrine', 'light'), 'light')

    const saffron = custom()
    paint(choice({ appearance: 'light', lightTheme: saffron.id, customThemes: [saffron] }))
    await expectBrand(saffron.colors, 'light')

    // An unsaved editor draft repaints the root, and the mark with it.
    const draft = { appearance: 'dark' as const, colors: createVividThemeColors('dark', '#0b1a12', '#2ecc71') }
    paint(choice(), draft)
    await expectBrand(draft.colors, 'dark')
    // Geometry is untouched.
    expect(svg.querySelector('rect[x="26"]')).toHaveAttribute('height', '56')
  })

  it('wears the app icon itself on the default theme, in both modes', async () => {
    paint(choice({ darkTheme: DEFAULT_THEME_ID, lightTheme: DEFAULT_THEME_ID }))
    const { container } = render(<SottoMark />)
    const svg = container.querySelector('svg')!
    for (const mode of ['dark', 'light'] as const) {
      paint(choice({ appearance: mode, darkTheme: DEFAULT_THEME_ID, lightTheme: DEFAULT_THEME_ID }))
      await waitFor(() => expect(svg).toHaveAttribute('data-tile', APP_ICON_BRAND.tile))
      expect(svg).toHaveAttribute('data-glyph', APP_ICON_BRAND.glyph)
    }

    // Any other theme hands the mark back to its own accent, which the light default is not.
    paint(choice({ appearance: 'light', lightTheme: 'citrine' }))
    const citrine = themeBrand(builtIn('citrine', 'light'), 'light')
    await waitFor(() => expect(svg).toHaveAttribute('data-tile', citrine.tile))
    expect(citrine.tile).not.toBe(APP_ICON_BRAND.tile)
  })
})

describe('AgentOrb', () => {
  it('keeps one renderer while its colours follow the theme and its state and motion stay put', async () => {
    const orb = handle()
    vi.mocked(createOrb).mockReturnValue(orb)
    paint(choice())
    const { rerender } = render(<AgentOrb state="wake" />)
    const canvas = document.querySelector('canvas.agent-orb')!
    const nocturne = themeBrand(builtIn('nocturne', 'dark'), 'dark').orb
    expect(createOrb).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createOrb).mock.calls[0]![1]).toMatchObject({ state: 'wake', colors: nocturne })
    expect(canvas).toHaveAttribute('data-orb-colors', nocturne.join(' '))

    paint(choice({ darkTheme: 'citrine' }))
    const citrine = themeBrand(builtIn('citrine', 'dark'), 'dark').orb
    await waitFor(() => expect(orb.setColors).toHaveBeenLastCalledWith(citrine))
    expect(citrine).not.toEqual(nocturne)
    expect(canvas).toHaveAttribute('data-orb-colors', citrine.join(' '))

    rerender(<AgentOrb state="speaking" />)
    expect(orb.setState).toHaveBeenLastCalledWith('speaking')
    act(() => { document.documentElement.dataset.reducedMotion = 'on' })
    await waitFor(() => expect(orb.setStill).toHaveBeenLastCalledWith(true))
    expect(createOrb).toHaveBeenCalledTimes(1)
    expect(document.querySelector('canvas.agent-orb')).toBe(canvas)
    expect(orb.dispose).not.toHaveBeenCalled()
    delete document.documentElement.dataset.reducedMotion
  })

  it('draws beneath the light room ink filter so the theme colour is what shows', async () => {
    const orb = handle()
    vi.mocked(createOrb).mockReturnValue(orb)
    paint(choice({ appearance: 'light', lightTheme: 'tropic' }))
    render(<AgentOrb state="idle" />)
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.agent-orb')!
    const visible = themeBrand(builtIn('tropic', 'light'), 'light').orb
    act(() => { canvas.style.filter = ORB_INK_FILTER })
    paint(choice({ appearance: 'light', lightTheme: 'citrine' }))
    const citrine = themeBrand(builtIn('citrine', 'light'), 'light').orb
    await waitFor(() => expect(orb.setColors).toHaveBeenLastCalledWith(orbColorsBeneath(ORB_INK_FILTER, citrine)))
    expect(canvas).toHaveAttribute('data-orb-colors', citrine.join(' '))
    expect(visible).not.toEqual(citrine)
  })
})

describe('orb ink filter compensation', () => {
  function throughFilter(drawn: string): [number, number, number] {
    // invert(1) then hue-rotate(180deg), as the compositor applies them in sRGB.
    const [r, g, b] = [1, 3, 5].map(index => 1 - parseInt(drawn.slice(index, index + 2), 16) / 255) as [number, number, number]
    return [
      -0.574 * r + 1.43 * g + 0.144 * b,
      0.426 * r + 0.43 * g + 0.144 * b,
      0.426 * r + 1.43 * g - 0.856 * b,
    ].map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255)) as [number, number, number]
  }

  it.each(BUILT_IN_THEMES.map(theme => [theme.label, theme] as const))('%s light orb shows through the filter in its own hue', (_label, theme) => {
    for (const color of themeBrand(getThemeColorsForMode(theme, 'light')!, 'light').orb) {
      const seen = inkableColor(color)
      const expected = [1, 3, 5].map(index => parseInt(seen.slice(index, index + 2), 16))
      throughFilter(colorBeneathInkFilter(color)).forEach((channel, index) => expect(Math.abs(channel - expected[index]!)).toBeLessThanOrEqual(2))
      // Chroma gives way to fit the filter while the hue holds; the pull toward
      // equal-luminance grey moves perceived lightness only slightly.
      const want = oklch(color)
      const got = oklch(seen)
      expect(got.C).toBeLessThanOrEqual(want.C + 0.005)
      expect(Math.abs(got.L - want.L)).toBeLessThan(0.12)
      if (want.C > 0.04) expect(hueDistance(got.h, want.h)).toBeLessThan(10)
    }
  })

  it('shows a colour the filter can already carry exactly', () => {
    const quiet = '#5a6f86'
    expect(inkableColor(quiet)).toBe(quiet)
    throughFilter(colorBeneathInkFilter(quiet)).forEach((channel, index) => expect(Math.abs(channel - [0x5a, 0x6f, 0x86][index]!)).toBeLessThanOrEqual(1))
  })

  it('leaves colours alone when no ink filter is in force', () => {
    const pair = ['#123456', '#abcdef'] as const
    expect(orbColorsBeneath('none', pair)).toBe(pair)
  })
})

describe('AgentAppearance', () => {
  it('offers no separate orb colour: the sphere wears the theme', () => {
    vi.mocked(useAgents).mockReturnValue({
      state: { configuration: { ...defaultAgentConfiguration(), orbColor: 'violet' }, credentials: { grokSpeech: false }, voice: { error: null } },
      command: vi.fn(),
    } as never)
    render(<AgentAppearance />)
    expect(screen.queryByRole('group', { name: /orb/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /orb$/i })).toBeNull()
    expect(screen.queryByText(/orb colou?r/i)).toBeNull()
  })
})
