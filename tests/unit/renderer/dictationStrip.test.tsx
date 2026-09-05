import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DictationStrip, formatElapsed } from '../../../src/renderer/src/features/dictation/DictationStrip'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import type { DictationState } from '../../../src/shared/dictation'
import { MODEL_CATALOG } from '../../../src/shared/modelCatalog'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const baseProps = {
  settings: { ...DEFAULT_SETTINGS, onboardingComplete: true },
  platform: 'win32' as const,
  dictation: { status: 'idle' as const },
  modelStatus: { preset: DEFAULT_SETTINGS.modelPreset, state: 'bundled' as const },
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
  onOpenSettings: vi.fn(),
}

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')

function strip(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('.dictation-strip')
  if (!(surface instanceof HTMLElement)) throw new Error('Missing dictation strip')
  return surface
}

function barHeights(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('.voice-wave__bar')]
    .map((bar) => Number.parseFloat(bar.style.height || '0'))
}

describe('DictationStrip', () => {
  it('names the deck, shows the shortcut, and says what the machine is doing while idle', () => {
    const { container } = render(<DictationStrip {...baseProps} />)

    expect(screen.getByRole('region', { name: 'Dictation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start dictation/i })).toBeEnabled()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Ready' })).toBeVisible()
    expect(screen.getByText(new RegExp(`${MODEL_CATALOG[DEFAULT_SETTINGS.modelPreset].label} model, English default, on this device`))).toBeVisible()
    expect(strip(container)).toHaveAttribute('data-stage', 'idle')
    expect(strip(container)).toHaveAttribute('data-active', 'false')
    expect(screen.getByText('00:00')).toHaveClass('tt-tabular')
  })

  it('starts and stops manually for the matching dictation states', async () => {
    const user = userEvent.setup()
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const rendered = render(<DictationStrip {...baseProps} onStart={start} onStop={stop} />)

    await user.click(screen.getByRole('button', { name: /start dictation/i }))
    expect(start).toHaveBeenCalledOnce()

    rendered.rerender(<DictationStrip {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt: Date.now(), level: 0.4 }} onStart={start} onStop={stop} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Listening' })).toBeVisible()
    expect(strip(rendered.container)).toHaveAttribute('data-active', 'true')
    await user.click(screen.getByRole('button', { name: /stop and transcribe/i }))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps one stable row order so no state displaces the control', () => {
    const states: DictationState[] = [
      { status: 'idle' },
      { status: 'requesting-permission', sessionId: 'one' },
      { status: 'listening', sessionId: 'one', startedAt: 1, level: 0.5 },
      { status: 'processing', sessionId: 'one', startedAt: 1 },
      { status: 'success', sessionId: 'one', text: 'done', output: 'pasted' },
      { status: 'error', code: 'TRANSCRIPTION_FAILED', message: 'private' },
    ]
    for (const dictation of states) {
      const { container, unmount } = render(<DictationStrip {...baseProps} dictation={dictation} />)
      expect([...strip(container).children].map((child) => child.className.split(' ')[0])).toEqual([
        'dictation-strip__buttons',
        'voice-wave',
        'dictation-strip__timer',
        'tt-shortcut',
        'dictation-strip__state',
      ])
      unmount()
    }
  })

  it('carries the widget wave at deck size: seven bars resting at 6px and peaking at 26px', () => {
    const { container } = render(<DictationStrip {...baseProps} />)

    const wave = container.querySelector<HTMLElement>('.voice-wave')
    expect(wave).toHaveAttribute('data-stage', 'idle')
    expect(wave).toHaveAttribute('aria-hidden', 'true')
    expect(wave?.style.getPropertyValue('--wave-rest')).toBe('6px')
    expect(wave?.style.getPropertyValue('--wave-peak')).toBe('26px')
    const heights = barHeights(container)
    expect(heights).toHaveLength(7)
    expect(heights.every((height) => height === 6)).toBe(true)
  })

  it('answers the real microphone level while listening and names itself as a meter', () => {
    const energy = (container: HTMLElement): number =>
      barHeights(container).reduce((total, height) => total + height, 0)
    const listening = { status: 'listening' as const, sessionId: 'one', startedAt: Date.now() }
    const quiet = render(<DictationStrip {...baseProps} dictation={{ ...listening, level: 0.1 }} />)
    const quietEnergy = energy(quiet.container)

    quiet.rerender(<DictationStrip {...baseProps} dictation={{ ...listening, level: 0.9 }} />)
    expect(energy(quiet.container)).toBeGreaterThan(quietEnergy)
    expect(Math.max(...barHeights(quiet.container))).toBeLessThanOrEqual(26)

    const meter = screen.getByRole('meter', { name: 'Microphone activity' })
    expect(meter).toHaveAttribute('data-stage', 'listening')
    expect(meter).toHaveAttribute('aria-valuenow', '0.9')
  })

  it('runs the session clock from startedAt and freezes it while transcribing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T10:00:00Z'))
    const startedAt = Date.now() - 65_000
    const rendered = render(<DictationStrip {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt, level: 0.2 }} />)
    expect(screen.getByText('01:05')).toBeVisible()

    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('01:07')).toBeVisible()

    rendered.rerender(<DictationStrip {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt }} />)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(screen.getByText('01:07')).toBeVisible()

    rendered.rerender(<DictationStrip {...baseProps} dictation={{ status: 'success', sessionId: 'one', text: 'x', output: 'pasted' }} />)
    expect(screen.getByText('00:00')).toBeVisible()
    expect(formatElapsed(Number.NaN)).toBe('00:00')
    expect(formatElapsed(3_599_000)).toBe('59:59')
  })

  it('gates recording while the selected model is unavailable or work is processing', () => {
    const { rerender } = render(<DictationStrip {...baseProps} modelStatus={{ preset: DEFAULT_SETTINGS.modelPreset, state: 'missing' }} />)
    expect(screen.getByRole('button', { name: /model required/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /open settings/i })).toBeEnabled()

    rerender(<DictationStrip {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt: 1 }} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Turning speech into text' })).toBeVisible()
    expect(screen.getByRole('button', { name: /transcribing/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /open settings/i })).not.toBeInTheDocument()
  })

  it('shows finite recovery guidance for an error without exposing its message', () => {
    render(<DictationStrip {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED', message: 'private stack detail' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not transcribe/i)
    expect(document.body).not.toHaveTextContent('private stack detail')
  })

  it.each(['win32', 'darwin'] as const)('draws microphone and shortcut copy from the %s row', (platform) => {
    const copy = platformCopy(platform)
    const rendered = render(<DictationStrip {...baseProps} platform={platform} dictation={{ status: 'error', code: 'MIC_PERMISSION_DENIED', message: '' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(copy.homeMicrophonePermissionDenied)

    rendered.rerender(<DictationStrip {...baseProps} platform={platform} dictation={{ status: 'requesting-permission', sessionId: 'one' }} />)
    expect(screen.getByText(copy.homeRequestingPermissionDetail)).toBeVisible()
    expect(screen.getByLabelText(platform === 'darwin' ? 'Command+Shift+Space' : 'Ctrl+Shift+Space')).toBeVisible()
  })

  it('does not claim the status role, so page notices stay the only status on screen', () => {
    render(<DictationStrip {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt: Date.now(), level: 0.4 }} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const live = document.querySelector('.dictation-strip__state')
    expect(live).toHaveAttribute('aria-live', 'polite')
  })

  it('gives success and error tones distinct semantic colours', () => {
    const rendered = render(<DictationStrip {...baseProps} dictation={{ status: 'success', sessionId: 'done', text: 'x', output: 'pasted' }} />)
    expect(strip(rendered.container)).toHaveAttribute('data-tone', 'success')
    expect(screen.getByRole('heading', { level: 2, name: 'Text pasted' })).toBeVisible()

    rendered.rerender(<DictationStrip {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED', message: '' }} />)
    expect(strip(rendered.container)).toHaveAttribute('data-tone', 'error')
    for (const tone of ['success', 'error']) {
      expect(globalCss).toMatch(
        new RegExp(`\\.dictation-strip\\[data-tone='${tone}'\\] \\.dictation-strip__icon \\{[^}]*var\\(--tt-${tone}\\)`, 'su'),
      )
    }
  })

  it('suppresses wave and wash motion through both reduced-motion paths', () => {
    for (const guard of [
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.voice-wave \.voice-wave__bar \{[^}]*animation: none;/su,
      /:root\[data-reduced-motion='on'\] \.voice-wave \.voice-wave__bar \{[^}]*animation: none;/su,
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.dictation-strip::before \{[^}]*animation: none;/su,
      /:root\[data-reduced-motion='on'\] \.dictation-strip::before \{[^}]*animation: none;/su,
    ]) expect(globalCss).toMatch(guard)
  })
})
