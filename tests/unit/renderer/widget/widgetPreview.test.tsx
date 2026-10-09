import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  WidgetApp,
  isVisualPreviewEnabled,
  parseVisualPreview
} from '../../../../src/renderer/src/widget/WidgetApp'
import { setupWidgetTests, snapshot } from '../../../fixtures/renderer/widgetHarness'

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
    if (first?.status === 'listening') expect(first.level).toBe(0.64)
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

  it('renders the one pill widget across its resting, listening, and resolved states', () => {
    const { rerender, container } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={5_000} />,
    )
    // The resting sliver is a bare bar carrying only the hover prompt.
    expect(container.querySelector('.widget-sliver')).toBeInTheDocument()
    expect(screen.getByText('Click to dictate')).toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'listening', startedAt: 0, level: 0.5,
          cancellable: true,
        })}
        platform="win32" now={5_000}
      />,
    )
    expect(screen.getByTestId('listening-bars')).toHaveClass('widget-bars')
    expect(container.querySelectorAll('.widget-bars__bar')).toHaveLength(7)
    expect(screen.getByText('00:05')).toBeVisible()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'processing', startedAt: 0, stage: 'transcribing',
          progress: 0.4, cancellable: true,
        })}
        platform="win32" now={5_000}
      />,
    )
    expect(screen.queryByTestId('listening-bars')).not.toBeInTheDocument()
    expect(screen.getByTestId('processing-orbit')).toHaveClass('widget-spinner')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'success', sessionId: 'success', output: 'pasted' })}
        platform="win32" now={5_000}
      />,
    )
    expect(screen.getByText('Pasted')).toBeVisible()
    expect(container.querySelector('.widget-state-icon')).toBeInTheDocument()
  })
})
