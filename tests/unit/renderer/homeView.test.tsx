import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '../../../src/renderer/src/features/home/HomeView'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import type { DictationState } from '../../../src/shared/dictation'
import type { HistoryEntry } from '../../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(cleanup)

// Seven three-word transcripts spread across recent hours: 21 words over
// 8.4 seconds of audio -> 21 words, 150 avg wpm, 0 whole minutes this week.
const NOW = Date.now()
const entries: HistoryEntry[] = Array.from({ length: 7 }, (_, index) => ({
  id: String(index + 1),
  text: `Local note ${index + 1}`,
  createdAt: NOW - (7 - index) * 3_600_000,
  durationMs: 1_200,
  language: 'en',
  modelPreset: 'balanced',
}))

const baseProps = {
  settings: { ...DEFAULT_SETTINGS, onboardingComplete: true },
  platform: 'win32' as const,
  dictation: { status: 'idle' as const },
  modelStatus: { preset: 'balanced' as const, state: 'bundled' as const },
  entries,
  historyStatus: 'ready' as const,
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
  onOpenHistory: vi.fn(),
  onOpenSettings: vi.fn(),
}

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')

function meter(label: string): HTMLElement {
  const readout = screen.getByText(label).closest('.home-meter')
  if (!(readout instanceof HTMLElement)) throw new Error(`Missing meter: ${label}`)
  return readout
}

function barHeights(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('.home-breath__bar')]
    .map((bar) => Number.parseFloat(bar.style.height || '0'))
}

