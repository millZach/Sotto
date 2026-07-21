import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '../../../src/renderer/src/features/home/HomeView'
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

function statTile(label: string): HTMLElement {
  const tile = screen.getByText(label).closest('.home-stat')
  if (!(tile instanceof HTMLElement)) throw new Error(`Missing stat tile: ${label}`)
  return tile
}

describe('HomeView', () => {
  it.each(['light', 'dark'] as const)('renders the stats-forward home in a forced %s container', (theme) => {
    render(<div data-theme={theme}><HomeView {...baseProps} /></div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start dictation/i })).toBeEnabled()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: /ready when you are/i })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible()
  })

  it('shows weekly words, average wpm, and dictated minutes in tabular stat tiles', () => {
    render(<HomeView {...baseProps} />)

    expect(within(statTile('Words')).getByText('21')).toHaveClass('tt-tabular')
    expect(within(statTile('Avg WPM')).getByText('150')).toHaveClass('tt-tabular')
    expect(within(statTile('Minutes dictated')).getByText('0')).toHaveClass('tt-tabular')
    expect(screen.getAllByText('this week')).toHaveLength(3)
  })

  it('decorates the words and minutes tiles with hidden single-hue sparklines', () => {
    render(<HomeView {...baseProps} />)

    for (const label of ['Words', 'Minutes dictated']) {
      const sparkline = statTile(label).querySelector('svg.home-stat__sparkline')
      expect(sparkline).not.toBeNull()
      expect(sparkline).toHaveAttribute('aria-hidden', 'true')
      expect(sparkline?.querySelector('polyline')).toHaveAttribute('stroke', 'var(--tt-primary)')
    }
    expect(statTile('Avg WPM').querySelector('svg')).toBeNull()
  })

  it('zeroes every stat tile gracefully for empty history', () => {
    render(<HomeView {...baseProps} entries={[]} />)

    for (const label of ['Words', 'Avg WPM', 'Minutes dictated']) {
      expect(within(statTile(label)).getByText('0')).toBeVisible()
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

  it('uses stable named grid areas so listening detail cannot displace the compact bar action', () => {
    expect(globalCss).toMatch(/\.home-dictation-bar\s*\{[^}]*grid-template-areas:\s*"icon copy action"\s*"icon meter action"/su)
    expect(globalCss).toMatch(/\.home-dictation-bar__icon\s*\{[^}]*grid-area:\s*icon/su)
    expect(globalCss).toMatch(/\.home-dictation-bar__copy\s*\{[^}]*grid-area:\s*copy/su)
    expect(globalCss).toMatch(/\.home-dictation-bar \.tt-level-meter[^}]*grid-area:\s*meter/su)
    expect(globalCss).toMatch(/\.home-dictation-bar__action\s*\{[^}]*grid-area:\s*action/su)
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

  it('gives success and error dictation bars distinct semantic visual tones', () => {
    const rendered = render(<HomeView {...baseProps} dictation={{ status: 'success', sessionId: 'done', output: 'pasted' }} />)
    expect(rendered.container.querySelector('.home-dictation-bar')).toHaveAttribute('data-tone', 'success')
    expect(screen.getByRole('heading', { level: 2, name: 'Text pasted' })).toBeVisible()

    rendered.rerender(<HomeView {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED' }} />)
    expect(rendered.container.querySelector('.home-dictation-bar')).toHaveAttribute('data-tone', 'error')
  })

  it('shows exactly the three newest local transcripts under Recent', () => {
    render(<HomeView {...baseProps} />)
    expect(screen.getByText('Local note 7')).toBeVisible()
    expect(screen.getByText('Local note 5')).toBeVisible()
    expect(screen.queryByText('Local note 4')).not.toBeInTheDocument()
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
