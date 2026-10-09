import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { platformCopy } from '../../../../src/renderer/src/platformCopy'
import {
  WidgetApp,
  formatElapsedTime
} from '../../../../src/renderer/src/widget/WidgetApp'
import { MICROPHONE_NOT_SET_UP_DETAIL, TRANSCRIPTION_KEPT_DETAIL, type WidgetErrorCode } from '../../../../src/shared/dictation'
import { setupWidgetTests, snapshot, win32Copy } from '../../../fixtures/renderer/widgetHarness'

setupWidgetTests()

describe('WidgetApp', () => {
  it('says dictated audio went to OpenRouter only once transcription is underway, on both platforms', () => {
    // ADR-0006: the audio is uploaded to OpenRouter for transcription, and it is never written to disk. Before the
    // upload, a stop that fails or finds no speech sends nothing, so those stages only say the audio is not kept.
    const cases = [
      ['preparing-audio', 'Preparing audio', 'Audio is never saved'],
      ['loading-model', 'Preparing transcription', 'Audio is never saved'],
      ['transcribing', 'Transcribing', 'Sent to OpenRouter, never saved'],
      ['delivering-output', 'Delivering text', 'Sent to OpenRouter, never saved'],
    ] as const
    for (const platform of ['win32', 'darwin'] as const) {
      for (const [stage, label, detail] of cases) {
        render(
          <WidgetApp
            snapshot={snapshot({ status: 'processing', sessionId: `${platform}-${stage}`, startedAt: 0, stage, progress: 0.5, cancellable: true })}
            platform={platform}
            now={0}
          />,
        )
        expect(screen.getByText(label)).toHaveAttribute('title', detail)
        cleanup()
      }
    }
  })

  it('renders the macOS copy row and glyph shortcut on darwin', () => {
    const macCopy = platformCopy('darwin')
    const { rerender } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'idle', shortcut: 'Control+Shift+Space' })}
        platform="darwin"
        now={0}
      />,
    )
    expect(screen.getByText('⌃+⇧+Space')).toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'requesting-permission', sessionId: 'permission', cancellable: true })}
        platform="darwin"
        now={0}
      />,
    )
    expect(screen.getByText('Waiting for microphone')).toHaveAttribute('title', macCopy.widgetPermissionPromptDetail)

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'processing', sessionId: 'work', startedAt: 0, stage: 'transcribing', progress: 0.5, cancellable: true })}
        platform="darwin"
        now={0}
      />,
    )
    expect(screen.getByText('Transcribing')).toHaveAttribute('title', macCopy.widgetProcessingDetail)

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'error', sessionId: 'failed', code: 'MIC_PERMISSION_DENIED' })}
        platform="darwin"
        now={0}
      />,
    )
    expect(screen.getByText('Microphone blocked')).toHaveAttribute('title', macCopy.widgetMicrophoneBlockedDetail)
  })

  it('renders idle, permission, listening, success, and cancelled without private content', () => {
    const privateFields = { text: 'private transcript', audio: [0.25], message: 'raw failure' }
    const { rerender, container } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle', ...privateFields })} platform="win32" now={15_340} />,
    )
    expect(screen.getByTestId('widget-sliver')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+Space')).toBeInTheDocument()
    expect(screen.getByText('Click to dictate')).toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'requesting-permission', sessionId: 'permission', cancellable: true, ...privateFields,
        })}
        platform="win32" now={15_340}
      />,
    )
    expect(screen.getByText('Waiting for microphone')).toBeVisible()
    expect(screen.getByText('Waiting for microphone')).toHaveAttribute(
      'title',
      win32Copy.widgetPermissionPromptDetail,
    )

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'listening', startedAt: 3_000, level: 0.65,
          cancellable: true, ...privateFields,
        })}
        platform="win32" now={15_340}
      />,
    )
    expect(screen.getByText('00:12')).toBeVisible()
    expect(screen.getByTestId('listening-bars')).toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'success', sessionId: 'success', output: 'pasted', ...privateFields })}
        platform="win32" now={15_340}
      />,
    )
    expect(screen.getByText('Pasted')).toBeVisible()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'success', sessionId: 'success', output: 'copied', ...privateFields })}
        platform="win32" now={15_340}
      />,
    )
    expect(screen.getByText('Copied — paste manually')).toBeVisible()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'cancelled', sessionId: 'cancelled', ...privateFields })}
        platform="win32" now={15_340}
      />,
    )
    expect(screen.getByText('Cancelled')).toBeVisible()
    expect(container).not.toHaveTextContent('private transcript')
    expect(container).not.toHaveTextContent('raw failure')
    expect(container.innerHTML).not.toContain('0.25')
  })

  it.each([
    ['preparing-audio', 'Preparing audio'],
    ['loading-model', 'Preparing transcription'],
    ['transcribing', 'Transcribing'],
    ['delivering-output', 'Delivering text'],
  ] as const)('renders the %s processing stage with bounded progress', (stage, label) => {
    render(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'processing', startedAt: 1_000,
          stage, progress: 0.428, cancellable: true,
        })}
        platform="win32" now={4_000}
      />,
    )
    expect(screen.getByText(label)).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
    expect(screen.getByTestId('processing-orbit')).toBeInTheDocument()
    expect(screen.queryByTestId('listening-bars')).not.toBeInTheDocument()
  })

  it.each<[WidgetErrorCode, string, string]>([
    ['MIC_PERMISSION_DENIED', 'Microphone blocked', win32Copy.widgetMicrophoneBlockedDetail],
    ['MIC_DEVICE_NOT_FOUND', 'No microphone found', 'Connect a microphone and try again.'],
    ['MIC_START_FAILED', 'Microphone unavailable', 'Check the selected microphone and try again.'],
    ['MIC_NOT_SET_UP', 'No microphone set up', MICROPHONE_NOT_SET_UP_DETAIL],
    ['RECORDING_FAILED', 'Recording stopped', 'Check your microphone and try again.'],
    ['NO_SPEECH', 'No speech detected', 'Speak closer to the microphone and try again.'],
    ['TRANSCRIPTION_UNCONFIGURED', 'API key needed', 'Sotto has no OpenRouter API key yet. The recording was not kept. Add your key in Settings, then dictate again.'],
    ['TRANSCRIPTION_UNAUTHORIZED', 'API key rejected', 'OpenRouter rejected the API key. The recording was not kept. Check the key in Settings.'],
    ['TRANSCRIPTION_OFFLINE', 'Connection unavailable', 'Sotto could not reach OpenRouter. The recording was not kept. Check your connection and try again.'],
    ['TRANSCRIPTION_BILLING', 'Out of credit', 'OpenRouter has no credit left for this key. The recording was not kept. Add credit at openrouter.ai, then dictate again.'],
    ['TRANSCRIPTION_RATE_LIMITED', 'Too many requests', 'OpenRouter is limiting requests on this key. The recording was not kept. Wait a minute, then dictate again.'],
    ['TRANSCRIPTION_SERVICE_ERROR', 'OpenRouter error', 'OpenRouter’s transcription service returned an error. The recording was not kept. Dictate again in a moment.'],
    ['TRANSCRIPTION_FAILED', 'Couldn’t transcribe', 'Sotto did not get usable text back. The recording was not kept. Dictate again.'],
    ['OUTPUT_UNAVAILABLE', 'Output unavailable', 'Open Sotto and try again.'],
    ['OUTPUT_FAILED', 'Couldn’t copy text', 'Try again from the Sotto app.'],
    ['HISTORY_FAILED', 'Saved to clipboard', 'Local history was not updated.'],
    ['SETTINGS_UNAVAILABLE', 'Settings unavailable', 'Open Sotto to restore settings.'],
  ])('maps %s to finite safe recovery copy', (code, title, recovery) => {
    const privateFields = { message: 'C:\\Users\\private\\raw-model-error' }
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'error', sessionId: 'error', code,
          ...privateFields,
        })}
        platform="win32" now={0}
      />,
    )
    expect(screen.getByText(title)).toBeVisible()
    expect(screen.getByText(title)).toHaveAttribute('title', recovery)
    expect(container).not.toHaveTextContent('raw-model-error')
    // An error stays until it is dismissed, so its one control is Dismiss.
    expect(screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Dismiss'])
  })

  it('makes the pill Try again for a kept recording and keeps what went wrong in its tooltip', () => {
    const onRetry = vi.fn()
    const onCancel = vi.fn()
    const onDismiss = vi.fn()
    const onStop = vi.fn()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'error', sessionId: 'kept', code: 'TRANSCRIPTION_RATE_LIMITED', kept: true })}
        platform="win32" now={0}
        onRetry={onRetry} onCancel={onCancel} onDismiss={onDismiss} onStop={onStop}
      />,
    )
    const label = screen.getByText('Click to try again')
    expect(label).toBeVisible()
    expect(label).toHaveAttribute('title', `Too many requests. ${TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_RATE_LIMITED}`)

    fireEvent.click(container.querySelector('.widget-capsule')!)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onStop).not.toHaveBeenCalled()

    // A click in the first half second was aimed at the esc this × replaced.
    now.mockReturnValue(1_300)
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }))
    expect(onDismiss).not.toHaveBeenCalled()

    // Discarding is its own command; cancel is only for work in progress.
    now.mockReturnValue(2_000)
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    expect(onRetry).toHaveBeenCalledOnce()
    now.mockRestore()
  })

  it.each([
    ['TRANSCRIPTION_RATE_LIMITED', 'Still busy · retry'],
    ['TRANSCRIPTION_OFFLINE', 'Failed again · retry'],
  ] as const)('says when Try again on %s failed too', (code, title) => {
    const onRetry = vi.fn()
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'error', sessionId: 'again', code, kept: true, retried: true })}
        platform="win32" now={0} onRetry={onRetry}
      />,
    )
    expect(screen.getByText(title)).toHaveAttribute('title', expect.stringMatching(/^Try again did not get through\. /))
    fireEvent.click(container.querySelector('.widget-capsule')!)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('dismisses an error that keeps nothing when the pill is clicked', () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'error', sessionId: 'plain', code: 'NO_SPEECH' })}
        platform="win32" now={0}
        onRetry={onRetry} onDismiss={onDismiss}
      />,
    )
    fireEvent.click(container.querySelector('.widget-capsule')!)
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('exposes only semantic non-focusing stop and cancel actions in allowed states', () => {
    const onStop = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'listening', startedAt: 0, level: 0.4,
          cancellable: true,
        })}
        platform="win32" now={1_000}
        onStop={onStop}
        onCancel={onCancel}
      />,
    )
    const stop = screen.getByRole('button', { name: 'Stop dictation' })
    const cancel = screen.getByRole('button', { name: 'Cancel dictation' })
    expect(stop).toHaveAttribute('tabindex', '-1')
    expect(cancel).toHaveAttribute('tabindex', '-1')
    expect(fireEvent.mouseDown(stop)).toBe(false)
    expect(fireEvent.mouseDown(cancel)).toBe(false)
    fireEvent.click(stop)
    fireEvent.click(cancel)
    expect(onStop).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'processing', startedAt: 0,
          stage: 'transcribing', progress: 0.5, cancellable: false,
        })}
        platform="win32" now={1_000}
        onStop={onStop}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('gates permission and processing cancellation exactly by the snapshot contract', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'requesting-permission', sessionId: 'permission', cancellable: false })}
        platform="win32" now={0}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'requesting-permission', sessionId: 'permission', cancellable: true })}
        platform="win32" now={0}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Stop dictation' })).not.toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'processing', startedAt: 0,
          stage: 'loading-model', progress: 0.2, cancellable: true,
        })}
        platform="win32" now={0}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('button', { name: 'Cancel dictation' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Stop dictation' })).not.toBeInTheDocument()
  })

  it('formats elapsed time deterministically and caps it to a two-digit minute display', () => {
    expect(formatElapsedTime(3_000, 15_340)).toBe('00:12')
    expect(formatElapsedTime(5_000, 1_000)).toBe('00:00')
    expect(formatElapsedTime(Number.NaN, 1_000)).toBe('00:00')
    expect(formatElapsedTime(0, 6_600_000)).toBe('99:59')
  })
})
