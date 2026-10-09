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
import { MICROPHONE_NOT_SET_UP_DETAIL, TRANSCRIPTION_ERROR_DETAIL, TRANSCRIPTION_KEPT_DETAIL, type DictationState } from '../../../src/shared/dictation'
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
  it.each([false, true])('matches the Linux recording hint to Automatic paste=%s', autoPaste => {
    const { container } = render(<DictateRoom {...baseProps} platform="linux"
      settings={{ ...baseProps.settings, autoPaste }}
      dictation={{ status: 'listening', sessionId: 'hint', startedAt: Date.now(), level: 0 }} />)
    expect(container).toHaveTextContent(autoPaste
      ? 'Sotto copies, then pastes into the focused window on Hyprland.'
      : 'Sotto copies your text. Paste with Super+V, Omarchy’s universal paste.')
    if (!autoPaste) expect(container).not.toHaveTextContent('then pastes')
  })

  it('points at retained text without offering manual paste when the desktop clipboard is unavailable', () => {
    const { container } = render(<DictateRoom {...baseProps} platform="linux"
      dictation={{ status: 'error', code: 'DESKTOP_CLIPBOARD_UNAVAILABLE', message: 'unused' }}
      recovery={[entries[0]!]} />)
    expect(screen.getByText(/The desktop clipboard could not be updated. Your text is kept below/)).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue(entries[0]!.text)
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeVisible()
    expect(container).not.toHaveTextContent('Super+V')
    expect(container).not.toHaveTextContent('Copied — paste manually')
  })

  it('uses local calendar days for Yesterday across both daylight-saving changes', context => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const dates = [
        ['2026-03-09T12:00:00', '2026-03-08T00:00:00', '2026-03-07T23:30:00'],
        ['2026-11-02T12:00:00', '2026-11-01T00:00:00', '2026-10-31T23:30:00'],
      ]
      if (dates.some(([today, yesterday]) => new Date(today!).getTimezoneOffset() === new Date(yesterday!).getTimezoneOffset())) {
        context.skip('This worker does not apply America/Los_Angeles at runtime; the dates must cross a DST offset change.')
      }
      for (const [today, yesterday, dayBefore] of dates) {
        expect(new Date(today!).getTimezoneOffset()).not.toBe(new Date(yesterday!).getTimezoneOffset())
        const now = new Date(today!).valueOf()
        expect(transcriptStamp(new Date(yesterday!).valueOf(), now).label).toBe('Yesterday')
        expect(transcriptStamp(new Date(dayBefore!).valueOf(), now).label).not.toBe('Yesterday')
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })

  it('keeps selectable completed text and normal controls through failed and successful Copy retries', async () => {
    const onCopy = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const onDismissRecovery = vi.fn()
    const user = userEvent.setup()
    render(<DictateRoom {...baseProps} settings={{ ...baseProps.settings, historyEnabled: false }} recovery={[entries[0]!]} onCopy={onCopy} onDismissRecovery={onDismissRecovery} />)
    expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue(entries[0]!.text)
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Copy failed. Your text is still here.')
    expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue(entries[0]!.text)
    await user.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(screen.getByRole('status')).toHaveTextContent('Copied.')
    expect(onCopy.mock.calls).toEqual([[entries[0]!.text], [entries[0]!.text]])
    expect(onDismissRecovery).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Dismiss text' }))
    expect(onDismissRecovery).toHaveBeenCalledWith(entries[0]!.id)
  })

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
    const rendered = render(<DictateRoom {...baseProps} dictation={{ status: 'processing', sessionId: 'one', startedAt: Date.now() }} />)
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

  it('offers Try again and Discard recording for a kept recording, from the keyboard', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn(async () => undefined)
    const onDismiss = vi.fn(async () => undefined)
    render(<DictateRoom {...baseProps} onRetry={onRetry} onDismiss={onDismiss}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_RATE_LIMITED', message: 'internal', kept: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_RATE_LIMITED)
    expect(screen.getByRole('alert')).not.toHaveTextContent('was not kept')
    // The shortcut would start over, so it is not shown beside Try again.
    expect(screen.queryByText(/in any app/)).not.toBeInTheDocument()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onRetry).toHaveBeenCalledOnce()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Discard recording' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('says when Try again failed too', () => {
    render(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={vi.fn(async () => undefined)}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_RATE_LIMITED', message: 'internal', kept: true, retried: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(`Try again did not get through. ${TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_RATE_LIMITED}`)
  })

  it('dismisses an error with Escape, but not from a text field or over a dialog', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn(async () => undefined)
    const error = { status: 'error' as const, sessionId: 'one', code: 'TRANSCRIPTION_RATE_LIMITED', message: 'internal', kept: true }
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { rerender } = render(<>
      <input aria-label="Search threads" />
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    // An Escape in the first half second was meant for the work the error replaced.
    now.mockReturnValue(1_400)
    await user.keyboard('{Escape}')
    expect(onDismiss).not.toHaveBeenCalled()

    now.mockReturnValue(5_000)
    await user.click(screen.getByRole('textbox', { name: 'Search threads' }))
    await user.keyboard('{Escape}')
    expect(onDismiss).not.toHaveBeenCalled()

    rerender(<>
      <div role="dialog" aria-label="Open dialog" />
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    await user.keyboard('{Escape}')
    expect(onDismiss).not.toHaveBeenCalled()

    const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // A native <dialog>, such as the Add project folder browser, owns Escape too.
    rerender(<>
      <dialog open aria-label="Choose a folder" />
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).not.toHaveBeenCalled()

    // A non-modal panel, such as the theme editor, does not hold Escape while focus is elsewhere.
    rerender(<>
      <div role="dialog" aria-modal="false" aria-label="Theme editor" />
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).toHaveBeenCalledOnce()
    onDismiss.mockClear()

    // A part of the window that claims Escape, as the client-update card does, keeps it.
    rerender(<>
      <button type="button" onKeyDown={(event) => { if (event.key === 'Escape') event.preventDefault() }}>Put away update</button>
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    screen.getByRole('button', { name: 'Put away update' }).focus()
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).not.toHaveBeenCalled()

    // Focus on Sotto's own navigation, outside the room, still counts.
    rerender(<>
      <button type="button" role="tab" aria-selected="true">Dictate</button>
      <DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />
    </>)
    screen.getByRole('tab', { name: 'Dictate' }).focus()
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).toHaveBeenCalledOnce()

    rerender(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} dictation={error} />)
    now.mockReturnValue(9_000)
    screen.getByRole('button', { name: 'Try again' }).focus()
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).toHaveBeenCalledTimes(2)

    rerender(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss} />)
    await user.keyboard('{Escape}')
    await settle()
    expect(onDismiss).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })

  it('still points at Settings when a kept recording failed on the key', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={vi.fn(async () => undefined)} onOpenSettings={onOpenSettings}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_UNAUTHORIZED', message: 'internal', kept: true }} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('offers Dismiss for an error that keeps nothing, and keeps Start dictation', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn(async () => undefined)
    render(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_RATE_LIMITED', message: 'internal' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_RATE_LIMITED)
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
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

  it('says no microphone is set up after a skip and points at the Settings test', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    const onStart = vi.fn(async () => undefined)
    render(<DictateRoom {...baseProps} settings={{ ...baseProps.settings, microphoneSkipped: true }} onOpenSettings={onOpenSettings} onStart={onStart} />)

    expect(screen.getByRole('heading', { level: 1, name: 'No microphone is set up.' })).toBeVisible()
    expect(screen.getByText(MICROPHONE_NOT_SET_UP_DETAIL)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Microphone needed' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(onStart).not.toHaveBeenCalled()
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

  it.each(Object.entries(TRANSCRIPTION_ERROR_DETAIL))('says why %s happened in the detail line', (code, detail) => {
    expect(dictateSentence({ status: 'error', sessionId: 'a', code, message: '' }, platformCopy('win32'))).toEqual({
      sentence: 'Dictation needs attention.', detail, tone: 'error',
    })
  })
})
