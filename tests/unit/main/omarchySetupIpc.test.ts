// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerOmarchySetupIpc } from '../../../src/main/omarchy/ipc'
import type { OmarchySetup } from '../../../src/main/omarchy/setup'
import { OMARCHY_SETUP_GET, OMARCHY_SETUP_COMMAND } from '../../../src/shared/omarchySetup'
import { ipcRegistry } from '../../fixtures/ipcHarness'

describe('Omarchy setup IPC', () => {
  it.each(['win32', 'darwin'] as const)('registers nothing and performs no detection on %s', platform => {
    const registry = ipcRegistry(), engine = { get: vi.fn(), command: vi.fn() }
    const focus = vi.fn()
    registerOmarchySetupIpc(registry.ipc, platform, engine as unknown as OmarchySetup, registry.trustedSenders, { follow: focus, notify: vi.fn() })()
    expect(registry.handlers.size).toBe(0)
    expect(engine.get).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
  it('notifies the renderer on native main-window focus without inspecting and stops following it during cleanup', () => {
    const registry = ipcRegistry(), engine = { get: vi.fn(async () => 'state'), command: vi.fn() }
    let focus: (() => void) | undefined
    const unsubscribe = vi.fn(() => { focus = undefined }), notify = vi.fn()
    const cleanup = registerOmarchySetupIpc(registry.ipc, 'linux', engine as unknown as OmarchySetup, registry.trustedSenders,
      { follow: listener => { focus = listener; return unsubscribe }, notify })
    focus!(); expect(notify).toHaveBeenCalledOnce(); expect(engine.get).not.toHaveBeenCalled()
    cleanup(); expect(focus).toBeUndefined(); expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('accepts only a trusted main frame, exact arguments and the bounded command schema', async () => {
    const r = ipcRegistry(), engine = { get: vi.fn(async () => 'state'), command: vi.fn(async () => 'state') }
    const cleanup = registerOmarchySetupIpc(r.ipc, 'linux', engine as unknown as OmarchySetup, r.trustedSenders)
    await expect(r.invoke(OMARCHY_SETUP_GET)).resolves.toBe('state')
    const command = { type: 'setup', pieces: ['keys'], keys: 'give' }
    await expect(r.invoke(OMARCHY_SETUP_COMMAND, [command])).resolves.toBe('state')
    for (const channel of [OMARCHY_SETUP_GET, OMARCHY_SETUP_COMMAND]) {
      await expect(r.invoke(channel, [], r.widgetEvent)).rejects.toThrow('OMARCHY_MAIN_WINDOW_REQUIRED')
      await expect(r.invoke(channel, [], { sender: r.main.webContents, senderFrame: { parent: {}, url: r.main.url } })).rejects.toThrow('OMARCHY_MAIN_WINDOW_REQUIRED')
    }
    await expect(r.invoke(OMARCHY_SETUP_GET, [{}])).rejects.toThrow()
    await expect(r.invoke(OMARCHY_SETUP_COMMAND, [{ ...command, path: '/home/zach' }])).rejects.toThrow()
    await expect(r.invoke(OMARCHY_SETUP_COMMAND, [{ ...command, keys: 'yes' }])).rejects.toThrow()
    expect(engine.command).toHaveBeenCalledTimes(1)
    cleanup(); expect(r.handlers.size).toBe(0)
  })
})
