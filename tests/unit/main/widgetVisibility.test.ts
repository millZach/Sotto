// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { platformProfile } from '../../../src/main/platformProfile'
import { WIDGET_VISIBILITY } from '../../../src/shared/channels'
import { createDeferred, createHarness, setWidgetPresentation, reportWidgetDrag, generationBound, createMutableTwoDisplayAdapter, registerWidgetMonitorTimers } from '../../fixtures/windowManager'

describe('WindowManager cursor monitor following', () => {
  registerWidgetMonitorTimers()

  it('keeps an idle reveal resting after a delayed active report from the previous visible generation', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()

    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 1,
    })

    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('remembers a current hidden idle report before the next reveal', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 1,
    })
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })

    manager.hideWidget()
    generationBound(manager).setWidgetPresentation({
      presentation: 'idle-resting',
      generation: 2,
    })
    widget.setBounds.mockClear()

    await manager.showWidget()

    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('reconciles a current show-generation active republish during the reveal gap', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    widget.setBounds.mockClear()

    const reveal = manager.showWidget()
    generationBound(manager).setWidgetPresentation({
      presentation: 'active',
      generation: 3,
    })
    await reveal

    expect(widget.webContents.send).toHaveBeenLastCalledWith(
      WIDGET_VISIBILITY,
      { visible: true, generation: 3 },
    )
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
  })

  it('rejects delayed drag phases from a previous visible generation after rapid hide and show', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    const stale = generationBound(manager)
    stale.reportWidgetDrag({ phase: 'start', generation: 1, gestureId: 0 })
    stale.reportWidgetDrag({ phase: 'move', generation: 1, gestureId: 0 })
    stale.reportWidgetDrag({ phase: 'end', generation: 1, gestureId: 0 })

    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('rejects a hover report from the previous visibility generation after reveal', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    setWidgetPresentation(manager, 'idle-hovered')
    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })

    manager.hideWidget()
    widget.setBounds.mockClear()
    await manager.showWidget()

    setWidgetPresentation(manager, 'idle-hovered', 1)

    expect(widget.bounds).toEqual({ x: 438, y: 730, width: 124, height: 54 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('accepts a current hover after reveal when the cursor resynchronizes it', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    await manager.showWidget()
    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 500, y: 750 }

    setWidgetPresentation(manager, 'idle-hovered')

    expect(widget.bounds).toEqual({ x: 376, y: 708, width: 248, height: 76 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
  })

  it('preserves an active presentation across concealment and reveal', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    setWidgetPresentation(manager, 'active')
    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })

    manager.hideWidget()
    widget.setBounds.mockClear()
    await manager.showWidget()

    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('uses an active presentation published during the reveal gap', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    manager.hideWidget()
    widget.setBounds.mockClear()

    const reveal = manager.showWidget()
    setWidgetPresentation(manager, 'active', 3)
    await reveal

    expect(widget.bounds).toEqual({ x: 1_476, y: 896, width: 248, height: 88 })
    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_476, y: 896, width: 248, height: 88 },
      false,
    )
  })

  it('stops checks when hidden', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    manager.hideWidget()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
  })

  it('does not reveal after hide wins an in-flight widget load', async () => {
    const rendererLoad = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => rendererLoad.promise)
    })

    const reveal = manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    rendererLoad.resolve()
    await reveal

    expect(widget.hide).toHaveBeenCalledOnce()
    expect(widget.webContents.send.mock.calls.filter(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )).toHaveLength(0)
    expect(widget.showInactive).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    manager.hideWidget()
    expect(widget.webContents.send.mock.calls.filter(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )).toHaveLength(0)
  })

  it('rolls back a failed native reveal so a later reveal retries and restarts monitoring', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness(
      { display: adapter.display },
      (window) => {
        window.showInactive.mockImplementationOnce(() => {
          throw new Error('native reveal failed')
        })
      },
    )

    await expect(manager.showWidget()).rejects.toThrow('native reveal failed')
    const widget = windows[0]!

    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      1,
      WIDGET_VISIBILITY,
      { visible: true, generation: 1 },
    )
    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      2,
      WIDGET_VISIBILITY,
      { visible: false, generation: 2 },
    )
    expect(widget.showInactive).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    widget.getBounds.mockClear()
    reportWidgetDrag(manager, 'start')
    expect(widget.getBounds).not.toHaveBeenCalled()

    await manager.showWidget()

    expect(widget.webContents.send).toHaveBeenNthCalledWith(
      3,
      WIDGET_VISIBILITY,
      { visible: true, generation: 3 },
    )
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    widget.setBounds.mockClear()
    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('rejects late drag reports while hidden and resumes reveal monitoring', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    reportWidgetDrag(manager, 'start')
    reportWidgetDrag(manager, 'move')
    await manager.showWidget()

    expect(widget.showInactive).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    reportWidgetDrag(manager, 'move')
    expect(widget.setPosition).not.toHaveBeenCalled()

    adapter.cursor.current = { x: 1_700, y: 970 }
    vi.advanceTimersByTime(100)

    expect(adapter.getCursorScreenPoint).toHaveBeenCalledOnce()
    expect(adapter.getDisplayNearestPoint).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('stops checks when widget closes or renderer is lost', async () => {
    const closedAdapter = createMutableTwoDisplayAdapter()
    const closedHarness = createHarness({ display: closedAdapter.display })
    await closedHarness.manager.showWidget()
    closedAdapter.getCursorScreenPoint.mockClear()
    closedAdapter.getDisplayNearestPoint.mockClear()

    closedHarness.windows[0]!.emit('closed')
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(closedAdapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(closedAdapter.getDisplayNearestPoint).not.toHaveBeenCalled()

    const lostAdapter = createMutableTwoDisplayAdapter()
    const lostHarness = createHarness({ display: lostAdapter.display })
    await lostHarness.manager.showWidget()
    lostAdapter.getCursorScreenPoint.mockClear()
    lostAdapter.getDisplayNearestPoint.mockClear()

    lostHarness.windows[0]!.emitRenderProcessGone()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(lostAdapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(lostAdapter.getDisplayNearestPoint).not.toHaveBeenCalled()
  })

  it('stops checks when WindowManager is disposed', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    adapter.getCursorScreenPoint.mockClear()
    adapter.getDisplayNearestPoint.mockClear()

    manager.dispose()
    vi.advanceTimersByTime(200)

    expect(vi.getTimerCount()).toBe(0)
    expect(adapter.getCursorScreenPoint).not.toHaveBeenCalled()
    expect(adapter.getDisplayNearestPoint).not.toHaveBeenCalled()
    expect(widget.setBounds).not.toHaveBeenCalled()
  })
})

