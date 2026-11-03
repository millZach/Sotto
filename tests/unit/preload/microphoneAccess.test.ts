// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
import { deferred } from '../../fixtures/deferred'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge } from '../../../src/preload'
import { MICROPHONE_ACCESS_WAITING, MICROPHONE_ENSURE_ACCESS } from '../../../src/shared/channels'

describe('microphone permission bridge', () => {
  it('correlates pending notifications and removes each listener when its request settles', async () => {
    const ipc = preloadElectron().ipcRenderer
    const first = deferred<boolean>(), second = deferred<boolean>()
    ipc.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const bridge = createSottoBridge(ipc, 'darwin')
    const firstWaiting = vi.fn(), secondWaiting = vi.fn()
    const firstResult = bridge.ensureMicrophoneAccess(firstWaiting)
    const secondResult = bridge.ensureMicrophoneAccess(secondWaiting)
    const requestIds = ipc.invoke.mock.calls.map(([channel, requestId]) => {
      expect(channel).toBe(MICROPHONE_ENSURE_ACCESS)
      expect(requestId).toEqual(expect.any(String))
      return requestId
    })
    expect(requestIds[0]).not.toBe(requestIds[1])
    const handlers = ipc.on.mock.calls.filter(([channel]) => channel === MICROPHONE_ACCESS_WAITING).map(([, handler]) => handler)
    const event = { sender: 'must not cross the bridge' }
    for (const handler of handlers) handler(event, { requestId: requestIds[0], waiting: true })
    expect(firstWaiting.mock.calls).toEqual([[true]])
    expect(secondWaiting).not.toHaveBeenCalled()
    for (const handler of handlers) handler(event, { requestId: requestIds[1], waiting: 'true' })
    expect(secondWaiting).not.toHaveBeenCalled()
    first.resolve(true)
    await expect(firstResult).resolves.toBe(true)
    expect(ipc.removeListener).toHaveBeenCalledWith(MICROPHONE_ACCESS_WAITING, handlers[0])
    handlers[1]!(event, { requestId: requestIds[0], waiting: false })
    expect(secondWaiting).not.toHaveBeenCalled()
    handlers[1]!(event, { requestId: requestIds[1], waiting: true })
    expect(secondWaiting.mock.calls).toEqual([[true]])
    second.resolve(false)
    await expect(secondResult).resolves.toBe(false)
    expect(ipc.removeListener).toHaveBeenCalledWith(MICROPHONE_ACCESS_WAITING, handlers[1])
    expect(ipc.removeListener).toHaveBeenCalledTimes(2)
  })

  it('removes its pending listener when the invoke rejects', async () => {
    const ipc = preloadElectron().ipcRenderer
    ipc.invoke.mockRejectedValueOnce(new Error('request failed'))
    const result = createSottoBridge(ipc, 'darwin').ensureMicrophoneAccess(vi.fn())
    await expect(result).rejects.toThrow('request failed')
    const [, handler] = ipc.on.mock.calls.find(([channel]) => channel === MICROPHONE_ACCESS_WAITING)!
    expect(ipc.removeListener).toHaveBeenCalledWith(MICROPHONE_ACCESS_WAITING, handler)
  })

  it('preserves the no-argument request when no pending callback is needed', async () => {
    const ipc = preloadElectron().ipcRenderer
    ipc.invoke.mockResolvedValueOnce(true)
    await expect(createSottoBridge(ipc, 'darwin').ensureMicrophoneAccess()).resolves.toBe(true)
    expect(ipc.invoke).toHaveBeenCalledWith(MICROPHONE_ENSURE_ACCESS)
    expect(ipc.on.mock.calls.some(([channel]) => channel === MICROPHONE_ACCESS_WAITING)).toBe(false)
  })
})
