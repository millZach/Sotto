import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HomeView } from '../../../src/renderer/src/features/home/HomeView'
import type { HistoryEntry } from '../../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(cleanup)

const entries: HistoryEntry[] = Array.from({ length: 7 }, (_, index) => ({
  id: String(index + 1),
  text: `Local note ${index + 1}`,
  createdAt: index + 1,
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

describe('HomeView', () => {
  it.each(['light', 'dark'] as const)('renders a complete ready dashboard in a forced %s container', (theme) => {
    render(<div data-theme={theme}><HomeView {...baseProps} /></div>)

    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
    expect(screen.getByRole('button', { name: /start dictation/i })).toBeEnabled()
    expect(screen.getByText(/speech stays on this computer/i)).toBeVisible()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(screen.getByText(/balanced is ready/i)).toBeVisible()
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

  it('gates recording while the selected model is unavailable or work is processing', () => {
    const { rerender } = render(<HomeView {...baseProps} modelStatus={{ preset: 'balanced', state: 'missing' }} />)
    expect(screen.getByRole('button', { name: /model required/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /open settings/i })).toBeEnabled()

    rerender(<HomeView {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt: 1 }} />)
    expect(screen.getByRole('status')).toHaveTextContent(/turning speech into text/i)
    expect(screen.getByRole('button', { name: /transcribing/i })).toBeDisabled()
  })

  it('shows finite recovery guidance for an error without exposing its message', () => {
    render(<HomeView {...baseProps} dictation={{ status: 'error', code: 'TRANSCRIPTION_FAILED', message: 'private stack detail' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not transcribe/i)
    expect(document.body).not.toHaveTextContent('private stack detail')
  })

  it('shows exactly the five newest local transcripts', () => {
    render(<HomeView {...baseProps} />)
    expect(screen.getByText('Local note 7')).toBeVisible()
    expect(screen.getByText('Local note 3')).toBeVisible()
    expect(screen.queryByText('Local note 2')).not.toBeInTheDocument()
  })

  it.each([
    ['loading', true, /loading recent transcripts/i],
    ['degraded', true, /recent transcripts are unavailable/i],
    ['ready', false, /history is off/i],
  ] as const)('renders the %s recent-history state', (historyStatus, enabled, message) => {
    render(<HomeView {...baseProps} historyStatus={historyStatus} settings={{ ...baseProps.settings, historyEnabled: enabled }} entries={[]} />)
    expect(screen.getByText(message)).toBeVisible()
  })
})
