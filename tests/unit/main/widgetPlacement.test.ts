// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { platformProfile } from '../../../src/main/platformProfile'
import type { StoredWidgetPlacement } from '../../../src/main/storage/widgetPlacementRepository'
import { createHarness, setWidgetPresentation } from '../../fixtures/windowManager'

describe('WindowManager lifecycle', () => {
  it('loads remembered placement once', async () => {
    const getWidgetPlacement = vi.fn<() => StoredWidgetPlacement | null>(() => ({
      kind: 'edge',
      edge: 'top',
    }))
    const { manager } = createHarness({ getWidgetPlacement })

    await manager.showWidget()
    await manager.showWidget()
    setWidgetPresentation(manager, 'active')

    expect(getWidgetPlacement).toHaveBeenCalledOnce()
  })

  it('migrates a legacy point to a centered edge', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
    })

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_016, y: 488, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledOnce()
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it.each([
    { x: 1_538, y: 110, edge: 'top' },
    { x: 1_538, y: 936, edge: 'bottom' },
    { x: 1_008, y: 500, edge: 'left' },
    { x: 2_080, y: 500, edge: 'right' },
  ] as const)('resolves a suppressed legacy point to $edge once and shares it with the returning widget', async ({ x, y, edge }) => {
    const getWidgetPlacement = vi.fn<() => StoredWidgetPlacement>(() => ({ kind: 'point', x, y }))
    const getDisplayNearestPoint = vi.fn(() => ({ workArea: { x: 1_000, y: 100, width: 1_200, height: 900 } }))
    const { manager, onWidgetMoved, windows } = createHarness({
      platform: 'linux', chrome: platformProfile('linux'), getWidgetPlacement,
      display: { getCursorScreenPoint: () => ({ x: 1_700, y: 970 }), getDisplayNearestPoint },
    })
    await manager.setWidgetSuppressed(true)
    await manager.showWidget()
    expect(windows).toHaveLength(0)
    expect(manager.getWidgetPlacement()).toEqual({ edge })
    expect(getDisplayNearestPoint).toHaveBeenCalledExactlyOnceWith({ kind: 'point', x, y })
    expect(manager.getWidgetPlacement()).toEqual({ edge })
    expect(onWidgetMoved).toHaveBeenCalledExactlyOnceWith({ edge })
    await manager.setWidgetSuppressed(false)
    expect(getWidgetPlacement).toHaveBeenCalledOnce()
    expect(manager.getWidgetPlacement()).toEqual({ edge })
    const bounds = windows[0]!.bounds
    if (edge === 'top') expect(bounds.y).toBe(116)
    if (edge === 'bottom') expect(bounds.y + bounds.height).toBe(984)
    if (edge === 'left') expect(bounds.x).toBe(1_016)
    if (edge === 'right') expect(bounds.x + bounds.width).toBe(2_184)
  })

  it('uses the idle footprint and existing tie order for a suppressed legacy point', async () => {
    const { manager } = createHarness({
      platform: 'linux', chrome: platformProfile('linux'),
      getWidgetPlacement: () => ({ kind: 'point', x: 438, y: 373 }),
      display: {
        getCursorScreenPoint: () => ({ x: 500, y: 400 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1_000, height: 800 } }),
      },
    })
    await manager.setWidgetSuppressed(true)
    expect(manager.getWidgetPlacement()).toEqual({ edge: 'bottom' })
  })

  it('uses the current idle-resting footprint when migrating a legacy point', async () => {
    const { manager, onWidgetMoved, windows } = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 5, y: 708 }),
      display: {
        getCursorScreenPoint: () => ({ x: 500, y: 400 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1_000, height: 800 },
        }),
      },
    })

    await manager.showWidget()

    expect(windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 16, y: 338, width: 54, height: 124 },
      false,
    )
    expect(onWidgetMoved).toHaveBeenCalledWith({ edge: 'left' })
  })

  it('falls back to centered bottom after storage or display failure', async () => {
    const storageFailure = createHarness({
      getWidgetPlacement: () => {
        throw new Error('placement store unavailable')
      },
    })
    await storageFailure.manager.showWidget()
    expect(storageFailure.windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )

    let displayLookup = 0
    const displayFailure = createHarness({
      getWidgetPlacement: () => ({ kind: 'point', x: 1_100, y: 300 }),
      display: {
        getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
        getDisplayNearestPoint: () => {
          displayLookup += 1
          if (displayLookup === 1) throw new Error('legacy display unavailable')
          return { workArea: { x: 1_000, y: 100, width: 1_200, height: 900 } }
        },
      },
    })
    await displayFailure.manager.showWidget()
    expect(displayFailure.windows[0]!.setBounds).toHaveBeenCalledWith(
      { x: 1_538, y: 930, width: 124, height: 54 },
      false,
    )
    expect(displayFailure.onWidgetMoved).not.toHaveBeenCalled()
  })
})

describe('Linux shell widget placement', () => {
  const linux = { platform: 'linux', chrome: platformProfile('linux') } as const
  it('defaults to the top on Linux and applies a saved shell edge to an already-created widget', async () => {
    const { manager, windows } = createHarness(linux)
    await manager.showWidget()
    expect(windows[0]!.bounds.y).toBeLessThan(200)
    await manager.setWidgetSuppressed(true)
    await manager.setWidgetPlacement({ edge: 'bottom' })
    await manager.setWidgetSuppressed(false)
    expect(windows[0]!.bounds.y).toBeGreaterThan(800)
  })
})
