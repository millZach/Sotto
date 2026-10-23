// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerNotificationIpc } from '../../../src/main/notifications/notificationIpc'
import { NOTIFICATION_TEST } from '../../../src/shared/desktopNotifications'
import { ipcRegistry } from '../../fixtures/ipcHarness'

describe('the window\'s test notification (ADR-0112)', () => {
  it('registers nothing where notifications are off, so no window can ask for one', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerNotificationIpc(ipc, null, () => [main])()
    expect(handlers.size).toBe(0)
  })

  it('shows one test for the main window, answers what the system did, and refuses any other window or payload', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const notifier = { test: vi.fn(async () => 'shown' as const) }
    const close = registerNotificationIpc(ipc, notifier, () => [main])
    const test = handlers.get(NOTIFICATION_TEST)!
    await expect(test(mainEvent)).resolves.toBe('shown')
    expect(notifier.test).toHaveBeenCalledTimes(1)
    await expect(test(widgetEvent)).rejects.toThrow('main Sotto window')
    await expect(test(mainEvent, 'extra')).rejects.toThrow()
    expect(notifier.test).toHaveBeenCalledTimes(1)
    notifier.test.mockResolvedValueOnce('failed' as never)
    await expect(test(mainEvent)).resolves.toBe('failed')
    notifier.test.mockResolvedValueOnce('maybe' as never)
    await expect(test(mainEvent)).rejects.toThrow()
    close()
    expect(handlers.size).toBe(0)
  })
})
