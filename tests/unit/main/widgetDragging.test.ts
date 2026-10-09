// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { WindowManager } from '../../../src/main/windows/windowManager'
import { FakeWindow, createHarness, currentWidgetVisibilityGeneration, setWidgetPresentation, reportWidgetDrag, generationBound, monitorWorkAreas, createMutableTwoDisplayAdapter } from '../../fixtures/windowManager'

describe('WindowManager lifecycle', () => {
  it('expands a resting idle widget before recording the drag origin', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.getBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    setWidgetPresentation(manager, 'idle-hovered')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 908, width: 248, height: 76 },
      false,
    )
    expect(widget.bounds).toEqual({ x: 1_476, y: 908, width: 248, height: 76 })
    expect(widget.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      widget.getBounds.mock.invocationCallOrder[0]!,
    )
  })

  it('does not acquire drag ownership when resting expansion fails', async () => {
    const { manager, onWidgetMoved, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setBounds.mockImplementationOnce(() => {
      throw new Error('native expansion unavailable')
    })

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'move')
    reportWidgetDrag(manager, 'end')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('records native window and Electron cursor origins on start', async () => {
    const cursor = { current: { x: 1_700, y: 970 } }
    const getCursorScreenPoint = vi.fn(() => ({ ...cursor.current }))
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint,
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }
    getCursorScreenPoint.mockClear()

    reportWidgetDrag(manager, 'start')
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 1_730, y: 950 }
    reportWidgetDrag(manager, 'move')

    expect(widget.getBounds).toHaveBeenCalled()
    expect(getCursorScreenPoint).toHaveBeenCalledTimes(2)
    expect(widget.setPosition).toHaveBeenCalledWith(1_230, 480, false)
  })

  it('moves from Electron cursor deltas without renderer coordinates', async () => {
    const cursor = { current: { x: 1_700, y: 970 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    cursor.current = { x: 1_730, y: 950 }
    reportWidgetDrag(manager, 'move')
    cursor.current = { x: 1_710, y: 975 }
    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition.mock.calls).toStrictEqual([
      [1_230, 480, false],
      [1_210, 505, false],
    ])
  })

  it('replaces stale ownership on repeated start', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 300, y: 200 }
    reportWidgetDrag(manager, 'start')
    cursor.current = { x: 315, y: 180 }
    reportWidgetDrag(manager, 'move')

    expect(widget.setPosition).toHaveBeenCalledOnce()
    expect(widget.setPosition).toHaveBeenCalledWith(1_415, 680, false)
  })

  it('ignores a delayed end from an earlier gesture in the current visibility generation', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_200, y: 500, width: 248, height: 76 }
    const generation = currentWidgetVisibilityGeneration(manager)
    const drag = generationBound(manager)

    drag.reportWidgetDrag({ phase: 'start', generation, gestureId: 1 })
    widget.bounds = { x: 1_400, y: 700, width: 248, height: 76 }
    cursor.current = { x: 300, y: 200 }
    drag.reportWidgetDrag({ phase: 'start', generation, gestureId: 2 })
    drag.reportWidgetDrag({ phase: 'end', generation, gestureId: 1 })
    cursor.current = { x: 315, y: 180 }
    drag.reportWidgetDrag({ phase: 'move', generation, gestureId: 2 })

    expect(widget.setPosition).toHaveBeenCalledOnce()
    expect(widget.setPosition).toHaveBeenCalledWith(1_415, 680, false)
  })

  it('ignores move and end without ownership', async () => {
    const getCursorScreenPoint = vi.fn(() => ({ x: 1_700, y: 970 }))
    const getDisplayNearestPoint = vi.fn(() => ({
      workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
    }))
    const { manager, onWidgetMoved, windows } = createHarness({
      display: { getCursorScreenPoint, getDisplayNearestPoint },
    })
    await manager.createWidgetWindow()
    const widget = windows[0]!
    widget.getBounds.mockClear()

    reportWidgetDrag(manager, 'move')
    reportWidgetDrag(manager, 'end')

    expect(getCursorScreenPoint).not.toHaveBeenCalled()
    expect(getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.getBounds).not.toHaveBeenCalled()
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('snaps on the display containing the native window center', async () => {
    const cursor = { current: { x: 100, y: 100 } }
    const getDisplayNearestPoint = vi.fn((point: { readonly x: number }) => ({
      workArea: point.x < 1_000 ? monitorWorkAreas.left : monitorWorkAreas.right,
    }))
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ ...cursor.current }),
        getDisplayNearestPoint,
      },
    })
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 76 }
    widget.setBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    getDisplayNearestPoint.mockClear()
    reportWidgetDrag(manager, 'end')

    expect(getDisplayNearestPoint).toHaveBeenCalledWith({ x: 1_224, y: 338 })
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 88, height: 124 },
      false,
    )
  })

  it('persists only the selected edge', async () => {
    const { manager, onWidgetMoved, windows } = createHarness()
    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-hovered')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 76 }

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'end')

    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('centers the current presentation after orientation changes', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    setWidgetPresentation(manager, 'active')
    const widget = windows[0]!
    widget.bounds = { x: 1_100, y: 300, width: 248, height: 88 }
    widget.setBounds.mockClear()

    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'end')

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 426, width: 88, height: 248 },
      false,
    )
  })

  it('clears ownership after cursor or native movement failure', async () => {
    const cursorAdapter = createMutableTwoDisplayAdapter()
    const cursorFailure = createHarness({ display: cursorAdapter.display })
    await cursorFailure.manager.showWidget()
    setWidgetPresentation(cursorFailure.manager, 'idle-hovered')
    const cursorFailureWidget = cursorFailure.windows[0]!
    cursorFailureWidget.setBounds.mockClear()
    reportWidgetDrag(cursorFailure.manager, 'start')
    cursorAdapter.getCursorScreenPoint.mockClear()
    cursorAdapter.failures.cursor = new Error('cursor unavailable')

    reportWidgetDrag(cursorFailure.manager, 'move')
    reportWidgetDrag(cursorFailure.manager, 'move')
    reportWidgetDrag(cursorFailure.manager, 'end')

    expect(cursorAdapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(cursorFailureWidget.setPosition).not.toHaveBeenCalled()
    expect(cursorFailureWidget.setBounds).not.toHaveBeenCalled()
    expect(cursorFailure.onWidgetMoved).not.toHaveBeenCalled()

    const nativeFailure = createHarness()
    await nativeFailure.manager.showWidget()
    setWidgetPresentation(nativeFailure.manager, 'idle-hovered')
    const nativeFailureWidget = nativeFailure.windows[0]!
    nativeFailureWidget.setBounds.mockClear()
    nativeFailureWidget.setPosition.mockImplementationOnce(() => {
      throw new Error('native movement unavailable')
    })
    reportWidgetDrag(nativeFailure.manager, 'start')

    reportWidgetDrag(nativeFailure.manager, 'move')
    reportWidgetDrag(nativeFailure.manager, 'move')
    reportWidgetDrag(nativeFailure.manager, 'end')

    expect(nativeFailureWidget.setPosition).toHaveBeenCalledOnce()
    expect(nativeFailureWidget.setBounds).not.toHaveBeenCalled()
    expect(nativeFailure.onWidgetMoved).not.toHaveBeenCalled()
  })

  it('clears ownership when hidden closed or renderer is lost', async () => {
    const hidden = createHarness()
    await hidden.manager.showWidget()
    setWidgetPresentation(hidden.manager, 'idle-hovered')
    hidden.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(hidden.manager, 'start')
    hidden.manager.hideWidget()
    reportWidgetDrag(hidden.manager, 'end')
    expect(hidden.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(hidden.onWidgetMoved).not.toHaveBeenCalled()

    const closed = createHarness()
    await closed.manager.showWidget()
    setWidgetPresentation(closed.manager, 'idle-hovered')
    closed.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(closed.manager, 'start')
    closed.windows[0]!.emit('closed')
    reportWidgetDrag(closed.manager, 'end')
    expect(closed.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(closed.onWidgetMoved).not.toHaveBeenCalled()

    const rendererLost = createHarness()
    await rendererLost.manager.showWidget()
    setWidgetPresentation(rendererLost.manager, 'idle-hovered')
    rendererLost.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(rendererLost.manager, 'start')
    rendererLost.windows[0]!.emitRenderProcessGone()
    reportWidgetDrag(rendererLost.manager, 'end')
    expect(rendererLost.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(rendererLost.onWidgetMoved).not.toHaveBeenCalled()

    const disposed = createHarness()
    await disposed.manager.showWidget()
    setWidgetPresentation(disposed.manager, 'idle-hovered')
    disposed.windows[0]!.setBounds.mockClear()
    reportWidgetDrag(disposed.manager, 'start')
    disposed.manager.dispose()
    reportWidgetDrag(disposed.manager, 'end')
    expect(disposed.windows[0]!.setBounds).not.toHaveBeenCalled()
    expect(disposed.onWidgetMoved).not.toHaveBeenCalled()
  })

  it('resumes monitor following after every terminal path', async () => {
    vi.useFakeTimers()
    try {
      const terminalPaths: Array<
        (
          manager: WindowManager,
          widget: FakeWindow,
          adapter: ReturnType<typeof createMutableTwoDisplayAdapter>,
        ) => void
      > = [
        (manager) => {
          reportWidgetDrag(manager, 'end')
        },
        (manager, _widget, adapter) => {
          adapter.failures.cursor = new Error('cursor unavailable')
          reportWidgetDrag(manager, 'move')
        },
        (manager, widget) => {
          widget.setPosition.mockImplementationOnce(() => {
            throw new Error('native movement unavailable')
          })
          reportWidgetDrag(manager, 'move')
        },
        (manager, widget) => {
          widget.getBounds.mockImplementationOnce(() => {
            throw new Error('native bounds unavailable')
          })
          reportWidgetDrag(manager, 'end')
        },
        (manager, _widget, adapter) => {
          adapter.failures.display = new Error('display unavailable')
          reportWidgetDrag(manager, 'end')
        },
      ]

      for (const finishDrag of terminalPaths) {
        const adapter = createMutableTwoDisplayAdapter()
        const { manager, windows } = createHarness({ display: adapter.display })
        await manager.showWidget()
        const widget = windows[0]!
        reportWidgetDrag(manager, 'start')

        finishDrag(manager, widget, adapter)
        widget.setBounds.mockClear()
        adapter.getCursorScreenPoint.mockClear()
        adapter.getDisplayNearestPoint.mockClear()
        adapter.cursor.current = { x: 1_700, y: 970 }
        vi.advanceTimersByTime(100)

        expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
        expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
        expect(widget.setBounds).toHaveBeenCalledWith(
          { x: 1_476, y: 908, width: 248, height: 76 },
          false,
        )
        manager.dispose()
      }
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('native drag-end snap failure clears ownership and the next monitor tick recovers', async () => {
    vi.useFakeTimers()
    try {
      const adapter = createMutableTwoDisplayAdapter()
      const { manager, onWidgetMoved, windows } = createHarness({ display: adapter.display })
      await manager.showWidget()
      const widget = windows[0]!
      reportWidgetDrag(manager, 'start')
      widget.setBounds.mockClear()
      widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
      widget.setBounds.mockImplementationOnce(() => {
        throw new Error('native snap unavailable')
      })

      reportWidgetDrag(manager, 'end')
      reportWidgetDrag(manager, 'end')

      expect(widget.setBounds).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenLastCalledWith(
        { x: 16, y: 338, width: 88, height: 124 },
        false,
      )
      expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })

      widget.setBounds.mockClear()
      adapter.getCursorScreenPoint.mockClear()
      adapter.getDisplayNearestPoint.mockClear()
      vi.advanceTimersByTime(100)

      expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
      expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
      expect(widget.setBounds).toHaveBeenCalledWith(
        { x: 16, y: 338, width: 88, height: 124 },
        false,
      )
      expect(widget.bounds).toEqual({ x: 16, y: 338, width: 88, height: 124 })
      manager.dispose()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('ignores drag reports without a widget window', () => {
    const { manager } = createHarness()

    expect(() => reportWidgetDrag(manager, 'start')).not.toThrow()
    expect(() => reportWidgetDrag(manager, 'move')).not.toThrow()
    expect(() => reportWidgetDrag(manager, 'end')).not.toThrow()
  })
})
