// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerProductEventsIpc } from '../../../../src/main/productEvents/ipc'
import { PRODUCT_EVENT_STATE, PRODUCT_EVENT_TOOL_OPENED } from '../../../../src/shared/productEvents'
import { ipcRegistry } from '../../../fixtures/ipcHarness'

describe('what the window may tell product events', () => {
  function setup() {
    const featureUsed = vi.fn()
    const registry = ipcRegistry()
    const { url, webContents: sender } = registry.main
    const cleanup = registerProductEventsIpc(registry.ipc, { featureUsed, state: { canSend: true, offBy: null } }, () => [{ role: 'main', url, webContents: sender }])
    const call = (...args: unknown[]) => registry.handlers.get(PRODUCT_EVENT_TOOL_OPENED)!({ sender, senderFrame: sender.mainFrame }, ...args)
    return { featureUsed, registry, sender, call, cleanup }
  }

  it('answers what it can send to the main window alone', () => {
    const { registry, sender } = setup()
    const ask = registry.handlers.get(PRODUCT_EVENT_STATE)!
    expect(ask({ sender, senderFrame: sender.mainFrame })).toEqual({ canSend: true, offBy: null })
    const stranger = ipcRegistry().main.webContents
    expect(ask({ sender: stranger, senderFrame: stranger.mainFrame })).toBeNull()
  })

  it.each(['files', 'changes'])('takes %s from the main window', tool => {
    const { featureUsed, call } = setup()
    call(tool)
    expect(featureUsed).toHaveBeenCalledExactlyOnceWith(tool)
  })

  it('ignores any other name or extra argument, and answers nothing', () => {
    const { featureUsed, call } = setup()
    expect(call('secret-repo-name')).toBeUndefined()
    expect(call('council')).toBeUndefined()
    expect(call('files', 'extra')).toBeUndefined()
    expect(call({ feature: 'files' })).toBeUndefined()
    expect(featureUsed).not.toHaveBeenCalled()
  })

  it('ignores any other window, and leaves no handler behind', () => {
    const { featureUsed, registry, sender, cleanup } = setup()
    registry.handlers.get(PRODUCT_EVENT_TOOL_OPENED)!({ sender: { ...sender }, senderFrame: sender.mainFrame }, 'files')
    expect(featureUsed).not.toHaveBeenCalled()
    cleanup()
    expect(registry.handlers.has(PRODUCT_EVENT_TOOL_OPENED)).toBe(false)
  })
})
