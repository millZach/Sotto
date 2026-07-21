import { describe, expect, it, vi } from 'vitest'

import { NativeDictationLifecycle } from '../../../src/main/app/nativeDictationLifecycle'
import { WIDGET_STATE } from '../../../src/shared/channels'
import type { WidgetSnapshot } from '../../../src/shared/dictation'

function snapshot(overrides: Partial<WidgetSnapshot> = {}): WidgetSnapshot {
  return {
    status: 'idle',
    theme: 'system',
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
  const lockDisplay = vi.fn()
  const unlockDisplay = vi.fn()
  const lifecycle = new NativeDictationLifecycle({
    delivery: { sendToWidget },
    getTrayState: () => ({ dictating: false, autoPaste: true }),
    updateTray: vi.fn(),
    syncEscape: vi.fn(),
    widgetDisplay: { lock: lockDisplay, unlock: unlockDisplay },
    showWidgetWhenIdle: () => showWidgetWhenIdle,
    log: vi.fn(),
  })
  return { lifecycle, lockDisplay, sendToWidget, unlockDisplay }
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

describe('NativeDictationLifecycle session display lock', () => {
  it('locks the display for non-idle snapshots and unlocks when idle returns', async () => {
    const { lifecycle, lockDisplay, unlockDisplay } = createHarness()

    await lifecycle.publish(listening())
    expect(lockDisplay).toHaveBeenCalledOnce()
    expect(unlockDisplay).not.toHaveBeenCalled()

    await lifecycle.publish(snapshot({ status: 'idle' }))
    expect(unlockDisplay).toHaveBeenCalledOnce()
  })

  it('unlocks the display when the main renderer disappears mid-session', async () => {
    const { lifecycle, unlockDisplay } = createHarness()
    await lifecycle.publish(listening())

    lifecycle.rendererProcessGone('main')

    expect(unlockDisplay).toHaveBeenCalledOnce()
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
