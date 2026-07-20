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

function createHarness() {
  const sendToWidget = vi.fn(async () => true)
  const lifecycle = new NativeDictationLifecycle({
    delivery: { sendToWidget },
    getTrayState: () => ({ dictating: false, autoPaste: true }),
    updateTray: vi.fn(),
    syncEscape: vi.fn(),
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

  it('reveals the widget for active dictation snapshots', async () => {
    const { lifecycle, sendToWidget } = createHarness()

    await lifecycle.publish(
      snapshot({ status: 'listening', sessionId: 's', startedAt: 1, level: 0.5, cancellable: true }),
    )

    expect(sendToWidget).toHaveBeenCalledWith(WIDGET_STATE, expect.anything(), true)
  })

  it('keeps the idle sliver revealed after the main renderer disappears', async () => {
    const { lifecycle, sendToWidget } = createHarness()
    await lifecycle.publish(
      snapshot({ status: 'listening', sessionId: 's', startedAt: 1, level: 0.5, cancellable: true }),
    )

    lifecycle.rendererProcessGone('main')
    await Promise.resolve()

    expect(sendToWidget).toHaveBeenLastCalledWith(
      WIDGET_STATE,
      expect.objectContaining({ status: 'idle' }),
      true,
    )
  })
})