describe('Linux shell widget ownership', () => {
  const linux = { platform: 'linux', chrome: platformProfile('linux') } as const
  it('steps aside, refuses other reveals and returns when the plugin goes away', async () => {
    const { manager, windows } = createHarness(linux)
    await manager.showWidget()
    const widget = windows[0]!
    expect(widget.showInactive).toHaveBeenCalledTimes(1)
    await manager.setWidgetSuppressed(true)
    expect(widget.hide).toHaveBeenCalledTimes(1)
    await manager.showWidget()
    expect(widget.showInactive).toHaveBeenCalledTimes(1)
    await manager.setWidgetSuppressed(false)
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })
  it('keeps a pending reveal hidden when the plugin arrives during widget creation', async () => {
    const load = createDeferred<void>()
    const { manager, windows } = createHarness(linux, window => window.loadFile.mockReturnValue(load.promise))
    const reveal = manager.showWidget()
    await manager.setWidgetSuppressed(true)
    load.resolve()
    await reveal
    expect(windows[0]!.showInactive).not.toHaveBeenCalled()
    await manager.setWidgetSuppressed(false)
    expect(windows[0]!.showInactive).toHaveBeenCalledTimes(1)
  })
  it('does not resurrect a widget hidden by its normal visibility policy', async () => {
    const { manager, windows } = createHarness(linux)
    await manager.showWidget()
    await manager.setWidgetSuppressed(true)
    manager.hideWidget()
    await manager.setWidgetSuppressed(false)
    expect(windows[0]!.showInactive).toHaveBeenCalledTimes(1)
  })
  it.each(['win32', 'darwin'] as const)('leaves %s reveals and the bottom default unchanged', async platform => {
    const { manager, windows } = createHarness({ platform, chrome: platformProfile(platform) })
    await manager.setWidgetSuppressed(true)
    await manager.showWidget()
    expect(windows[0]!.showInactive).toHaveBeenCalledTimes(1)
    expect(windows[0]!.bounds.y).toBeGreaterThan(800)
  })
})
