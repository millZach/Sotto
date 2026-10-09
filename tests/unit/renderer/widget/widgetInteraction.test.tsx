import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { WidgetApp } from '../../../../src/renderer/src/widget/WidgetApp'
import type { WidgetPresentation } from '../../../../src/shared/contracts'
import { setupWidgetTests, snapshot } from '../../../fixtures/renderer/widgetHarness'

setupWidgetTests()

describe('WidgetApp', () => {

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
