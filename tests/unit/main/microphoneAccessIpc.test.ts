// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createMicrophoneAccessGate } from '../../../src/main/media/microphoneAccess'
import { MICROPHONE_ACCESS_WAITING, MICROPHONE_ENSURE_ACCESS } from '../../../src/shared/channels'
import { deferred } from '../../fixtures/deferred'
import { createIpcHarness, trustedIpcSender } from '../../fixtures/ipcHarness'

describe('microphone permission notifications', () => {
  it('sends the real pending request only to its invoking window, with its request id', async () => {
    const permission = deferred<boolean>()
    const entered = deferred()
    const gate = createMicrophoneAccessGate({ status: () => 'not-determined', request: () => {
      entered.resolve()
      return permission.promise
    } })
    const harness = createIpcHarness({ microphoneAccess: gate })
    const send = vi.fn()
    Object.assign(harness.trustedContents, { send })
    const requestId = 'aa624ac2-0fca-4217-b4c7-dc27268ca816'
    const result = harness.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [requestId])
    await entered.promise
    expect(send.mock.calls).toEqual([[MICROPHONE_ACCESS_WAITING, { requestId, waiting: true }]])
    permission.resolve(true)
    await expect(result).resolves.toBe(true)
    expect(send.mock.calls).toEqual([
      [MICROPHONE_ACCESS_WAITING, { requestId, waiting: true }],
      [MICROPHONE_ACCESS_WAITING, { requestId, waiting: false }],
    ])
    harness.cleanup()
  })

  it('keeps no-callback callers working without sending permission notifications', async () => {
    const gate = createMicrophoneAccessGate({ status: () => 'not-determined', request: async () => true })
    const harness = createIpcHarness({ microphoneAccess: gate })
    const send = vi.fn()
    Object.assign(harness.trustedContents, { send })
    await expect(harness.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [])).resolves.toBe(true)
    expect(send).not.toHaveBeenCalled()
    harness.cleanup()
  })

  it('refuses malformed ids and widget requests before asking the OS', async () => {
    const ensure = vi.fn(async () => true)
    const widget = trustedIpcSender('widget')
    const harness = createIpcHarness({ microphoneAccess: { ensure }, trustedSenders: () => [widget] })
    const widgetEvent = { sender: widget.webContents, senderFrame: widget.webContents.mainFrame }
    await expect(harness.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [], widgetEvent)).rejects.toThrow()
    harness.cleanup()
    const main = createIpcHarness({ microphoneAccess: { ensure } })
    await expect(main.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, ['not-a-request-id'])).rejects.toThrow()
    await expect(main.ipc.invokeArgs(MICROPHONE_ENSURE_ACCESS, [undefined, true])).rejects.toThrow()
    expect(ensure).not.toHaveBeenCalled()
    main.cleanup()
  })
})
