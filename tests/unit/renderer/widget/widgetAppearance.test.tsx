import React from 'react'
import { readFileSync } from 'node:fs'

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  WidgetApp,
  applyRootPresentation
} from '../../../../src/renderer/src/widget/WidgetApp'
import { type WidgetSnapshot } from '../../../../src/shared/dictation'
import { APP_ICON_BRAND, APP_ICON_BRAND_ATTRIBUTE, themeBrand, widgetPaletteFor } from '../../../../src/shared/themeBranding'
import { DEFAULT_THEME_ID } from '../../../../src/shared/themes/library'
import { setWindowSize, setupWidgetTests, snapshot } from '../../../fixtures/renderer/widgetHarness'

setupWidgetTests()

describe('WidgetApp', () => {

  it('waves the recording bars only while the voice registers, and settles them on silence', () => {
    vi.useFakeTimers()
    const listening = (level: number): WidgetSnapshot =>
      snapshot({ status: 'listening', sessionId: 'one', startedAt: 0, level })
    const { container, rerender } = render(
      <WidgetApp snapshot={listening(0.004)} platform="win32" now={0} />,
    )
    const show = (level: number): void => {
      rerender(<WidgetApp snapshot={listening(level)} platform="win32" now={0} />)
    }
    const bars = screen.getByTestId('listening-bars')
    expect(bars).toHaveAttribute('aria-hidden', 'true')
    expect(bars.querySelectorAll('.widget-bars__bar')).toHaveLength(7)
    // A silence-floor level never starts the wave.
    expect(bars).not.toHaveAttribute('data-speaking')

    // Speech opens the gate immediately.
    show(0.06)
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Inside the hysteresis band the wave simply holds; nothing is scheduled.
    show(0.015)
    act(() => vi.advanceTimersByTime(5_000))
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Below the release threshold the wave still rides out the hold, so a gap
    // between words keeps it running, and a real pause settles it.
    show(0.004)
    act(() => vi.advanceTimersByTime(300))
    expect(bars).toHaveAttribute('data-speaking', 'true')
    act(() => vi.advanceTimersByTime(25))
    expect(bars).not.toHaveAttribute('data-speaking')

    // A voiced frame inside the hold cancels the settle outright.
    show(0.05)
    expect(bars).toHaveAttribute('data-speaking', 'true')
    show(0)
    act(() => vi.advanceTimersByTime(200))
    show(0.05)
    act(() => vi.advanceTimersByTime(5_000))
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Out-of-range and non-finite levels are clamped, never trusted raw.
    show(Number.NaN)
    act(() => vi.advanceTimersByTime(400))
    expect(bars).not.toHaveAttribute('data-speaking')
    show(2)
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // The level reaches CSS only through that one attribute: no inline
    // heights, no meter, no per-bar state.
    expect(container.querySelector('[style]')).toBeNull()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect([...bars.querySelectorAll('.widget-bars__bar')].every(
      (bar) => bar.attributes.length === 1 && bar.className === 'widget-bars__bar',
    )).toBe(true)
  })

  it('drops a pending bar settle when the widget unmounts mid-hold', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'hold', startedAt: 0, level: 0.4 })}
        platform="win32" now={0}
      />,
    )
    expect(screen.getByTestId('listening-bars')).toHaveAttribute('data-speaking', 'true')
    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'hold', startedAt: 0, level: 0 })}
        platform="win32" now={0}
      />,
    )
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['requesting permission', snapshot({ status: 'requesting-permission', sessionId: 'mark', cancellable: true })],
    ['listening', snapshot({ status: 'listening', sessionId: 'mark', startedAt: 0, level: 0.4, cancellable: true })],
    ['processing', snapshot({
      status: 'processing', sessionId: 'mark', startedAt: 0, stage: 'transcribing',
      progress: 0.5, cancellable: true,
    })],
    ['pasted', snapshot({ status: 'success', sessionId: 'mark', output: 'pasted' })],
    ['copied', snapshot({ status: 'success', sessionId: 'mark', output: 'copied' })],
    ['cancelled', snapshot({ status: 'cancelled', sessionId: 'mark' })],
    ['error', snapshot({ status: 'error', sessionId: 'mark', code: 'NO_SPEECH' })],
  ] as const)('leads the %s capsule with the decorative app mark', (_name, activeSnapshot) => {
    const tropic = widgetPaletteFor({ lightTheme: 'tropic', darkTheme: 'tropic', customThemes: [] })
    const release = applyRootPresentation({ theme: 'dark', palette: tropic, reducedMotion: 'system' }, true)
    const { container } = render(
      <WidgetApp snapshot={activeSnapshot} platform="win32" now={1_000} />,
    )

    const glyph = screen.getByTestId('widget-glyph')
    // Purely decorative: the live regions already carry the spoken status.
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.widget-capsule')?.firstElementChild).toBe(glyph)
    // The mark wears the painted theme half: its accent tile and a readable glyph.
    const brand = themeBrand(tropic.dark, 'dark')
    expect(glyph.querySelector('rect')).toHaveAttribute('fill', brand.tile)
    expect(glyph.querySelector('path[fill-rule="evenodd"]')).toHaveAttribute('fill', brand.glyph)
    expect([...glyph.querySelectorAll('circle')].map((circle) => circle.getAttribute('fill')))
      .toEqual([brand.glyph, brand.glyph])
    release()
  })

  it('wears the app icon on the half the default theme paints, and gives the attribute back on release', () => {
    const root = document.documentElement
    // One half on the default theme, the other on a built-in, so the two answers show in one palette.
    const split = widgetPaletteFor({ lightTheme: DEFAULT_THEME_ID, darkTheme: 'tropic', customThemes: [] })
    expect(split.appIcon).toEqual({ light: true, dark: false })

    const release = applyRootPresentation({ theme: 'light', palette: split, reducedMotion: 'system' }, false)
    expect(root.dataset.brand).toBe(APP_ICON_BRAND_ATTRIBUTE)
    render(<WidgetApp snapshot={snapshot({ status: 'listening', sessionId: 'icon', startedAt: 0, level: 0.4 })} platform="win32" now={1_000} />)
    const mark = screen.getByTestId('widget-glyph').querySelector('svg')
    expect(mark).toHaveAttribute('data-tile', APP_ICON_BRAND.tile)
    expect(mark).toHaveAttribute('data-glyph', APP_ICON_BRAND.glyph)

    // The dark half belongs to another theme, so the mark goes back to that theme's accent.
    applyRootPresentation({ theme: 'dark', palette: split, reducedMotion: 'system' }, true)
    expect(root.dataset.brand).toBeUndefined()

    release()
    expect(root).not.toHaveAttribute('data-brand')
  })

  it('leaves the resting sliver free of the app mark', () => {
    render(<WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />)

    expect(screen.getByTestId('widget-sliver')).toBeInTheDocument()
    expect(screen.queryByTestId('widget-glyph')).not.toBeInTheDocument()
  })

  it('keeps visible copy readable but non-live', () => {
    const { container, rerender } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'announced', startedAt: 0, level: 0.2,
          cancellable: true,
        })}
        platform="win32" now={1_000}
      />,
    )
    const listeningTime = container.querySelector('.widget-time')
    expect(listeningTime).toHaveTextContent('00:01')
    expect(listeningTime).not.toHaveAttribute('role')
    expect(listeningTime).toHaveAttribute('aria-live', 'off')

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'announced', startedAt: 0,
          stage: 'transcribing', progress: 0.58, cancellable: true,
        })}
        platform="win32" now={2_000}
      />,
    )
    const processingCopy = container.querySelector('.widget-copy')
    expect(processingCopy).toHaveTextContent('Transcribing')
    expect(processingCopy).not.toHaveAttribute('role')
    expect(processingCopy).not.toHaveAttribute('aria-live')
  })

  it('never exposes Electron accelerator vocabulary in the resting affordance', () => {
    render(
      <WidgetApp
        snapshot={snapshot({
          status: 'idle',
          shortcut: 'CommandOrControl+Shift+Space',
        })}
        platform="win32" now={1_000}
      />,
    )
    expect(screen.getByText('Ctrl+Shift+Space')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('CommandOrControl')
  })

  it('reflects the window proportions as a shell orientation attribute', () => {
    const { container, rerender } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />,
    )
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'horizontal',
    )

    // The main process swapped the resting presentation to its vertical root.
    setWindowSize(54, 124)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )

    // The active capsule shell carries the same orientation attribute.
    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'vertical', startedAt: 0, level: 0.4,
          cancellable: true,
        })}
        platform="win32" now={1_000}
      />,
    )
    setWindowSize(88, 248)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )

    setWindowSize(248, 88)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'horizontal',
    )
  })

  it('starts vertical when mounted inside a portrait presentation root', () => {
    setWindowSize(54, 124)
    const { container } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />,
    )
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )
  })
})

