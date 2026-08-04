import { readFileSync } from 'node:fs'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SottoWidgetBridge,
  WidgetPresentation,
} from '../../../src/shared/contracts'
import type { WidgetErrorCode, WidgetSnapshot } from '../../../src/shared/dictation'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import {
  WidgetApp,
  WidgetEntry,
  formatElapsedTime,
  isVisualPreviewEnabled,
  parseVisualPreview,
} from '../../../src/renderer/src/widget/WidgetApp'

const win32Copy = platformCopy('win32')

const metadata = {
  theme: 'dark',
  reducedMotion: 'system',
  shortcut: 'Ctrl+Shift+Space',
  cancellable: false,
} as const

function snapshot(
  state: Omit<WidgetSnapshot, keyof typeof metadata> & Partial<typeof metadata>,
): WidgetSnapshot {
  return { ...metadata, ...state } as WidgetSnapshot
}

function setWindowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-reduced-motion')
  setWindowSize(1_024, 768)
  vi.useRealTimers()
})

describe('WidgetApp', () => {
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
    expect(screen.getByText('Transcribing locally')).toHaveAttribute('title', macCopy.widgetProcessingDetail)

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
    ['loading-model', 'Loading local model'],
    ['transcribing', 'Transcribing locally'],
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
    ['RECORDING_FAILED', 'Recording stopped', 'Check your microphone and try again.'],
    ['NO_SPEECH', 'No speech detected', 'Speak closer to the microphone and try again.'],
    ['TRANSCRIPTION_FAILED', 'Couldn’t transcribe', 'Try again or choose the Standard model.'],
    ['OUTPUT_UNAVAILABLE', 'Output unavailable', 'Open Sotto and try again.'],
    ['OUTPUT_FAILED', 'Couldn’t copy text', 'Try again from the Sotto app.'],
    ['HISTORY_FAILED', 'Saved to clipboard', 'Local history was not updated.'],
    ['SETTINGS_UNAVAILABLE', 'Settings unavailable', 'Open Sotto to restore settings.'],
  ])('maps %s to finite safe recovery copy', (code, title, recovery) => {
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'error', sessionId: 'error', code,
          message: 'C:\\Users\\private\\raw-model-error',
        })}
        platform="win32" now={0}
      />,
    )
    expect(screen.getByText(title)).toBeVisible()
    expect(screen.getByText(title)).toHaveAttribute('title', recovery)
    expect(container).not.toHaveTextContent('raw-model-error')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
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

  it('waves the recording bars only while the voice registers, and settles them on silence', () => {
    vi.useFakeTimers()
    const listening = (level: number): WidgetSnapshot =>
      snapshot({ status: 'listening', sessionId: 'one', startedAt: 0, level })
    const { container, rerender } = render(
      <WidgetApp snapshot={listening(0.004)} platform="win32" now={0} />,
    )
    const show = (level: number): void => {
      rerender(<WidgetApp snapshot={listening(level)} platform="win32" now={0} />)
    }
    const bars = screen.getByTestId('listening-bars')
    expect(bars).toHaveAttribute('aria-hidden', 'true')
    expect(bars.querySelectorAll('.widget-bars__bar')).toHaveLength(7)
    // A silence-floor level never starts the wave.
    expect(bars).not.toHaveAttribute('data-speaking')

    // Speech opens the gate immediately.
    show(0.06)
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Inside the hysteresis band the wave simply holds; nothing is scheduled.
    show(0.015)
    act(() => vi.advanceTimersByTime(5_000))
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Below the release threshold the wave still rides out the hold, so a gap
    // between words keeps it running, and a real pause settles it.
    show(0.004)
    act(() => vi.advanceTimersByTime(300))
    expect(bars).toHaveAttribute('data-speaking', 'true')
    act(() => vi.advanceTimersByTime(25))
    expect(bars).not.toHaveAttribute('data-speaking')

    // A voiced frame inside the hold cancels the settle outright.
    show(0.05)
    expect(bars).toHaveAttribute('data-speaking', 'true')
    show(0)
    act(() => vi.advanceTimersByTime(200))
    show(0.05)
    act(() => vi.advanceTimersByTime(5_000))
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // Out-of-range and non-finite levels are clamped, never trusted raw.
    show(Number.NaN)
    act(() => vi.advanceTimersByTime(400))
    expect(bars).not.toHaveAttribute('data-speaking')
    show(2)
    expect(bars).toHaveAttribute('data-speaking', 'true')

    // The level reaches CSS only through that one attribute: no inline
    // heights, no meter, no per-bar state.
    expect(container.querySelector('[style]')).toBeNull()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect([...bars.querySelectorAll('.widget-bars__bar')].every(
      (bar) => bar.attributes.length === 1 && bar.className === 'widget-bars__bar',
    )).toBe(true)
  })

  it('drops a pending bar settle when the widget unmounts mid-hold', () => {
    vi.useFakeTimers()
    const { rerender, unmount } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'hold', startedAt: 0, level: 0.4 })}
        platform="win32" now={0}
      />,
    )
    expect(screen.getByTestId('listening-bars')).toHaveAttribute('data-speaking', 'true')
    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'hold', startedAt: 0, level: 0 })}
        platform="win32" now={0}
      />,
    )
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['requesting permission', snapshot({ status: 'requesting-permission', sessionId: 'mark', cancellable: true })],
    ['listening', snapshot({ status: 'listening', sessionId: 'mark', startedAt: 0, level: 0.4, cancellable: true })],
    ['processing', snapshot({
      status: 'processing', sessionId: 'mark', startedAt: 0, stage: 'transcribing',
      progress: 0.5, cancellable: true,
    })],
    ['pasted', snapshot({ status: 'success', sessionId: 'mark', output: 'pasted' })],
    ['copied', snapshot({ status: 'success', sessionId: 'mark', output: 'copied' })],
    ['cancelled', snapshot({ status: 'cancelled', sessionId: 'mark' })],
    ['error', snapshot({ status: 'error', sessionId: 'mark', code: 'NO_SPEECH' })],
  ] as const)('leads the %s capsule with the decorative app mark', (_name, activeSnapshot) => {
    const { container } = render(
      <WidgetApp snapshot={activeSnapshot} platform="win32" now={1_000} />,
    )

    const glyph = screen.getByTestId('widget-glyph')
    // Purely decorative: the live regions already carry the spoken status.
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('.widget-capsule')?.firstElementChild).toBe(glyph)
    // The mark must stay the packaged icon's burnt amber, never the retired purple.
    expect([...glyph.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color')))
      .toEqual(['#cf6c0d', '#8f4404'])
  })

  it('leaves the resting sliver free of the app mark', () => {
    render(<WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />)

    expect(screen.getByTestId('widget-sliver')).toBeInTheDocument()
    expect(screen.queryByTestId('widget-glyph')).not.toBeInTheDocument()
  })

  it('keeps visible copy readable but non-live', () => {
    const { container, rerender } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'announced', startedAt: 0, level: 0.2,
          cancellable: true,
        })}
        platform="win32" now={1_000}
      />,
    )
    const listeningTime = container.querySelector('.widget-time')
    expect(listeningTime).toHaveTextContent('00:01')
    expect(listeningTime).not.toHaveAttribute('role')
    expect(listeningTime).toHaveAttribute('aria-live', 'off')

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'processing', sessionId: 'announced', startedAt: 0,
          stage: 'transcribing', progress: 0.58, cancellable: true,
        })}
        platform="win32" now={2_000}
      />,
    )
    const processingCopy = container.querySelector('.widget-copy')
    expect(processingCopy).toHaveTextContent('Transcribing locally')
    expect(processingCopy).not.toHaveAttribute('role')
    expect(processingCopy).not.toHaveAttribute('aria-live')
  })

  it('starts dictation from a non-focusing click on the idle sliver', () => {
    const onToggle = vi.fn()
    render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} onToggle={onToggle} />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    expect(sliver).toHaveAttribute('tabindex', '-1')
    expect(fireEvent.mouseDown(sliver)).toBe(false)
    fireEvent.click(sliver)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('stops the session from a capsule surface click without double-firing through action buttons', () => {
    const onToggle = vi.fn()
    const onStop = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'click', startedAt: 0, level: 0.4,
          cancellable: true,
        })}
        platform="win32" now={1_000}
        onToggle={onToggle}
        onStop={onStop}
        onCancel={onCancel}
      />,
    )

    const capsule = container.querySelector('.widget-capsule')
    expect(capsule).not.toBeNull()
    expect(fireEvent.mouseDown(capsule!)).toBe(false)
    fireEvent.click(capsule!)
    expect(onStop).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
    expect(onStop).toHaveBeenCalledTimes(2)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('keeps sub-threshold pointer movement a click on the idle sliver', () => {
    const onToggle = vi.fn()
    const onDrag = vi.fn()
    render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} onToggle={onToggle} onDrag={onDrag} />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, { pointerId: 1, button: 0, isPrimary: true, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(sliver, { pointerId: 1, screenX: 102, screenY: 101 })
    fireEvent.pointerUp(sliver, { pointerId: 1, screenX: 102, screenY: 101 })
    fireEvent.click(sliver)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(onDrag).not.toHaveBeenCalled()
  })

  it('turns super-threshold movement into a drag that suppresses the click', () => {
    const onToggle = vi.fn()
    const onDrag = vi.fn()
    render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} onToggle={onToggle} onDrag={onDrag} />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, { pointerId: 1, button: 0, isPrimary: true, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(sliver, { pointerId: 1, screenX: 120, screenY: 90 })
    fireEvent.pointerMove(sliver, { pointerId: 1, screenX: 150, screenY: 130 })
    fireEvent.pointerUp(sliver, { pointerId: 1, screenX: 150, screenY: 130 })
    fireEvent.click(sliver)

    expect(onToggle).not.toHaveBeenCalled()
    expect(onDrag.mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start', generation: 0, gestureId: expect.any(Number) },
      { phase: 'move', generation: 0, gestureId: expect.any(Number) },
      { phase: 'end', generation: 0, gestureId: expect.any(Number) },
    ])

    // The suppression is consumed by the drag's own click; the next plain
    // click is a fresh gesture and must work again.
    fireEvent.click(sliver)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('drags the capsule with the same threshold while button presses never start drags', () => {
    const onStop = vi.fn()
    const onDrag = vi.fn()
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'drag', startedAt: 0, level: 0.4,
          cancellable: true,
        })}
        platform="win32" now={1_000}
        onStop={onStop}
        onDrag={onDrag}
      />,
    )

    const capsule = container.querySelector('.widget-capsule')!
    fireEvent.pointerDown(capsule, { pointerId: 2, button: 0, isPrimary: true, screenX: 10, screenY: 10 })
    fireEvent.pointerMove(capsule, { pointerId: 2, screenX: 40, screenY: 10 })
    fireEvent.pointerUp(capsule, { pointerId: 2, screenX: 40, screenY: 10 })
    fireEvent.click(capsule)
    expect(onStop).not.toHaveBeenCalled()
    expect(onDrag).toHaveBeenLastCalledWith({ phase: 'end', generation: 0, gestureId: expect.any(Number) })

    onDrag.mockClear()
    const stop = screen.getByRole('button', { name: 'Stop dictation' })
    fireEvent.pointerDown(stop, { pointerId: 2, button: 0, isPrimary: true, screenX: 10, screenY: 10 })
    fireEvent.pointerMove(capsule, { pointerId: 2, screenX: 60, screenY: 60 })
    fireEvent.pointerUp(capsule, { pointerId: 2, screenX: 60, screenY: 60 })
    fireEvent.click(stop)
    expect(onDrag).not.toHaveBeenCalled()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('never exposes Electron accelerator vocabulary in the resting affordance', () => {
    render(
      <WidgetApp
        snapshot={snapshot({
          status: 'idle',
          shortcut: 'CommandOrControl+Shift+Space',
        })}
        platform="win32" now={1_000}
      />,
    )
    expect(screen.getByText('Ctrl+Shift+Space')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('CommandOrControl')
  })

  it('reflects the window proportions as a shell orientation attribute', () => {
    const { container, rerender } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />,
    )
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'horizontal',
    )

    // The main process swapped the resting presentation to its vertical root.
    setWindowSize(54, 124)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )

    // The active capsule shell carries the same orientation attribute.
    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'vertical', startedAt: 0, level: 0.4,
          cancellable: true,
        })}
        platform="win32" now={1_000}
      />,
    )
    setWindowSize(88, 248)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )

    setWindowSize(248, 88)
    fireEvent(window, new Event('resize'))
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'horizontal',
    )
  })

  it('starts vertical when mounted inside a portrait presentation root', () => {
    setWindowSize(54, 124)
    const { container } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} />,
    )
    expect(container.querySelector('.widget-shell')).toHaveAttribute(
      'data-orientation',
      'vertical',
    )
  })

  it('keeps idle hover expanded through a transient leave and collapses after settled hover-out', () => {
    vi.useFakeTimers()
    const onToggle = vi.fn()
    render(
      <WidgetApp
        snapshot={snapshot({ status: 'idle' })}
        platform="win32" now={0}
        onToggle={onToggle}
      />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    expect(sliver).not.toHaveAttribute('data-expanded')

    fireEvent.mouseEnter(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByText('Click to dictate')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+Space')).toBeInTheDocument()

    // Native resize/re-centering can briefly synthesize a leave followed by
    // re-entry while the 180 ms expansion transition is still running.
    fireEvent.mouseLeave(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')
    act(() => vi.advanceTimersByTime(100))
    fireEvent.mouseEnter(sliver)
    act(() => vi.advanceTimersByTime(500))
    expect(sliver).toHaveAttribute('data-expanded', 'true')

    // Clicking the expanded pill starts dictation through the same path.
    fireEvent.click(sliver)
    expect(onToggle).toHaveBeenCalledOnce()

    fireEvent.mouseLeave(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')
    act(() => vi.advanceTimersByTime(500))
    expect(sliver).not.toHaveAttribute('data-expanded')
  })

  it('reports one stable idle-hovered presentation before settled hover-out', () => {
    vi.useFakeTimers()
    const presentations: WidgetPresentation[] = []
    render(
      <WidgetApp
        snapshot={snapshot({ status: 'idle' })}
        platform="win32" now={0}
        onPresentationChange={(presentation) => presentations.push(presentation)}
      />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    expect(presentations).toEqual(['idle-resting'])
    fireEvent.mouseEnter(sliver)
    expect(presentations).toEqual(['idle-resting', 'idle-hovered'])
    fireEvent.mouseLeave(sliver)
    act(() => vi.advanceTimersByTime(100))
    fireEvent.mouseEnter(sliver)
    act(() => vi.advanceTimersByTime(500))
    expect(presentations).toEqual(['idle-resting', 'idle-hovered'])

    fireEvent.mouseLeave(sliver)
    act(() => vi.advanceTimersByTime(500))
    expect(presentations).toEqual(['idle-resting', 'idle-hovered', 'idle-resting'])
  })

  it.each([
    ['requesting permission', snapshot({ status: 'requesting-permission', sessionId: 'permission' })],
    ['listening', snapshot({ status: 'listening', sessionId: 'listening', startedAt: 0, level: 0.4 })],
    ['processing', snapshot({
      status: 'processing', sessionId: 'processing', startedAt: 0,
      stage: 'transcribing', progress: 0.5,
    })],
    ['success', snapshot({ status: 'success', sessionId: 'success', output: 'copied' })],
    ['cancelled', snapshot({ status: 'cancelled', sessionId: 'cancelled' })],
    ['error', snapshot({ status: 'error', sessionId: 'error', code: 'NO_SPEECH' })],
  ] as const)('reports active for %s snapshots', (_name, activeSnapshot) => {
    const onPresentationChange = vi.fn<(presentation: WidgetPresentation) => void>()
    render(
      <WidgetApp
        snapshot={activeSnapshot}
        platform="win32" now={0}
        onPresentationChange={onPresentationChange}
      />,
    )

    expect(onPresentationChange).toHaveBeenCalledOnce()
    expect(onPresentationChange).toHaveBeenCalledWith('active')
  })

  it('returns to idle-resting when an idle drag ends', () => {
    const onPresentationChange = vi.fn<(presentation: WidgetPresentation) => void>()
    render(
      <WidgetApp
        snapshot={snapshot({ status: 'idle' })}
        platform="win32" now={0}
        onPresentationChange={onPresentationChange}
      />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.mouseEnter(sliver)
    expect(onPresentationChange).toHaveBeenLastCalledWith('idle-hovered')
    fireEvent.pointerDown(sliver, {
      pointerId: 9, button: 0, isPrimary: true, screenX: 10, screenY: 10,
    })
    fireEvent.pointerMove(sliver, { pointerId: 9, screenX: 40, screenY: 10 })
    expect(onPresentationChange).toHaveBeenLastCalledWith('idle-hovered')
    fireEvent.pointerUp(sliver, { pointerId: 9, screenX: 40, screenY: 10 })
    expect(onPresentationChange).toHaveBeenLastCalledWith('idle-resting')
  })

  it('collapses the expanded sliver when a drag finishes and snaps the window away', () => {
    const onDrag = vi.fn()
    render(
      <WidgetApp snapshot={snapshot({ status: 'idle' })} platform="win32" now={0} onDrag={onDrag} />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.mouseEnter(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')

    fireEvent.pointerDown(sliver, { pointerId: 9, button: 0, isPrimary: true, screenX: 10, screenY: 10 })
    fireEvent.pointerMove(sliver, { pointerId: 9, screenX: 40, screenY: 10 })
    fireEvent.pointerUp(sliver, { pointerId: 9, screenX: 40, screenY: 10 })

    expect(onDrag).toHaveBeenLastCalledWith({ phase: 'end', generation: 0, gestureId: expect.any(Number) })
    expect(sliver).not.toHaveAttribute('data-expanded')
  })
})

describe('WidgetEntry', () => {
  it('subscribes once per StrictMode mount lifecycle, routes commands, and cleans up', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const unsubscribe = vi.fn()
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: vi.fn((next) => {
        listener = next
        return unsubscribe
      }),
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const view = render(
      <StrictMode><WidgetEntry bridge={bridge} platform="win32" preview={null} /></StrictMode>,
    )
    expect(bridge.onWidgetState).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    act(() => listener?.(snapshot({
      status: 'listening', sessionId: 'live', startedAt: Date.now(), level: 0.4, cancellable: true,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
    expect(bridge.requestStop).toHaveBeenCalledOnce()
    expect(bridge.requestCancel).toHaveBeenCalledOnce()
    expect(bridge.requestToggle).not.toHaveBeenCalled()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('routes idle sliver clicks to toggle and capsule surface clicks to stop', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)

    act(() => listener?.(snapshot({ status: 'idle' })))
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'idle-resting',
      generation: 0,
    })
    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.mouseEnter(sliver)
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'idle-hovered',
      generation: 0,
    })
    fireEvent.click(sliver)
    expect(bridge.requestToggle).toHaveBeenCalledTimes(1)

    act(() => listener?.(snapshot({
      status: 'listening', sessionId: 'click', startedAt: Date.now(), level: 0.4,
      cancellable: true,
    })))
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'active',
      generation: 0,
    })
    fireEvent.click(container.querySelector('.widget-capsule')!)
    expect(bridge.requestStop).toHaveBeenCalledTimes(1)
    expect(bridge.requestToggle).toHaveBeenCalledTimes(1)
  })

  it('reports drag phases through the widget bridge', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)

    act(() => listener?.(snapshot({ status: 'idle' })))
    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, { pointerId: 3, button: 0, isPrimary: true, screenX: 50, screenY: 60 })
    fireEvent.pointerMove(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    fireEvent.pointerUp(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    expect(vi.mocked(bridge.reportDrag).mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start', generation: 0, gestureId: expect.any(Number) },
      { phase: 'move', generation: 0, gestureId: expect.any(Number) },
      { phase: 'end', generation: 0, gestureId: expect.any(Number) },
    ])
    expect(bridge.requestToggle).not.toHaveBeenCalled()
  })

  it('republishes an unchanged presentation for every visibility generation', () => {
    let stateListener: ((state: WidgetSnapshot) => void) | null = null
    let visibilityListener: ((visibility: { visible: boolean; generation: number }) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        stateListener = next
        return () => { stateListener = null }
      },
      onWidgetVisibilityChange: ((next: typeof visibilityListener) => {
        visibilityListener = next
        return () => { visibilityListener = null }
      }) as unknown as SottoWidgetBridge['onWidgetVisibilityChange'],
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    act(() => stateListener?.(snapshot({ status: 'idle' })))
    vi.mocked(bridge.setPresentation).mockClear()

    act(() => visibilityListener?.({ visible: false, generation: 2 }))
    act(() => visibilityListener?.({ visible: true, generation: 3 }))

    expect(vi.mocked(bridge.setPresentation).mock.calls.map(([report]) => report)).toEqual([
      { presentation: 'idle-resting', generation: 2 },
      { presentation: 'idle-resting', generation: 3 },
    ])
  })

  it('binds every renderer drag phase to the generation where the gesture started', () => {
    let stateListener: ((state: WidgetSnapshot) => void) | null = null
    let visibilityListener: ((visibility: { visible: boolean; generation: number }) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        stateListener = next
        return () => { stateListener = null }
      },
      onWidgetVisibilityChange: ((next: typeof visibilityListener) => {
        visibilityListener = next
        return () => { visibilityListener = null }
      }) as unknown as SottoWidgetBridge['onWidgetVisibilityChange'],
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    act(() => visibilityListener?.({ visible: true, generation: 7 }))
    act(() => stateListener?.(snapshot({ status: 'idle' })))

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, {
      pointerId: 3, button: 0, isPrimary: true, screenX: 50, screenY: 60,
    })
    fireEvent.pointerMove(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    act(() => visibilityListener?.({ visible: false, generation: 8 }))

    expect(vi.mocked(bridge.reportDrag).mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start', generation: 7, gestureId: expect.any(Number) },
      { phase: 'move', generation: 7, gestureId: expect.any(Number) },
      { phase: 'end', generation: 7, gestureId: expect.any(Number) },
    ])
  })

  it('resets idle hover state across native hide and reveal', () => {
    vi.useFakeTimers()
    let stateListener: ((state: WidgetSnapshot) => void) | null = null
    let visibilityListener: ((visibility: { visible: boolean; generation: number }) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        stateListener = next
        return () => { stateListener = null }
      },
      onWidgetVisibilityChange: (next) => {
        visibilityListener = next
        return () => { visibilityListener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)

    act(() => stateListener?.(snapshot({ status: 'idle' })))
    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.mouseEnter(sliver)
    fireEvent.mouseLeave(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'idle-hovered',
      generation: 0,
    })
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      visibilityListener?.({ visible: false, generation: 1 })
      visibilityListener?.({ visible: true, generation: 2 })
    })

    expect(sliver).not.toHaveAttribute('data-expanded')
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'idle-resting',
      generation: 2,
    })
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.mouseEnter(sliver)
    expect(sliver).toHaveAttribute('data-expanded', 'true')
    expect(bridge.setPresentation).toHaveBeenLastCalledWith({
      presentation: 'idle-hovered',
      generation: 2,
    })
  })

  it('terminates the renderer drag gesture when the native widget becomes hidden', () => {
    let stateListener: ((state: WidgetSnapshot) => void) | null = null
    let visibilityListener: ((visibility: { visible: boolean; generation: number }) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        stateListener = next
        return () => { stateListener = null }
      },
      onWidgetVisibilityChange: (next) => {
        visibilityListener = next
        return () => { visibilityListener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)

    act(() => stateListener?.(snapshot({ status: 'idle' })))
    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, {
      pointerId: 3, button: 0, isPrimary: true, screenX: 50, screenY: 60,
    })
    fireEvent.pointerMove(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    expect(container.querySelector('.widget-shell')).toHaveAttribute('data-dragging', 'true')

    act(() => visibilityListener?.({ visible: false, generation: 1 }))

    expect(container.querySelector('.widget-shell')).not.toHaveAttribute('data-dragging')
    expect(vi.mocked(bridge.reportDrag).mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start', generation: 0, gestureId: expect.any(Number) },
      { phase: 'move', generation: 0, gestureId: expect.any(Number) },
      { phase: 'end', generation: 0, gestureId: expect.any(Number) },
    ])
    fireEvent.pointerUp(window, { pointerId: 3 })
    expect(vi.mocked(bridge.reportDrag).mock.calls.filter(
      ([payload]) => payload.phase === 'end',
    )).toHaveLength(1)
  })

  it('fails closed without a bridge and applies/removes root theme and motion attributes', () => {
    const { rerender, container, unmount } = render(<WidgetEntry bridge={undefined} platform="win32" preview={null} />)
    const polite = screen.getByRole('status')
    const assertive = screen.getByRole('alert')
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toBeEmptyDOMElement()
    expect(container.querySelector('.widget-shell')).not.toBeInTheDocument()

    rerender(<WidgetEntry bridge={undefined} platform="win32" preview={snapshot({ status: 'idle', theme: 'light', reducedMotion: 'on' })} />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-reduced-motion', 'on')
    rerender(<WidgetEntry bridge={undefined} platform="win32" preview={snapshot({ status: 'idle', theme: 'system', reducedMotion: 'system' })} />)
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
  })

  it('keeps persistent announcement channels across null, idle, normal, success, and error states', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    const polite = screen.getByRole('status')
    const assertive = screen.getByRole('alert')
    expect(polite).toHaveAttribute('aria-live', 'polite')
    expect(polite).toHaveAttribute('aria-atomic', 'true')
    expect(assertive).toHaveAttribute('aria-live', 'assertive')
    expect(assertive).toHaveAttribute('aria-atomic', 'true')
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toBeEmptyDOMElement()

    const emit = (next: WidgetSnapshot): void => {
      act(() => listener?.(next))
      expect(screen.getByRole('status')).toBe(polite)
      expect(screen.getByRole('alert')).toBe(assertive)
    }

    emit(snapshot({ status: 'idle' }))
    expect(container.querySelector('.widget-sliver')).toBeInTheDocument()
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({ status: 'requesting-permission', sessionId: 'announce', cancellable: true }))
    expect(polite).toHaveTextContent(`Waiting for microphone. ${win32Copy.widgetPermissionPromptDetail}`)
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({
      status: 'listening', sessionId: 'announce', startedAt: Date.now() - 1_000,
      level: 0.4, cancellable: true,
    }))
    expect(polite).toHaveTextContent('Listening. Ctrl+Shift+Space to finish')
    expect(assertive).toBeEmptyDOMElement()
    expect(polite.contains(screen.getByTestId('listening-bars'))).toBe(false)
    expect(polite.contains(container.querySelector('time'))).toBe(false)

    emit(snapshot({
      status: 'processing', sessionId: 'announce', startedAt: Date.now() - 1_000,
      stage: 'transcribing', progress: 0.58, cancellable: true,
    }))
    expect(polite).toHaveTextContent(`Transcribing locally. ${win32Copy.widgetProcessingDetail}`)
    expect(assertive).toBeEmptyDOMElement()
    expect(polite.contains(screen.getByRole('progressbar'))).toBe(false)
    expect(polite).not.toHaveTextContent('58%')

    emit(snapshot({ status: 'success', sessionId: 'announce', output: 'pasted' }))
    expect(polite).toHaveTextContent('Pasted. Text delivered')
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({ status: 'error', sessionId: 'announce', code: 'TRANSCRIPTION_FAILED' }))
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toHaveTextContent('Couldn’t transcribe. Try again or choose the Standard model.')
    expect(assertive.querySelector('[role="meter"], time, [role="progressbar"]')).toBeNull()

    emit(snapshot({ status: 'idle' }))
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toBeEmptyDOMElement()
    expect(container.querySelector('.widget-sliver')).toBeInTheDocument()
  })

  it('ticks the listening timer without changing the immutable snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const state = snapshot({ status: 'listening', sessionId: 'timer', startedAt: 0, level: 0.2 })
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    act(() => listener?.(state))
    expect(screen.getByText('00:01')).toBeVisible()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('00:02')).toBeVisible()
    expect(state).toEqual(expect.objectContaining({ startedAt: 0, level: 0.2 }))
  })

  it('contains rejected widget command promises without exposing an error', async () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => undefined
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(async () => Promise.reject(new Error('private toggle failure'))),
      requestStop: vi.fn(async () => Promise.reject(new Error('private stop failure'))),
      requestCancel: vi.fn(async () => Promise.reject(new Error('private cancel failure'))),
      setPresentation: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    act(() => listener?.(snapshot({
      status: 'listening', sessionId: 'rejected', startedAt: Date.now(), level: 0.2,
      cancellable: true,
    })))
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }))
    await act(async () => Promise.resolve())
    expect(container).not.toHaveTextContent('private stop failure')
    expect(container).not.toHaveTextContent('private cancel failure')
  })
})

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

  it('keeps widget source clean and the canvas transparent with complete motion overrides', () => {
    const source = readFileSync('src/renderer/src/widget/WidgetApp.tsx', 'utf8')
    const css = readFileSync('src/renderer/src/widget/widget.css', 'utf8')
    expect(`${source}\n${css}`).not.toMatch(/[\u00e2\ufffd]/)
    expect(css).toMatch(/html,\s*\nbody,\s*\n#root[\s\S]*background: transparent/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(":root[data-reduced-motion='on']")
    expect(css).toContain('@keyframes widget-bar')
    // The wave is gated on the voice: the bars rest at the keyframe floor and
    // only loop while the renderer marks the container as speaking. The loop
    // shorthand must stay on the base rule — the per-bar stagger below is a
    // lower-specificity animation-delay, so hoisting the shorthand into the
    // [data-speaking] rule would reset every delay to 0s and the seven bars
    // would rise in phase instead of rippling.
    expect(css).toMatch(
      /\.widget-bars__bar \{[\s\S]*?height: 5px;[\s\S]*?animation: widget-bar 0\.9s ease-in-out infinite;\r?\n {2}transition: height/,
    )
    expect(css).toMatch(
      /\.widget-bars:not\(\[data-speaking\]\) \.widget-bars__bar \{\r?\n {2}animation: none;\r?\n\}/,
    )
    // Outside the reduced-motion overrides nothing may re-declare the
    // animation shorthand on the speaking variant.
    const motionOverrides = css.indexOf('/* ---- motion overrides ---- */')
    expect(motionOverrides).toBeGreaterThan(0)
    expect(css.slice(0, motionOverrides)).not.toMatch(
      /\.widget-bars\[data-speaking\] \.widget-bars__bar \{[^}]*animation:/,
    )
    // The stagger stays intact and lower-specificity, one delay per bar.
    expect([...css.matchAll(/\.widget-bars__bar:nth-child\((\d)\) \{\r?\n {2}animation-delay: ([\d.]+s);/g)]
      .map(([, index, delay]) => [index, delay])).toEqual([
      ['2', '0.12s'], ['3', '0.24s'], ['4', '0.36s'],
      ['5', '0.48s'], ['6', '0.6s'], ['7', '0.72s'],
    ])
    // Reduced motion never loops; it answers the voice by height alone, with
    // no transition of its own.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\n {2}\.widget-bars__bar \{\r?\n {4}animation: none;\r?\n {4}height: 5px;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\n {2}\.widget-bars\[data-speaking\] \.widget-bars__bar \{\r?\n {4}animation: none;\r?\n {4}height: 11px;/,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.widget-bars__bar,\s*\n\s*\.widget-capsule,[\s\S]*?transition: none;/,
    )
    expect(css).toContain(
      ":root[data-reduced-motion='on'] .widget-bars[data-speaking] .widget-bars__bar",
    )
    expect(css).toContain(":root[data-reduced-motion='on'] .widget-bars__bar,")
    // The retired orb style left nothing behind.
    expect(`${source}\n${css}`).not.toMatch(/orb(?!it)/i)
    expect(`${source}\n${css}`).not.toContain('widget-dot')
    expect(`${source}\n${css}`).not.toContain('data-widget-style')
    // The hover-expand affordance fully replaced the old floating tooltip.
    expect(`${source}\n${css}`).not.toContain('widget-sliver__hint')
    // The leading app mark is sized from the stylesheet, never inline.
    expect(source).toContain('data-testid="widget-glyph"')
    expect(css).toMatch(/\.widget-glyph__mark \{[\s\S]*?width: 22px;/)
    expect(source).not.toMatch(/<svg/)
    // Both orientations are styled off the shell orientation attribute.
    expect(css).toContain("[data-orientation='vertical']")
    // Reduced motion silences the sliver expansion and prompt transitions.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.widget-sliver__prompt \{\s*\n\s*transition: none;/,
    )
    expect(css).toContain(":root[data-reduced-motion='on'] .widget-sliver__prompt")
  })
})
