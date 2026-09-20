// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { registerFilesIpc } from '../../../src/main/files/ipc'
import { FilesService } from '../../../src/main/files/service'
import { FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL } from '../../../src/shared/files'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'

function fixture() {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => {
    const url = `file:///${role}.html`, mainFrame = { parent: null, url }
    return { role, url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } }
  }
  const main = sender('main'), widget = sender('widget')
  const resolveBinding = vi.fn().mockReturnValue(null), copyPath = vi.fn(), reveal = vi.fn()
  const files = new FilesService({ resolveBinding, copyPath, reveal })
  const dispose = registerFilesIpc(ipc, files, () => [main, widget])
  const event: IpcInvocationEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame }
  const invoke = async (channel: string, source = event, ...args: unknown[]) => handlers.get(channel)!(source, ...args)
  return { handlers, main, widget, event, invoke, dispose, resolveBinding, copyPath, reveal }
}
const channels = [FILES_LIST, FILES_PREVIEW, FILES_COPY_PATH, FILES_REVEAL]
const request = { threadId: 'thread', path: '', workspaceId: 'a'.repeat(64) }
describe('Files IPC security', () => {
  it('allows the trusted main frame and returns recoverable unknown-thread errors for all methods', async () => {
    const f = fixture()
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).resolves.toMatchObject({ ok: false, error: { code: 'thread-unavailable' } })
    expect(f.resolveBinding).toHaveBeenCalledTimes(4)
    expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
    f.dispose(); expect(f.handlers.size).toBe(0)
  })
  it('rejects widget, foreign, iframe, spoofed frame, missing, navigated and destroyed senders before binding or IO', async () => {
    const f = fixture()
    const rejected: IpcInvocationEvent[] = [
      { sender: f.widget.webContents, senderFrame: f.widget.webContents.mainFrame },
      { ...f.event, sender: { ...f.main.webContents } },
      { ...f.event, senderFrame: { parent: {}, url: f.main.url } },
      { ...f.event, senderFrame: { parent: null, url: f.main.url } },
      { ...f.event, senderFrame: null },
    ]
    for (const channel of channels) for (const event of rejected) await expect(f.invoke(channel, event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    f.main.webContents.getURL = () => 'https://untrusted.example/'
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    f.main.webContents.getURL = () => f.main.url; f.main.webContents.isDestroyed = () => true
    for (const channel of channels) await expect(f.invoke(channel, f.event, request)).rejects.toThrow('FILES_MAIN_WINDOW_REQUIRED')
    expect(f.resolveBinding).not.toHaveBeenCalled(); expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
  })
  it('rejects extra arguments and arbitrary roots/absolute paths before binding or IO', async () => {
    const f = fixture()
    for (const channel of channels) {
      await expect(f.invoke(channel, f.event, request, 'extra')).rejects.toThrow()
      for (const payload of [null, { ...request, root: 'C:/' }, { ...request, path: 'C:/secret' }, { ...request, path: '../secret' }, { ...request, command: 'open' }]) {
        await expect(f.invoke(channel, f.event, payload)).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
      }
    }
    expect(f.resolveBinding).not.toHaveBeenCalled(); expect(f.copyPath).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled()
  })
})
