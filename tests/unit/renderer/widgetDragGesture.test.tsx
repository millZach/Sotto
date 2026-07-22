import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WidgetDragPhase } from '../../../src/shared/contracts'
import { useWidgetDragGesture } from '../../../src/renderer/src/widget/useWidgetDragGesture'

interface HarnessProps {
  readonly onClick?: () => void
  readonly onDrag?: (payload: WidgetDragPhase) => void
  readonly onDragFinished?: () => void
}

function Harness({ onClick, onDrag, onDragFinished }: HarnessProps): React.ReactNode {
  const gesture = useWidgetDragGesture(onClick, onDrag, onDragFinished)
  return (
    <div
      data-testid="surface"
      data-dragging={gesture.dragging || undefined}
      data-drag-active={gesture.isDragActive() || undefined}
      {...gesture.surfaceProps}
    />
  )
}

interface AnimationFrameHarness {
  readonly flushNext: () => void
  readonly pendingCount: () => number
}

function installAnimationFrameHarness(): AnimationFrameHarness {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId
    nextId += 1
    callbacks.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id)
  })
  return {
    flushNext: () => {
      const next = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
      if (next === undefined) return
      callbacks.delete(next[0])
      next[1](0)
    },
    pendingCount: () => callbacks.size,
  }
}

function beginDrag(surface: HTMLElement, pointerId = 1): void {
  fireEvent.pointerDown(surface, {
    pointerId,
    button: 0,
    isPrimary: true,
    screenX: 100,
    screenY: 100,
  })
  fireEvent.pointerMove(surface, {
    pointerId,
    screenX: 105,
    screenY: 100,
  })
}

function payloads(onDrag: ReturnType<typeof vi.fn>): unknown[] {
  return onDrag.mock.calls.map(([payload]) => payload)
}

let frames: AnimationFrameHarness

