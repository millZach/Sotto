// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
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
