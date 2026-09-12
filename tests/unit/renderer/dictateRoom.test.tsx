import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DictateRoom,
  countWords,
  dictateSentence,
  formatElapsed,
  transcriptStamp,
} from '../../../src/renderer/src/features/dictate/DictateRoom'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import type { DictationState } from '../../../src/shared/dictation'
import type { HistoryEntry } from '../../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const entries: readonly HistoryEntry[] = [
  { id: 'older', text: 'An older note with five words.', createdAt: 1_000, durationMs: 3_000, language: 'en', modelPreset: 'instant' },
  { id: 'newest', text: 'Send the launch summary to the team before lunch.', createdAt: Date.now(), durationMs: 8_000, language: 'en', modelPreset: 'instant' },
]

const baseProps = {
  settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, llmApiKey: crypto.randomUUID() },
  platform: 'win32' as const,
  dictation: { status: 'idle' as const },
  entries,
  historyStatus: 'ready' as const,
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
  onOpenSettings: vi.fn(),
  onCopy: vi.fn(async () => true),
}

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')

function room(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('.dictate')
  if (!(surface instanceof HTMLElement)) throw new Error('Missing dictate room')
  return surface
}

function barHeights(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('.voice-wave__bar')]
    .map((bar) => Number.parseFloat(bar.style.height || '0'))
}

