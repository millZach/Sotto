import { describe, expect, it, vi } from 'vitest'

import { NativeDictationLifecycle } from '../../../src/main/app/nativeDictationLifecycle'
import { WIDGET_STATE } from '../../../src/shared/channels'
import type { WidgetSnapshot } from '../../../src/shared/dictation'
import { DEFAULT_WIDGET_PALETTE, widgetPaletteFor } from '../../../src/shared/themeBranding'

function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
  return {
    status: 'idle',
    theme: 'system',
    palette: DEFAULT_WIDGET_PALETTE,
    reducedMotion: 'system',
    shortcut: 'Ctrl+Shift+Space',
    cancellable: false,
    ...overrides,
  } as WidgetSnapshot
}

function listening(): WidgetSnapshot {
  return snapshot({
    status: 'listening',
    sessionId: 's',
    startedAt: 1,
    level: 0.5,
    cancellable: true,
  })
}

function createHarness(showWidgetWhenIdle = true) {
  const sendToWidget = vi.fn(async () => true)
  const lifecycle = new NativeDictationLifecycle({
    delivery: { sendToWidget },
    getTrayState: () => ({ dictating: false, autoPaste: true }),
    updateTray: vi.fn(),
    syncEscape: vi.fn(),
    showWidgetWhenIdle: () => showWidgetWhenIdle,
    log: vi.fn(),
  })
  return { lifecycle, sendToWidget }
}

describe('NativeDictationLifecycle widget presence', () => {
  it('keeps the widget revealed for idle snapshots so the resting sliver stays visible', async () => {
    const { lifecycle, sendToWidget } = createHarness()

    await lifecycle.publish(snapshot({ status: 'idle' }))

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, expect.anything(), true)
  })

  it('conceals idle snapshots when the idle-visibility setting is off', async () => {
    const { lifecycle, sendToWidget } = createHarness(false)

    await lifecycle.publish(snapshot({ status: 'idle' }))

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, expect.anything(), false)
  })

  it('reveals the widget for active dictation snapshots', async () => {
    const { lifecycle, sendToWidget } = createHarness()

    await lifecycle.publish(listening())

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, expect.anything(), true)
  })

  it('reveals active dictation snapshots even when idle visibility is off', async () => {
    const { lifecycle, sendToWidget } = createHarness(false)

    await lifecycle.publish(listening())

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, expect.anything(), true)
  })

  it('keeps the idle sliver revealed after the main renderer disappears', async () => {
    const { lifecycle, sendToWidget } = createHarness()
    await lifecycle.publish(listening())

    lifecycle.rendererProcessGone('main')
    await Promise.resolve()

    expect(sendToWidget).toHaveBeenLastCalledWith(
      WIDGET_STATE,
      expect.objectContaining({ status: 'idle' }),
      true,
    )
  })

  it('conceals the fail-closed idle snapshot when idle visibility is off', async () => {
    const { lifecycle, sendToWidget } = createHarness(false)
    await lifecycle.publish(listening())

    lifecycle.rendererProcessGone('main')
    await Promise.resolve()

    expect(sendToWidget).toHaveBeenLastCalledWith(
      WIDGET_STATE,
      expect.objectContaining({ status: 'idle' }),
      false,
    )
  })
})

describe('NativeDictationLifecycle cursor-follow compatibility', () => {
  it('does not lock a display when dictation becomes active', async () => {
    const { lifecycle, sendToWidget } = createHarness()
    const active = listening()

    await lifecycle.publish(active)

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, active, true)
  })

  it('does not unlock a display when dictation returns to idle', async () => {
    const { lifecycle, sendToWidget } = createHarness()
    const idle = snapshot({ status: 'idle' })

    await lifecycle.publish(listening())
    await lifecycle.publish(idle)

    expect(sendToWidget).toHaveBeenLastCalledWith(WIDGET_STATE, idle, true)
  })

  it('preserves widget publication and visibility behavior without display locking', async () => {
    const { lifecycle, sendToWidget } = createHarness(false)
    const active = listening()
    const idle = snapshot({ status: 'idle' })

    await lifecycle.publish(active)
    await lifecycle.publish(idle)

    expect(sendToWidget).toHaveBeenNthCalledWith(1, WIDGET_STATE, active, true)
    expect(sendToWidget).toHaveBeenNthCalledWith(2, WIDGET_STATE, idle, false)
  })
})

describe('NativeDictationLifecycle idle reporting', () => {
  it('reports idle before any snapshot, after idle snapshots, and after renderer loss', async () => {
    const { lifecycle } = createHarness()

    expect(lifecycle.isIdle()).toBe(true)

    await lifecycle.publish(listening())
    expect(lifecycle.isIdle()).toBe(false)

    await lifecycle.publish(snapshot({ status: 'idle' }))
    expect(lifecycle.isIdle()).toBe(true)

    await lifecycle.publish(listening())
    lifecycle.rendererProcessGone('main')
    expect(lifecycle.isIdle()).toBe(true)
  })
})

describe('NativeDictationLifecycle theme presentation', () => {
  const ember = widgetPaletteFor({ lightTheme: 'ember', darkTheme: 'ember', customThemes: [] })
  const iris = widgetPaletteFor({ lightTheme: 'iris', darkTheme: 'iris', customThemes: [] })

  function presentedHarness() {
    let presentation = { theme: 'system' as const, palette: ember, reducedMotion: 'system' as const }
    const sendToWidget = vi.fn(async () => true)
    const lifecycle = new NativeDictationLifecycle({
      delivery: { sendToWidget },
      getTrayState: () => ({ dictating: false, autoPaste: true }),
      updateTray: vi.fn(),
      syncEscape: vi.fn(),
      showWidgetWhenIdle: () => true,
      presentation: () => presentation,
      log: vi.fn(),
    })
    return {
      lifecycle,
      sendToWidget,
      choose(palette: typeof ember) { presentation = { ...presentation, palette } },
      delivered: () => sendToWidget.mock.calls.map(call => (call as unknown[])[1] as WidgetSnapshot),
    }
  }

  it('stamps main’s current palette over a renderer publication built from older settings', async () => {
    const harness = presentedHarness()
    await harness.lifecycle.publish(listening())
    expect(harness.delivered().at(-1)?.palette).toEqual(ember)
    expect(harness.delivered().at(-1)).toMatchObject({ status: 'listening', level: 0.5 })
  })

  it('repaints an active session live when the theme changes, without a new renderer publication', async () => {
    const harness = presentedHarness()
    await harness.lifecycle.publish(listening())
    harness.choose(iris)

    await expect(harness.lifecycle.repaint()).resolves.toBe(true)

    expect(harness.sendToWidget).toHaveBeenCalledTimes(2)
    expect(harness.delivered().at(-1)).toMatchObject({ status: 'listening', sessionId: 's', palette: iris })
  })

  it('leaves idle repainting to the idle publication', async () => {
    const harness = presentedHarness()
    await expect(harness.lifecycle.repaint()).resolves.toBe(false)
    await harness.lifecycle.publish(snapshot({ status: 'idle' }))
    await expect(harness.lifecycle.repaint()).resolves.toBe(false)
    expect(harness.sendToWidget).toHaveBeenCalledTimes(1)
  })

  it('keeps the current palette on the idle snapshot after the main renderer disappears', async () => {
    const harness = presentedHarness()
    await harness.lifecycle.publish(listening())
    harness.choose(iris)
    harness.lifecycle.rendererProcessGone('main')
    await vi.waitFor(() => expect(harness.delivered().at(-1)).toMatchObject({ status: 'idle', palette: iris }))
  })
})
