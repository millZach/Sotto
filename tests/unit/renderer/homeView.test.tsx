import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '../../../src/renderer/src/features/home/HomeView'
import type { HistoryEntry } from '../../../src/shared/history'
import { MODEL_CATALOG } from '../../../src/shared/modelCatalog'
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
  modelStatus: { preset: DEFAULT_SETTINGS.modelPreset, state: 'bundled' as const },
  entries,
  historyStatus: 'ready' as const,
  onOpenHistory: vi.fn(),
  onCopy: vi.fn(async () => true),
}

function figure(unit: string): HTMLElement {
  const readout = screen.getByText(unit, { selector: '.home-figures span' })
  if (!(readout instanceof HTMLElement)) throw new Error(`Missing figure: ${unit}`)
  return readout
}

function statusRow(term: string): HTMLElement {
  const row = screen.getByText(term, { selector: '.home-status dt' }).parentElement
  if (!(row instanceof HTMLElement)) throw new Error(`Missing status row: ${term}`)
  return row
}

describe('HomeView', () => {
  it.each(['light', 'dark'] as const)('renders the week, status, and recent panels in a forced %s container', (theme) => {
    render(<div data-theme={theme}><HomeView {...baseProps} /></div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'This week' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Status' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).toBeVisible()
  })

  it('shows weekly words, average wpm, and dictated minutes as tabular readouts', () => {
    render(<HomeView {...baseProps} />)

    expect(within(figure('words')).getByText('21')).toHaveClass('tt-tabular')
    expect(within(figure('wpm')).getByText('150')).toHaveClass('tt-tabular')
    expect(within(figure('min')).getByText('0')).toHaveClass('tt-tabular')
  })

  it('draws seven relative day bars scaled to the busiest day and names them for assistive tech', () => {
    const { container } = render(<HomeView {...baseProps} />)

    const chart = screen.getByRole('img', { name: /words dictated per day over the last seven days/i })
    expect(chart).toHaveAccessibleName(expect.stringContaining('Today'))
    const bars = [...container.querySelectorAll<HTMLElement>('.home-chart__bar')]
    expect(bars).toHaveLength(7)
    const heights = bars.map((bar) => Number.parseFloat(bar.style.height))
    expect(Math.max(...heights)).toBe(116)
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(3)
    expect([...container.querySelectorAll('.home-chart__label')].map((label) => label.textContent))
      .toEqual(['6d', '5d', '4d', '3d', '2d', 'Yest', 'Today'])
  })

  it('zeroes every figure gracefully for empty history', () => {
    render(<HomeView {...baseProps} entries={[]} />)

    for (const unit of ['words', 'wpm', 'min']) {
      expect(within(figure(unit)).getByText('0')).toBeVisible()
    }
  })

  it('summarises the model, language, paste, formatting, history, and version in the status list', () => {
    render(<HomeView {...baseProps} version="3.5.0" settings={{ ...baseProps.settings, autoPaste: true, pasteDelayMs: 120, llmFormatting: false, historyRetention: 100 }} />)

    expect(statusRow('Model')).toHaveTextContent(`${MODEL_CATALOG[DEFAULT_SETTINGS.modelPreset].label}, ready`)
    expect(statusRow('Language')).toHaveTextContent('English default')
    expect(statusRow('Paste')).toHaveTextContent('Automatic, 120 ms')
    expect(statusRow('AI formatting')).toHaveTextContent('Off')
    expect(statusRow('History')).toHaveTextContent('7 of 100 kept')
    expect(statusRow('Version')).toHaveTextContent('Sotto 3.5.0')
  })

  it('reports a missing model and a disabled history without inventing readiness', () => {
    render(<HomeView {...baseProps} modelStatus={{ preset: DEFAULT_SETTINGS.modelPreset, state: 'missing' }} settings={{ ...baseProps.settings, historyEnabled: false }} />)

    expect(statusRow('Model')).toHaveTextContent(/not installed/i)
    expect(statusRow('History')).toHaveTextContent('Off')
    expect(screen.queryByText('Version', { selector: 'dt' })).not.toBeInTheDocument()
  })

  it('lists exactly the five newest local transcripts under Recent with a copy action each', async () => {
    const user = userEvent.setup()
    const copy = vi.fn(async () => true)
    const openHistory = vi.fn()
    render(<HomeView {...baseProps} onCopy={copy} onOpenHistory={openHistory} />)

    expect(screen.getByText('Local note 7')).toBeVisible()
    expect(screen.getByText('Local note 3')).toBeVisible()
    expect(screen.queryByText('Local note 2')).not.toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(6)
    const copyButtons = screen.getAllByRole('button', { name: 'Copy transcript' })
    expect(copyButtons).toHaveLength(5)

    await user.click(copyButtons[0]!)
    expect(copy).toHaveBeenCalledWith('Local note 7')
    await user.click(screen.getByRole('button', { name: /open history/i }))
    expect(openHistory).toHaveBeenCalledOnce()
  })

  it('stamps each recent row with a machine-readable time', () => {
    const { container } = render(<HomeView {...baseProps} />)

    const stamps = container.querySelectorAll('.home-recent td > time[datetime]')
    expect(stamps).toHaveLength(5)
  })

  it.each([
    ['loading', true, /loading recent transcripts/i],
    ['degraded', true, /recent transcripts are unavailable/i],
    ['ready', false, /history is off/i],
    ['ready', true, /no saved transcripts yet/i],
  ] as const)('renders the %s recent-history state (enabled: %s)', (historyStatus, enabled, message) => {
    render(<HomeView {...baseProps} historyStatus={historyStatus} settings={{ ...baseProps.settings, historyEnabled: enabled }} entries={[]} />)
    expect(screen.getByText(message)).toBeVisible()
    expect(screen.queryByRole('button', { name: /open history/i })).not.toBeInTheDocument()
  })

  it('no longer carries the dictation controls, which live in the deck strip', () => {
    render(<HomeView {...baseProps} />)
    expect(screen.queryByRole('button', { name: /start dictation/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.queryByText(/speech stays on this computer/i)).not.toBeInTheDocument()
  })
})