describe('DictateRoom', () => {
  it('says it is ready, offers the one pill and the shortcut, and shows only the newest transcript', () => {
    const { container } = render(<DictateRoom {...baseProps} />)

    expect(screen.getByRole('region', { name: 'Dictation' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(room(container)).toHaveAttribute('data-status', 'idle')
    expect(screen.getByText('Send the launch summary to the team before lunch.')).toBeVisible()
    expect(screen.queryByText('An older note with five words.')).not.toBeInTheDocument()
    expect(screen.getByText('9 words')).toBeInTheDocument()
    const copy = screen.getByRole('button', { name: 'Copy transcript' })
    expect(copy).toHaveTextContent('Copy')
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
  })

  it('copies the newest transcript through the caller', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(async () => true)
    render(<DictateRoom {...baseProps} onCopy={onCopy} />)
    await user.click(screen.getByRole('button', { name: 'Copy transcript' }))
    expect(onCopy).toHaveBeenCalledWith('Send the launch summary to the team before lunch.')
  })

  it('hides the transcript row when history is off, still loading, or empty', () => {
    const { rerender } = render(<DictateRoom {...baseProps} settings={{ ...baseProps.settings, historyEnabled: false }} />)
    expect(screen.queryByRole('button', { name: 'Copy transcript' })).not.toBeInTheDocument()
    rerender(<DictateRoom {...baseProps} historyStatus="loading" />)
    expect(screen.queryByRole('button', { name: 'Copy transcript' })).not.toBeInTheDocument()
    rerender(<DictateRoom {...baseProps} entries={[]} />)
    expect(screen.queryByRole('button', { name: 'Copy transcript' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
  })

  it('starts and stops for the matching states and ticks a clock inside the sentence while listening', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(10_000)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const rendered = render(<DictateRoom {...baseProps} onStart={start} onStop={stop} />)

    await user.click(screen.getByRole('button', { name: 'Start dictation' }))
    expect(start).toHaveBeenCalledOnce()

    const listening: DictationState = { status: 'listening', sessionId: 'one', startedAt: 10_000, level: 0.8 }
    rendered.rerender(<DictateRoom {...baseProps} dictation={listening} onStart={start} onStop={stop} />)
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent(/^Listening\.00:00$/u)
    expect(heading.querySelector('time')).toHaveAttribute('datetime', 'PT0S')
    expect(room(rendered.container)).toHaveAttribute('data-status', 'listening')
    expect(rendered.container.querySelector('.voice-wave')).toHaveAttribute('role', 'meter')
    act(() => { vi.setSystemTime(23_400); vi.advanceTimersByTime(300) })
    expect(heading).toHaveTextContent('00:13')
    expect(heading.querySelector('time')).toHaveAttribute('datetime', 'PT13S')

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledOnce()
    expect(screen.getByText(/press/i)).toHaveTextContent(/again/u)
  })

  it('locks the pill and drops the clock while transcribing, then reports the outcome', () => {
    const rendered = render(<DictateRoom {...baseProps} dictation={{ status: 'processing', sessionId: 'one' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Turning speech into text.' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Transcribing...' })).toBeDisabled()
    expect(rendered.container.querySelector('.voice-wave')).toHaveAttribute('data-stage', 'processing')
    expect(rendered.container.querySelector('.dictate__sentence time')).toBeNull()

    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'success', sessionId: 'one', text: 'hello', output: 'pasted' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pasted.' })).toBeVisible()
    expect(screen.getByText('9 words')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()

    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'success', sessionId: 'one', text: 'hello', output: 'copied' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Copied.' })).toBeVisible()

    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'cancelled', sessionId: 'one' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Cancelled.' })).toBeVisible()
  })

  it('announces an error assertively with one plain detail line', () => {
    render(<DictateRoom {...baseProps} dictation={{ status: 'error', sessionId: 'one', code: 'NO_SPEECH', message: 'internal' }} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Dictation needs attention.')
    expect(alert).toHaveTextContent('No speech was detected. Try again a little closer to the microphone.')
    expect(alert).not.toHaveTextContent('internal')
  })

  it('names the missing key and sends people to Settings instead of a dead pill', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<DictateRoom {...baseProps} settings={{ ...DEFAULT_SETTINGS }} onOpenSettings={onOpenSettings} />)
    expect(screen.getByRole('button', { name: 'API key required' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(screen.queryByText(/press/i)).not.toBeInTheDocument()
  })

  it('shares the widget speaking gate and seven-bar animation, settling after silence', () => {
    vi.useFakeTimers()
    const rendered = render(<DictateRoom {...baseProps} />)
    const resting = barHeights(rendered.container)
    expect(resting).toHaveLength(7)
    expect(resting[3]!).toBeGreaterThan(resting[0]!)
    expect(resting[0]).toBe(14)
    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt: 0, level: 1 }} />)
    const bars = screen.getByTestId('listening-bars')
    expect(bars.querySelectorAll('.widget-bars__bar')).toHaveLength(7)
    expect(bars).toHaveAttribute('data-speaking', 'true')
    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'listening', sessionId: 'one', startedAt: 0, level: 0 }} />)
    expect(bars).toHaveAttribute('data-speaking', 'true')
    act(() => vi.advanceTimersByTime(2_000))
    expect(bars).not.toHaveAttribute('data-speaking')
  })

  it('keeps the hero geometry, the sentence scale, and the reduced-motion wave override in the stylesheet', () => {
    expect(globalCss).toMatch(/\.dictate\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/su)
    expect(globalCss).toMatch(/\.dictate__sentence\s*\{[^}]*font-size:\s*44px;/su)
    expect(globalCss).toMatch(/\.dictate__sentence\s*\{[^}]*'opsz' 96/su)
    expect(globalCss).toMatch(/\.dictate__text\s*\{[^}]*-webkit-line-clamp:\s*3;/su)
    expect(globalCss).toMatch(/:root\[data-reduced-motion='on'\] \.voice-wave \.voice-wave__bar\s*\{[^}]*animation:\s*none;/su)
  })

  it('formats the clock, the word count, the stamp, and each state sentence', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(83_400)).toBe('01:23')
    expect(formatElapsed(Number.NaN)).toBe('00:00')
    expect(countWords('  one two   three ')).toBe(3)
    expect(countWords('')).toBe(0)
    const now = new Date(2026, 6, 12, 19, 30).valueOf()
    expect(transcriptStamp(now - 60_000, now).label).toMatch(/^\d{2}:\d{2}$/u)
    expect(transcriptStamp(now - 86_400_000, now).label).toBe('Yesterday')
    expect(transcriptStamp(now - 5 * 86_400_000, now).label).toMatch(/Jul/u)
    expect(transcriptStamp(Number.NaN, now)).toEqual({ label: 'Saved' })
    const copy = platformCopy('win32')
    expect(dictateSentence({ status: 'idle' }, copy).sentence).toBe('Ready when you are.')
    expect(dictateSentence({ status: 'requesting-permission', sessionId: 'a' }, copy)).toMatchObject({ sentence: 'Connecting to your microphone.', detail: copy.homeRequestingPermissionDetail })
    expect(dictateSentence({ status: 'error', sessionId: 'a', code: 'MIC_PERMISSION_DENIED', message: '' }, copy)).toMatchObject({ tone: 'error', detail: copy.homeMicrophonePermissionDenied })
  })
})
