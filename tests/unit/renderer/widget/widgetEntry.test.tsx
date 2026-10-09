import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { Profiler, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { WidgetEntry } from '../../../../src/renderer/src/widget/WidgetApp'
import type { AgentBridge, AgentState } from '../../../../src/shared/agents'
import type { SottoWidgetBridge } from '../../../../src/shared/contracts'
import { type WidgetSnapshot } from '../../../../src/shared/dictation'
import { DEFAULT_WIDGET_PALETTE, themeBrand, widgetPaletteFor } from '../../../../src/shared/themeBranding'
import { agentWireBridge } from '../../../fixtures/agentBridge'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { commandSucceeded, setupWidgetTests, snapshot, win32Copy } from '../../../fixtures/renderer/widgetHarness'

setupWidgetTests()

describe('WidgetEntry', () => {
  function liveBridge() {
    let listener: ((state: WidgetSnapshot) => void) | null = null
    const bridge: SottoWidgetBridge = {
      platform: 'win32',
      onWidgetState: (next) => {
        listener = next
        return () => { listener = null }
      },
      onWidgetVisibilityChange: () => () => undefined,
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
    }
    return { bridge, emit: (next: WidgetSnapshot) => act(() => listener?.(next)) }
  }

  it('repaints the mark, voice bars and surfaces live when a new palette arrives, without a new session', async () => {
    const { bridge, emit } = liveBridge()
    render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
    const nocturne = widgetPaletteFor({ lightTheme: 'nocturne', darkTheme: 'nocturne', customThemes: [] })
    const citrine = widgetPaletteFor({ lightTheme: 'nocturne', darkTheme: 'citrine', customThemes: [] })
    const listening = { status: 'listening', sessionId: 'live', startedAt: Date.now(), level: 0.4, cancellable: true } as const
    const root = document.documentElement

    emit(snapshot({ ...listening, theme: 'dark', palette: nocturne }))
    expect(screen.getByTestId('listening-bars')).toBeInTheDocument()
    expect(root.style.getPropertyValue('--theme-accent')).toBe(nocturne.dark.accent)
    expect(screen.getByTestId('widget-glyph').querySelector('svg')).toHaveAttribute('data-tile', themeBrand(nocturne.dark, 'dark').tile)

    // Same session, next level update carries the newly selected dark half.
    emit(snapshot({ ...listening, level: 0.5, theme: 'dark', palette: citrine }))
    expect(root.style.getPropertyValue('--theme-accent')).toBe(citrine.dark.accent)
    expect(root.style.getPropertyValue('--theme-surface-raised')).toBe(citrine.dark.surfaceRaised)
    expect(root.style.getPropertyValue('--theme-error-foreground')).toBe(citrine.dark.errorForeground)
    await waitFor(() => expect(screen.getByTestId('widget-glyph').querySelector('svg')).toHaveAttribute('data-tile', themeBrand(citrine.dark, 'dark').tile))
    expect(themeBrand(citrine.dark, 'dark').tile).not.toBe(themeBrand(nocturne.dark, 'dark').tile)

    // Back to idle keeps the theme; the resting sliver paints from the same roles.
    emit(snapshot({ status: 'idle', theme: 'dark', palette: citrine }))
    expect(screen.getByTestId('widget-sliver')).toBeInTheDocument()
    expect(root.style.getPropertyValue('--theme-accent')).toBe(citrine.dark.accent)
  })

  it('follows the system scheme live by painting the matching theme half', async () => {
    let dark = false
    const listeners = new Set<() => void>()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return dark },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })))
    try {
      const { bridge, emit } = liveBridge()
      render(<WidgetEntry bridge={bridge} platform="win32" preview={null} />)
      const palette = widgetPaletteFor({ lightTheme: 'tropic', darkTheme: 'citrine', customThemes: [] })
      emit(snapshot({ status: 'requesting-permission', sessionId: 'scheme', theme: 'system', palette, cancellable: true }))
      const root = document.documentElement
      expect(root).toHaveAttribute('data-theme', 'light')
      expect(root.style.getPropertyValue('--theme-accent')).toBe(palette.light.accent)
      const lightTile = screen.getByTestId('widget-glyph').querySelector('svg')!.getAttribute('data-tile')

      dark = true
      act(() => { for (const listener of listeners) listener() })
      expect(root).toHaveAttribute('data-theme', 'dark')
      expect(root.style.getPropertyValue('--theme-accent')).toBe(palette.dark.accent)
      await waitFor(() => expect(screen.getByTestId('widget-glyph').querySelector('svg')!.getAttribute('data-tile')).not.toBe(lightTile))
    } finally {
      vi.unstubAllGlobals()
    }
  })

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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
    expect(document.documentElement.style.getPropertyValue('--theme-accent')).toBe(DEFAULT_WIDGET_PALETTE.light.accent)
    // System resolves to a concrete half so the painted palette and the CSS scheme always agree.
    rerender(<WidgetEntry bridge={undefined} platform="win32" preview={snapshot({ status: 'idle', theme: 'system', reducedMotion: 'system' })} />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    expect(document.documentElement.style.getPropertyValue('--theme-accent')).toBe('')
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
    expect(polite).toHaveTextContent(`Transcribing. ${win32Copy.widgetProcessingDetail}`)
    expect(assertive).toBeEmptyDOMElement()
    expect(polite.contains(screen.getByRole('progressbar'))).toBe(false)
    expect(polite).not.toHaveTextContent('58%')

    emit(snapshot({ status: 'success', sessionId: 'announce', output: 'pasted' }))
    expect(polite).toHaveTextContent('Pasted. Text delivered')
    expect(assertive).toBeEmptyDOMElement()

    emit(snapshot({ status: 'error', sessionId: 'announce', code: 'TRANSCRIPTION_FAILED' }))
    expect(polite).toBeEmptyDOMElement()
    expect(assertive).toHaveTextContent('Couldn’t transcribe. Sotto did not get usable text back. The recording was not kept. Dictate again.')
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
      requestToggle: vi.fn(commandSucceeded),
      requestStop: vi.fn(commandSucceeded),
      requestCancel: vi.fn(commandSucceeded),
      requestRetry: vi.fn(commandSucceeded),
      requestDismiss: vi.fn(commandSucceeded),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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
      requestRetry: vi.fn(async () => Promise.reject(new Error('private retry failure'))),
      requestDismiss: vi.fn(async () => Promise.reject(new Error('private dismiss failure'))),
      setPresentation: vi.fn(commandSucceeded),
      reportDrag: vi.fn(commandSucceeded),
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

  it('holds no agent connection while the voice coordinator is off, and a whole one when it turns on', async () => {
    const shells = new Set<(state: AgentState) => void>()
    let agentState = threadsStateFixture()
    const agents: AgentBridge = {
      get: vi.fn(async () => agentState),
      command: vi.fn(async () => agentState),
      onState: vi.fn((listener: (state: AgentState) => void) => { shells.add(listener); return () => { shells.delete(listener) } }),
    }
    const { bridge, emit } = liveBridge()
    let commits = 0
    render(<Profiler id="widget" onRender={() => { commits += 1 }}><WidgetEntry bridge={{ ...bridge, agents: agentWireBridge(agents) }} platform="win32" preview={null} /></Profiler>)
    /** One streamed chunk per shell, each a new state, the way main publishes while an agent works. */
    const stream = (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        agentState = { ...agentState, notice: `chunk ${index}` }
        act(() => { for (const listener of shells) listener(agentState) })
      }
    }

    emit(snapshot({ status: 'idle' }))
    emit(snapshot({ status: 'idle', voiceCoordinator: false }))
    await act(async () => Promise.resolve())
    const before = commits
    stream(100)
    expect(agents.onState).not.toHaveBeenCalled()
    expect(agents.get).not.toHaveBeenCalled()
    expect(commits - before).toBe(0)

    // Turning the coordinator on connects afresh: one subscription, one whole fetch, every shell drawn.
    emit(snapshot({ status: 'idle', voiceCoordinator: true }))
    await waitFor(() => expect(agents.get).toHaveBeenCalledTimes(1))
    expect(agents.onState).toHaveBeenCalledTimes(1)
    await act(async () => Promise.resolve())
    const connected = commits
    stream(100)
    expect(commits - connected).toBe(100)

    // And off again lets go of it.
    emit(snapshot({ status: 'idle', voiceCoordinator: false }))
    expect(shells.size).toBe(0)
  })
})
