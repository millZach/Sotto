import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DictateRoom,
  countWords,
  dictateSentence,
  formatElapsed,
} from '../../../src/renderer/src/features/dictate/DictateRoom'
import { LiveLevelStore } from '../../../src/renderer/src/audio/liveLevel'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { MICROPHONE_NOT_SET_UP_DETAIL, SPEECH_MODEL_NOT_READY_DETAIL, TRANSCRIPTION_ERROR_DETAIL, TRANSCRIPTION_KEPT_DETAIL, type DictationState } from '../../../src/shared/dictation'
import type { DictationRecord } from '../../../src/shared/dictationRecord'
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

// Newest first, as main lists them.
const records: readonly DictationRecord[] = [
  { id: 'newest', createdAt: entries[1]!.createdAt, durationMs: 8_000, words: 9, app: 'Microsoft Outlook' },
  { id: 'older', createdAt: 1_000, durationMs: 3_000, words: 6 },
]

const baseProps = {
  settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, llmApiKey: crypto.randomUUID() },
  speechModel: { state: 'ready' as const },
  platform: 'win32' as const,
  dictation: { status: 'idle' as const },
  // Newest first, as main lists them.
  entries: [entries[1]!, entries[0]!],
  records,
  historyStatus: 'ready' as const,
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
  onOpenSettings: vi.fn(),
  onCopy: vi.fn(async () => true),
}

const globalCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/global.css'), 'utf8')
const roomCss = readFileSync(join(process.cwd(), 'src/renderer/src/features/dictate/dictate.css'), 'utf8')

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
      dictation={{ status: 'listening', sessionId: 'hint', startedAt: Date.now(), speaking: false }} />)
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

  it('says it is ready in the compact bar, offers the one pill and the shortcut, then the Journal and its stats', () => {
    const { container } = render(<DictateRoom {...baseProps} now={entries[1]!.createdAt} />)

    expect(screen.getByRole('region', { name: 'Dictation' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
    expect(room(container)).toHaveAttribute('data-status', 'idle')
    expect(container.querySelector('.dictate__bar .voice-wave')).not.toBeNull()
    // Every transcript by day, a week at a time, not only the newest.
    expect(screen.getByText('Send the launch summary to the team before lunch.')).toBeVisible()
    expect(screen.queryByText('An older note with five words.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show the 7 days before' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Microsoft Outlook · 9 words · 68 wpm')
    expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toBeVisible()
    expect(screen.getByRole('complementary', { name: 'Your dictation' })).toHaveTextContent('9 words in 1 dictation')
  })

  it('copies a transcript through the caller', async () => {
    const user = userEvent.setup()
    const onCopy = vi.fn(async () => true)
    render(<DictateRoom {...baseProps} onCopy={onCopy} now={entries[1]!.createdAt} />)
    await user.click(within(screen.getByRole('region', { name: 'Today' })).getByRole('button', { name: 'Copy transcript' }))
    expect(onCopy).toHaveBeenCalledWith('Send the launch summary to the team before lunch.')
  })

  it('says History is off, is still loading, or holds nothing yet, under the bar', () => {
    const { rerender } = render(<DictateRoom {...baseProps} settings={{ ...baseProps.settings, historyEnabled: false }} />)
    expect(screen.getByText(/^History is off\. New dictations keep their numbers only/)).toBeVisible()
    rerender(<DictateRoom {...baseProps} historyStatus="loading" />)
    expect(screen.getByRole('heading', { name: 'Loading transcripts.' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Copy transcript' })).not.toBeInTheDocument()
    rerender(<DictateRoom {...baseProps} entries={[]} records={[]} />)
    expect(screen.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 1, name: 'Ready when you are.' })).toBeVisible()
  })

  it('moves from the bar to the search, the More menu, the chips and the rows, in the order the eye does', async () => {
    const user = userEvent.setup()
    render(<DictateRoom {...baseProps} now={entries[1]!.createdAt} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Start dictation' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'More transcript actions' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'All' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Microsoft Outlook' })).toHaveFocus()
    await user.tab()
    expect(screen.getAllByRole('button', { name: /^Transcript from/ })[0]).toHaveFocus()
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

    const listening: DictationState = { status: 'listening', sessionId: 'one', startedAt: 10_000, speaking: true }
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
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()

    // Once its record is in, the bar says where the dictation went, and keeps the shortcut under it.
    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'success', sessionId: 'newest', text: 'hello', output: 'pasted' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pasted into Microsoft Outlook.' })).toBeVisible()
    expect(screen.getByText(/in any app/)).toBeVisible()

    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'success', sessionId: 'older', text: 'hello', output: 'pasted' }} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pasted.' })).toBeVisible()

    rendered.rerender(<DictateRoom {...baseProps} dictation={{ status: 'success', sessionId: 'newest', text: 'hello', output: 'copied' }} />)
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
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_FAILED', message: 'internal', kept: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_FAILED)
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
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_FAILED', message: 'internal', kept: true, retried: true }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(`Try again failed too. ${TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_FAILED}`)
  })

  it('dismisses an error with Escape, but not from a text field or over a dialog', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn(async () => undefined)
    const error = { status: 'error' as const, sessionId: 'one', code: 'TRANSCRIPTION_FAILED', message: 'internal', kept: true }
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

  it('still points at Settings when a kept recording failed on the speech model', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={vi.fn(async () => undefined)} onOpenSettings={onOpenSettings}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_MODEL_NOT_READY', message: 'internal', kept: true }} />)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith('settings-transcription')
  })

  it('offers Dismiss for an error that keeps nothing, and keeps Start dictation', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn(async () => undefined)
    render(<DictateRoom {...baseProps} onRetry={vi.fn(async () => undefined)} onDismiss={onDismiss}
      dictation={{ status: 'error', sessionId: 'one', code: 'TRANSCRIPTION_FAILED', message: 'internal' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(TRANSCRIPTION_ERROR_DETAIL.TRANSCRIPTION_FAILED)
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('says no speech model is chosen and sends people to the speech model in Settings → Dictation instead of a dead pill', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<DictateRoom {...baseProps} speechModel={{ state: 'missing' }} onOpenSettings={onOpenSettings} />)
    expect(screen.getByRole('heading', { level: 1, name: 'No speech model is chosen.' })).toBeVisible()
    expect(screen.getByText('Choose one in Settings → Dictation, under Speech model.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Speech model needed' })).toBeDisabled()
    expect(screen.getByText('No speech model chosen')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith('settings-transcription')
    expect(screen.queryByText(/press/i)).not.toBeInTheDocument()
  })

  it('shows the downloading and loading labels while the speech model is not ready', () => {
    const { rerender } = render(<DictateRoom {...baseProps} speechModel={{ state: 'downloading', receivedBytes: 1, totalBytes: 2 }} />)
    expect(screen.getByRole('button', { name: 'Downloading speech model' })).toBeDisabled()
    expect(screen.getByText(/Downloading the speech model/)).toBeVisible()
    rerender(<DictateRoom {...baseProps} speechModel={{ state: 'loading' }} />)
    expect(screen.getByRole('button', { name: 'Starting speech model' })).toBeDisabled()
    expect(screen.getByText('Starting the speech model')).toBeVisible()
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
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith('settings-capture')
    expect(onStart).not.toHaveBeenCalled()
  })

  it('shares the widget speaking gate and seven-bar animation from the live level, settling after silence', () => {
    vi.useFakeTimers()
    const level = new LiveLevelStore()
    const rendered = render(<DictateRoom {...baseProps} level={level} />)
    const resting = barHeights(rendered.container)
    expect(resting).toHaveLength(7)
    expect(resting[3]!).toBeGreaterThan(resting[0]!)
    expect(resting[0]).toBe(6)
    const listening: DictationState = { status: 'listening', sessionId: 'one', startedAt: 0, speaking: true }
    rendered.rerender(<DictateRoom {...baseProps} level={level} dictation={listening} />)
    act(() => level.set(1))
    const bars = screen.getByTestId('listening-bars')
    expect(bars.querySelectorAll('.widget-bars__bar')).toHaveLength(7)
    expect(bars).toHaveAttribute('data-speaking', 'true')
    // The meter gives screen readers the live level, which reaches it without the room being handed new state.
    expect(rendered.container.querySelector('.voice-wave')).toHaveAttribute('aria-valuenow', '1')
    act(() => level.set(0))
    expect(rendered.container.querySelector('.voice-wave')).toHaveAttribute('aria-valuenow', '0')
    expect(bars).toHaveAttribute('data-speaking', 'true')
    act(() => vi.advanceTimersByTime(2_000))
    expect(bars).not.toHaveAttribute('data-speaking')
  })

  it('keeps the stats column, its compact row below 900 pixels of room, two-line rows and the reduced-motion wave in the stylesheets', () => {
    expect(roomCss).toMatch(/\.dictate\s*\{[^}]*container:\s*dictate-room \/ inline-size;/su)
    expect(roomCss).toMatch(/\.dictate__layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 300px;/su)
    expect(roomCss).toMatch(/@container dictate-room \(max-width: 899px\)\s*\{[\s\S]*?\.journal-stats \[data-wide\]\s*\{\s*display:\s*none;/su)
    expect(roomCss).toMatch(/\.journal-entry__text\s*\{[^}]*-webkit-line-clamp:\s*2;/su)
    expect(globalCss).toMatch(/:root\[data-reduced-motion='on'\] \.voice-wave \.voice-wave__bar\s*\{[^}]*animation:\s*none;/su)
  })

  it('formats the clock, the word count, and each state sentence', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(83_400)).toBe('01:23')
    expect(formatElapsed(Number.NaN)).toBe('00:00')
    expect(countWords('  one two   three ')).toBe(3)
    expect(countWords('')).toBe(0)
    const copy = platformCopy('win32')
    expect(dictateSentence({ status: 'idle' }, copy).sentence).toBe('Ready when you are.')
    expect(dictateSentence({ status: 'requesting-permission', sessionId: 'a' }, copy)).toMatchObject({ sentence: 'Connecting to your microphone.', detail: copy.homeRequestingPermissionDetail })
    expect(dictateSentence({ status: 'error', sessionId: 'a', code: 'MIC_PERMISSION_DENIED', message: '' }, copy)).toMatchObject({ tone: 'error', detail: copy.homeMicrophonePermissionDenied })
  })

  it('says the speech model is not ready yet while idle, and gives its own detail when a dictation fails on it', () => {
    const copy = platformCopy('win32')
    expect(dictateSentence({ status: 'idle' }, copy, false, false)).toEqual({
      sentence: 'The speech model is not ready yet.', tone: 'normal',
    })
    expect(dictateSentence(
      { status: 'error', sessionId: 'a', code: 'SPEECH_MODEL_NOT_READY', message: '' }, copy,
    )).toMatchObject({ tone: 'error', detail: SPEECH_MODEL_NOT_READY_DETAIL })
  })

  it.each(Object.entries(TRANSCRIPTION_ERROR_DETAIL))('says why %s happened in the detail line', (code, detail) => {
    expect(dictateSentence({ status: 'error', sessionId: 'a', code, message: '' }, platformCopy('win32'))).toEqual({
      sentence: 'Dictation needs attention.', detail, tone: 'error',
    })
  })
})
