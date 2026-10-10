// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { type Rectangle } from '../../../src/main/windows/windowManager'
import { createHarness, createMutableTwoDisplayAdapter, registerWidgetMonitorTimers, reportWidgetDrag, setWidgetPresentation } from '../../fixtures/windowManager'

describe('WindowManager cursor monitor following', () => {
  registerWidgetMonitorTimers()

  it('follows the cursor monitor in every widget presentation', async () => {
    const presentations = [
      {
        presentation: 'idle-resting' as const,
        bounds: { x: 1_538, y: 930, width: 124, height: 54 },
      },
      {
        presentation: 'idle-hovered' as const,
        bounds: { x: 1_476, y: 908, width: 248, height: 76 },
      },
      {
        presentation: 'active' as const,
        bounds: { x: 1_476, y: 896, width: 248, height: 88 },
      },
    ]

    for (const { bounds, presentation } of presentations) {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, windows } = createHarness({ display: adapter.display })
      await manager.showWidget()
      setWidgetPresentation(manager, presentation)
      const widget = windows[0]!
      widget.setBounds.mockClear()

      adapter.cursor.current = { x: 1_700, y: 970 }
      vi.advanceTimersByTime(200)

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenCalledWith(bounds, false)
      manager.dispose()
    }
  })

  it('preserves the edge and centers on the target monitor', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
  })

  it('does no native work while the cursor remains on one monitor', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setSize.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    adapter.cursor.current = { x: 900, y: 700 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setSize).not.toHaveBeenCalled()
  })

  it('pauses monitor following while drag ownership is active', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(1)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
  })

  it('resumes following after drag end', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    reportWidgetDrag(manager, 'start')
    adapter.cursor.current = { x: 1_700, y: 970 }
    reportWidgetDrag(manager, 'end')
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 908, width: 248, height: 76 },
      false,
    )
  })

  it('expands a vertical idle drag to the active footprint without releasing drag ownership', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'idle-hovered')
    expect(widget.bounds).toEqual({ x: 16, y: 338, width: 88, height: 124 })

    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()
    widget.setBounds.mockImplementationOnce((bounds: Rectangle): void => {
      widget.bounds = { ...bounds, x: bounds.x + 1, y: bounds.y + 2 }
    })

    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 338, width: 88, height: 248 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 17, y: 340, width: 88, height: 248 })
    expect(vi.getTimerCount()).toBe(1)

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(200)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).toHaveBeenCalledOnce()

    adapter.cursor.current = { x: 120, y: 130 }
    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).toHaveBeenCalledWith(37, 370, false)
  })

  it('shrinks a vertical active drag through idle presentations without leaving an oversized blocker', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({
      display: adapter.display,
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'active')
    expect(widget.bounds).toEqual({ x: 16, y: 276, width: 88, height: 248 })

    reportWidgetDrag(manager, 'start')
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()

    setWidgetPresentation(manager, 'idle-hovered')
    setWidgetPresentation(manager, 'idle-resting')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 276, width: 88, height: 124 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 16, y: 276, width: 88, height: 124 })

    adapter.cursor.current = { x: 130, y: 115 }
    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).toHaveBeenCalledWith(46, 291, false)
  })

  it.each([
    {
      initial: 'idle-hovered' as const,
      next: 'active' as const,
      initialBounds: { x: 16, y: 338, width: 88, height: 124 },
      desiredBounds: { x: 16, y: 338, width: 88, height: 248 },
    },
    {
      initial: 'active' as const,
      next: 'idle-hovered' as const,
      initialBounds: { x: 16, y: 276, width: 88, height: 248 },
      desiredBounds: { x: 16, y: 276, width: 88, height: 124 },
    },
  ])(
    'retries a failed $initial to $next resize while drag ownership is active',
    async ({ desiredBounds, initial, initialBounds, next }) => {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, windows } = createHarness({
        display: adapter.display,
        getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
      })
      await manager.showWidget()
      const widget = windows[0]!
      setWidgetPresentation(manager, initial)
      expect(widget.bounds).toEqual(initialBounds)

      reportWidgetDrag(manager, 'start')
      widget.setBounds.mockClear()
      adapter.getCursorScreenPoint.mockClear()
      adapter.getDisplayNearestPoint.mockClear()
      widget.setBounds.mockImplementationOnce(() => {
        throw new Error('native resize unavailable')
      })

      setWidgetPresentation(manager, next)

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.bounds).toEqual(initialBounds)

      vi.advanceTimersByTime(100)

      expect(widget.setBounds).toHaveBeenCalledTimes(2)
      expect(widget.setBounds).toHaveBeenLastCalledWith(desiredBounds, false)
      expect(widget.bounds).toEqual(desiredBounds)
      expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
      expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    },
  )

  it('retries after cursor or display lookup failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    adapter.getCursorScreenPoint.mockImplementationOnce(() => {
      throw new Error('cursor unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )

    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 100, y: 100 }
    adapter.getDisplayNearestPoint.mockImplementationOnce(() => {
      throw new Error('display unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
  })

  it('retries the same target monitor after a transient bounds failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    widget.setBounds.mockImplementationOnce(() => {
      throw new Error('native bounds unavailable')
    })

    vi.advanceTimersByTime(100)
    expect(widget.setBounds).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledTimes(2)
    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('reapplies snapped bounds after a drag move readback failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()

    reportWidgetDrag(manager, 'start')
    adapter.cursor.current = { x: 200, y: 100 }
    widget.getBounds.mockImplementationOnce(() => {
      throw new Error('post-move bounds unavailable')
    })

    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition).toHaveBeenCalledWith(476, 708, false)
    expect(widget.bounds).toEqual({ x: 476, y: 708, width: 248, height: 76 })

    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 376, y: 708, width: 248, height: 76 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })
  })

  it('reapplies desired bounds after a moved-event readback failure', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, onWidgetMoved, windows } = createHarness({
      display: adapter.display,
    })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
    widget.getBounds.mockImplementationOnce(() => {
      throw new Error('moved bounds unavailable')
    })

    widget.emit('moved')

    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
  })
})
