// @vitest-environment node
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { platformProfile } from '../../../src/main/platformProfile'
import { type Rectangle } from '../../../src/main/windows/windowManager'
import { WIDGET_VISIBILITY } from '../../../src/shared/channels'
import { createDeferred, createHarness, createMutableTwoDisplayAdapter, setWidgetPresentation } from '../../fixtures/windowManager'

describe('WindowManager lifecycle', () => {
  it('constructs the widget at the bottom idle-resting footprint', async () => {
    const { manager, options, windows } = createHarness()

    await manager.createWidgetWindow()

    expect(options[0]).toMatchObject({ width: 124, height: 54 })
    expect(windows[0]!.setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('applies presentation changes through one bounds path', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    widget.setPosition.mockClear()
    widget.setSize.mockClear()

    setWidgetPresentation(manager, 'idle-hovered')
    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds.mock.calls).toStrictEqual([
      [{ x: 1_476, y: 908, width: 248, height: 76 }, false],
      [{ x: 1_476, y: 896, width: 248, height: 88 }, false],
    ])
    expect(widget.setPosition).not.toHaveBeenCalled()
    expect(widget.setSize).not.toHaveBeenCalled()
  })

  it('preserves the selected edge and center while presentation changes', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.showWidget()
    const widget = windows[0]!

    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )

    setWidgetPresentation(manager, 'active')

    expect(widget.setBounds).toHaveBeenLastCalledWith(
      { x: 1_016, y: 426, width: 88, height: 248 },
      false,
    )
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('skips native work when desired bounds already match', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    await manager.showWidget()
    setWidgetPresentation(manager, 'idle-resting')
    manager.hideWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('reads back applied bounds and retries a mismatched native result', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!
    widget.setBounds.mockImplementationOnce((bounds: Rectangle): void => {
      widget.bounds = { ...bounds, height: bounds.height + 2 }
      widget.setBoundsCalls.push({ ...widget.bounds })
    })

    await manager.showWidget()
    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 56 })

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(2)
    expect(widget.bounds).toEqual({ x: 1_538, y: 930, width: 124, height: 54 })
  })

  it('suppresses moved events caused by coordinator bounds', async () => {
    const { manager, onWidgetMoved, windows } = createHarness(
      {},
      (window) => {
        window.emitMovedOnSetBounds = true
      },
    )

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledOnce()
    expect(onWidgetMoved).not.toHaveBeenCalled()
  })

  it('ignores native moved events while the widget is hidden', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, onWidgetMoved, windows } = createHarness({
      display: adapter.display,
    })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    widget.setBounds.mockClear()
    onWidgetMoved.mockClear()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }

    widget.emit('moved')

    expect(widget.setBounds).not.toHaveBeenCalled()
    expect(onWidgetMoved).not.toHaveBeenCalled()
    expect(widget.bounds).toEqual({ x: 100, y: 300, width: 124, height: 54 })
  })

  it('reapplies the remembered edge after a hidden native move', async () => {
    const adapter = createMutableTwoDisplayAdapter()
    const { manager, windows } = createHarness({ display: adapter.display })
    await manager.showWidget()
    const widget = windows[0]!

    manager.hideWidget()
    widget.bounds = { x: 100, y: 300, width: 124, height: 54 }
    widget.emit('moved')
    widget.setBounds.mockClear()

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 438, y: 730, width: 124, height: 54 },
      false,
    )
  })

  it('snaps a genuinely external move without recursion', async () => {
    const { manager, onWidgetMoved, windows } = createHarness(
      {},
      (window) => {
        window.emitMovedOnSetBounds = true
      },
    )
    await manager.showWidget()
    const widget = windows[0]!
    widget.setBounds.mockClear()
    onWidgetMoved.mockClear()
    widget.bounds = { x: 1_234, y: 567, width: 124, height: 54 }

    widget.emit('moved')

    expect(widget.setBounds).toHaveBeenCalledOnce()
    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('shows the widget without activation inside the active work area', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
    expect(widget.showInactive).toHaveBeenCalledOnce()
    expect(widget.show).not.toHaveBeenCalled()
    expect(widget.focus).not.toHaveBeenCalled()
  })

  it('shows the native widget once per visibility transition', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    await manager.showWidget()
    await manager.showWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(1)
    expect(widget.showInactive).toHaveBeenCalledTimes(1)

    manager.hideWidget()
    await manager.showWidget()

    expect(widget.setBounds).toHaveBeenCalledTimes(1)
    expect(widget.showInactive).toHaveBeenCalledTimes(2)
  })

  it('notifies the widget renderer before every native visibility transition', async () => {
    const { manager, windows } = createHarness()
    await manager.showWidget()
    const widget = windows[0]!

    expect(widget.webContents.send).toHaveBeenCalledWith(
      WIDGET_VISIBILITY,
      { visible: true, generation: 1 },
    )

    manager.hideWidget()

    expect(widget.webContents.send).toHaveBeenLastCalledWith(
      WIDGET_VISIBILITY,
      { visible: false, generation: 2 },
    )
    expect(widget.webContents.send.mock.invocationCallOrder.at(-1)).toBeLessThan(
      widget.hide.mock.invocationCallOrder[0]!,
    )
  })

  it('centers an edge-only stored placement instead of restoring a legacy offset', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
  })

  it('chooses the nearest edge for a legacy point and centers it', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('centers a legacy remembered point that no longer fits any display work area', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 5_000, y: 5_000 }),
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('falls back to the default anchor when reading the remembered position throws', async () => {
    const { manager, windows } = createHarness({
      getWidgetPlacement: () => {
        throw new Error('placement store unavailable')
      },
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
  })

  it('starts interactive and still honors explicit interactivity requests', async () => {
    const { manager, windows } = createHarness()
    await manager.createWidgetWindow()
    const widget = windows[0]!

    expect(widget.setIgnoreMouseEvents).not.toHaveBeenCalled()

    manager.setWidgetMouseInteractive(true)
    expect(widget.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)

    manager.setWidgetMouseInteractive(false)
    expect(widget.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
  })

  it('ignores interactivity requests without a widget window', () => {
    const { manager } = createHarness()

    expect(() => manager.setWidgetMouseInteractive(true)).not.toThrow()
  })

  it('does not report widget send success until renderer load completes', async () => {
    const load = createDeferred<void>()
    const { manager, windows } = createHarness({}, (window) => {
      window.loadFile.mockImplementationOnce(() => load.promise)
    })
    const creation = manager.createWidgetWindow()
    expect(manager.sendToWidget('state', { status: 'idle' })).toBe(false)
    expect(windows[0]!.webContents.send).not.toHaveBeenCalled()
    load.resolve()
    await creation
    expect(manager.sendToWidget('state', { status: 'idle' })).toBe(true)
  })

  it('centers the idle footprint in a small negative-coordinate work area', async () => {
    const { manager, windows } = createHarness({
      display: {
        getCursorScreenPoint: () => ({ x: -1_900, y: -900 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: -2_000, y: -1_000, width: 200, height: 90 },
        }),
      },
    })
    await manager.createWidgetWindow()

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: -1_962, y: -980, width: 124, height: 54 },
      false,
    )
  })
})

it.each(['win32', 'darwin'] as const)(
    'keeps dictation unfocused across presentation changes and hiding on %s',
    async (platform) => {
      const { manager, onWidgetMoved, windows } = createHarness({
        platform,
        chrome: platformProfile(platform),
        getWidgetPlacement: () => ({ kind: 'edge', edge: 'left' }),
      })
      await manager.showWidget()
      const widget = windows[0]!

      for (const presentation of ['idle-hovered', 'active', 'active', 'idle-resting'] as const) {
        setWidgetPresentation(manager, presentation)
      }
      setWidgetPresentation(manager, 'active')
      expect(widget.bounds).toEqual({ x: 1_016, y: 426, width: 88, height: 248 })
      manager.hideWidget()
      setWidgetPresentation(manager, 'idle-resting')
      await manager.showWidget()
      expect(widget.bounds).toEqual({ x: 1_016, y: 488, width: 54, height: 124 })
      expect(widget.setFocusable).not.toHaveBeenCalled()
      expect(widget.focus).not.toHaveBeenCalled()
      expect(onWidgetMoved).not.toHaveBeenCalled()
      manager.dispose()
    },
  )
