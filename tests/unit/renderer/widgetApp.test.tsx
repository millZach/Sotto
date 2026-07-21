import { readFileSync } from 'node:fs'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React, { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TalkTypeWidgetBridge } from '../../../src/shared/contracts'
import type { WidgetErrorCode, WidgetSnapshot } from '../../../src/shared/dictation'
import {
  WidgetApp,
  WidgetEntry,
  formatElapsedTime,
  isVisualPreviewEnabled,
  parseVisualPreview,
} from '../../../src/renderer/src/widget/WidgetApp'

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

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-reduced-motion')
  vi.useRealTimers()
})

describe('WidgetApp', () => {
  it('renders idle, permission, listening, success, and cancelled without private content', () => {
    const privateFields = { text: 'private transcript', audio: [0.25], message: 'raw failure' }
    const { rerender, container } = render(
      <WidgetApp snapshot={snapshot({ status: 'idle', ...privateFields })} now={15_340} />,
    )
    expect(screen.getByTestId('widget-sliver')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+Space to dictate')).toBeInTheDocument()
    expect(screen.getByText('Click to dictate')).toBeInTheDocument()

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'requesting-permission', sessionId: 'permission', cancellable: true, ...privateFields,
        })}
        now={15_340}
      />,
    )
    expect(screen.getByText('Waiting for microphone')).toBeVisible()
    expect(screen.getByText('Waiting for microphone')).toHaveAttribute(
      'title',
      'Approve access in Windows',
    )

    rerender(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'listening', startedAt: 3_000, level: 0.65,
          cancellable: true, ...privateFields,
        })}
        now={15_340}
      />,
    )
    expect(screen.getByText('00:12')).toBeVisible()
    expect(screen.getAllByTestId('level-bar')).toHaveLength(12)
    expect(screen.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('aria-valuenow', '65')

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'success', sessionId: 'success', output: 'pasted', ...privateFields })}
        now={15_340}
      />,
    )
    expect(screen.getByText('Pasted')).toBeVisible()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'success', sessionId: 'success', output: 'copied', ...privateFields })}
        now={15_340}
      />,
    )
    expect(screen.getByText('Copied — paste manually')).toBeVisible()

    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'cancelled', sessionId: 'cancelled', ...privateFields })}
        now={15_340}
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
        now={4_000}
      />,
    )
    expect(screen.getByText(label)).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43')
    expect(screen.getByTestId('processing-orbit')).toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it.each<[WidgetErrorCode, string, string]>([
    ['MIC_PERMISSION_DENIED', 'Microphone blocked', 'Allow microphone access in Windows Settings.'],
    ['MIC_DEVICE_NOT_FOUND', 'No microphone found', 'Connect a microphone and try again.'],
    ['MIC_START_FAILED', 'Microphone unavailable', 'Check the selected microphone and try again.'],
    ['RECORDING_FAILED', 'Recording stopped', 'Check your microphone and try again.'],
    ['NO_SPEECH', 'No speech detected', 'Speak closer to the microphone and try again.'],
    ['TRANSCRIPTION_FAILED', 'Couldn’t transcribe', 'Try again or choose the Balanced model.'],
    ['OUTPUT_UNAVAILABLE', 'Output unavailable', 'Open TalkType and try again.'],
    ['OUTPUT_FAILED', 'Couldn’t copy text', 'Try again from the TalkType app.'],
    ['HISTORY_FAILED', 'Saved to clipboard', 'Local history was not updated.'],
    ['SETTINGS_UNAVAILABLE', 'Settings unavailable', 'Open TalkType to restore settings.'],
  ])('maps %s to finite safe recovery copy', (code, title, recovery) => {
    const { container } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'error', sessionId: 'error', code,
          message: 'C:\\Users\\private\\raw-model-error',
        })}
        now={0}
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
        now={1_000}
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
        now={1_000}
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
        now={0}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'requesting-permission', sessionId: 'permission', cancellable: true })}
        now={0}
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
        now={0}
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

  it('derives all twelve listening bars from the one bounded scalar level', () => {
    const { rerender } = render(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'one', startedAt: 0, level: 0 })}
        now={0}
      />,
    )
    const quiet = screen.getAllByTestId('level-bar').map((bar) => bar.getAttribute('style'))
    rerender(
      <WidgetApp
        snapshot={snapshot({ status: 'listening', sessionId: 'one', startedAt: 0, level: 1 })}
        now={0}
      />,
    )
    const loud = screen.getAllByTestId('level-bar').map((bar) => bar.getAttribute('style'))
    expect(new Set(quiet).size).toBeGreaterThan(2)
    expect(quiet).not.toEqual(loud)
  })

  it('keeps visible copy readable but non-live', () => {
    const { container, rerender } = render(
      <WidgetApp
        snapshot={snapshot({
          status: 'listening', sessionId: 'announced', startedAt: 0, level: 0.2,
          cancellable: true,
        })}
        now={1_000}
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
        now={2_000}
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
      <WidgetApp snapshot={snapshot({ status: 'idle' })} now={0} onToggle={onToggle} />,
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
        now={1_000}
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
      <WidgetApp snapshot={snapshot({ status: 'idle' })} now={0} onToggle={onToggle} onDrag={onDrag} />,
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
      <WidgetApp snapshot={snapshot({ status: 'idle' })} now={0} onToggle={onToggle} onDrag={onDrag} />,
    )

    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, { pointerId: 1, button: 0, isPrimary: true, screenX: 100, screenY: 100 })
    fireEvent.pointerMove(sliver, { pointerId: 1, screenX: 120, screenY: 90 })
    fireEvent.pointerMove(sliver, { pointerId: 1, screenX: 150, screenY: 130 })
    fireEvent.pointerUp(sliver, { pointerId: 1, screenX: 150, screenY: 130 })
    fireEvent.click(sliver)

    expect(onToggle).not.toHaveBeenCalled()
    expect(onDrag.mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start' },
      { phase: 'move', deltaX: 20, deltaY: -10 },
      { phase: 'move', deltaX: 50, deltaY: 30 },
      { phase: 'end' },
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
        now={1_000}
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
    expect(onDrag).toHaveBeenLastCalledWith({ phase: 'end' })

    onDrag.mockClear()
    const stop = screen.getByRole('button', { name: 'Stop dictation' })
    fireEvent.pointerDown(stop, { pointerId: 2, button: 0, isPrimary: true, screenX: 10, screenY: 10 })
    fireEvent.pointerMove(capsule, { pointerId: 2, screenX: 60, screenY: 60 })
    fireEvent.pointerUp(capsule, { pointerId: 2, screenX: 60, screenY: 60 })
    fireEvent.click(stop)
    expect(onDrag).not.toHaveBeenCalled()
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('never exposes Electron accelerator vocabulary in the resting hint', () => {
    render(
      <WidgetApp
        snapshot={snapshot({
          status: 'idle',
          shortcut: 'CommandOrControl+Shift+Space',
        })}
        now={1_000}
      />,
    )
    expect(screen.getByText('Ctrl+Shift+Space to dictate')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('CommandOrControl')
  })
})

describe('WidgetEntry', () => {
  it('subscribes once per StrictMode mount lifecycle, routes commands, and cleans up', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const unsubscribe = vi.fn()
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: vi.fn((next) => {
        listener = next
        return unsubscribe
      }),
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const view = render(
      <StrictMode><WidgetEntry bridge={bridge} preview={null} /></StrictMode>,
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
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} preview={null} />)

    act(() => listener?.(snapshot({ status: 'idle' })))
    fireEvent.click(screen.getByTestId('widget-sliver'))
    expect(bridge.requestToggle).toHaveBeenCalledTimes(1)

    act(() => listener?.(snapshot({
      status: 'listening', sessionId: 'click', startedAt: Date.now(), level: 0.4,
      cancellable: true,
    })))
    fireEvent.click(container.querySelector('.widget-capsule')!)
    expect(bridge.requestStop).toHaveBeenCalledTimes(1)
    expect(bridge.requestToggle).toHaveBeenCalledTimes(1)
  })

  it('reports drag phases through the widget bridge', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} preview={null} />)

    act(() => listener?.(snapshot({ status: 'idle' })))
    const sliver = screen.getByTestId('widget-sliver')
    fireEvent.pointerDown(sliver, { pointerId: 3, button: 0, isPrimary: true, screenX: 50, screenY: 60 })
    fireEvent.pointerMove(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    fireEvent.pointerUp(sliver, { pointerId: 3, screenX: 80, screenY: 60 })
    expect(vi.mocked(bridge.reportDrag).mock.calls.map(([payload]) => payload)).toEqual([
      { phase: 'start' },
      { phase: 'move', deltaX: 30, deltaY: 0 },
      { phase: 'end' },
    ])
    expect(bridge.requestToggle).not.toHaveBeenCalled()
  })

  it('fails closed without a bridge and applies/removes root theme and motion attributes', () => {
    const { rerender, container, unmount } = render(<WidgetEntry bridge={undefined} preview={null} />)
    const polite = screen.getByRole('status')
    const assertive = screen.getByRole('alert')
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toBeEmptyDOMElement()
    expect(container.querySelector('.widget-shell')).not.toBeInTheDocument()

    rerender(<WidgetEntry bridge={undefined} preview={snapshot({ status: 'idle', theme: 'light', reducedMotion: 'on' })} />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-reduced-motion', 'on')
    rerender(<WidgetEntry bridge={undefined} preview={snapshot({ status: 'idle', theme: 'system', reducedMotion: 'system' })} />)
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
  })

  it('keeps persistent announcement channels across null, idle, normal, success, and error states', () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} preview={null} />)
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
    expect(polite).toHaveTextContent('Waiting for microphone. Approve access in Windows')
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({
      status: 'listening', sessionId: 'announce', startedAt: Date.now() - 1_000,
      level: 0.4, cancellable: true,
    }))
    expect(polite).toHaveTextContent('Listening. Ctrl+Shift+Space to finish')
    expect(assertive).toBeEmptyDOMElement()
    expect(polite.contains(screen.getByRole('meter'))).toBe(false)
    expect(polite.contains(container.querySelector('time'))).toBe(false)

    emit(snapshot({
      status: 'processing', sessionId: 'announce', startedAt: Date.now() - 1_000,
      stage: 'transcribing', progress: 0.58, cancellable: true,
    }))
    expect(polite).toHaveTextContent('Transcribing locally. Audio stays on this PC')
    expect(assertive).toBeEmptyDOMElement()
    expect(polite.contains(screen.getByRole('progressbar'))).toBe(false)
    expect(polite).not.toHaveTextContent('58%')

    emit(snapshot({ status: 'success', sessionId: 'announce', output: 'pasted' }))
    expect(polite).toHaveTextContent('Pasted. Text delivered')
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({ status: 'error', sessionId: 'announce', code: 'TRANSCRIPTION_FAILED' }))
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toHaveTextContent('Couldn’t transcribe. Try again or choose the Balanced model.')
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
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      requestToggle: vi.fn(async () => ({ ok: true })),
      requestStop: vi.fn(async () => ({ ok: true })),
      requestCancel: vi.fn(async () => ({ ok: true })),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    render(<WidgetEntry bridge={bridge} preview={null} />)
    act(() => listener?.(state))
    expect(screen.getByText('00:01')).toBeVisible()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('00:02')).toBeVisible()
    expect(state).toEqual(expect.objectContaining({ startedAt: 0, level: 0.2 }))
  })

  it('contains rejected widget command promises without exposing an error', async () => {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: TalkTypeWidgetBridge = {
      onWidgetState: (next) => {
        listener = next
        return () => undefined
      },
      requestToggle: vi.fn(async () => Promise.reject(new Error('private toggle failure'))),
      requestStop: vi.fn(async () => Promise.reject(new Error('private stop failure'))),
      requestCancel: vi.fn(async () => Promise.reject(new Error('private cancel failure'))),
      setMouseInteractive: vi.fn(async () => ({ ok: true })),
      reportDrag: vi.fn(async () => ({ ok: true })),
    }
    const { container } = render(<WidgetEntry bridge={bridge} preview={null} />)
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
    Object.defineProperty(immutable, '__TALKTYPE_VISUAL_PREVIEW__', {
      value: true, writable: false, configurable: false,
    })
    expect(isVisualPreviewEnabled(immutable, '1')).toBe(true)
    for (const disabled of [undefined, '', '0', 'true', '01', ' 1', '1 ']) {
      expect(isVisualPreviewEnabled(immutable, disabled)).toBe(false)
    }

    const writable = {} as Window
    Object.defineProperty(writable, '__TALKTYPE_VISUAL_PREVIEW__', {
      value: true, writable: true, configurable: false,
    })
    expect(isVisualPreviewEnabled(writable, '1')).toBe(false)

    const configurable = {} as Window
    Object.defineProperty(configurable, '__TALKTYPE_VISUAL_PREVIEW__', {
      value: true, writable: false, configurable: true,
    })
    expect(isVisualPreviewEnabled(configurable, '1')).toBe(false)
    expect(isVisualPreviewEnabled({} as Window, '1')).toBe(false)
  })

  it('keeps widget source clean and the canvas transparent with complete motion overrides', () => {
    const source = readFileSync('src/renderer/src/widget/WidgetApp.tsx', 'utf8')
    const css = readFileSync('src/renderer/src/widget/widget.css', 'utf8')
    expect(`${source}\n${css}`).not.toMatch(/[\u00e2\ufffd]/)
    expect(css).toMatch(/html,\s*\nbody,\s*\n#root[\s\S]*background: transparent/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain(":root[data-reduced-motion='on']")
    expect(css).toContain('@keyframes widget-orbit')
    expect(css).not.toMatch(/widget-levels[^}]*animation:/)
  })
})
