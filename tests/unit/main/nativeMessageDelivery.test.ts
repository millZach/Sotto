import { describe, expect, it, vi } from 'vitest'

import { NativeMessageDelivery } from '../../../src/main/app/nativeMessageDelivery'

function createHarness() {
  const order: string[] = []
  const windows = {
    sendToMain: vi.fn(() => false),
    sendToWidget: vi.fn(() => false),
    createMainWindow: vi.fn(async () => {
      order.push('create:main')
    }),
    createWidgetWindow: vi.fn(async () => {
      order.push('create:widget')
    }),
    showWidget: vi.fn(async () => {
      order.push('show:widget')
    }),
    hideWidget: vi.fn(() => {
      order.push('hide:widget')
    }),
  }
  return { delivery: new NativeMessageDelivery(windows), order, windows }
}

describe('NativeMessageDelivery', () => {
  it('recreates a hidden main renderer and retries a failed command exactly once', async () => {
    const { delivery, order, windows } = createHarness()
    windows.sendToMain
      .mockImplementationOnce(() => {
        order.push('send:main:initial')
        return false
      })
      .mockImplementationOnce(() => {
        order.push('send:main:retry')
        return true
      })

    await expect(delivery.sendToMain('dictation', { type: 'toggle' })).resolves.toBe(true)

    expect(order).toStrictEqual(['send:main:initial', 'create:main', 'send:main:retry'])
    expect(windows.sendToMain).toHaveBeenCalledTimes(2)
    expect(windows.createMainWindow).toHaveBeenCalledOnce()
    expect(windows.showWidget).not.toHaveBeenCalled()
  })

  it('returns false without a second send when main recreation fails', async () => {
    const { delivery, windows } = createHarness()
    windows.createMainWindow.mockRejectedValueOnce(new Error('secret renderer path'))

    await expect(delivery.sendToMain('dictation', { type: 'cancel' })).resolves.toBe(false)

    expect(windows.sendToMain).toHaveBeenCalledOnce()
  })

  it('recreates a widget and retries hidden state delivery without flashing it', async () => {
    const { delivery, order, windows } = createHarness()
    windows.sendToWidget
      .mockImplementationOnce(() => {
        order.push('send:widget:initial')
        return false
      })
      .mockImplementationOnce(() => {
        order.push('send:widget:retry')
        return true
      })

    await expect(
      delivery.sendToWidget('widget-state', { status: 'idle' }, false),
    ).resolves.toBe(true)

    expect(order).toStrictEqual([
      'send:widget:initial',
      'create:widget',
      'send:widget:retry',
      'hide:widget',
    ])
    expect(windows.showWidget).not.toHaveBeenCalled()
    expect(windows.hideWidget).toHaveBeenCalledOnce()
  })

  it('reveals a recovered error widget only after its requested state is delivered', async () => {
    const { delivery, order, windows } = createHarness()
    windows.sendToWidget
      .mockImplementationOnce(() => {
        order.push('send:widget:initial')
        return false
      })
      .mockImplementationOnce(() => {
        order.push('send:widget:retry')
        return true
      })

    await expect(
      delivery.sendToWidget('widget-state', { status: 'error' }, true),
    ).resolves.toBe(true)

    expect(order).toStrictEqual([
      'send:widget:initial',
      'create:widget',
      'send:widget:retry',
      'show:widget',
    ])
  })

  it('does not reveal a recreated widget when its retry also fails', async () => {
    const { delivery, windows } = createHarness()

    await expect(
      delivery.sendToWidget('widget-state', { status: 'idle' }, false),
    ).resolves.toBe(false)

    expect(windows.sendToWidget).toHaveBeenCalledTimes(2)
    expect(windows.showWidget).not.toHaveBeenCalled()
  })

  it('can reveal an already-live widget after successful delivery', async () => {
    const { delivery, windows } = createHarness()
    windows.sendToWidget.mockReturnValueOnce(true)

    await expect(
      delivery.sendToWidget('widget-state', { status: 'listening' }, true),
    ).resolves.toBe(true)

    expect(windows.createWidgetWindow).not.toHaveBeenCalled()
    expect(windows.showWidget).toHaveBeenCalledOnce()
  })
})