describe('visual preview parser', () => {

  it('keeps widget source clean and the canvas transparent with complete motion overrides', () => {
    const source = readFileSync('src/renderer/src/widget/WidgetApp.tsx', 'utf8')
    const css = readFileSync('src/renderer/src/components/listeningBars.css', 'utf8') + '\n' + readFileSync('src/renderer/src/widget/widget.css', 'utf8')
    expect(`${source}\n${css}`).not.toMatch(/[\u00e2\ufffd]/)
    expect(css).toMatch(/html,\s*\nbody,\s*\n#root[\s\S]*background: transparent/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(":root[data-reduced-motion='on']")
    expect(css).toContain('@keyframes widget-bar')
    // The wave is gated on the voice: the bars rest at the keyframe floor and
    // only loop while the renderer marks the container as speaking. The loop
    // shorthand must stay on the base rule — the per-bar stagger below is a
    // lower-specificity animation-delay, so hoisting the shorthand into the
    // [data-speaking] rule would reset every delay to 0s and the seven bars
    // would rise in phase instead of rippling.
    expect(css).toMatch(
      /\.widget-bars__bar \{[\s\S]*?height: 5px;[\s\S]*?animation: widget-bar 0\.9s ease-in-out infinite;\r?\n {2}transition: height/,
    )
    expect(css).toMatch(
      /\.widget-bars:not\(\[data-speaking\]\) \.widget-bars__bar \{\r?\n {2}animation: none;\r?\n\}/,
    )
    // Outside the reduced-motion overrides nothing may re-declare the
    // animation shorthand on the speaking variant.
    const motionOverrides = css.indexOf('/* ---- motion overrides ---- */')
    expect(motionOverrides).toBeGreaterThan(0)
    expect(css.slice(0, motionOverrides)).not.toMatch(
      /\.widget-bars\[data-speaking\] \.widget-bars__bar \{[^}]*animation:/,
    )
    // The stagger stays intact and lower-specificity, one delay per bar.
    expect([...css.matchAll(/\.widget-bars__bar:nth-child\((\d)\) \{\r?\n {2}animation-delay: ([\d.]+s);/g)]
      .map(([, index, delay]) => [index, delay])).toEqual([
      ['2', '0.12s'], ['3', '0.24s'], ['4', '0.36s'],
      ['5', '0.48s'], ['6', '0.6s'], ['7', '0.72s'],
    ])
    // Reduced motion never loops; it answers the voice by height alone, with
    // no transition of its own.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\n {2}\.widget-bars__bar \{\r?\n {4}animation: none;\r?\n {4}height: 5px;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\n {2}\.widget-bars\[data-speaking\] \.widget-bars__bar \{\r?\n {4}animation: none;\r?\n {4}height: 11px;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.widget-bars__bar,\s*\n\s*\.widget-capsule,[\s\S]*?transition: none;/,
    )
    expect(css).toContain(
      ":root[data-reduced-motion='on'] .widget-bars[data-speaking] .widget-bars__bar",
    )
    expect(css).toContain(":root[data-reduced-motion='on'] .widget-bars__bar,")
    expect(`${source}\n${css}`).not.toContain('widget-dot')
    expect(`${source}\n${css}`).not.toContain('data-widget-style')
    // The hover-expand affordance fully replaced the old floating tooltip.
    expect(`${source}\n${css}`).not.toContain('widget-sliver__hint')
    // The leading app mark is sized from the stylesheet, never inline.
    expect(source).toContain('data-testid="widget-glyph"')
    expect(css).toMatch(/\.widget-glyph__mark \{[\s\S]*?width: 22px;/)
    expect(source).not.toMatch(/<svg/)
    // Both orientations are styled off the shell orientation attribute.
    expect(css).toContain("[data-orientation='vertical']")
    // Reduced motion silences the sliver expansion and prompt transitions.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.widget-sliver__prompt \{\s*\n\s*transition: none;/,
    )
    expect(css).toContain(":root[data-reduced-motion='on'] .widget-sliver__prompt")
  })
})