describe('HomeView', () => {
  it.each(['light', 'dark'] as const)('renders the instrument-forward home in a forced %s container', (theme) => {
    render(<div data-theme={theme}><HomeView {...baseProps} /></div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start dictation/i })).toBeEnabled()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: /ready when you are/i })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible()
  })

  it('shows weekly words, average wpm, and dictated minutes as tabular mono readouts', () => {
    render(<HomeView {...baseProps} />)

    expect(within(meter('Words / wk')).getByText('21')).toHaveClass('tt-tabular')
    expect(within(meter('Avg WPM')).getByText('150')).toHaveClass('tt-tabular')
    expect(within(meter('Time / wk')).getByText('0')).toHaveClass('tt-tabular')
    expect(within(meter('Time / wk')).getByText('min')).toHaveClass('home-meter__unit')
  })

  it('states the seven-day window in the engraved meter labels themselves', () => {
    render(<HomeView {...baseProps} />)

    expect(screen.getAllByText(/\/ wk$/u).map((label) => label.textContent))
      .toEqual(['Words / wk', 'Time / wk'])
    for (const label of ['Words / wk', 'Avg WPM', 'Time / wk']) {
      expect(screen.getByText(label)).toHaveClass('tt-instrument')
    }
  })

  it('decorates the words and time meters with hidden single-hue trend bars', () => {
    render(<HomeView {...baseProps} />)

    for (const label of ['Words / wk', 'Time / wk']) {
      const trend = meter(label).querySelector('.home-meter__trend')
      expect(trend).not.toBeNull()
      expect(trend).toHaveAttribute('aria-hidden', 'true')
      expect(trend?.querySelectorAll('span')).toHaveLength(7)
    }
    expect(meter('Avg WPM').querySelector('.home-meter__trend')).toBeNull()
    expect(globalCss).toMatch(/\.home-meter__trend > span \{[^}]*var\(--tt-activity\)/su)
  })

  it('gives the thousands separator its own narrow cell so mono digits do not read as "2 ,847"', () => {
    const long: HistoryEntry[] = [{
      id: 'long',
      text: Array.from({ length: 2_847 }, () => 'word').join(' '),
      createdAt: NOW - 3_600_000,
      durationMs: 60_000,
      language: 'en',
      modelPreset: 'balanced',
    }]
    render(<HomeView {...baseProps} entries={long} />)

    const separators = meter('Words / wk').querySelectorAll('.home-meter__separator')
    expect(separators).toHaveLength(1)
    expect(separators[0]).toHaveTextContent(',')
    expect(meter('Words / wk')).toHaveTextContent('2,847')
    expect(globalCss).toMatch(/\.home-meter__separator \{[^}]*width:\s*0\.34em/su)
  })

  it('zeroes every meter gracefully for empty history', () => {
    render(<HomeView {...baseProps} entries={[]} />)

    for (const label of ['Words / wk', 'Avg WPM', 'Time / wk']) {
      expect(within(meter(label)).getByText('0')).toBeVisible()
    }
  })

  it('starts and stops manually for the matching dictation states', async () => {
    const user = userEvent.setup()
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const rendered = render(<HomeView {...baseProps} onStart={start} onStop={stop} />)

    await user.click(screen.getByRole('button', { name: /start dictation/i }))
    expect(start).toHaveBeenCalledOnce()

    rendered.rerender(<HomeView {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt: 1, level: 0.4 }} onStart={start} onStop={stop} />)
    expect(screen.getByRole('status')).toHaveTextContent(/listening/i)
    await user.click(screen.getByRole('button', { name: /stop and transcribe/i }))
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps one stable surface — copy, breath line, action row — so no state displaces the action', () => {
    const states: DictationState[] = [
      { status: 'idle' },
      { status: 'requesting-permission', sessionId: 'one' },
      { status: 'listening', sessionId: 'one', startedAt: 1, level: 0.5 },
      { status: 'processing', sessionId: 'one', startedAt: 1 },
      { status: 'success', sessionId: 'one', text: 'done', output: 'pasted' },
      { status: 'error', code: 'TRANSCRIPTION_FAILED', message: 'private' },
    ]
    for (const dictation of states) {
      const { container, unmount } = render(<HomeView {...baseProps} dictation={dictation} />)
      const surface = container.querySelector('.home-dictation-bar')
      expect([...surface!.children].map((child) => child.className.split(' ')[0])).toEqual([
        'home-dictation-bar__copy',
        'home-breath',
        'home-dictation-bar__action',
      ])
      unmount()
    }
    // The line reserves its own height, so answering the voice cannot reflow
    // anything below it.
    expect(globalCss).toMatch(/\.home-breath \{[^}]*height:\s*34px;/su)
    expect(globalCss).toMatch(/\.home-breath__bar \{[^}]*height:\s*2px;/su)
  })

  it('rests the breath line flat with a raised centre while idle', () => {
    const { container } = render(<HomeView {...baseProps} />)

    const line = container.querySelector('.home-breath')
    expect(line).toHaveAttribute('data-stage', 'idle')
    expect(line).toHaveAttribute('aria-hidden', 'true')
    const heights = barHeights(container)
    expect(heights).toHaveLength(64)
    expect(Math.max(...heights)).toBe(24)
    expect(heights.filter((height) => height === 2)).toHaveLength(57)
    expect(globalCss).toMatch(/\.home-breath\[data-stage='idle'\] \.home-breath__bar\[data-level='2'\] \{[^}]*home-breath-pulse/su)
  })

  it('answers the real microphone level while listening and names itself as a meter', () => {
    const energy = (container: HTMLElement): number =>
      barHeights(container).reduce((total, height) => total + height, 0)
    const listening = { status: 'listening' as const, sessionId: 'one', startedAt: 1 }
    const quiet = render(<HomeView {...baseProps} dictation={{ ...listening, level: 0.1 }} />)
    const quietEnergy = energy(quiet.container)

    quiet.rerender(<HomeView {...baseProps} dictation={{ ...listening, level: 0.9 }} />)
    expect(energy(quiet.container)).toBeGreaterThan(quietEnergy * 2)
    // Silence never collapses the line: it holds the resting shape it wears
    // when idle, and the voice lifts it from there.
    quiet.rerender(<HomeView {...baseProps} dictation={{ ...listening, level: 0 }} />)
    expect(Math.max(...barHeights(quiet.container))).toBe(24)

    quiet.rerender(<HomeView {...baseProps} dictation={{ ...listening, level: 0.9 }} />)
    const line = screen.getByRole('meter', { name: 'Microphone activity' })
    expect(line).toHaveAttribute('data-stage', 'listening')
    expect(line).toHaveAttribute('aria-valuenow', '0.9')
  })

  it('travels the line while transcribing and leaves its height to the stylesheet', () => {
    const { container } = render(<HomeView {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt: 1 }} />)

    const line = container.querySelector('.home-breath')
    expect(line).toHaveAttribute('data-stage', 'processing')
    expect(barHeights(container).every((height) => height === 0)).toBe(true)
    const bars = container.querySelectorAll<HTMLElement>('.home-breath__bar')
    expect(bars[0]!.style.getPropertyValue('--tt-breath-delay')).toBe('0.00s')
    expect(bars[63]!.style.getPropertyValue('--tt-breath-delay')).toBe('1.18s')
    expect(globalCss).toMatch(/\.home-breath\[data-stage='processing'\] \.home-breath__bar \{[^}]*home-breath-travel/su)
  })

  it('suppresses breath-line motion through both reduced-motion paths', () => {
    for (const guard of [
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.home-breath\[data-stage='processing'\] \.home-breath__bar \{\s*height: 9px;\s*animation: none;/su,
      /:root\[data-reduced-motion='on'\] \.home-breath\[data-stage='processing'\] \.home-breath__bar \{\s*height: 9px;\s*animation: none;/su,
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.home-dictation-bar::before \{\s*animation: none;/su,
      /:root\[data-reduced-motion='on'\] \.home-dictation-bar::before \{\s*animation: none;/su,
    ]) expect(globalCss).toMatch(guard)
  })

  it('gates recording while the selected model is unavailable or work is processing', () => {
    const { rerender } = render(<HomeView {...baseProps} modelStatus={{ preset: 'balanced', state: 'missing' }} />)
    expect(screen.getByRole('button', { name: /model required/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /open settings/i })).toBeEnabled()

    rerender(<HomeView {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt: 1 }} />)
    expect(screen.getByRole('status')).toHaveTextContent(/turning speech into text/i)
    expect(screen.getByRole('button', { name: /transcribing/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /open settings/i })).not.toBeInTheDocument()
  })

  it('shows finite recovery guidance for an error without exposing its message', () => {
    render(<HomeView {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED', message: 'private stack detail' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not transcribe/i)
    expect(document.body).not.toHaveTextContent('private stack detail')
  })

  it.each(['win32', 'darwin'] as const)('draws microphone and shortcut copy from the %s row', (platform) => {
    const copy = platformCopy(platform)
    const rendered = render(<HomeView {...baseProps} platform={platform} dictation={{ status: 'error', code: 'MIC_PERMISSION_DENIED', message: '' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(copy.homeMicrophonePermissionDenied)

    rendered.rerender(<HomeView {...baseProps} platform={platform} dictation={{ status: 'requesting-permission', sessionId: 'one' }} />)
    expect(screen.getByRole('status')).toHaveTextContent(copy.homeRequestingPermissionDetail)
    expect(screen.getByLabelText(platform === 'darwin' ? 'Command+Shift+Space' : 'Ctrl+Shift+Space')).toBeVisible()
  })

  it('gives success and error dictation surfaces distinct semantic visual tones', () => {
    const rendered = render(<HomeView {...baseProps} dictation={{ status: 'success', sessionId: 'done', text: 'x', output: 'pasted' }} />)
    expect(rendered.container.querySelector('.home-dictation-bar')).toHaveAttribute('data-tone', 'success')
    expect(screen.getByRole('heading', { level: 2, name: 'Text pasted' })).toBeVisible()

    rendered.rerender(<HomeView {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED', message: '' }} />)
    expect(rendered.container.querySelector('.home-dictation-bar')).toHaveAttribute('data-tone', 'error')
    for (const tone of ['success', 'error']) {
      expect(globalCss).toMatch(
        new RegExp(`\\.home-dictation-bar\\[data-tone='${tone}'\\] \\.home-dictation-bar__icon \\{[^}]*var\\(--tt-${tone}\\)`, 'su'),
      )
    }
  })

  it('shows exactly the three newest local transcripts under Recent, with hanging mono timestamps', () => {
    const { container } = render(<HomeView {...baseProps} />)
    expect(screen.getByText('Local note 7')).toBeVisible()
    expect(screen.getByText('Local note 5')).toBeVisible()
    expect(screen.queryByText('Local note 4')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.home-recent li > time')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /view all history/i })).toBeEnabled()
  })

  it.each([
    ['loading', true, /loading recent transcripts/i],
    ['degraded', true, /recent transcripts are unavailable/i],
    ['ready', false, /history is off/i],
  ] as const)('renders the %s recent-history state', (historyStatus, enabled, message) => {
    render(<HomeView {...baseProps} historyStatus={historyStatus} settings={{ ...baseProps.settings, historyEnabled: enabled }} entries={[]} />)
    expect(screen.getByText(message)).toBeVisible()
  })

  it('no longer renders home page chrome: eyebrow strip, privacy pill, or model card', () => {
    render(<HomeView {...baseProps} />)
    expect(screen.queryByText(/dashboard/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/speech stays on this computer/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/transcription model/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open settings/i })).not.toBeInTheDocument()
  })
})