beforeEach(() => {
  frames = installAnimationFrameHarness()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useWidgetDragGesture', () => {
  it('keeps movement at or below four pixels as a click', () => {
    const onClick = vi.fn()
    const onDrag = vi.fn()
    render(<Harness onClick={onClick} onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    fireEvent.pointerDown(surface, {
      pointerId: 1, button: 0, isPrimary: true, screenX: 20, screenY: 30,
    })
    fireEvent.pointerMove(surface, { pointerId: 1, screenX: 24, screenY: 30 })
    fireEvent.pointerUp(surface, { pointerId: 1, screenX: 24, screenY: 30 })
    fireEvent.click(surface)

    expect(onDrag).not.toHaveBeenCalled()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('emits one start after crossing the threshold', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.pointerMove(surface, { pointerId: 1, screenX: 130, screenY: 140 })

    expect(payloads(onDrag)).toEqual([{ phase: 'start' }])
    expect(surface).toHaveAttribute('data-dragging', 'true')
    expect(surface).toHaveAttribute('data-drag-active', 'true')
  })

  it('coalesces high-frequency moves into one move per animation frame', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.pointerMove(surface, { pointerId: 1, screenX: 120, screenY: 100 })
    fireEvent.pointerMove(surface, { pointerId: 1, screenX: 140, screenY: 100 })
    expect(frames.pendingCount()).toBe(1)
    expect(payloads(onDrag)).toEqual([{ phase: 'start' }])

    frames.flushNext()
    expect(payloads(onDrag)).toEqual([{ phase: 'start' }, { phase: 'move' }])

    fireEvent.pointerMove(surface, { pointerId: 1, screenX: 160, screenY: 100 })
    expect(frames.pendingCount()).toBe(1)
    frames.flushNext()
    expect(payloads(onDrag)).toEqual([
      { phase: 'start' },
      { phase: 'move' },
      { phase: 'move' },
    ])
  })

  it('flushes a queued move before end', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    expect(frames.pendingCount()).toBe(1)
    fireEvent.pointerUp(surface, { pointerId: 1, screenX: 105, screenY: 100 })

    expect(payloads(onDrag)).toEqual([
      { phase: 'start' },
      { phase: 'move' },
      { phase: 'end' },
    ])
    expect(frames.pendingCount()).toBe(0)
    frames.flushNext()
    expect(onDrag).toHaveBeenCalledTimes(3)
  })

  it('completes terminal cleanup when a drag callback throws', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const release = vi.fn()
    const errors: Error[] = []
    const captureError = (event: ErrorEvent): void => {
      errors.push(event.error as Error)
      event.preventDefault()
    }
    const onDrag = vi.fn((payload: WidgetDragPhase) => {
      if (payload.phase === 'end') throw new Error('drag callback failed')
    })
    window.addEventListener('error', captureError)
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')
    surface.releasePointerCapture = release

    try {
      beginDrag(surface)
      fireEvent.pointerUp(surface, { pointerId: 1 })

      expect(errors.map((error) => error.message)).toEqual(['drag callback failed'])
      expect(surface).not.toHaveAttribute('data-dragging')
      expect(release).toHaveBeenCalledWith(1)
      for (const eventName of ['pointermove', 'pointerup', 'pointercancel']) {
        expect(remove.mock.calls.some(([name]) => name === eventName)).toBe(true)
      }
    } finally {
      window.removeEventListener('error', captureError)
    }
  })

  it('dispatches end and completion when a queued move callback throws', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const release = vi.fn()
    const onDragFinished = vi.fn(() => {
      throw new Error('completion callback failed')
    })
    const errors: Error[] = []
    const captureError = (event: ErrorEvent): void => {
      errors.push(event.error as Error)
      event.preventDefault()
    }
    const onDrag = vi.fn((payload: WidgetDragPhase) => {
      if (payload.phase === 'move') throw new Error('queued move callback failed')
      if (payload.phase === 'end') throw new Error('end callback failed')
    })
    window.addEventListener('error', captureError)
    render(<Harness onDrag={onDrag} onDragFinished={onDragFinished} />)
    const surface = screen.getByTestId('surface')
    surface.releasePointerCapture = release

    try {
      beginDrag(surface)
      fireEvent.pointerUp(surface, { pointerId: 1 })

      expect(errors.map((error) => error.message)).toEqual(['queued move callback failed'])
      expect(payloads(onDrag)).toEqual([
        { phase: 'start' },
        { phase: 'move' },
        { phase: 'end' },
      ])
      expect(onDragFinished).toHaveBeenCalledOnce()
      expect(surface).not.toHaveAttribute('data-dragging')
      expect(release).toHaveBeenCalledWith(1)
      for (const eventName of ['pointermove', 'pointerup', 'pointercancel']) {
        expect(remove.mock.calls.some(([name]) => name === eventName)).toBe(true)
      }
    } finally {
      window.removeEventListener('error', captureError)
    }
  })

  it('continues through window move and pointer-up when capture throws', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')
    surface.setPointerCapture = vi.fn(() => {
      throw new Error('capture unavailable')
    })

    fireEvent.pointerDown(surface, {
      pointerId: 7, button: 0, isPrimary: true, screenX: 10, screenY: 10,
    })
    fireEvent.pointerMove(window, { pointerId: 7, screenX: 20, screenY: 10 })
    fireEvent.pointerUp(window, { pointerId: 7, screenX: 20, screenY: 10 })

    expect(payloads(onDrag)).toEqual([
      { phase: 'start' },
      { phase: 'move' },
      { phase: 'end' },
    ])
  })

  it('ends exactly once on pointercancel', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.pointerCancel(surface, { pointerId: 1 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(payloads(onDrag).filter((payload) =>
      (payload as WidgetDragPhase).phase === 'end')).toHaveLength(1)
  })

  it('ends exactly once on lostpointercapture', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.lostPointerCapture(surface, { pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(payloads(onDrag).filter((payload) =>
      (payload as WidgetDragPhase).phase === 'end')).toHaveLength(1)
  })

  it('suppresses the click that follows lost pointer capture after a completed drag', () => {
    const onClick = vi.fn()
    render(<Harness onClick={onClick} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.lostPointerCapture(surface, { pointerId: 1 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
    fireEvent.click(surface)

    expect(onClick).not.toHaveBeenCalled()

    fireEvent.click(surface)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('ends exactly once on blur', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.blur(window)
    fireEvent.blur(window)
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(payloads(onDrag).filter((payload) =>
      (payload as WidgetDragPhase).phase === 'end')).toHaveLength(1)
  })

  it('ends exactly once when document becomes hidden', () => {
    const onDrag = vi.fn()
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(document, new Event('visibilitychange'))
    fireEvent.pointerUp(window, { pointerId: 1 })

    expect(payloads(onDrag).filter((payload) =>
      (payload as WidgetDragPhase).phase === 'end')).toHaveLength(1)
    if (descriptor === undefined) delete (document as unknown as { visibilityState?: string }).visibilityState
    else Object.defineProperty(document, 'visibilityState', descriptor)
  })

  it('ends exactly once on unmount', () => {
    const onDrag = vi.fn()
    const view = render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    view.unmount()
    view.unmount()

    expect(payloads(onDrag).filter((payload) =>
      (payload as WidgetDragPhase).phase === 'end')).toHaveLength(1)
  })

  it('removes temporary listeners through common cleanup', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.pointerCancel(window, { pointerId: 1 })

    for (const eventName of ['pointermove', 'pointerup', 'pointercancel']) {
      expect(remove.mock.calls.some(([name]) => name === eventName)).toBe(true)
    }
  })

  it('suppresses only the click following a completed drag', () => {
    const onClick = vi.fn()
    render(<Harness onClick={onClick} />)
    const surface = screen.getByTestId('surface')

    beginDrag(surface)
    fireEvent.pointerUp(surface, { pointerId: 1 })
    fireEvent.click(surface)
    expect(onClick).not.toHaveBeenCalled()

    fireEvent.click(surface)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('ignores secondary and non-primary pointers', () => {
    const onDrag = vi.fn()
    render(<Harness onDrag={onDrag} />)
    const surface = screen.getByTestId('surface')

    fireEvent.pointerDown(surface, {
      pointerId: 1, button: 2, isPrimary: true, screenX: 0, screenY: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 1, screenX: 20, screenY: 0 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    fireEvent.pointerDown(surface, {
      pointerId: 2, button: 0, isPrimary: false, screenX: 0, screenY: 0,
    })
    fireEvent.pointerMove(window, { pointerId: 2, screenX: 20, screenY: 0 })
    fireEvent.pointerUp(window, { pointerId: 2 })

    expect(onDrag).not.toHaveBeenCalled()
  })
})
