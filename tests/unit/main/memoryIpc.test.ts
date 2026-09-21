// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerMemoryIpc } from '../../../src/main/memory/ipc'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { MEMORY_COMMAND, MEMORY_GET } from '../../../src/shared/memory'

function fixture(available = true) {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => {
    const url = `file:///${role}.html`, mainFrame = { parent: null, url }
    return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } }
  }
  const main = sender('main'), widget = sender('widget')
  const snapshot = { available: true, questionnaireCompletedAt: null, memories: [], policies: [] }
  const profile = { snapshot: vi.fn(() => snapshot), command: vi.fn(() => snapshot) }, changed = vi.fn()
  const dispose = registerMemoryIpc(ipc, available ? profile : undefined, () => [main, widget], changed)
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  return { handlers, main, widget, event, profile, changed, snapshot, dispose,
    invoke: async (channel: string, source = event, ...args: unknown[]) => handlers.get(channel)!(source, ...args) }
}

describe('memory IPC', () => {
  it('reads and mutates only through trusted main, notifying after a successful command', async () => {
    const f = fixture()
    await expect(f.invoke(MEMORY_GET)).resolves.toEqual(f.snapshot)
    await expect(f.invoke(MEMORY_COMMAND, f.event, { type: 'delete', id: 'memory' })).resolves.toEqual(f.snapshot)
    expect(f.profile.command).toHaveBeenCalledWith({ type: 'delete', id: 'memory' })
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(f.snapshot)
    f.profile.command.mockImplementationOnce(() => { throw new Error('stale memory') })
    await expect(f.invoke(MEMORY_COMMAND, f.event, { type: 'delete', id: 'memory' })).rejects.toThrow('stale memory')
    expect(f.changed).toHaveBeenCalledTimes(1)
    f.dispose()
    expect(f.handlers.size).toBe(0)
  })

  it('rejects widget, foreign, missing, child, spoofed and navigated frames before accessing memory', async () => {
    const f = fixture()
    const rejected: IpcInvocationEvent[] = [
      { sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame },
      { ...f.event, sender: { ...f.main.webContents } },
      { ...f.event, senderFrame: null },
      { ...f.event, senderFrame: { parent: {}, url: f.main.url } },
      { ...f.event, senderFrame: { parent: null, url: f.main.url } },
    ]
    for (const event of rejected) for (const channel of [MEMORY_GET, MEMORY_COMMAND]) {
      await expect(f.invoke(channel, event, { type: 'delete', id: 'memory' })).rejects.toThrow('MEMORY_MAIN_WINDOW_REQUIRED')
    }
    f.main.webContents.getURL = () => 'https://untrusted.example/'
    await expect(f.invoke(MEMORY_GET)).rejects.toThrow('MEMORY_MAIN_WINDOW_REQUIRED')
    expect(f.profile.snapshot).not.toHaveBeenCalled()
    expect(f.profile.command).not.toHaveBeenCalled()
  })

  it('rejects invalid payloads and extra arguments; unavailable storage is readable but not writable', async () => {
    const f = fixture()
    await expect(f.invoke(MEMORY_GET, f.event, {})).rejects.toThrow()
    await expect(f.invoke(MEMORY_COMMAND, f.event, { type: 'delete', id: 'memory', grant: true })).rejects.toThrow()
    await expect(f.invoke(MEMORY_COMMAND, f.event, { type: 'delete', id: 'memory' }, 'extra')).rejects.toThrow()
    expect(f.profile.command).not.toHaveBeenCalled()
    const unavailable = fixture(false)
    await expect(unavailable.invoke(MEMORY_GET)).resolves.toEqual({ available: false, questionnaireCompletedAt: null, memories: [], policies: [] })
    await expect(unavailable.invoke(MEMORY_COMMAND, unavailable.event, { type: 'delete', id: 'memory' })).rejects.toThrow('Memory is unavailable')
  })
})
